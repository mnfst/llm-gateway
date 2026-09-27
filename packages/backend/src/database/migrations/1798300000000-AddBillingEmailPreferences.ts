import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores tenant-level billing email preferences. Null/default means usage
 * alert emails remain enabled for existing tenants.
 */
export class AddBillingEmailPreferences1798300000000 implements MigrationInterface {
  name = 'AddBillingEmailPreferences1798300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_email_preferences" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN IF EXISTS "billing_email_preferences"`,
    );
  }
}
