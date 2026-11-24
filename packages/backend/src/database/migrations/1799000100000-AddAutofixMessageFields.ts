import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Autofix audit to `agent_messages`. A healed request is recorded as
 * TWO rows — the failed original (`status='auto_fixed'`) and the successful
 * retry (`status='ok'`) — linked by a shared `autofix_group_id`:
 * - `autofix_applied`    — is this row part of an Autofix flow?
 * - `autofix_group_id`   — links the original ↔ retry rows (indexed for sibling lookup).
 * - `autofix_role`       — 'original' | 'retry'.
 * - `autofix_operations` — the Phoenix edits that fixed the request.
 */
export class AddAutofixMessageFields1799000100000 implements MigrationInterface {
  name = 'AddAutofixMessageFields1799000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN "autofix_applied" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN "autofix_group_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN "autofix_role" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "agent_messages" ADD COLUMN "autofix_operations" jsonb`);
    // Partial index: only Autofix rows carry a non-NULL `autofix_group_id`, and
    // the sole reader is the sibling lookup (original ↔ retry). Excluding the NULL
    // majority keeps the index tiny and off the write path for normal messages.
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_messages_autofix_group" ON "agent_messages" ("tenant_id", "autofix_group_id") WHERE "autofix_group_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_agent_messages_autofix_group"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN "autofix_operations"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN "autofix_role"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN "autofix_group_id"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN "autofix_applied"`);
  }
}
