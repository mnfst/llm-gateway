import { DataSource } from 'typeorm';
import { SeedPlaygroundAgents1791400000000 } from '../src/database/migrations/1791400000000-SeedPlaygroundAgents';
import { RenameProviderAccessToEnabledProviders1791800000000 } from '../src/database/migrations/1791800000000-RenameProviderAccessToEnabledProviders';
import { RenameIsSystemToIsPlayground1791900000000 } from '../src/database/migrations/1791900000000-RenameIsSystemToIsPlayground';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

/**
 * Runs the REAL migration chain so SeedPlaygroundAgents executes against
 * Postgres (the e2e suite uses synchronize:true and never runs migrations). We
 * revert back to the pre-seed schema (the later renames first, then the seed
 * itself), seed two tenants (one with a user agent that collides on
 * the reserved name) + their provider pools, then replay the up() migrations and
 * assert the data transformation.
 */
describe('SeedPlaygroundAgents data transformation (e2e)', () => {
  let ds: DataSource;
  const migration = new SeedPlaygroundAgents1791400000000();
  const tableRenameMigration = new RenameProviderAccessToEnabledProviders1791800000000();
  const renameMigration = new RenameIsSystemToIsPlayground1791900000000();

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

    const requestSchemaQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().down(requestSchemaQr);
    await requestSchemaQr.release();

    // Revert the later tenant re-scope first (newest first) so this historical
    // migration can be replayed against the schema naming it expects
    // (user_providers / user_provider_id, agent_provider_access, no is_playground
    // column). TenantProviders.down() restores user_providers + user_provider_id
    // and the agent_messages.tenant_provider_id → user_provider_id rename.
    const tenantProvidersQr = ds.createQueryRunner();
    await new TenantProviders1792500000000().down(tenantProvidersQr);
    await tenantProvidersQr.release();

    // Then revert back to the pre-seed schema so this historical migration can be
    // replayed against the naming it expects (agent_provider_access, no
    // is_playground column): the column rename first, then the table rename, then
    // the seed itself.
    const revertQr = ds.createQueryRunner();
    await renameMigration.down(revertQr);
    await tableRenameMigration.down(revertQr);
    await migration.down(revertQr);
    await revertQr.release();

    await ds.query(`DELETE FROM "agent_provider_access"`);
    await ds.query(`DELETE FROM "user_providers"`);
    await ds.query(`DELETE FROM "agents"`);
    await ds.query(`DELETE FROM "tenants"`);

    // Two tenants. tenants.name = user_id (pre-owner-column resolution).
    await ds.query(
      `INSERT INTO "tenants" ("id","name","owner_user_id","is_active") VALUES ('t1','u1','u1',true)`,
    );
    await ds.query(
      `INSERT INTO "tenants" ("id","name","owner_user_id","is_active") VALUES ('t2','u2','u2',true)`,
    );
    // t1 already has a user agent literally named 'Playground' → must be relabeled.
    await ds.query(
      `INSERT INTO "agents" ("id","name","display_name","tenant_id") VALUES ('a-user','Playground','Playground','t1')`,
    );
    // Provider pools: u1 has 2, u2 has 1.
    const up = (id: string, user: string, provider: string) =>
      ds.query(
        `INSERT INTO "user_providers" ("id","user_id","provider","auth_type","label","priority","is_active","connected_at","updated_at")
         VALUES ($1,$2,$3,'api_key','Default',0,true, now(), now())`,
        [id, user, provider],
      );
    await up('up1', 'u1', 'anthropic');
    await up('up2', 'u1', 'openai');
    await up('up3', 'u2', 'groq');

    const upQr = ds.createQueryRunner();
    await migration.up(upQr);
    await tableRenameMigration.up(upQr);
    await renameMigration.up(upQr);
    await upQr.release();
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('creates exactly one reserved Playground agent per tenant', async () => {
    const rows: { tenant_id: string; name: string }[] = await ds.query(
      `SELECT "tenant_id","name" FROM "agents" WHERE "is_playground" = true ORDER BY "tenant_id"`,
    );
    expect(rows).toEqual([
      { tenant_id: 't1', name: 'Playground' },
      { tenant_id: 't2', name: 'Playground' },
    ]);
  });

  it("relabels the colliding user agent instead of deleting it", async () => {
    const row: { name: string; is_playground: boolean }[] = await ds.query(
      `SELECT "name","is_playground" FROM "agents" WHERE "id" = 'a-user'`,
    );
    expect(row[0].is_playground).toBe(false);
    // Slug-safe suffix: `name-<id>` so the relabeled agent remains routable
    // via the ^[a-zA-Z0-9_-]+$ validator (no spaces or brackets).
    expect(row[0].name).toBe('Playground-a-user');
  });

  it("grants each Playground agent its tenant's whole provider pool", async () => {
    const grants: { provider: string }[] = await ds.query(
      `SELECT up."provider" FROM "agent_enabled_providers" apa
       JOIN "agents" a ON a."id" = apa."agent_id" AND a."is_playground" = true
       JOIN "user_providers" up ON up."id" = apa."user_provider_id"
       WHERE a."tenant_id" = 't1' ORDER BY up."provider"`,
    );
    expect(grants.map((g) => g.provider)).toEqual(['anthropic', 'openai']);

    const t2: { provider: string }[] = await ds.query(
      `SELECT up."provider" FROM "agent_enabled_providers" apa
       JOIN "agents" a ON a."id" = apa."agent_id" AND a."is_playground" = true
       JOIN "user_providers" up ON up."id" = apa."user_provider_id"
       WHERE a."tenant_id" = 't2'`,
    );
    expect(t2.map((g) => g.provider)).toEqual(['groq']);
  });
});
