/**
 * Transparent stale-while-revalidate (SWR) cache for dashboard GET requests.
 *
 * The dashboard router unmounts/remounts every page on navigation, so each page's
 * `createResource` re-runs from scratch on every tab switch — a full refetch of
 * Overview → Messages → Subscriptions → back every single time. This module sits
 * behind the shared GET helper (`fetchJson`) and serves cached payloads keyed by
 * request URL so navigation feels instant without going stale.
 *
 * Design choices (documented per the implementation brief):
 *
 * - **Default-on for GETs, explicit deny-list + per-call opt-out.** Caching every
 *   GET by default is what makes navigation transparently fast (pages don't have
 *   to opt in). A small deny-list (`isCacheable`) excludes always-fresh/sensitive
 *   endpoints, and callers can force a bypass with `fetchJson(path, params, { cache: false })`.
 * - **Short TTL (30s).** Long enough to make back-and-forth navigation feel
 *   instant, short enough that data is never meaningfully stale even without an
 *   SSE invalidation. SSE events (`services/sse.ts`) invalidate the relevant key
 *   groups immediately, so the TTL is just a backstop.
 * - **Stale-while-revalidate.** A stale-but-present entry is returned immediately
 *   while a background refetch updates the cache, so the UI never blocks on the
 *   network for a key it has seen recently.
 * - **In-flight de-duplication.** Concurrent identical GETs share one promise so a
 *   page that mounts several resources hitting the same URL only fires one request.
 * - **Never cache failures.** Only resolved 2xx payloads are stored; a rejected
 *   fetch leaves the cache untouched so the next call retries.
 */

/** Default freshness window, in milliseconds. */
export const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  /** Last successfully-fetched payload, or undefined while the first fetch is in flight. */
  data?: T;
  /** Epoch ms after which `data` is considered stale and should be revalidated. */
  expiresAt: number;
  /** Shared promise for an in-flight fetch, used to de-dupe concurrent identical GETs. */
  inflight?: Promise<T>;
}

// Module-level cache keyed by fully-qualified request URL (path + query string).
// `unknown` because entries are heterogeneous across endpoints; callers re-assert
// the type at the `fetchJson<T>` boundary.
const cache = new Map<string, CacheEntry<unknown>>();

// Monotonic invalidation generation. Every invalidate* call bumps this counter.
// A fetch captures the generation when it starts; if the counter advanced before
// the fetch resolves, an invalidation ran *during* the request and its result is
// stale — so the success write is suppressed rather than allowed to resurrect a
// key that was just dropped. This is what keeps the SSE invalidate-before-bump
// contract sound: a refetch kicked off after invalidation captures the new
// generation and writes normally, while any request that was already in flight
// when invalidation happened silently declines to repopulate the cache.
let generation = 0;

/**
 * Bound the cache by dropping expired entries that have no in-flight refetch.
 * Runs on every successful write, so growth is pruned incrementally without a
 * timer. Entries with a live `inflight` promise are kept (a revalidation is
 * mid-flight); entries still holding stale-but-usable data within a fresh
 * window are kept too — only fully-expired, idle keys are swept.
 */
function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (!entry.inflight && now >= entry.expiresAt) cache.delete(key);
  }
}

/**
 * Endpoints that must NEVER be cached — always-fresh or sensitive surfaces. A
 * match anywhere in the URL is enough (these are unambiguous path fragments):
 *
 * - `/auth`          — Better Auth (sessions, login state) must always be live.
 * - `/key`           — agent API key reveal; never serve a stale/secret value.
 * - `/rotate-key`    — key rotation is a mutation that returns a fresh secret.
 * - `/events`        — SSE stream endpoint; not a JSON GET.
 * - `/health`        — liveness probe must reflect the current instant.
 */
const DENY_LIST = ['/auth', '/key', '/rotate-key', '/events', '/health'];

/** True when a URL is eligible for caching (not on the always-fresh deny-list). */
export function isCacheable(url: string): boolean {
  return !DENY_LIST.some((fragment) => url.includes(fragment));
}

/**
 * Stale-while-revalidate read-through cache for a single GET.
 *
 * @param url     Fully-qualified request URL (the cache key).
 * @param fetcher Performs the actual network fetch. Only its resolved value is cached;
 *                a rejection is propagated and never stored.
 * @param ttlMs   Freshness window for a fresh hit.
 */
export function cachedFetch<T>(
  url: string,
  fetcher: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const now = Date.now();
  // Generation snapshot for this call. If an invalidation bumps `generation`
  // before the fetch resolves, the resolved payload is stale and must not be
  // written back (see the success handler below).
  const startGeneration = generation;
  const entry = cache.get(url) as CacheEntry<T> | undefined;

  // Fresh hit — serve cached data without touching the network.
  if (entry && entry.data !== undefined && now < entry.expiresAt) {
    return Promise.resolve(entry.data);
  }

  // In-flight de-dupe — a request for this URL is already running; share it.
  if (entry?.inflight) {
    // Stale-but-present: still return the cached data immediately rather than
    // awaiting the revalidation that's already underway.
    if (entry.data !== undefined) {
      return Promise.resolve(entry.data);
    }
    return entry.inflight;
  }

  // Kick off a (re)fetch. The promise updates the cache on success and clears the
  // in-flight marker either way so a failed fetch doesn't wedge the key.
  const inflight = fetcher()
    .then((data) => {
      // Resurrection guard: an invalidation that ran while this fetch was in
      // flight bumped `generation`. Writing now would repopulate a key that was
      // deliberately dropped (and possibly already refetched by a newer call),
      // so suppress the write and just clear our own in-flight marker. The
      // payload is still returned to this caller — only the cache is left alone.
      if (generation !== startGeneration) {
        const current = cache.get(url) as CacheEntry<T> | undefined;
        if (current?.inflight === inflight) {
          current.inflight = undefined;
          if (current.data === undefined) cache.delete(url);
        }
        return data;
      }
      const settledAt = Date.now();
      cache.set(url, { data, expiresAt: settledAt + ttlMs });
      pruneExpired(settledAt);
      return data;
    })
    .catch((err) => {
      const current = cache.get(url) as CacheEntry<T> | undefined;
      // Only act on the slot we actually registered. An invalidation may have
      // dropped this key and a newer request may now own it; we must not clobber
      // that newer in-flight marker or its data.
      if (current && current.inflight === inflight) {
        // Drop only the in-flight marker; keep any previously-cached data so a
        // transient failure during background revalidation doesn't evict a good value.
        current.inflight = undefined;
        if (current.data === undefined) cache.delete(url);
      }
      throw err;
    });

  if (entry && entry.data !== undefined) {
    // Stale-while-revalidate: return the stale value now, revalidate in background.
    entry.inflight = inflight;
    // Swallow the background rejection so an unhandled-rejection isn't surfaced;
    // the next caller will retry against a now-empty in-flight slot.
    inflight.catch(() => undefined);
    return Promise.resolve(entry.data);
  }

  // Cache miss with no prior data: store the in-flight promise and await it.
  cache.set(url, { expiresAt: 0, inflight });
  return inflight;
}

/** Drop every cached entry whose URL starts with `prefix`. */
export function invalidate(prefix: string): void {
  generation++;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Drop every cached entry whose URL matches `predicate`. */
export function invalidatePredicate(predicate: (url: string) => boolean): void {
  generation++;
  for (const key of cache.keys()) {
    if (predicate(key)) cache.delete(key);
  }
}

/** Drop the entire cache. Used by mutations with broad blast radius and tests. */
export function invalidateAll(): void {
  generation++;
  cache.clear();
}

/**
 * URL-fragment groups used by SSE-driven invalidation. A cached key is dropped when
 * its URL contains any fragment in the relevant group. Kept here (next to the cache)
 * so the matching rules live with the cache they govern.
 */
export const INVALIDATION_GROUPS = {
  // Keep the message feed near-real-time without forcing every aggregate chart
  // to refetch at the feed's faster cadence.
  message: ['/messages'],
  // A new/changed message moves every usage-derived chart, summary, and table.
  analytics: [
    '/overview',
    '/costs',
    '/tokens',
    '/usage',
    '/provider-analytics',
    '/providers/usage',
    '/agents',
  ],
  // A routing/provider change moves provider lists and routing config.
  routing: ['/routing', '/providers', '/provider-analytics'],
  // An agent create/rename/delete moves the agent list and per-agent views.
  agent: ['/agents', '/agent/'],
} as const;

/** Invalidate every cached key belonging to one of the {@link INVALIDATION_GROUPS}. */
export function invalidateGroup(group: keyof typeof INVALIDATION_GROUPS): void {
  const fragments = INVALIDATION_GROUPS[group];
  invalidatePredicate((url) => fragments.some((fragment) => url.includes(fragment)));
}
