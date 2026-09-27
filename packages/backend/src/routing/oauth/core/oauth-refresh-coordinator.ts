/**
 * Single-flight coordinator for lazy OAuth access-token refreshes.
 *
 * Why this exists (issue #2012): providers like OpenAI now issue ROTATING
 * refresh tokens — every successful refresh invalidates the old refresh token
 * and returns a new one. The naive "parse blob → refresh(blob.r) → persist"
 * path each `unwrapToken()` used has two fatal races under that model:
 *
 *   1. Concurrent requests. An agent fires many parallel requests against an
 *      expired token. Each one parsed its own (stale) blob and calls the
 *      provider with the SAME old refresh token. The first rotates it; every
 *      other one gets `refresh_token_invalidated` and fails.
 *
 *   2. Persist-after-rotate failure. If the DB write fails AFTER the provider
 *      already rotated, the only copy of the new refresh token is lost while
 *      the stored one is already dead — the account is bricked until the user
 *      reconnects (exactly issue #2012).
 *
 * Layered protection:
 *
 *   - In-process single-flight (this file): concurrent requests on one
 *     backend instance coalesce onto one refresh promise.
 *   - DB row lock (`withLock`, usually SELECT … FOR UPDATE on
 *     tenant_providers): multi-replica deploys serialize the critical
 *     section so two instances cannot rotate the same refresh token.
 *   - Inside the lock: re-read the blob, skip refresh if already valid,
 *     then refresh + persist with retries (never re-refresh on persist fail).
 */
import { Logger } from '@nestjs/common';

/** Minimum shape every provider's stored OAuth blob shares. */
export interface RefreshableBlob {
  /** Access token. */
  t: string;
  /** Access-token expiry (epoch ms). */
  e: number;
}

/**
 * Expiry a caller puts on a token the provider rejected (a 401 before its
 * stored expiry), asking the coordinator to refresh it anyway.
 */
export const REJECTED_TOKEN_EXPIRY = 0;

/** Skew applied to expiry so a token about to expire is refreshed early. */
export const REFRESH_EXPIRY_SKEW_MS = 60_000;

/** How many times to retry persisting an already-rotated blob before giving up. */
export const PERSIST_MAX_ATTEMPTS = 3;

/** Locked read/write of one credential row (same DB transaction). */
export interface CredentialLockOps<T extends RefreshableBlob> {
  /** Fresh raw credential value under the lock (or null if no row). */
  readFreshRaw: () => Promise<string | null>;
  /** Persist a refreshed blob under the same lock. */
  persist: (refreshed: T) => Promise<void>;
}

export interface CoordinatedRefreshParams<T extends RefreshableBlob> {
  /** Identity key for single-flight: `${provider}:${tenantId}:${label}`. */
  readonly key: string;
  readonly logger: Logger;
  /**
   * Blob the caller already parsed from the value it was handed. May be stale
   * (read before a concurrent refresh), so the fresh DB copy wins, with one
   * exception: a caller whose provider just rejected this token sets its
   * expiry to `REJECTED_TOKEN_EXPIRY`, and the coordinator then refreshes even
   * though the DB copy has not expired yet.
   */
  readonly callerBlob: T;
  /** Parse a raw stored value into the provider's blob type. */
  readonly parse: (raw: string) => T | null;
  /** Perform the provider-specific refresh-token exchange. */
  readonly refresh: (current: T) => Promise<T>;
  /**
   * Exclusive critical section for this credential. Callers pass a DB row
   * lock (`ProviderService.withSubscriptionCredentialLock`) so multi-replica
   * refreshes serialize. Tests can use a no-op wrapper around mock ops.
   */
  readonly withLock: <R>(fn: (ops: CredentialLockOps<T>) => Promise<R>) => Promise<R>;
}

/**
 * Build the single-flight key for one credential. Namespaced by provider so two
 * providers never share an entry, and by label so an agent's multiple keys for
 * the same provider refresh independently. `undefined`/`'Default'` labels map to
 * the same key, matching how the row is persisted (tenant-scoped).
 */
export function oauthRefreshKey(providerId: string, tenantId: string, label?: string): string {
  return `${providerId}:${tenantId}:${label ?? 'Default'}`;
}

/**
 * Build a `withLock` callback that holds the tenant_providers subscription
 * row for the duration of the refresh critical section.
 */
export function subscriptionCredentialLock<T extends RefreshableBlob>(
  lock: <R>(
    tenantId: string,
    provider: string,
    label: string | undefined,
    fn: (ops: {
      readFreshRaw: () => Promise<string | null>;
      writeRaw: (raw: string) => Promise<void>;
    }) => Promise<R>,
  ) => Promise<R>,
  tenantId: string,
  provider: string,
  label: string | undefined,
  serialize: (blob: T) => string,
): CoordinatedRefreshParams<T>['withLock'] {
  return (fn) =>
    lock(tenantId, provider, label, async (ops) =>
      fn({
        readFreshRaw: ops.readFreshRaw,
        persist: async (refreshed) => ops.writeRaw(serialize(refreshed)),
      }),
    );
}

// Shared across every OAuth service. Each value is the in-flight refresh for
// one credential; the key namespaces by provider so collisions are impossible.
const inFlight = new Map<string, Promise<RefreshableBlob>>();

/**
 * Refresh (or reuse a concurrently-refreshed) OAuth blob for one credential,
 * guaranteeing at most one provider round-trip in flight per credential.
 *
 * Resolves to the usable blob (freshly refreshed, or the already-valid blob
 * found in the DB). Rejects if the provider refresh fails or the blob cannot
 * be persisted after retries — callers keep their provider-specific fallback
 * behaviour in a `catch`.
 */
export async function coordinateOAuthRefresh<T extends RefreshableBlob>(
  params: CoordinatedRefreshParams<T>,
): Promise<T> {
  const pending = inFlight.get(params.key) as Promise<T> | undefined;
  if (pending) return pending;

  const run = refreshOnce(params);
  inFlight.set(params.key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(params.key);
  }
}

async function refreshOnce<T extends RefreshableBlob>(
  params: CoordinatedRefreshParams<T>,
): Promise<T> {
  // withLock holds the tenant_providers row (FOR UPDATE) for the whole
  // section so another replica cannot rotate the same refresh token.
  return params.withLock(async (ops) => {
    // The DB is the source of truth under the lock: another instance may have
    // already rotated. Re-read so we never refresh with a stale token.
    let current = params.callerBlob;
    const freshRaw = await ops.readFreshRaw();
    if (freshRaw) {
      const fresh = params.parse(freshRaw);
      if (fresh) current = fresh;
    }

    // Already valid: it never really expired, or someone just refreshed. The
    // one exception is the exact token the provider rejected, which is dead
    // whatever its stored expiry says.
    const rejectedToken =
      params.callerBlob.e === REJECTED_TOKEN_EXPIRY && current.t === params.callerBlob.t;
    if (!rejectedToken && Date.now() < current.e - REFRESH_EXPIRY_SKEW_MS) return current;

    const refreshed = await params.refresh(current);
    await persistWithRetry(params, ops.persist, refreshed);
    return refreshed;
  });
}

async function persistWithRetry<T extends RefreshableBlob>(
  params: CoordinatedRefreshParams<T>,
  persist: (refreshed: T) => Promise<void>,
  refreshed: T,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt++) {
    try {
      await persist(refreshed);
      return;
    } catch (err) {
      lastErr = err;
      params.logger.warn(
        `OAuth token persist attempt ${attempt}/${PERSIST_MAX_ATTEMPTS} failed for ${params.key}: ${err}`,
      );
    }
  }
  // Surface the failure so the caller's catch runs. The provider may already
  // have rotated; retrying the same blob is the best we can do without a
  // durable outbox.
  throw lastErr;
}

/** Test seam: clear in-flight state between cases. */
export function __resetOAuthRefreshCoordinator(): void {
  inFlight.clear();
}
