import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an `autofix_waitlist_at` timestamp column to the `tenants` table.
 * When non-null, the tenant's owner has joined the Autofix early access
 * waitlist. The timestamp records when they signed up.
 */
export class AddAutofixWaitlist1796000000000 implements MigrationInterface {
  name = 'AddAutofixWaitlist1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN "autofix_waitlist_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN "autofix_waitlist_at"`);
  }
}
