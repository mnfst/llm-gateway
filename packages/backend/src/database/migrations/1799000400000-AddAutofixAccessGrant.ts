import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an `autofix_access_granted_at` timestamp column to the `tenants` table.
 * When non-null, WE have explicitly hand-picked this tenant for Autofix early
 * access — it unlocks Autofix in every rollout phase (see `AUTOFIX_ROLLOUT`),
 * independent of whether the tenant joined the opt-in `autofix_waitlist_at`.
 */
export class AddAutofixAccessGrant1799000400000 implements MigrationInterface {
  name = 'AddAutofixAccessGrant1799000400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN "autofix_access_granted_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "autofix_access_granted_at"`);
  }
}
