import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partial index over the provider attempts that still hold a request
 * recording (`recording_key IS NOT NULL`), for the nightly retention job.
 *
 * `RequestRecordingRetentionService` (`database/request-recording-retention.service.ts`)
 * selects expired recordings by `recording_key IS NOT NULL AND timestamp <
 * cutoff`. No index carries `recording_key`, so both of its SELECTs are heap
 * scans of the whole `agent_messages` table: the global-retention query scans
 * `agent_messages` alone, the plan-aware one joins `requests` on top of that
 * scan. The plan-aware query is what was measured on production on 2026-09-21
 * (its `pg_stat_statements` entry): 194 s mean, 37.8 GB of buffers per nightly
 * run, for a result of a few thousand rows. Only ~2.4 % of attempts carry a
 * recording (`pg_stats.null_frac = 0.976`), so the partial index holds
 * ~250 k entries and the job's read becomes a short range at its head.
 *
 * `timestamp` leads because every retention predicate is a `timestamp <`
 * bound and both queries `ORDER BY timestamp ASC`. `id`, `request_id` and
 * `recording_key` are INCLUDEd so the attempt side of the plan-aware query
 * (which joins `requests` only to find the tenant) can be an index-only scan.
 *
 * Write-path cost: `recording_key` is written by a follow-up UPDATE in
 * `routing/proxy/attempt-recording.service.ts`, after the attempt row is
 * INSERTed. Indexing it as both predicate and INCLUDE column makes that UPDATE
 * non-HOT, so it writes a new tuple into *every* index on `agent_messages`,
 * not only this one; the trade was taken deliberately against the nightly
 * 37.8 GB scan. Compare `n_tup_hot_upd / n_tup_upd` in `pg_stat_user_tables`
 * before and after the deploy to see what it cost.
 *
 * Built CONCURRENTLY (so `transaction = false`) to avoid the ACCESS EXCLUSIVE
 * lock that deadlocks against live writes during a deploy. Budget minutes on
 * Cloud: two heap passes over the 12 GB heap (`pg_relation_size`; 26 GB with
 * its indexes), and it blocks autovacuum on `agent_messages` while it runs.
 * Not gated on deployment mode: the retention job runs on self-hosted too,
 * where the table is small and the build is quick.
 *
 * `npm run migration:revert` passes `--transaction none`, so `down()` runs
 * outside a transaction as CONCURRENTLY requires.
 */
export class AddAgentMessagesRecordingIndex1802600000000 implements MigrationInterface {
  name = 'AddAgentMessagesRecordingIndex1802600000000';
  transaction = false;

  private static readonly INDEX = 'IDX_agent_messages_recording';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { INDEX } = AddAgentMessagesRecordingIndex1802600000000;
    // A cancelled CONCURRENTLY build leaves an INVALID shell that
    // `CREATE ... IF NOT EXISTS` would skip over by name. Drop only that shell:
    // an unconditional drop would also destroy a *valid* index when a deploy
    // is interrupted after the build succeeded but before TypeORM recorded the
    // migration, costing a full rebuild on the retry.
    if (await this.indexIsInvalid(queryRunner, INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "agent_messages" ("timestamp") INCLUDE ("id", "request_id", "recording_key") WHERE "recording_key" IS NOT NULL`,
    );
    // The planner only picks the index if it believes the predicate is
    // selective; refresh the stats it reasons from before the first read.
    await queryRunner.query(`ANALYZE "agent_messages"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${AddAgentMessagesRecordingIndex1802600000000.INDEX}"`,
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
