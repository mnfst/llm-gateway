import { mergeAnthropicBeta } from './anthropic-beta';

/** Beta header required by Anthropic when setting `thinking.block_binding`. */
export const THINKING_BINDING_CONTROLS_BETA = 'thinking-binding-controls-2026-08-01';

const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_BINDING_SESSION_ENTRIES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasBetaFlag(headerValue: string | undefined, flag: string): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(',')
    .map((part) => part.trim())
    .includes(flag);
}

function isThinkingEnabledBody(body: Record<string, unknown>): boolean {
  return isRecord(body.thinking) && body.thinking.type !== 'disabled';
}

/** Whether the body explicitly carries an Anthropic `thinking.block_binding` setting. */
export function hasAnthropicThinkingBlockBinding(body: Record<string, unknown>): boolean {
  return (
    isThinkingEnabledBody(body) &&
    isRecord((body.thinking as Record<string, unknown>).block_binding)
  );
}

/** Merge the thinking-binding beta header when an Anthropic request carries `thinking.block_binding`. */
export function withThinkingBindingBetaIfNeeded(
  headers: Record<string, string>,
  isAnthropicHostEndpoint: boolean,
  body: Record<string, unknown>,
): Record<string, string> {
  if (!isAnthropicHostEndpoint || !hasAnthropicThinkingBlockBinding(body)) return headers;
  const merged = mergeAnthropicBeta(headers['anthropic-beta'], THINKING_BINDING_CONTROLS_BETA);
  if (merged === undefined || merged === headers['anthropic-beta']) return headers;
  return { ...headers, 'anthropic-beta': merged };
}

/** Inject `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'` when thinking is active. */
export function applyThinkingDropBlock(
  body: Record<string, unknown>,
  options?: { preserveExplicitBehavior?: boolean },
): Record<string, unknown> {
  if (!isThinkingEnabledBody(body)) return body;
  const thinking = body.thinking as Record<string, unknown>;
  const existingBinding = isRecord(thinking.block_binding) ? thinking.block_binding : undefined;
  if (existingBinding?.prefix_mismatch_behavior === 'drop_block') return body;
  if (
    options?.preserveExplicitBehavior &&
    existingBinding?.prefix_mismatch_behavior !== undefined
  ) {
    return body;
  }
  return {
    ...body,
    thinking: {
      ...thinking,
      block_binding: {
        ...(existingBinding ?? {}),
        prefix_mismatch_behavior: 'drop_block',
      },
    },
  };
}

/** Detect Anthropic's 400 error caused by a thinking block whose signature fails prefix binding. */
export function isAnthropicThinkingBindingError(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('bound to a different conversation') &&
    (lower.includes('thinking') ||
      lower.includes('prefix_mismatch_behavior') ||
      lower.includes(THINKING_BINDING_CONTROLS_BETA))
  );
}

function stripThinkingBlocksFromMessages(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(body.messages)) return null;
  let changed = false;
  const nextMessages: unknown[] = [];

  for (const msg of body.messages) {
    if (!isRecord(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      nextMessages.push(msg);
      continue;
    }
    const filtered = msg.content.filter(
      (block) =>
        !isRecord(block) || (block.type !== 'thinking' && block.type !== 'redacted_thinking'),
    );
    if (filtered.length !== msg.content.length) {
      changed = true;
      if (filtered.length > 0) nextMessages.push({ ...msg, content: filtered });
    } else {
      nextMessages.push(msg);
    }
  }

  return changed ? { ...body, messages: nextMessages } : null;
}

export interface ThinkingBindingRecovery {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  rememberDropBlock: boolean;
}

/**
 * Build a one-shot retry payload for Anthropic's prefix-binding 400.
 *
 * When thinking is active, prefer Anthropic's `thinking-binding-controls-2026-08-01`
 * beta + `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` so
 * mismatched cached blocks are dropped server-side without violating Anthropic's
 * requirement that active tool loops include thinking blocks. When thinking is
 * inactive or disabled, fall back to stripping stale thinking blocks.
 */
export function buildThinkingBindingRecovery(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): ThinkingBindingRecovery | null {
  if (isThinkingEnabledBody(body)) {
    const nextBody = applyThinkingDropBlock(body);
    const mergedBeta = mergeAnthropicBeta(
      headers['anthropic-beta'],
      THINKING_BINDING_CONTROLS_BETA,
    );
    const hadDropBlock = nextBody === body;
    const hadBeta = hasBetaFlag(headers['anthropic-beta'], THINKING_BINDING_CONTROLS_BETA);
    if (hadDropBlock && hadBeta) return null;

    const nextHeaders =
      mergedBeta !== undefined && mergedBeta !== headers['anthropic-beta']
        ? { ...headers, 'anthropic-beta': mergedBeta }
        : headers;
    return { body: nextBody, headers: nextHeaders, rememberDropBlock: true };
  }

  const stripped = stripThinkingBlocksFromMessages(body);
  return stripped ? { body: stripped, headers, rememberDropBlock: false } : null;
}

/**
 * Bounded per-session tracker remembering `(baseUrl, model, session)` scopes
 * that required `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`.
 */
export class AnthropicThinkingBindingSessionStore {
  private readonly sessions = new Map<string, number>();
  private lastCleanup = Date.now();

  buildKey(baseUrl: string, bareModel: string, sessionId: string): string {
    return `${baseUrl.trim().toLowerCase()}\u0000${bareModel.trim()}\u0000${sessionId}`;
  }

  has(key: string): boolean {
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  remember(key: string): void {
    this.maybeCleanup();
    this.sessions.delete(key);
    this.sessions.set(key, Date.now() + SESSION_TTL_MS);
    while (this.sessions.size > MAX_BINDING_SESSION_ENTRIES) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, expiresAt] of this.sessions) {
      if (now > expiresAt) this.sessions.delete(key);
    }
  }
}
