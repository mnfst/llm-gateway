import { MigrationInterface, QueryRunner } from 'typeorm';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';

/**
 * Partial index over the requests Autofix repaired, for the CRM metrics feed.
 *
 * `GET /api/v1/internal/crm-metrics` groups every healed request by tenant.
 * No existing `requests` index mentions `autofix_status`, so the planner fell
 * back to a sequential scan: measured on production, 7,016,836 rows discarded
 * by the filter and 845,495 shared buffers (~6.6 GB) read to return 59 rows,
 * in 2.4s. `shared_buffers` there is ~128 MB, so the damage is not the latency
 * but the eviction — one call flushes the working set of every other query.
 *
 * Healed requests are a rounding error of the table (~8.3k of 7.0M), so a
 * partial index costs almost nothing to store, and turns that scan into a read
 * of a few hundred pages.
 *
 * `tenant_id` leads because the feed needs *every* healed row (the all-time
 * count takes no time bound) grouped by tenant, and because the same index
 * then serves `WHERE tenant_id = ANY(...)`. The timestamp-leading partial
 * index added in 1795100000000 solved the opposite shape — a narrow window
 * across all tenants — where a tenant-leading key forced a scan of every error
 * row ever. Revisit if healed rows ever approach seven figures.
 *
 * `status` is INCLUDEd rather than filtered from the heap: the feed applies the
 * canonical healed predicate (`sqlIsSuccessStatus` AND retry_succeeded, per
 * request-volume.service.ts), and carrying `status` in the index keeps that
 * check off the heap. `autofix_status` itself is deliberately absent — it is
 * constant inside a partial index and would be pure waste.
 *
 * Write-path cost is negligible despite the predicate column blocking HOT
 * updates: `status` is already indexed and already flips pending -> terminal on
 * every request, so those upserts are non-HOT today regardless.
 *
 * Built CONCURRENTLY (so `transaction = false`) to avoid the ACCESS EXCLUSIVE
 * lock that deadlocks against live writes during a deploy. Budget minutes for
 * this one: two heap passes over ~6.6 GB, and it blocks autovacuum on
 * `requests` while it runs.
 *
 * `npm run migration:revert` passes `--transaction none`, so `down()` runs
 * outside a transaction as CONCURRENTLY requires. Under the default
 * transaction mode Postgres would reject the statement.
 *
 * Cloud only, mirroring 1801300000000: a self-hosted install gets no schema
 * change at all. Consequence to know about — an install that ran this while
 * self-hosted and later switches `MANIFEST_MODE=cloud` will not re-run it,
 * because TypeORM has already recorded it. The endpoint reports that state
 * explicitly (503 naming the missing index) rather than silently scanning.
 */
export class AddRequestsAutofixHealedIndex1802200000000 implements MigrationInterface {
  name = 'AddRequestsAutofixHealedIndex1802200000000';
  transaction = false;

  private static readonly INDEX = 'IDX_requests_autofix_healed';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The CRM feed is a Cloud outreach concern and its module is not even
    // registered on self-hosted, so the index would be dead weight there.
    // Skipping also spares self-hosted upgrades a CONCURRENTLY build, which
    // scans the whole `requests` table however few rows match the predicate,
    // and runs during boot where it would delay container startup.
    if (isSelfHosted()) return;

    const { INDEX } = AddRequestsAutofixHealedIndex1802200000000;
    // A cancelled CONCURRENTLY build leaves an INVALID shell that
    // `CREATE ... IF NOT EXISTS` would skip over by name, leaving the feed
    // permanently unindexed. Drop only that shell: an unconditional drop would
    // also destroy a *valid* index when a deploy is interrupted after the build
    // succeeded but before TypeORM recorded the migration, costing minutes of
    // 503s on the retry while it rebuilds.
    if (await this.indexIsInvalid(queryRunner, INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "requests" ("tenant_id", "timestamp") INCLUDE ("status") WHERE "autofix_status" = 'retry_succeeded'`,
    );
    // The planner only picks the index if it believes the predicate is
    // selective; refresh the stats it reasons from before the first read.
    await queryRunner.query(`ANALYZE "requests"`);
  }

  // Deliberately ungated, unlike up(): a database migrated in cloud mode and
  // reverted while MANIFEST_MODE=selfhosted would otherwise keep the index
  // forever. DROP ... IF EXISTS is already a no-op where it was never created.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${AddRequestsAutofixHealedIndex1802200000000.INDEX}"`,
    );
  }

  /** True when an index of this name exists but is INVALID (interrupted build). */
  private async indexIsInvalid(queryRunner: QueryRunner, indexName: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [indexName],
    );
    return rows.length > 0;
  }
}
