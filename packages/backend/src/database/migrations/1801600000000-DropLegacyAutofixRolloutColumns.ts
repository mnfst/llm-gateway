import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Autofix is generally available, so tenant rollout timestamps no longer
 * affect access. Historical waitlist claims are intentionally retained until
 * their separate compatibility and data-retention window closes.
 */
export class DropLegacyAutofixRolloutColumns1801600000000 implements MigrationInterface {
  name = 'DropLegacyAutofixRolloutColumns1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(`
        ALTER TABLE "tenants"
          DROP COLUMN IF EXISTS "autofix_waitlist_at",
          DROP COLUMN IF EXISTS "autofix_access_granted_at"
      `);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(`
        ALTER TABLE "tenants"
          ADD COLUMN IF NOT EXISTS "autofix_waitlist_at" TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS "autofix_access_granted_at" TIMESTAMP WITH TIME ZONE
      `);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
