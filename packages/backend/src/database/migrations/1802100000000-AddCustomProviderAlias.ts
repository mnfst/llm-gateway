import { MigrationInterface, QueryRunner } from 'typeorm';
import { deriveCustomProviderAlias, isReservedCustomProviderAlias } from 'manifest-shared';

/**
 * Adds `custom_providers.alias`: the public prefix of a custom provider's
 * model ids in `/v1/models` (`<alias>/<model_name>`), replacing the internal
 * `custom:<uuid>/<model_name>` key that chat clients truncate.
 *
 * Nullable — a null alias keeps publishing the internal key, which the proxy
 * accepts forever. Uniqueness is case-insensitive per tenant, as for `name`,
 * via a partial unique index that ignores null rows.
 *
 * Existing rows are backfilled from their name so every install gets readable
 * ids on upgrade. The derivation is the same one `create` uses for a default.
 * A row is skipped (alias stays null) when its name yields nothing usable, a
 * reserved or built-in provider name, or an alias another row of the same
 * tenant already took — oldest row wins, so a re-run is a no-op.
 */
export class AddCustomProviderAlias1802100000000 implements MigrationInterface {
  name = 'AddCustomProviderAlias1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "custom_providers" ADD COLUMN IF NOT EXISTS "alias" varchar`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_custom_providers_tenant_alias" ON "custom_providers" ("tenant_id", LOWER("alias")) WHERE "alias" IS NOT NULL`,
    );

    const rows: { id: string; tenant_id: string; name: string; alias: string | null }[] =
      await queryRunner.query(
        `SELECT "id", "tenant_id", "name", "alias" FROM "custom_providers" ORDER BY "created_at" ASC, "id" ASC`,
      );

    const taken = new Set<string>();
    for (const row of rows) {
      if (row.alias) taken.add(`${row.tenant_id} ${row.alias.toLowerCase()}`);
    }

    for (const row of rows) {
      if (row.alias) continue;
      const alias = deriveCustomProviderAlias(row.name);
      if (!alias || isReservedCustomProviderAlias(alias)) continue;
      const key = `${row.tenant_id} ${alias}`;
      if (taken.has(key)) continue;
      taken.add(key);
      await queryRunner.query(`UPDATE "custom_providers" SET "alias" = $1 WHERE "id" = $2`, [
        alias,
        row.id,
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_custom_providers_tenant_alias"`);
    await queryRunner.query(`ALTER TABLE "custom_providers" DROP COLUMN IF EXISTS "alias"`);
  }
}
