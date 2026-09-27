import { DataSource } from 'typeorm';
import { AddCustomProviderFkToUserProviders1792100000000 } from '../src/database/migrations/1792100000000-AddCustomProviderFkToUserProviders';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from '../src/database/migrations/1792600000000-TenantScopedConfigs';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/manifest_duprepro';

function makeDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: DB_URL,
    entities: ['src/entities/!(*.spec).ts'],
    migrations: ['src/database/migrations/!(*.spec).ts'],
    synchronize: false,
    dropSchema: true,
    logging: false,
  });
}

/**
 * Deployment-shaped no-data-loss invariant. The migration ships to a live
 * Postgres that already holds a realistic mix of provider rows. This spec
 * snapshots the FULL contents of user_providers / custom_providers /
 * agent_enabled_providers BEFORE up() and proves up() changes NOTHING except
 * deleting the unresolvable orphans (and cascade-removing their grants).
 *
 * Edge cases seeded:
 *  - 'custom:' (empty id) → orphan, deleted (must NOT crash the generated
 *    column / FK; the cleanup DELETE removes it first — verified empirically).
 *  - inactive-but-resolvable companion (is_active=false) → must survive.
 *  - two companions for the same custom provider with different auth_type
 *    ('local' vs 'api_key') → both survive, both get the same custom_provider_id.
 *  - agent_enabled_providers grant on a survivor → survives.
 *  - agent_enabled_providers grant on a deleted orphan → cascade-removed.
 */
describe('AddCustomProviderFkToUserProviders deployment data-loss invariant (e2e)', () => {
  let ds: DataSource;
  const migration = new AddCustomProviderFkToUserProviders1792100000000();

  // The ids we expect to survive up() untouched.
  const SURVIVOR_UP_IDS = [
    'up-active', // resolvable, active, api_key
    'up-inactive', // resolvable but is_active=false — must survive
    'up-local', // same cp as up-active but auth_type='local'
    'up-plain', // non-custom provider, out of scope
  ];
  // The ids we expect up() to delete.
  const ORPHAN_UP_IDS = ['up-empty', 'up-gone'];

  let beforeUserProviders: Record<string, unknown>[];
  let beforeCustomProviders: Record<string, unknown>[];
  let beforeAccessSurvivors: Record<string, unknown>[];

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    const requestSchemaQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().down(requestSchemaQr);
    await requestSchemaQr.release();

    // The tenant-canonical chain (later migrations) renames user_providers →
    // tenant_providers and demotes custom_providers.user_id → created_by_user_id;
    // undo both (newest first) so this migration runs against the user_providers /
    // custom_providers.user_id schema it was authored for.
    const tenantConfigsQr = ds.createQueryRunner();
    await new TenantScopedConfigs1792600000000().down(tenantConfigsQr);
    await tenantConfigsQr.release();
    const tenantRenameQr = ds.createQueryRunner();
    await new TenantProviders1792500000000().down(tenantRenameQr);
    await tenantRenameQr.release();

    // Revert just this migration so we seed the realistic pre-FK schema.
    const revertQr = ds.createQueryRunner();
    await migration.down(revertQr);
    await revertQr.release();

    await ds.query(`DELETE FROM "agent_enabled_providers"`);
    await ds.query(`DELETE FROM "user_providers"`);
    await ds.query(`DELETE FROM "custom_providers"`);
    await ds.query(`DELETE FROM "agents"`);
    await ds.query(`DELETE FROM "tenants"`);

    // Tenant + agent so agent_enabled_providers grants can be seeded.
    await ds.query(`INSERT INTO "tenants" ("id","name","is_active") VALUES ('t1','u-1',true)`);
    await ds.query(`INSERT INTO "agents" ("id","name","tenant_id") VALUES ('ag-1','ag-1','t1')`);

    // One resolvable custom provider, shared by two companion rows.
    await ds.query(
      `INSERT INTO "custom_providers" ("id","user_id","name","base_url","api_kind","models","created_at")
       VALUES ('cp-live','u-1','My LLM Server','https://llm.example.com/v1','openai','[]', now())`,
    );

    // Resolvable + active companion (api_key).
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","key_prefix","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-active','u-1','custom:cp-live','enc-active','sk-act','api_key','Default',0,true, now(), now())`,
    );
    // Resolvable but INACTIVE companion — disabled by the user, still valid.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-inactive','u-1','custom:cp-live','enc-inactive','api_key','Backup',1,false, now(), now())`,
    );
    // Same custom provider, different auth_type ('local') — Ollama/LM Studio shape.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-local','u-1','custom:cp-live',NULL,'local','Local',2,true, now(), now())`,
    );
    // Plain non-custom provider — completely out of scope.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-plain','u-1','anthropic','enc-plain','api_key','Default',0,true, now(), now())`,
    );
    // Orphan: empty embedded id. Must be deleted, not crash the FK.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-empty','u-1','custom:','enc-empty','api_key','Default',0,true, now(), now())`,
    );
    // Orphan: points at a custom provider that no longer exists.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-gone','u-1','custom:vanished','enc-gone','api_key','Default',0,true, now(), now())`,
    );

    // Grants: one on a survivor (must persist), one on an orphan (must cascade).
    await ds.query(
      `INSERT INTO "agent_enabled_providers" ("agent_id","user_provider_id") VALUES ('ag-1','up-active')`,
    );
    await ds.query(
      `INSERT INTO "agent_enabled_providers" ("agent_id","user_provider_id") VALUES ('ag-1','up-gone')`,
    );

    // Snapshot the full pre-migration contents of every governed table.
    beforeUserProviders = await ds.query(
      `SELECT "id","user_id","provider","api_key_encrypted","key_prefix","auth_type","label",
              "priority","region","is_active"
         FROM "user_providers" WHERE "id" = ANY($1) ORDER BY "id"`,
      [SURVIVOR_UP_IDS],
    );
    beforeCustomProviders = await ds.query(
      `SELECT "id","user_id","name","base_url","api_kind","models" FROM "custom_providers" ORDER BY "id"`,
    );
    beforeAccessSurvivors = await ds.query(
      `SELECT "agent_id","user_provider_id" FROM "agent_enabled_providers"
         WHERE "user_provider_id" = ANY($1) ORDER BY "agent_id","user_provider_id"`,
      [SURVIVOR_UP_IDS],
    );

    const upQr = ds.createQueryRunner();
    await migration.up(upQr);
    await upQr.release();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('deletes exactly the two unresolvable orphans (including the empty-id row) and nothing else', async () => {
    const all: { id: string }[] = await ds.query(`SELECT "id" FROM "user_providers" ORDER BY "id"`);
    expect(all.map((r) => r.id)).toEqual(SURVIVOR_UP_IDS);
    for (const orphan of ORPHAN_UP_IDS) {
      const gone: { id: string }[] = await ds.query(
        `SELECT "id" FROM "user_providers" WHERE "id" = $1`,
        [orphan],
      );
      expect(gone).toHaveLength(0);
    }
  });

  it('leaves every surviving user_providers row byte-for-byte identical to its pre-migration snapshot', async () => {
    const afterUserProviders: Record<string, unknown>[] = await ds.query(
      `SELECT "id","user_id","provider","api_key_encrypted","key_prefix","auth_type","label",
              "priority","region","is_active"
         FROM "user_providers" WHERE "id" = ANY($1) ORDER BY "id"`,
      [SURVIVOR_UP_IDS],
    );
    // Whole-table content snapshot: the migration must mutate no existing column.
    expect(afterUserProviders).toEqual(beforeUserProviders);
  });

  it('leaves the custom_providers table entirely untouched', async () => {
    const afterCustomProviders: Record<string, unknown>[] = await ds.query(
      `SELECT "id","user_id","name","base_url","api_kind","models" FROM "custom_providers" ORDER BY "id"`,
    );
    expect(afterCustomProviders).toEqual(beforeCustomProviders);
  });

  it('computes the same custom_provider_id for every resolvable companion regardless of auth_type / is_active', async () => {
    const rows: { id: string; custom_provider_id: string | null }[] = await ds.query(
      `SELECT "id","custom_provider_id" FROM "user_providers"
         WHERE "id" IN ('up-active','up-inactive','up-local','up-plain') ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.custom_provider_id]));
    // All three companions of cp-live resolve to the same id — active, inactive,
    // and local alike — proving the generated column ignores row state.
    expect(byId['up-active']).toBe('cp-live');
    expect(byId['up-inactive']).toBe('cp-live');
    expect(byId['up-local']).toBe('cp-live');
    // The plain provider carries a NULL generated id.
    expect(byId['up-plain']).toBeNull();
  });

  it('preserves the grant attached to a surviving companion row', async () => {
    const afterAccessSurvivors: Record<string, unknown>[] = await ds.query(
      `SELECT "agent_id","user_provider_id" FROM "agent_enabled_providers"
         WHERE "user_provider_id" = ANY($1) ORDER BY "agent_id","user_provider_id"`,
      [SURVIVOR_UP_IDS],
    );
    expect(afterAccessSurvivors).toEqual(beforeAccessSurvivors);
    expect(afterAccessSurvivors).toEqual([{ agent_id: 'ag-1', user_provider_id: 'up-active' }]);
  });

  it('cascade-removes the grant that pointed at a deleted orphan companion', async () => {
    const orphanGrants: { user_provider_id: string }[] = await ds.query(
      `SELECT "user_provider_id" FROM "agent_enabled_providers" WHERE "user_provider_id" = 'up-gone'`,
    );
    expect(orphanGrants).toHaveLength(0);
    // The only grant left is the survivor's — no dangling references remain.
    const allGrants: { user_provider_id: string }[] = await ds.query(
      `SELECT "user_provider_id" FROM "agent_enabled_providers" ORDER BY "user_provider_id"`,
    );
    expect(allGrants.map((g) => g.user_provider_id)).toEqual(['up-active']);
  });

  it('deleting the shared custom provider cascade-removes all of its companions at once', async () => {
    await ds.query(`DELETE FROM "custom_providers" WHERE "id" = 'cp-live'`);
    const all: { id: string }[] = await ds.query(`SELECT "id" FROM "user_providers" ORDER BY "id"`);
    // up-active / up-inactive / up-local all reference cp-live → all cascade.
    // Only the plain provider remains.
    expect(all.map((r) => r.id)).toEqual(['up-plain']);
  });
});
