import { MigrationInterface, QueryRunner } from 'typeorm';

/** One-time codes for CLI browser login (see cli-auth-code.entity.ts). */
export class CreateCliAuthCodes1801710000000 implements MigrationInterface {
  name = 'CreateCliAuthCodes1801710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cli_auth_codes" (
        "id" character varying NOT NULL,
        "code_hash" character varying(64) NOT NULL,
        "state" character varying(128) NOT NULL,
        "tenant_id" character varying NOT NULL,
        "user_id" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_cli_auth_codes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cli_auth_codes_code_hash" ON "cli_auth_codes" ("code_hash")`,
    );
    // Every /cli/authorize sweeps expired rows; without this the sweep is a
    // full-table scan once abandoned logins accumulate.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cli_auth_codes_expires_at" ON "cli_auth_codes" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cli_auth_codes"`);
  }
}
