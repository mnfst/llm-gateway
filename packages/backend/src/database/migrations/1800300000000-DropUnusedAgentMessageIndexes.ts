import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops two indexes on `agent_messages` that no query uses.
 *
 * The table's indexes had grown to 8.3 GB against a 7.0 GB heap — 17 of them,
 * every one written on every insert, and every one rebuilt by VACUUM. Two carry
 * that cost and serve nothing:
 *
 * `IDX_agent_messages_user_id_timestamp` (715 MB, non-partial, so it is written
 * on EVERY row) indexes `user_id`, which is the deprecated attribution-only
 * column. Both this codebase and the control plane state it is never scoped on
 * — see `query-helpers.ts` ("the informational `at.user_id` column is never
 * consulted") — and neither queries it. Production confirms: 215 index scans
 * over the table's whole lifetime, against 238k on the (tenant, agent, ts)
 * index.
 *
 * `IDX_agent_messages_errors` (302 MB) is `(tenant_id, timestamp) WHERE status
 * IN (errors)`. Migration 1795100000000 added the timestamp-leading twin for
 * cross-tenant scans and kept this one "for the dashboard's tenant-scoped error
 * views". That never happened: the tenant-scoped views resolve through
 * `IDX_agent_messages_tenant_timestamp` and `IDX_agent_messages_tenant_agent_status`,
 * and this index has 3 scans over its lifetime. The cross-tenant twin
 * (`IDX_agent_messages_errors_timestamp`, 106 MB) is the one doing the work.
 *
 * Both are recreatable from the statements in `down()` if a plan regresses.
 *
 * Dropped CONCURRENTLY (so `transaction = false`) to avoid the ACCESS EXCLUSIVE
 * lock against live writes during a deploy.
 *
 * `npm run migration:revert` explicitly uses TypeORM's `--transaction none`.
 * TypeORM's undo path otherwise ignores this migration's `transaction = false`
 * and opens a transaction, which Postgres rejects for concurrent index work.
 */
export class DropUnusedAgentMessageIndexes1800300000000 implements MigrationInterface {
  name = 'DropUnusedAgentMessageIndexes1800300000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_user_id_timestamp"`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Clear any invalid leftover from an interrupted CONCURRENTLY build first:
    // `CREATE ... IF NOT EXISTS` matches on name, so it would skip over an
    // invalid index and leave it permanently unusable. Same guard migration
    // 1795100000000 applies before its concurrent build.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_user_id_timestamp"`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_user_id_timestamp" ON "agent_messages" ("user_id", "timestamp")`,
    );

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_errors" ON "agent_messages" ("tenant_id", "timestamp") WHERE "status" IN ('error', 'fallback_error', 'rate_limited')`,
    );
  }
}
