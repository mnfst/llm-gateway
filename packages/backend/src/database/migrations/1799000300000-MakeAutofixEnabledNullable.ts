import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `agents.autofix_enabled` nullable so NULL can mean "no explicit choice —
 * inherit the deployment-mode default" (Autofix defaults ON in cloud, OFF in
 * self-hosted; resolved at read time in AutofixService). The column previously
 * defaulted to a blanket `false`, which cannot express a mode-dependent default.
 *
 * Existing rows still holding that blanket `false` are reset to NULL so they
 * inherit the mode default too — pre-feature `false` was never a user choice
 * (the toggle shipped in the same feature branch). Rows explicitly set to `true`
 * are left untouched.
 */
export class MakeAutofixEnabledNullable1799000300000 implements MigrationInterface {
  name = 'MakeAutofixEnabledNullable1799000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "autofix_enabled" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "autofix_enabled" DROP NOT NULL`);
    await queryRunner.query(
      `UPDATE "agents" SET "autofix_enabled" = NULL WHERE "autofix_enabled" = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // NULL meant "inherit default"; the pre-migration column had no NULLs, so
    // collapse them back to the old blanket false before restoring the constraint.
    await queryRunner.query(
      `UPDATE "agents" SET "autofix_enabled" = false WHERE "autofix_enabled" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ALTER COLUMN "autofix_enabled" SET DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "autofix_enabled" SET NOT NULL`);
  }
}
