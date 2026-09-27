import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the per-agent Autofix opt-in toggle to the `agents` table:
 * - `autofix_enabled` — opt-in toggle (default off).
 */
export class AddAutofixAgentFlags1799000010000 implements MigrationInterface {
  name = 'AddAutofixAgentFlags1799000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN "autofix_enabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "autofix_enabled"`);
  }
}
