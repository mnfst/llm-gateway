import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `autofix_phoenix` to `agent_messages` — Phoenix's own identifiers for the
 * heal decision behind an Autofix row ({ issueId, patchId, healAttemptId }), so
 * a Manifest message can be cross-referenced with the healing service's timeline.
 */
export class AddAutofixPhoenixIds1799000200000 implements MigrationInterface {
  name = 'AddAutofixPhoenixIds1799000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_messages" ADD COLUMN "autofix_phoenix" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN "autofix_phoenix"`);
  }
}
