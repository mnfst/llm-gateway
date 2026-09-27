/**
 * Anthropic extended-thinking content block. We only read `type` to route
 * storage; everything else is forwarded verbatim to preserve the signature.
 */
export interface ThinkingBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * Route that produced an Anthropic extended-thinking prelude.
 *
 * Anthropic signs thinking blocks for a specific continuation context. We
 * only replay cached blocks into outbound attempts that resolve to the same
 * provider/auth/model tuple, so fallback attempts on another route do not
 * send stale signatures.
 */
export interface ThinkingBlockRouteContext {
  provider: string;
  authType?: string | null;
  model: string;
}

interface NormalizedThinkingBlockRouteContext {
  provider: string;
  authType: string;
  model: string;
}

interface CachedThinkingBlocks {
  blocks: ThinkingBlock[];
  routeContext?: NormalizedThinkingBlockRouteContext;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Hard ceiling on cached turns. The key embeds an upstream-generated tool-use id
 * (unique per turn), so the keyspace is unbounded and the lazy TTL sweep — which
 * only runs on `store()` — cannot cap a burst. Oldest entries are evicted FIFO.
 */
export const MAX_CACHE_ENTRIES = 10_000;

function normalizeRouteContext(
  routeContext?: ThinkingBlockRouteContext | null,
): NormalizedThinkingBlockRouteContext | undefined {
  if (!routeContext) return undefined;
  return {
    provider: routeContext.provider.trim().toLowerCase(),
    authType: (routeContext.authType ?? 'api_key').trim().toLowerCase(),
    model: routeContext.model.trim().toLowerCase(),
  };
}

function routeContextMatches(
  stored: NormalizedThinkingBlockRouteContext | undefined,
  requested: NormalizedThinkingBlockRouteContext | undefined,
): boolean {
  if (!requested) return true;
  if (!stored) return false;
  return (
    stored.provider === requested.provider &&
    stored.authType === requested.authType &&
    stored.model === requested.model
  );
}

/**
 * In-memory cache for Anthropic extended-thinking content blocks.
 *
 * When extended thinking is enabled, Anthropic returns `thinking` and
 * `redacted_thinking` blocks alongside text and tool_use in the assistant
 * turn. If the next request continues a tool-use conversation, those blocks
 * must be echoed back verbatim — including the signature on each `thinking`
 * block — or Anthropic rejects the request:
 *
 *   "When `thinking` is enabled, assistant messages in multi-turn
 *    conversations that include `tool_use` content blocks must also include
 *    unmodified `thinking` or `redacted_thinking` blocks that preceded the
 *    tool use."
 *
 * OpenAI-compat clients strip unknown fields, so Manifest caches the blocks
 * here and re-injects them when the client replays the assistant turn.
 *
 * Keyed by `${sessionKey}:${firstToolUseId}` — the first tool_use id from
 * the turn uniquely identifies the assistant message within the session,
 * and the client will echo that id back when continuing the conversation.
 */
export class ThinkingBlockCache {
  private cache = new Map<string, CachedThinkingBlocks>();
  private lastCleanup = Date.now();

  /** Store the ordered thinking block sequence for an assistant turn. */
  store(
    sessionKey: string,
    firstToolUseId: string,
    blocks: ThinkingBlock[],
    routeContext?: ThinkingBlockRouteContext,
  ): void {
    if (blocks.length === 0) return;
    this.maybeCleanup();
    const normalizedRouteContext = normalizeRouteContext(routeContext);
    this.cache.set(`${sessionKey}:${firstToolUseId}`, {
      blocks,
      ...(normalizedRouteContext ? { routeContext: normalizedRouteContext } : {}),
      expiresAt: Date.now() + TTL_MS,
    });
    this.evictOverflow();
  }

  /** Bound the cache to MAX_CACHE_ENTRIES, evicting oldest (FIFO) entries first. */
  private evictOverflow(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      // size > cap (> 0) guarantees a first key exists.
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  /** Retrieve the cached thinking blocks, or null if not found/expired. */
  retrieve(
    sessionKey: string,
    firstToolUseId: string,
    routeContext?: ThinkingBlockRouteContext,
  ): ThinkingBlock[] | null {
    const entry = this.cache.get(`${sessionKey}:${firstToolUseId}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(`${sessionKey}:${firstToolUseId}`);
      return null;
    }
    if (!routeContextMatches(entry.routeContext, normalizeRouteContext(routeContext))) return null;
    return entry.blocks;
  }

  /** Clear all cached thinking blocks for a session. */
  clearSession(sessionKey: string): void {
    const prefix = `${sessionKey}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Lazily evict expired entries to avoid unbounded growth. */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}
