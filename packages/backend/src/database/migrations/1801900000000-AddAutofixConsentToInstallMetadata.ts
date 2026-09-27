import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the once-per-install Autofix consent for self-hosted installs.
 *
 * `install_metadata` is the existing singleton row telemetry already uses, so
 * consent-once is one nullable column on an existing table — no new table, no
 * new entity. When set, the self-hosted consent modal never shows again.
 * Cloud never writes it (and never consults it).
 */
export class AddAutofixConsentToInstallMetadata1801900000000 implements MigrationInterface {
  name = 'AddAutofixConsentToInstallMetadata1801900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Catalog-only, but takes ACCESS EXCLUSIVE — bound the wait so a deploy
    // queues behind a long read instead of blocking the table indefinitely.
    // Plain `timestamp` matches the rest of install_metadata (timestampType()).
    // SET LOCAL scopes the timeout to this migration's transaction, so a
    // lock-timeout failure surfaces as itself rather than being masked by a
    // subsequent RESET running inside an already-aborted transaction.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "install_metadata" ADD COLUMN IF NOT EXISTS "autofix_consented_at" timestamp DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "install_metadata" DROP COLUMN IF EXISTS "autofix_consented_at"`,
    );
  }
}
