import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RoutingCacheService } from './routing-cache.service';

/** How often every instance applies the invalidations the others published. */
export const SYNC_POLL_INTERVAL_MS = 1_000;
/**
 * Each poll re-reads this far behind the previous one, so a row whose insert
 * committed just after a poll ran is still applied. Re-applying an
 * invalidation is harmless, and it also clears an entry that a read started
 * before the write managed to cache after the first invalidation.
 */
const OVERLAP_SECONDS = 2;
/** Rows older than this are deleted; the in-memory TTLs (2 min) cover the rest. */
const RETENTION_MINUTES = 10;
const PRUNE_EVERY_POLLS = 60;

type Scope = 'agent' | 'tenant';

interface FeedRow {
  next_since: string;
  scope: Scope | null;
  target_id: string | null;
}

/**
 * Keeps the routing caches of every backend process in step.
 *
 * RoutingCacheService (and the discovered-model cache hanging off it) lives in
 * one process's memory. In production several Cloud Run instances serve the
 * same tenants, and a dashboard write only cleared the instance that served
 * it: the dashboard's next read, and the proxy on the other instances, kept
 * the old tiers, providers and keys for up to the two-minute TTL.
 *
 * Every local invalidation is now appended to `cache_invalidations`, and each
 * instance polls that table once a second and applies what it finds. Two
 * extra guarantees make management surfaces read their own writes:
 * - `flushPending()` lets a mutating request wait until its invalidations are
 *   committed before it responds (RoutingCacheFlushInterceptor);
 * - `catchUp()` lets a management read apply pending invalidations before it
 *   reads the caches (ResolveAgentService.resolve).
 *
 * Failures are logged and swallowed: the feed only ever shortens staleness,
 * the in-memory TTLs still bound it if the table is unreachable.
 */
@Injectable()
export class RoutingCacheSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RoutingCacheSyncService.name);
  private readonly pending = new Map<string, { scope: Scope; id: string }>();
  private flushScheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  /** Set while applying the feed so the resulting invalidations are not re-published. */
  private applyingFeed = false;
  /** DB-clock lower bound of the next poll; null until the first poll. */
  private since: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private timerPollRunning = false;
  private polls = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly routingCache: RoutingCacheService,
  ) {
    routingCache.addInvalidationListener((agentId) => this.enqueue('agent', agentId));
    routingCache.addTenantInvalidationListener((tenantId) => this.enqueue('tenant', tenantId));
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.timerTick(), SYNC_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushPending();
  }

  /** Resolves once every invalidation queued so far is committed to the feed. */
  flushPending(): Promise<void> {
    this.flushScheduled = false;
    if (this.pending.size > 0) {
      const batch = [...this.pending.values()];
      this.pending.clear();
      this.flushing = this.flushing.then(() => this.insert(batch));
    }
    return this.flushing;
  }

  /** Applies invalidations other instances published since the last poll. */
  async catchUp(): Promise<void> {
    try {
      await this.poll();
    } catch (err) {
      this.logger.warn(`Routing cache catch-up failed: ${describe(err)}`);
    }
  }

  private enqueue(scope: Scope, id: string): void {
    if (this.applyingFeed) return;
    this.pending.set(pendingKey(scope, id), { scope, id });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Coalesce the per-agent fan-out of one write (e.g. a provider connect
    // invalidates every agent of the tenant) into a single INSERT.
    setImmediate(() => void this.flushPending());
  }

  private async insert(batch: { scope: Scope; id: string }[]): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO "cache_invalidations" ("scope", "target_id")
         SELECT * FROM unnest($1::varchar[], $2::varchar[])`,
        [batch.map((b) => b.scope), batch.map((b) => b.id)],
      );
    } catch (err) {
      // Put the batch back so the next timer tick retries it, rather than
      // leaving the other instances on stale config until their TTL expires.
      for (const entry of batch) {
        const key = pendingKey(entry.scope, entry.id);
        if (!this.pending.has(key)) this.pending.set(key, entry);
      }
      this.logger.warn(`Could not publish routing cache invalidations: ${describe(err)}`);
    }
  }

  private async timerTick(): Promise<void> {
    if (this.timerPollRunning) return;
    this.timerPollRunning = true;
    try {
      // Retries any batch a failed insert put back.
      await this.flushPending();
      await this.catchUp();
      if (++this.polls % PRUNE_EVERY_POLLS === 0) await this.prune();
    } finally {
      this.timerPollRunning = false;
    }
  }

  private async poll(): Promise<void> {
    // The window is computed on the DB clock so instance clock skew cannot
    // skip rows. The first poll of a process starts from "now": its caches
    // are empty, so nothing earlier can be stale.
    const rows: FeedRow[] = await this.dataSource.query(
      `WITH clock AS (SELECT LOCALTIMESTAMP AS now)
       SELECT (clock.now - interval '${OVERLAP_SECONDS} seconds')::text AS next_since,
              c.scope, c.target_id
       FROM clock
       LEFT JOIN "cache_invalidations" c
         ON c.created_at > COALESCE($1::timestamp, clock.now)`,
      [this.since],
    );
    this.apply(rows);
    if (rows.length > 0) this.since = rows[0].next_since;
  }

  private apply(rows: FeedRow[]): void {
    const seen = new Set<string>();
    this.applyingFeed = true;
    try {
      for (const { scope, target_id } of rows) {
        if (!scope || !target_id) continue;
        const key = pendingKey(scope, target_id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (scope === 'agent') this.routingCache.invalidateAgent(target_id);
        else if (scope === 'tenant') this.routingCache.invalidateTenant(target_id);
      }
    } finally {
      this.applyingFeed = false;
    }
  }

  private async prune(): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM "cache_invalidations"
         WHERE created_at < LOCALTIMESTAMP - interval '${RETENTION_MINUTES} minutes'`,
      );
    } catch (err) {
      this.logger.warn(`Could not prune routing cache invalidations: ${describe(err)}`);
    }
  }
}

function pendingKey(scope: Scope, id: string): string {
  return `${scope}\u0000${id}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
