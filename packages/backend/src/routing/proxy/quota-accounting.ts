/**
 * Attempted-vs-consumed quota accounting (RET-480-B2).
 *
 * Per-provider window counters, keyed by the LOWERCASED routed provider:
 * - attempted_requests / attempted_est_tokens — counted BEFORE the upstream
 *   fetch (est = ceil(serialized wire body chars / 4)); retries and timeouts
 *   are attempts too.
 * - consumed_requests / consumed_tokens — normalized usage
 *   (prompt + completion; prompt_tokens already includes cache).
 *
 * Window identity = the 429-halt `next_flush_time` (same identity as the
 * admission side's quota_reset_at boundary, surfaced as `flushMs` by
 * quota-halt.ts). Identity change or expiry rolls and zeroes the counters;
 * the FIRST adoption keeps the already-counted attempts but re-stamps
 * window_start, because those attempts belong to the now-identified window.
 *
 * This module is deliberately pure (no Nest, no fs) so both the routing
 * error paths and the specs can import it cheaply. Persistence and Nest
 * lifecycle live in quota-accounting.service.ts.
 */

/** Default persistence target (mirrors the quota-state.json convention). */
export const QUOTA_ACCOUNTING_FILE_DEFAULT = '/data/quota-accounting.json';

/** Debounce window for background persistence. */
export const QUOTA_ACCOUNTING_FLUSH_DEBOUNCE_MS = 30_000;

/** Minimal usage shape the accounting accepts (StreamUsage-compatible). */
export interface QuotaUsageShape {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

export interface QuotaProviderAccounting {
  /** ISO instant this counting window opened. */
  window_start: string;
  /** ISO instant the halted quota window flushes; null while no halt seen. */
  window_flush_at: string | null;
  attempted_requests: number;
  attempted_est_tokens: number;
  consumed_requests: number;
  consumed_tokens: number;
  updated_at: string;
}

export interface QuotaAccountingSnapshot {
  providers: Record<string, QuotaProviderAccounting>;
}

/** Provider keys are case-insensitive: `OpenAI` and `openai` are one window. */
export function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Attempted-token estimate: ceil(serialized wire body chars / 4). */
export function estimateTokens(wireBody: string): number {
  return Math.ceil(wireBody.length / 4);
}

/** Normalized usage tokens: prompt + completion (prompt already has cache). */
export function normalizeUsageTokens(usage?: QuotaUsageShape | null): number {
  const prompt =
    typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
      ? Math.max(0, usage.prompt_tokens)
      : 0;
  const completion =
    typeof usage?.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)
      ? Math.max(0, usage.completion_tokens)
      : 0;
  return prompt + completion;
}

function emptyEntry(nowMs: number): QuotaProviderAccounting {
  const now = new Date(nowMs).toISOString();
  return {
    window_start: now,
    window_flush_at: null,
    attempted_requests: 0,
    attempted_est_tokens: 0,
    consumed_requests: 0,
    consumed_tokens: 0,
    updated_at: now,
  };
}

/** Get (creating if needed) the entry for a provider key. */
export function entryFor(
  state: QuotaAccountingSnapshot,
  provider: string,
  nowMs: number,
): QuotaProviderAccounting {
  const key = normalizeProviderKey(provider);
  let entry = state.providers[key];
  if (!entry) {
    entry = emptyEntry(nowMs);
    state.providers[key] = entry;
  }
  return entry;
}

/**
 * Roll a provider's window when its halt window has flushed (identity expiry):
 * zero the counters, open a fresh window. Returns true when a roll happened.
 */
export function rollIfExpired(
  state: QuotaAccountingSnapshot,
  provider: string,
  nowMs: number,
): boolean {
  const entry = state.providers[normalizeProviderKey(provider)];
  if (!entry?.window_flush_at) return false;
  if (Date.parse(entry.window_flush_at) > nowMs) return false;
  entry.attempted_requests = 0;
  entry.attempted_est_tokens = 0;
  entry.consumed_requests = 0;
  entry.consumed_tokens = 0;
  entry.window_start = new Date(nowMs).toISOString();
  entry.window_flush_at = null;
  entry.updated_at = entry.window_start;
  return true;
}

/** Count one provider attempt (est tokens from the exact serialized body). */
export function applyAttempt(
  state: QuotaAccountingSnapshot,
  provider: string,
  wireBody: string,
  nowMs: number,
): void {
  rollIfExpired(state, provider, nowMs);
  const entry = entryFor(state, provider, nowMs);
  entry.attempted_requests += 1;
  entry.attempted_est_tokens += estimateTokens(wireBody);
  entry.updated_at = new Date(nowMs).toISOString();
}

/** Count one consumed response from normalized usage. */
export function applyConsumed(
  state: QuotaAccountingSnapshot,
  provider: string,
  usage: QuotaUsageShape | null | undefined,
  nowMs: number,
): void {
  rollIfExpired(state, provider, nowMs);
  const entry = entryFor(state, provider, nowMs);
  entry.consumed_requests += 1;
  entry.consumed_tokens += normalizeUsageTokens(usage);
  entry.updated_at = new Date(nowMs).toISOString();
}

export type WindowFlushOutcome = 'unchanged' | 'adopted' | 'rolled';

/**
 * Adopt a 429-halt window as the provider's accounting window identity.
 * - same identity → 'unchanged';
 * - first adoption (no window yet) → 'adopted': counters are KEPT (they
 *   belong to the now-identified window) and window_start is re-stamped;
 * - different identity → 'rolled': counters zeroed, fresh window stamped.
 */
export function applyWindowFlush(
  state: QuotaAccountingSnapshot,
  provider: string,
  flushMs: number,
  nowMs: number,
): WindowFlushOutcome {
  const entry = entryFor(state, provider, nowMs);
  const flushIso = new Date(flushMs).toISOString();
  if (entry.window_flush_at === flushIso) return 'unchanged';
  const firstAdoption = entry.window_flush_at === null;
  if (!firstAdoption) {
    entry.attempted_requests = 0;
    entry.attempted_est_tokens = 0;
    entry.consumed_requests = 0;
    entry.consumed_tokens = 0;
  }
  // Both adoption and roll re-stamp window_start to the observed instant.
  entry.window_start = new Date(nowMs).toISOString();
  entry.window_flush_at = flushIso;
  entry.updated_at = entry.window_start;
  return firstAdoption ? 'adopted' : 'rolled';
}

/* ── Response-handler hook registry ────────────────────────────────────────
 * proxy-response-handler is plain functions (no DI), so the accounting
 * service registers itself here at boot. Everything is optional-injected
 * and guarded: telemetry can NEVER break forwarding.
 */

export interface QuotaAccountingHooks {
  noteWindowFlush(provider: string, flushMs: number): void;
}

let quotaAccountingHooks: QuotaAccountingHooks | null = null;

/** Register (or clear with null) the accounting hooks behind the error paths. */
export function setQuotaAccountingHooks(hooks: QuotaAccountingHooks | null): void {
  quotaAccountingHooks = hooks;
}

/** Guarded notify from a parsed quota-halt window. Never throws. */
export function notifyWindowFlush(provider: string, flushMs: number): void {
  if (!quotaAccountingHooks) return;
  try {
    quotaAccountingHooks.noteWindowFlush(provider, flushMs);
  } catch {
    // Telemetry must never break forwarding.
  }
}
