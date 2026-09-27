import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Timestamp-leading partial index over error rows, for CROSS-TENANT error scans
 * by time window (the Manifest Cloud control plane's hourly error-insights
 * rollup: `WHERE timestamp >= $1 AND timestamp < $2 AND status IN (errors)`,
 * with no tenant filter).
 *
 * The existing IDX_agent_messages_errors is `(tenant_id, timestamp) WHERE
 * status IN (...)` — tenant-leading, so a tenant-less time-window query can't
 * range-scan it and instead scans EVERY error row ever recorded (cost grows with
 * total accumulated errors). Measured on ~2M error rows: 110ms / 29k buffers,
 * and it only gets worse as errors pile up — this was the source of multi-minute
 * (up to ~5h) scans saturating the prod DB. This timestamp-leading copy turns it
 * into a windowed range scan (2ms / 274 buffers, constant in total errors).
 *
 * Kept partial (errors are a small fraction of rows) so the write-amplification
 * on the hot ingest path stays negligible. The per-tenant IDX_agent_messages_errors
 * stays for the dashboard's tenant-scoped error views.
 *
 * Built CONCURRENTLY (so `transaction = false`) to avoid the ACCESS EXCLUSIVE
 * lock that deadlocks against live writes during a deploy.
 */
export class AddCrossTenantErrorTimestampIndex1795100000000 implements MigrationInterface {
  name = 'AddCrossTenantErrorTimestampIndex1795100000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Clear any invalid leftover from an interrupted CONCURRENTLY build, since
    // CREATE ... IF NOT EXISTS would otherwise skip over an invalid index.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors_timestamp"`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_errors_timestamp" ON "agent_messages" ("timestamp") WHERE "status" IN ('error', 'fallback_error', 'rate_limited')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors_timestamp"`,
    );
  }
}
