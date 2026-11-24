import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLI-minted management PATs expire (30-day sliding window refreshed on use);
 * NULL keeps every existing dashboard/CI key non-expiring.
 */
export class AddApiKeyExpiresAt1801700000000 implements MigrationInterface {
  name = 'AddApiKeyExpiresAt1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(
        `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP`,
      );
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "expires_at"`);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
