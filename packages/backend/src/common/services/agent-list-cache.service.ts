import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { AGENT_LIST_CACHE_TTL_MS, agentListCacheKey } from '../constants/cache.constants';
import { TtlCache } from '../utils/ttl-cache';

/**
 * How long a tenant's generation is remembered. Forgetting one drops the tenant
 * back to generation 0, so it is only safe once every entry written under
 * generation 0 has expired. The last of those can be written by a request that
 * was in flight across the invalidation that left generation 0, so two list TTLs
 * is the margin.
 */
const GENERATION_RESIDENCY_MS = AGENT_LIST_CACHE_TTL_MS * 2;
/** Ceiling on tracked tenants; the least-recently-invalidated is dropped first. */
const GENERATION_MAX_TENANTS = 50_000;

/**
 * Owns the cache keys behind GET /agents.
 *
 * Invalidation bumps a per-tenant generation rather than relying on a delete
 * landing at the right moment. That is what makes it race-free: a request that
 * is already in flight resolved its key under the old generation, so whenever
 * its response is written back it lands on a key no later reader looks at, and
 * a request that starts after the bump computes the new key and misses. Nothing
 * has to wait for in-flight work, and a failed delete cannot serve a stale list.
 *
 * It lives in a service, not on AgentListCacheInterceptor, because Nest
 * instantiates a controller-scoped copy of an interceptor passed to
 * `@UseInterceptors()` — state kept on the interceptor would not be the state
 * the event bus and the mutation handlers see.
 */
@Injectable()
export class AgentListCacheService {
  private readonly logger = new Logger(AgentListCacheService.name);
  private readonly generations = new TtlCache<string, number>({
    maxSize: GENERATION_MAX_TENANTS,
    ttlMs: GENERATION_RESIDENCY_MS,
  });
  /**
   * Generations are drawn from one process-wide counter, never from a per-tenant
   * one, so a tenant whose entry was dropped (idle past the residency, or
   * evicted at the ceiling) never comes back on a number it used before. Reusing
   * a number could hand readers an entry warmed under the earlier run of that
   * same generation — the stale count this class exists to prevent.
   */
  private nextGeneration = 0;

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /** Cache key for the tenant's current agent-list generation. */
  key(tenantId: string, includePlayground: boolean): string {
    return agentListCacheKey(tenantId, includePlayground, this.generations.get(tenantId) ?? 0);
  }

  /**
   * Retire the tenant's cached agent lists so the next read rebuilds them.
   * Deleting the retired keys is only housekeeping — the generation bump is
   * what guarantees freshness — so a cache failure is logged, never thrown:
   * callers must not have to choose between a stale list and dropping the
   * refetch that follows.
   */
  async invalidate(tenantId: string): Promise<void> {
    const retired = this.generations.get(tenantId) ?? 0;
    this.generations.set(tenantId, ++this.nextGeneration);

    await Promise.all(
      [false, true].map(async (includePlayground) => {
        const key = agentListCacheKey(tenantId, includePlayground, retired);
        try {
          await this.cache.del(key);
        } catch (error) {
          this.logger.warn(
            `Could not delete the retired agent-list cache entry ${key}; it expires on its own`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }),
    );
  }
}
