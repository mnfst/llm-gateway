import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PKCE (RFC 7636) challenge for the CLI browser login. Nullable because the
 * table can be migrated while short-lived codes are still outstanding; the
 * exchange path fails closed on a row that has no challenge, so a legacy code
 * cannot be redeemed without the verifier.
 */
export class AddCliAuthCodeChallenge1801730000000 implements MigrationInterface {
  name = 'AddCliAuthCodeChallenge1801730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(
        `ALTER TABLE "cli_auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge" character varying(128)`,
      );
      await queryRunner.query(
        `ALTER TABLE "cli_auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge_method" character varying(10)`,
      );
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await queryRunner.query(
        `ALTER TABLE "cli_auth_codes" DROP COLUMN IF EXISTS "code_challenge_method"`,
      );
      await queryRunner.query(
        `ALTER TABLE "cli_auth_codes" DROP COLUMN IF EXISTS "code_challenge"`,
      );
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
