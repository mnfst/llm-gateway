import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentUsageDaily1802800000000 implements MigrationInterface {
  name = 'AddAgentUsageDaily1802800000000';
  transaction = false;

  private static readonly REQUEST_INDEX = 'IDX_requests_agent_usage_pending';
  private static readonly ATTEMPT_INDEX = 'IDX_agent_messages_agent_usage_pending';
  private static readonly READ_INDEX = 'IDX_agent_usage_daily_tenant_day';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '1s'`);
    try {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "agent_usage_daily" (
          "tenant_id" varchar NOT NULL,
          "agent_id" varchar NOT NULL,
          "day" date NOT NULL,
          "request_count" bigint NOT NULL DEFAULT 0,
          "successful_request_count" bigint NOT NULL DEFAULT 0,
          "failed_request_count" bigint NOT NULL DEFAULT 0,
          "input_tokens" bigint NOT NULL DEFAULT 0,
          "output_tokens" bigint NOT NULL DEFAULT 0,
          "cost_usd" numeric(20, 8) NOT NULL DEFAULT 0,
          "last_active_at" timestamp NULL,
          "updated_at" timestamp NOT NULL DEFAULT NOW(),
          CONSTRAINT "PK_agent_usage_daily" PRIMARY KEY ("tenant_id", "agent_id", "day"),
          CONSTRAINT "FK_agent_usage_daily_agent"
            FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE
        )
      `);
      await queryRunner.query(`
        ALTER TABLE "requests"
          ADD COLUMN IF NOT EXISTS "agent_usage_rolled_up_at" timestamp NULL
      `);
      await queryRunner.query(`
        ALTER TABLE "agent_messages"
          ADD COLUMN IF NOT EXISTS "agent_usage_rolled_up_at" timestamp NULL
      `);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }

    const { REQUEST_INDEX, ATTEMPT_INDEX, READ_INDEX } = AddAgentUsageDaily1802800000000;
    for (const index of [REQUEST_INDEX, ATTEMPT_INDEX, READ_INDEX]) {
      if (await this.indexIsInvalid(queryRunner, index)) {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
      }
    }
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "${REQUEST_INDEX}"
        ON "requests" ("timestamp", "id")
        WHERE "agent_usage_rolled_up_at" IS NULL
          AND ("status" IS NULL OR "status" NOT IN ('pending', 'cancelled'))
          AND "tenant_id" IS NOT NULL
          AND "agent_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "${ATTEMPT_INDEX}"
        ON "agent_messages" ("timestamp", "id")
        WHERE "agent_usage_rolled_up_at" IS NULL
          AND ("status" IS NULL OR "status" NOT IN ('pending', 'cancelled'))
          AND "tenant_id" IS NOT NULL
          AND "agent_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "${READ_INDEX}"
        ON "agent_usage_daily" ("tenant_id", "day")
    `);
    await queryRunner.query(`ANALYZE "requests"`);
    await queryRunner.query(`ANALYZE "agent_messages"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { REQUEST_INDEX, ATTEMPT_INDEX, READ_INDEX } = AddAgentUsageDaily1802800000000;
    for (const index of [REQUEST_INDEX, ATTEMPT_INDEX, READ_INDEX]) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
    }
    await queryRunner.query(`SET lock_timeout = '1s'`);
    try {
      await queryRunner.query(
        `ALTER TABLE "requests" DROP COLUMN IF EXISTS "agent_usage_rolled_up_at"`,
      );
      await queryRunner.query(
        `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "agent_usage_rolled_up_at"`,
      );
      await queryRunner.query(`DROP TABLE IF EXISTS "agent_usage_daily"`);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  private async indexIsInvalid(queryRunner: QueryRunner, indexName: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [indexName],
    );
    return rows.length > 0;
  }
}
