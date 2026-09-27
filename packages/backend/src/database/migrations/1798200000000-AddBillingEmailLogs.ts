import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores one row per billing email dedupe key. Stripe webhooks are retried and
 * usage events can race across workers, so billing emails need their own
 * idempotency ledger instead of relying on in-memory throttles.
 */
export class AddBillingEmailLogs1798200000000 implements MigrationInterface {
  name = 'AddBillingEmailLogs1798200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing_email_logs" (
        "id" varchar NOT NULL,
        "dedupe_key" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "tenant_id" varchar,
        "user_id" varchar,
        "stripe_subscription_id" varchar,
        "period_start" TIMESTAMP,
        "period_end" TIMESTAMP,
        "metadata" jsonb,
        "sent_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "PK_billing_email_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_billing_email_logs_dedupe_key" ON "billing_email_logs" ("dedupe_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_email_logs_tenant_period" ON "billing_email_logs" ("tenant_id", "period_start") WHERE "tenant_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_email_logs_tenant_period"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_email_logs_dedupe_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "billing_email_logs"`);
  }
}
