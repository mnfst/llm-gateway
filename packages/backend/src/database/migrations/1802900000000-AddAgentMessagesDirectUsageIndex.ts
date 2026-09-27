import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentMessagesDirectUsageIndex1802900000000 implements MigrationInterface {
  name = 'AddAgentMessagesDirectUsageIndex1802900000000';
  transaction = false;

  private static readonly INDEX = 'IDX_agent_messages_direct_usage';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { INDEX } = AddAgentMessagesDirectUsageIndex1802900000000;
    if (await this.indexIsInvalid(queryRunner, INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    }
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"
        ON "agent_messages" ("tenant_id", "agent_id", "timestamp")
        INCLUDE (
          "request_id", "status", "input_tokens", "output_tokens", "cost_usd",
          "agent_usage_rolled_up_at"
        )
        WHERE "routing_reason" = 'direct'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${AddAgentMessagesDirectUsageIndex1802900000000.INDEX}"`,
    );
  }

  private async indexIsInvalid(queryRunner: QueryRunner, indexName: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [indexName],
    );
    return rows.length > 0;
  }
}
