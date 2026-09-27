import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Renames `autofix_waitlist_signups` → `waitlist_claims` and
 * `signed_up_at` → `claimed_at` for clarity.
 */
export class RenameWaitlistClaimsTable1800000000000 implements MigrationInterface {
  name = 'RenameWaitlistClaimsTable1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "autofix_waitlist_signups" RENAME TO "waitlist_claims"`);
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME COLUMN "signed_up_at" TO "claimed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME CONSTRAINT "PK_autofix_waitlist_signups" TO "PK_waitlist_claims"`,
    );
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME CONSTRAINT "UQ_autofix_waitlist_signups_email" TO "UQ_waitlist_claims_email"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME CONSTRAINT "UQ_waitlist_claims_email" TO "UQ_autofix_waitlist_signups_email"`,
    );
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME CONSTRAINT "PK_waitlist_claims" TO "PK_autofix_waitlist_signups"`,
    );
    await queryRunner.query(
      `ALTER TABLE "waitlist_claims" RENAME COLUMN "claimed_at" TO "signed_up_at"`,
    );
    await queryRunner.query(`ALTER TABLE "waitlist_claims" RENAME TO "autofix_waitlist_signups"`);
  }
}
