/**
 * Quota-halt 429 detection for upstream providers (RET-480-B1).
 *
 * Some providers answer a fully drained quota window with a 429 whose body
 * carries a numeric halt code plus a `next_flush_time` epoch marking when the
 * window resets and fresh quota becomes available. Those halts are
 * qualitatively different from RPM/burst 429s: no amount of immediate retrying
 * can succeed, so the client should get an honest `Retry-After` bounded to the
 * real window, and the route should cool down for the whole window rather than
 * the short default applied to ordinary rate limits.
 *
 * Concurrency 429s (1302/1305) and wallet/balance 429s (1113) are deliberately
 * NOT halts: the first free slot or a top-up unblocks them within seconds, so
 * they keep the plain 429 treatment (short default cooldown, no header).
 */

/** Upstream quota-window halt codes (distinct from concurrency/wallet codes). */
export const QUOTA_HALT_CODES: ReadonlySet<number> = new Set([
  1308, 1310, 1316, 1317, 1318, 1319, 1320, 1321,
]);

/** Never tell a client to wait longer than one hour on a quota window. */
export const MAX_QUOTA_RETRY_AFTER_SECONDS = 3600;

/** Always give at least one second so the header stays RFC-valid. */
export const MIN_QUOTA_RETRY_AFTER_SECONDS = 1;

export interface QuotaHaltWindow {
  /**
   * Milliseconds-epoch instant the halted quota window flushes. This is also
   * the window identity used by quota accounting (RET-480-B2): same value as
   * the admission side's `quota_reset_at` boundary.
   */
  flushMs: number;
  /**
   * Client-facing `Retry-After` seconds: ceil((flushMs - now) / 1000),
   * bounded to [MIN_QUOTA_RETRY_AFTER_SECONDS, MAX_QUOTA_RETRY_AFTER_SECONDS].
   */
  retryAfterSeconds: number;
}

/**
 * Parse an upstream 429 body into a quota-halt window.
 *
 * Tolerant by design — provider bodies vary:
 * - halt code and `next_flush_time` at the top level or nested under `error`;
 * - code numeric or numeric-string;
 * - `next_flush_time` in seconds or milliseconds, number or numeric-string.
 *
 * Returns null for anything that is not a quota-window halt: non-429 status,
 * unparseable body, unknown/concurrency/wallet codes, or a halt code without
 * a usable `next_flush_time` (no window identity → no honest header).
 */
export function parseQuotaHalt(
  status: number,
  body: string,
  nowMs: number = Date.now(),
): QuotaHaltWindow | null {
  if (status !== 429) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const { code, nextFlushTime } = haltFields(parsed);
  const codeNumber =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && code.trim() !== ''
        ? Number(code.trim())
        : Number.NaN;
  if (!Number.isFinite(codeNumber) || !QUOTA_HALT_CODES.has(codeNumber)) return null;

  const flushMs = toEpochMs(nextFlushTime);
  if (flushMs === null) return null;

  return { flushMs, retryAfterSeconds: quotaHaltRetryAfterSeconds(flushMs, nowMs) };
}

/** Client-facing `Retry-After` seconds for a known flush instant. */
export function quotaHaltRetryAfterSeconds(flushMs: number, nowMs: number = Date.now()): number {
  return Math.min(
    Math.max(Math.ceil((flushMs - nowMs) / 1000), MIN_QUOTA_RETRY_AFTER_SECONDS),
    MAX_QUOTA_RETRY_AFTER_SECONDS,
  );
}

/**
 * Route-cooldown TTL (ms) for a quota halt: the real window length, bounded to
 * [1s, 1h]. Deliberately NOT clamped to the plain-429 5-minute Retry-After cap
 * — a halt that says the window flushes in 40 minutes should sideline the
 * route for 40 minutes, because every in-window retry provably fails.
 */
export function quotaHaltCooldownTtlMs(flushMs: number, nowMs: number = Date.now()): number {
  return quotaHaltRetryAfterSeconds(flushMs, nowMs) * 1000;
}

/** Read `code` + `next_flush_time` from either the top level or `error`. */
function haltFields(raw: unknown): { code: unknown; nextFlushTime: unknown } {
  if (raw === null || typeof raw !== 'object') return { code: undefined, nextFlushTime: undefined };
  const top = raw as Record<string, unknown>;
  const err =
    top.error !== null && typeof top.error === 'object'
      ? (top.error as Record<string, unknown>)
      : undefined;
  return {
    code: top.code ?? err?.code,
    nextFlushTime: top.next_flush_time ?? err?.next_flush_time,
  };
}

/** Numeric or numeric-string epoch (seconds or milliseconds) → epoch ms. */
function toEpochMs(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  // Values below 1e12 cannot be a plausible present-day epoch-ms, so treat
  // them as epoch-seconds; 1e12+ is already milliseconds.
  const ms = Math.abs(n) < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) ? ms : null;
}
