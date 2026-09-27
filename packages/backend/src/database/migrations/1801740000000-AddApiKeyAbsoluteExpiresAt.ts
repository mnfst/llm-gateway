import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Absolute lifetime ceiling for CLI-minted PATs. The 30-day window slides on
 * every use, so without this a token in constant use would never expire; the
 * guard now refuses to renew past this instant. NULL keeps every existing
 * dashboard/CI key without a cap.
 */
export class AddApiKeyAbsoluteExpiresAt1801740000000 implements MigrationInterface {
  name = 'AddApiKeyAbsoluteExpiresAt1801740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(
        `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "absolute_expires_at" TIMESTAMP`,
      );
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "absolute_expires_at"`);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
