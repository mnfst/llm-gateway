import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partial index over the unlinked provider attempts (`request_id IS NULL`),
 * for the Overview and Autofix analytics.
 *
 * Every request-level dashboard query still carries a compatibility arm for
 * legacy attempts that were never linked to a `requests` row: the
 * request-reliability CTE (`aggregation.service.ts`), the disposition CTE
 * (`autofix-stats.service.ts`) and the timeseries request counts
 * (`timeseries-queries.service.ts`) each UNION an `agent_messages ... WHERE
 * request_id IS NULL` branch onto the `requests` branch. No index carries that
 * predicate, so the planner answers it with `IDX_agent_messages_request_id`
 * (1.4 GB, NULLs at the tail) and a bitmap over the heap. Measured on
 * production for one tenant's 7-day Overview: 22,241 unlinked rows visited
 * through ~38,000 buffers (~300 MB), twice per call, for zero matches, out of
 * the query's 145,000 buffers. The whole table holds only those ~22k unlinked
 * rows, so a partial index is a few hundred pages and turns each arm into a
 * read of a handful of them.
 *
 * `tenant_id, timestamp` is the shape of the tenant-scoped arms; `id` and
 * `status` are INCLUDEd because the reliability CTE's attempt-stats arm joins
 * unlinked rows by id with no tenant filter and reads only those two columns,
 * so it can stay on the index instead of touching the heap.
 *
 * Built CONCURRENTLY (so `transaction = false`) to avoid the ACCESS EXCLUSIVE
 * lock that deadlocks against live writes during a deploy. Budget minutes on
 * Cloud: two heap passes over the 11 GB table, and it blocks autovacuum on
 * `agent_messages` while it runs. Not gated on deployment mode: the queries it
 * serves run on self-hosted too, where the table is small and the build is
 * quick.
 *
 * `npm run migration:revert` passes `--transaction none`, so `down()` runs
 * outside a transaction as CONCURRENTLY requires.
 */
export class AddAgentMessagesUnlinkedIndex1802500000000 implements MigrationInterface {
  name = 'AddAgentMessagesUnlinkedIndex1802500000000';
  transaction = false;

  private static readonly INDEX = 'IDX_agent_messages_unlinked';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { INDEX } = AddAgentMessagesUnlinkedIndex1802500000000;
    // A cancelled CONCURRENTLY build leaves an INVALID shell that
    // `CREATE ... IF NOT EXISTS` would skip over by name. Drop only that shell:
    // an unconditional drop would also destroy a *valid* index when a deploy
    // is interrupted after the build succeeded but before TypeORM recorded the
    // migration, costing a full rebuild on the retry.
    if (await this.indexIsInvalid(queryRunner, INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "agent_messages" ("tenant_id", "timestamp") INCLUDE ("id", "status") WHERE "request_id" IS NULL`,
    );
    // The planner only picks the index if it believes the predicate is
    // selective; refresh the stats it reasons from before the first read.
    await queryRunner.query(`ANALYZE "agent_messages"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${AddAgentMessagesUnlinkedIndex1802500000000.INDEX}"`,
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
