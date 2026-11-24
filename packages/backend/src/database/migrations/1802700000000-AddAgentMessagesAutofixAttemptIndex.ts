import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index Provider Attempts that were part of an Autofix retry.
 *
 * The Requests log filters recovery attempts with a correlated lookup by
 * `request_id` and `autofix_applied`. The ordinary request-id index finds every
 * attempt for each parent before it can discard non-Autofix rows. This partial
 * index contains only the attempts that satisfy the filter, preserving its
 * semantics when a failed Autofix retry is followed by a successful fallback.
 *
 * The index is deliberately keyed only by request_id because request ids are
 * globally unique and the correlated lookup already supplies that value.
 *
 * Build concurrently so live Provider Attempt inserts continue during deploy.
 * The Requests log runs on self-hosted installs too, so do not gate it by mode.
 */
export class AddAgentMessagesAutofixAttemptIndex1802700000000 implements MigrationInterface {
  name = 'AddAgentMessagesAutofixAttemptIndex1802700000000';
  transaction = false;

  private static readonly INDEX = 'IDX_agent_messages_autofix_request';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { INDEX } = AddAgentMessagesAutofixAttemptIndex1802700000000;
    // A cancelled CONCURRENTLY build leaves an INVALID shell that
    // `CREATE ... IF NOT EXISTS` would skip over by name. Drop only that shell:
    // an unconditional drop would also destroy a valid index after a successful
    // build but before TypeORM records the migration, requiring a full rebuild.
    if (await this.indexIsInvalid(queryRunner, INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}" ON "agent_messages" ("request_id") WHERE "autofix_applied" = true`,
    );
    await queryRunner.query(`ANALYZE "agent_messages"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${AddAgentMessagesAutofixAttemptIndex1802700000000.INDEX}"`,
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
