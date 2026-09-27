import { createKeyv, type Keyv } from 'cacheable';
import {
  DASHBOARD_CACHE_MAX_ENTRIES,
  DASHBOARD_CACHE_SWEEP_MS,
  DASHBOARD_CACHE_TTL_MS,
} from '../constants/cache.constants';

/**
 * Builds the bounded in-memory store for the global response cache
 * (`CacheModule`).
 *
 * cache-manager@7's default store is an unbounded `Keyv` Map with lazy-only
 * expiry: it has no size cap and never sweeps, so an entry is dropped only when
 * its exact key is read again. The dashboard interceptors key by full request
 * URL, so high-cardinality query strings (ranges, cursors, filters, timestamps)
 * are written once and rarely re-read with an identical URL — their entries are
 * never evicted and heap climbs monotonically across the process lifetime.
 *
 * `createKeyv` returns a `Keyv` backed by `CacheableMemory`, adding a hard LRU
 * cap (`lruSize`) plus an active, `unref`'d sweep of expired entries
 * (`checkInterval`). Using the helper (rather than a hand-built `new Keyv()`)
 * yields the `Keyv` instance `@nestjs/cache-manager` recognises via
 * `instanceof Keyv`, so it is used as-is instead of being rejected.
 */
export function buildDashboardCacheStore(): Keyv {
  return createKeyv({
    ttl: DASHBOARD_CACHE_TTL_MS,
    lruSize: DASHBOARD_CACHE_MAX_ENTRIES,
    checkInterval: DASHBOARD_CACHE_SWEEP_MS,
  });
}
