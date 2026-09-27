import { DataSource } from 'typeorm';
import { AddCustomProviderFkToUserProviders1792100000000 } from '../src/database/migrations/1792100000000-AddCustomProviderFkToUserProviders';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from '../src/database/migrations/1792600000000-TenantScopedConfigs';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

/**
 * The tenant-canonical chain (which runs AFTER the migration under test) renames
 * user_providers → tenant_providers + its FK/index (TenantProviders) and demotes
 * custom_providers.user_id → created_by_user_id (TenantScopedConfigs). These
 * specs assert + seed under the ORIGINAL user_providers / custom_providers.user_id
 * names, so revert those later migrations (newest first) before exercising
 * this migration's own behaviour.
 */
async function revertTenantCanonicalScoping(ds: DataSource): Promise<void> {
  const requestSchemaQr = ds.createQueryRunner();
  await new AddRequestsAndProviderAttempts1801000000000().down(requestSchemaQr);
  await requestSchemaQr.release();
  const configsQr = ds.createQueryRunner();
  await new TenantScopedConfigs1792600000000().down(configsQr);
  await configsQr.release();
  const providersQr = ds.createQueryRunner();
  await new TenantProviders1792500000000().down(providersQr);
  await providersQr.release();
}

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
 * Runs the REAL migration chain (synchronize:false) so
 * AddCustomProviderFkToUserProviders actually executes against Postgres —
 * the e2e suite uses synchronize:true, which never runs migrations, so a
 * broken generated column or an FK that doesn't enforce would otherwise go
 * unnoticed until production.
 */
describe('AddCustomProviderFkToUserProviders schema (e2e)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    await revertTenantCanonicalScoping(ds);
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('adds custom_provider_id as a STORED generated column', async () => {
    const cols: { column_name: string; is_generated: string }[] = await ds.query(
      `SELECT column_name, is_generated FROM information_schema.columns
        WHERE table_name = 'user_providers' AND column_name = 'custom_provider_id'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].is_generated).toBe('ALWAYS');
  });

  it('wires the FK to custom_providers with ON DELETE CASCADE', async () => {
    const fks: { confdeltype: string }[] = await ds.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'FK_user_providers_custom_provider'
          AND conrelid = '"user_providers"'::regclass
          AND confrelid = '"custom_providers"'::regclass`,
    );
    expect(fks).toHaveLength(1);
    expect(fks[0].confdeltype).toBe('c'); // c = CASCADE
  });

  it('creates the partial index on the referencing column', async () => {
    const idx: { indexname: string }[] = await ds.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'user_providers'
          AND indexname = 'IDX_user_providers_custom_provider_id'`,
    );
    expect(idx).toHaveLength(1);
  });
});

/**
 * Real-data test: seeds a pre-migration dataset (valid companion rows, an
 * orphan, plain providers), runs up(), and proves that every reachable row
 * survives byte-for-byte while only the unresolvable orphan is removed.
 * Then exercises the live FK: orphan inserts rejected, cascade on delete.
 */
describe('AddCustomProviderFkToUserProviders data preservation (e2e)', () => {
  let ds: DataSource;
  const migration = new AddCustomProviderFkToUserProviders1792100000000();

  beforeAll(async () => {
    ds = makeDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    // Undo the later user_providers → tenant_providers rename so this migration
    // can be exercised against the user_providers schema it was authored for.
    await revertTenantCanonicalScoping(ds);

    // Revert just this migration to get the pre-FK schema, then seed the
    // exact half-states the FK is meant to govern.
    const revertQr = ds.createQueryRunner();
    await migration.down(revertQr);
    await revertQr.release();

    await ds.query(`DELETE FROM "agent_enabled_providers"`);
    await ds.query(`DELETE FROM "user_providers"`);
    await ds.query(`DELETE FROM "custom_providers"`);

    await ds.query(
      `INSERT INTO "custom_providers" ("id","user_id","name","base_url","api_kind","models","created_at")
       VALUES ('cp-alive','u-1','My Server','https://llm.example.com/v1','openai','[]', now())`,
    );
    // Valid companion row — must survive the migration untouched.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","key_prefix","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-alive','u-1','custom:cp-alive','enc-blob-1','sk-alive','api_key','Default',0,true, now(), now())`,
    );
    // Orphan companion — its custom provider was deleted long ago. The
    // migration must remove it (it is unresolvable and blocks the FK).
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-orphan','u-1','custom:gone-forever','enc-blob-2','api_key','Default',0,false, now(), now())`,
    );
    // Plain providers — completely out of scope, must survive untouched.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('up-plain','u-1','anthropic','enc-blob-3','api_key','Default',0,true, now(), now()),
              ('up-plain-2','u-2','openai','enc-blob-4','subscription','Work',1,false, now(), now())`,
    );

    const upQr = ds.createQueryRunner();
    await migration.up(upQr);
    await upQr.release();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('preserves the valid companion row byte-for-byte and computes its custom_provider_id', async () => {
    const rows: Record<string, unknown>[] = await ds.query(
      `SELECT "id","user_id","provider","api_key_encrypted","key_prefix","auth_type","label","priority","is_active","custom_provider_id"
         FROM "user_providers" WHERE "id" = 'up-alive'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'u-1',
      provider: 'custom:cp-alive',
      api_key_encrypted: 'enc-blob-1',
      key_prefix: 'sk-alive',
      auth_type: 'api_key',
      label: 'Default',
      priority: 0,
      is_active: true,
      custom_provider_id: 'cp-alive',
    });
  });

  it('preserves plain provider rows untouched, with a NULL custom_provider_id', async () => {
    const rows: Record<string, unknown>[] = await ds.query(
      `SELECT "id","provider","api_key_encrypted","auth_type","label","custom_provider_id"
         FROM "user_providers" WHERE "id" IN ('up-plain','up-plain-2') ORDER BY "id"`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      api_key_encrypted: 'enc-blob-3',
      custom_provider_id: null,
    });
    expect(rows[1]).toMatchObject({
      provider: 'openai',
      auth_type: 'subscription',
      label: 'Work',
      custom_provider_id: null,
    });
  });

  it('removes only the unresolvable orphan companion row', async () => {
    const orphans: { id: string }[] = await ds.query(
      `SELECT "id" FROM "user_providers" WHERE "id" = 'up-orphan'`,
    );
    expect(orphans).toHaveLength(0);
    // Total sanity check: exactly the three reachable rows remain.
    const all: { id: string }[] = await ds.query(
      `SELECT "id" FROM "user_providers" ORDER BY "id"`,
    );
    expect(all.map((r) => r.id)).toEqual(['up-alive', 'up-plain', 'up-plain-2']);
  });

  it('rejects inserting a companion row for a custom provider that does not exist', async () => {
    await expect(
      ds.query(
        `INSERT INTO "user_providers"
           ("id","user_id","provider","auth_type","label","priority","is_active","connected_at","updated_at")
         VALUES ('up-bad','u-1','custom:never-existed','api_key','Default',0,true, now(), now())`,
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('cascade-deletes the companion row when the custom provider is deleted — plain rows untouched', async () => {
    await ds.query(`DELETE FROM "custom_providers" WHERE "id" = 'cp-alive'`);
    const all: { id: string }[] = await ds.query(
      `SELECT "id" FROM "user_providers" ORDER BY "id"`,
    );
    expect(all.map((r) => r.id)).toEqual(['up-plain', 'up-plain-2']);
  });

  it('down() drops the generated column without touching the remaining rows', async () => {
    const downQr = ds.createQueryRunner();
    await migration.down(downQr);
    await downQr.release();

    const cols: { column_name: string }[] = await ds.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'user_providers' AND column_name = 'custom_provider_id'`,
    );
    expect(cols).toHaveLength(0);

    const all: { id: string; api_key_encrypted: string }[] = await ds.query(
      `SELECT "id","api_key_encrypted" FROM "user_providers" ORDER BY "id"`,
    );
    expect(all.map((r) => r.id)).toEqual(['up-plain', 'up-plain-2']);
    expect(all[0].api_key_encrypted).toBe('enc-blob-3');
  });
});
