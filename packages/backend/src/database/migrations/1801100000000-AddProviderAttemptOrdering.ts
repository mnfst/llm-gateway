import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds explicit provider-call order without rewriting the historical hot table.
 * Live writers populate the column immediately; the request backfill assigns it
 * only where the legacy chain has an unambiguous order.
 */
export class AddProviderAttemptOrdering1801100000000 implements MigrationInterface {
  name = 'AddProviderAttemptOrdering1801100000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await this.addAttemptOrdering(queryRunner);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  private async addAttemptOrdering(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "attempt_number" integer`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_agent_messages_attempt_number_positive'
            AND conrelid = 'agent_messages'::regclass
        ) THEN
          ALTER TABLE "agent_messages"
            ADD CONSTRAINT "CHK_agent_messages_attempt_number_positive"
            CHECK ("attempt_number" IS NULL OR "attempt_number" > 0) NOT VALID;
        END IF;
      END $$
    `);

    const indexes = (await queryRunner.query(`
      SELECT i.indisvalid AS valid,
             pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'UQ_agent_messages_request_attempt_number'
        AND i.indrelid = 'agent_messages'::regclass
    `)) as Array<{ valid: boolean; definition: string }>;
    const expected = '(request_id, attempt_number)';
    if (indexes[0] && (!indexes[0].valid || !indexes[0].definition.includes(expected))) {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "UQ_agent_messages_request_attempt_number"`,
      );
    }
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
        "UQ_agent_messages_request_attempt_number"
      ON "agent_messages" ("request_id", "attempt_number")
      WHERE "request_id" IS NOT NULL AND "attempt_number" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "UQ_agent_messages_request_attempt_number"`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_messages"
      DROP CONSTRAINT IF EXISTS "CHK_agent_messages_attempt_number_positive"
    `);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "attempt_number"`);
  }
}
