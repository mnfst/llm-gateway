import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tightens autovacuum/autoanalyze on agent_messages.
 *
 * agent_messages is the highest-churn table (millions of rows, continuous
 * inserts from the proxy). With Postgres defaults (vacuum_scale_factor 0.2)
 * autovacuum only fires after ~20% of the table changes, so on a multi-million
 * row table the visibility map goes stale for days. Stale VM turns the covering
 * "index-only" scans the dashboard relies on into hundreds of thousands of heap
 * fetches (measured: 223k heap fetches on a 312k-row index-only scan), which is
 * a large part of the post-scale dashboard latency.
 *
 * Lower scale factors keep the VM fresh so index-only scans stay index-only.
 * autovacuum_vacuum_insert_scale_factor (PG13+) is the important one here: it
 * triggers a vacuum after enough *inserts*, which is what sets the VM on an
 * insert-mostly table. Storage-parameter changes are cheap metadata updates and
 * run inside the migration transaction.
 */
export class TuneAgentMessagesAutovacuum1792900000000 implements MigrationInterface {
  name = 'TuneAgentMessagesAutovacuum1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" SET (
        autovacuum_vacuum_scale_factor = 0.02,
        autovacuum_analyze_scale_factor = 0.01,
        autovacuum_vacuum_insert_scale_factor = 0.02
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" RESET (
        autovacuum_vacuum_scale_factor,
        autovacuum_analyze_scale_factor,
        autovacuum_vacuum_insert_scale_factor
      )`,
    );
  }
}
