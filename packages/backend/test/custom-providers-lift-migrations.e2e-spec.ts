import { DataSource } from 'typeorm';
import { LiftCustomProvidersToUserLevel1791200000000 } from '../src/database/migrations/1791200000000-LiftCustomProvidersToUserLevel';
import { RenameProviderAccessToEnabledProviders1791800000000 } from '../src/database/migrations/1791800000000-RenameProviderAccessToEnabledProviders';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from '../src/database/migrations/1792600000000-TenantScopedConfigs';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

/**
 * Runs the REAL migration chain (synchronize:false) so LiftCustomProvidersToUserLevel
 * actually executes against Postgres — the e2e suite uses synchronize:true, which
 * never runs migrations, so a broken lift (bad SQL, or a unique index that doesn't
 * enforce) would otherwise go unnoticed until production.
 */
describe('LiftCustomProvidersToUserLevel under migration-built schema (e2e)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ??
        'postgresql://myuser:mypassword@localhost:5432/manifest_duprepro',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('drops the agent_id column from custom_providers and re-scopes it to the tenant', async () => {
    const cols: { column_name: string }[] = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'custom_providers'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('agent_id');
    expect(names).not.toContain('user_id');
    expect(names).toContain('tenant_id');
    expect(names).toContain('created_by_user_id');
  });

  it('enforces the tenant-scoped unique index on (tenant_id, LOWER(name))', async () => {
    await ds.query(
      `INSERT INTO "custom_providers" ("id","tenant_id","name","base_url","api_kind","models","created_at")
       VALUES ('cpm-1','t-1','My Provider','https://a.example.com/v1','openai','[]', now())`,
    );
    // Same tenant, case-insensitively equal name → must collide.
    await expect(
      ds.query(
        `INSERT INTO "custom_providers" ("id","tenant_id","name","base_url","api_kind","models","created_at")
         VALUES ('cpm-2','t-1','my provider','https://b.example.com/v1','openai','[]', now())`,
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('allows the same name under a different tenant', async () => {
    await expect(
      ds.query(
        `INSERT INTO "custom_providers" ("id","tenant_id","name","base_url","api_kind","models","created_at")
         VALUES ('cpm-3','t-2','My Provider','https://c.example.com/v1','openai','[]', now())`,
      ),
    ).resolves.toBeDefined();
  });
});

/**
 * Real-data test for the migration's relabel + grant backfill. Builds the
 * migrated schema, reverts JUST this migration (down → pre-lift schema with
 * agent_id), seeds a realistic pre-lift dataset, then runs up() and asserts the
 * data transformation. This is the part string-inspection specs can't catch.
 */
describe('LiftCustomProvidersToUserLevel data transformation (e2e)', () => {
  let ds: DataSource;
  const migration = new LiftCustomProvidersToUserLevel1791200000000();

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ??
        'postgresql://myuser:mypassword@localhost:5432/manifest_duprepro',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    // Revert the later tenant re-scoping + table renames first (newest first)
    // so this historical migration can be replayed against the schema naming
    // it expects (user_providers / agent_provider_access / user_id columns).
    const requestSchemaQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().down(requestSchemaQr);
    await requestSchemaQr.release();
    const tenantConfigsQr = ds.createQueryRunner();
    await new TenantScopedConfigs1792600000000().down(tenantConfigsQr);
    await tenantConfigsQr.release();
    const tenantProvidersQr = ds.createQueryRunner();
    await new TenantProviders1792500000000().down(tenantProvidersQr);
    await tenantProvidersQr.release();
    const renameQr = ds.createQueryRunner();
    await new RenameProviderAccessToEnabledProviders1791800000000().down(renameQr);
    await renameQr.release();

    // Revert just this migration to get the pre-lift schema (agent_id back).
    const revertQr = ds.createQueryRunner();
    await migration.down(revertQr);
    await revertQr.release();

    // Pre-lift seed for user "cu-1": tenant + 3 agents.
    await ds.query(`DELETE FROM "agent_provider_access"`);
    await ds.query(`DELETE FROM "user_providers"`);
    await ds.query(`DELETE FROM "custom_providers"`);
    await ds.query(`DELETE FROM "agents"`);
    await ds.query(`DELETE FROM "tenants"`);
    await ds.query(
      `INSERT INTO "tenants" ("id","name","owner_user_id","is_active") VALUES ('t1','cu-1','cu-1',true)`,
    );
    for (const a of ['a1', 'a2', 'a3']) {
      await ds.query(
        `INSERT INTO "agents" ("id","name","tenant_id") VALUES ($1,$1,'t1')`,
        [a],
      );
    }
    // cp1 (agent a1) and cp2 (agent a2) collide on name "Groq". cp3 is literally
    // named "Groq [cp2]" — the suffix cp2 would naively pick — forcing the
    // collision-safe path to choose "Groq [cp2-1]".
    const cps: [string, string, string][] = [
      ['cp1', 'a1', 'Groq'],
      ['cp2', 'a2', 'Groq'],
      ['cp3', 'a1', 'Groq [cp2]'],
    ];
    for (const [id, agentId, name] of cps) {
      await ds.query(
        `INSERT INTO "custom_providers" ("id","agent_id","user_id","name","base_url","api_kind","models","created_at")
         VALUES ($1,$2,'cu-1',$3,'https://x.example.com/v1','openai','[]', now())`,
        [id, agentId, name],
      );
      // Companion user_providers row, plus the single pre-lift grant (original agent only).
      await ds.query(
        `INSERT INTO "user_providers" ("id","user_id","agent_id","provider","auth_type","label","priority","is_active","connected_at","updated_at")
         VALUES ($1,'cu-1',$2,$3,'api_key','Default',0,true, now(), now())`,
        [`up-${id}`, agentId, `custom:${id}`],
      );
      await ds.query(
        `INSERT INTO "agent_provider_access" ("agent_id","user_provider_id") VALUES ($1,$2)`,
        [agentId, `up-${id}`],
      );
    }

    const upQr = ds.createQueryRunner();
    await migration.up(upQr);
    await upQr.release();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('relabels colliding names without hitting a pre-existing name', async () => {
    const rows: { id: string; name: string }[] = await ds.query(
      `SELECT "id","name" FROM "custom_providers" ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.name]));
    expect(byId['cp1']).toBe('Groq'); // kept (first in its group)
    expect(byId['cp3']).toBe('Groq [cp2]'); // untouched (distinct name)
    expect(byId['cp2']).toBe('Groq [cp2-1]'); // collision-safe suffix, NOT 'Groq [cp2]'
    // All names unique within the user → the unique index held.
    expect(new Set(rows.map((r) => r.name)).size).toBe(3);
  });

  it('backfills grants so every custom provider is usable on all of the user owner’s agents', async () => {
    for (const id of ['cp1', 'cp2', 'cp3']) {
      const grants: { agent_id: string }[] = await ds.query(
        `SELECT "agent_id" FROM "agent_provider_access" WHERE "user_provider_id" = $1 ORDER BY "agent_id"`,
        [`up-${id}`],
      );
      expect(grants.map((g) => g.agent_id)).toEqual(['a1', 'a2', 'a3']);
    }
  });
});
