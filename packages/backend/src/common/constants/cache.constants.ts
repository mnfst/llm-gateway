export const DASHBOARD_CACHE_TTL_MS = 30_000;
/**
 * Hard cap on entries in the global response cache. cache-manager@7's default
 * in-memory store is an unbounded Keyv Map; the dashboard interceptors key by
 * full request URL, so without a cap high-cardinality query strings accumulate
 * forever. Oldest entries are LRU-evicted once this ceiling is reached.
 */
export const DASHBOARD_CACHE_MAX_ENTRIES = 5_000;
/** Interval (ms) for the active sweep of expired global response-cache entries. */
export const DASHBOARD_CACHE_SWEEP_MS = 60_000;
export const AGENT_LIST_CACHE_TTL_MS = 60_000;
export const MODEL_PRICES_CACHE_TTL_MS = 300_000;
export const FREE_MODELS_CACHE_TTL_MS = 3_600_000;

/**
 * Canonical cache key for the GET /agents list. The route varies only by whether
 * the reserved Playground agent is included, so every query-string
 * variant collapses to one of two keys keyed on that boolean — never the raw
 * URL. This keeps the key set bounded (exactly two per tenant) so invalidation can
 * enumerate it exhaustively and no variant is ever left stale.
 *
 * `generation` retires a tenant's keys without having to delete them: bumping it
 * makes the next read miss, and a response that started under the previous
 * generation writes back to a key nobody reads any more. See
 * AgentListCacheService.
 */
export function agentListCacheKey(
  tenantId: string,
  includePlayground: boolean,
  generation = 0,
): string {
  return `${tenantId}:/api/v1/agents:playground=${includePlayground}:g${generation}`;
}
