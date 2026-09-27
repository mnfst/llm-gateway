/**
 * Real-data e2e for the tenant-canonical scoping migration chain
 * (TenantOwnerColumn → TenantProviders → TenantScopedConfigs →
 * DropUserScopeFromRouting).
 *
 * Builds the fully-migrated schema, reverts the request/attempt migration and
 * then the four tenant migrations (newest first), seeds a realistic pre-tenant
 * user-scoped dataset, then replays the chain and asserts every backfill — the
 * part string-inspection unit specs can't catch. Mirrors the replay pattern of
 * custom-providers-lift-migrations.e2e-spec.ts.
 */
import { DataSource } from 'typeorm';
import { TenantOwnerColumn1792400000000 } from '../src/database/migrations/1792400000000-TenantOwnerColumn';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from '../src/database/migrations/1792600000000-TenantScopedConfigs';
import { DropUserScopeFromRouting1792700000000 } from '../src/database/migrations/1792700000000-DropUserScopeFromRouting';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

const USER = 'mig-user-1';
const TENANT = 'mig-tenant-1';
const AGENT = 'mig-agent-1';

async function runDown(ds: DataSource, migration: {
  down(qr: import('typeorm').QueryRunner): Promise<void>;
}): Promise<void> {
  const qr = ds.createQueryRunner();
  try {
    await migration.down(qr);
  } finally {
    await qr.release();
  }
}

async function runUp(ds: DataSource, migration: {
  up(qr: import('typeorm').QueryRunner): Promise<void>;
}): Promise<void> {
  const qr = ds.createQueryRunner();
  try {
    await migration.up(qr);
  } finally {
    await qr.release();
  }
}

async function columnNames(ds: DataSource, table: string): Promise<string[]> {
  const cols: { column_name: string }[] = await ds.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return cols.map((c) => c.column_name);
}

describe('Tenant-canonical scoping migrations — data backfill (e2e)', () => {
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

    await runDown(ds, new AddRequestsAndProviderAttempts1801000000000());

    // Revert the four tenant migrations, newest first → pre-tenant schema
    // (user_id scope columns everywhere, no owner_user_id).
    await runDown(ds, new DropUserScopeFromRouting1792700000000());
    await runDown(ds, new TenantScopedConfigs1792600000000());
    await runDown(ds, new TenantProviders1792500000000());
    await runDown(ds, new TenantOwnerColumn1792400000000());

    // ---- Seed a realistic user-scoped dataset (tenants.name = user id) ----
    await ds.query(
      `INSERT INTO "tenants" ("id","name","is_active") VALUES ($1,$2,true)`,
      [TENANT, USER],
    );
    await ds.query(
      `INSERT INTO "agents" ("id","name","display_name","tenant_id") VALUES ($1,$1,$1,$2)`,
      [AGENT, TENANT],
    );
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","provider","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES ('mig-up1',$1,'openai','api_key','Default',0,true, now(), now())`,
      [USER],
    );
    await ds.query(
      `INSERT INTO "agent_enabled_providers" ("agent_id","user_provider_id") VALUES ($1,'mig-up1')`,
      [AGENT],
    );
    await ds.query(
      `INSERT INTO "custom_providers" ("id","user_id","name","base_url","api_kind","models","created_at")
       VALUES ('mig-cp1',$1,'My Custom','https://x.example.com/v1','openai','[]', now())`,
      [USER],
    );
    await ds.query(
      `INSERT INTO "api_keys" ("id","key","key_hash","key_prefix","user_id","name","created_at")
       VALUES ('mig-key1',NULL,'hash-mig-1','mk-prefix',$1,'Mig Key', now())`,
      [USER],
    );
    await ds.query(
      `INSERT INTO "email_provider_configs"
         ("id","user_id","provider","api_key_encrypted","is_active","created_at","updated_at")
       VALUES ('mig-email1',$1,'resend','enc', true, now(), now())`,
      [USER],
    );
    await ds.query(
      `INSERT INTO "notification_rules"
         ("id","tenant_id","user_id","agent_id","agent_name","metric_type","threshold","period","action","is_active","created_at","updated_at")
       VALUES ('mig-rule1',$1,$2,$3,$3,'tokens',100,'day','notify',true, now(), now())`,
      [TENANT, USER, AGENT],
    );
    await ds.query(
      `INSERT INTO "header_tiers"
         ("id","user_id","agent_id","name","header_key","header_value","badge_color","sort_order","enabled","output_modality","response_mode","created_at","updated_at")
       VALUES ('mig-ht1',$1,$2,'fast','x-tier','fast','indigo',0,true,'text','buffered', now(), now())`,
      [USER, AGENT],
    );
    await ds.query(
      `INSERT INTO "tier_assignments" ("id","user_id","agent_id","tier","updated_at")
       VALUES ('mig-tier1',$1,$2,'simple', now())`,
      [USER, AGENT],
    );
    await ds.query(
      `INSERT INTO "playground_runs"
         ("id","tenant_id","user_id","agent_id","agent_name","prompt","starred","created_at")
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001',$1,$2,$3,'Playground','hello',false, now())`,
      [TENANT, USER, AGENT],
    );

    // ---- Replay the chain in order ----
    await runUp(ds, new TenantOwnerColumn1792400000000());
    await runUp(ds, new TenantProviders1792500000000());
    await runUp(ds, new TenantScopedConfigs1792600000000());
    await runUp(ds, new DropUserScopeFromRouting1792700000000());
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('backfills tenants.owner_user_id from the legacy name=user-id link', async () => {
    const rows = await ds.query(`SELECT owner_user_id FROM "tenants" WHERE id = $1`, [TENANT]);
    expect(rows[0].owner_user_id).toBe(USER);
  });

  it('re-scopes provider connections to the tenant (rename + backfill + audit demotion)', async () => {
    const rows = await ds.query(
      `SELECT tenant_id, created_by_user_id FROM "tenant_providers" WHERE id = 'mig-up1'`,
    );
    expect(rows).toEqual([{ tenant_id: TENANT, created_by_user_id: USER }]);

    const names = await columnNames(ds, 'tenant_providers');
    expect(names).not.toContain('user_id');

    // The junction column followed the rename and kept pointing at the row.
    const junction = await ds.query(
      `SELECT tenant_provider_id FROM "agent_enabled_providers" WHERE agent_id = $1`,
      [AGENT],
    );
    expect(junction).toEqual([{ tenant_provider_id: 'mig-up1' }]);
  });

  it('moves the provider uniqueness key to (tenant_id, provider, auth_type, label)', async () => {
    await expect(
      ds.query(
        `INSERT INTO "tenant_providers"
           ("id","tenant_id","provider","auth_type","label","priority","is_active","connected_at","updated_at")
         VALUES ('mig-up2',$1,'openai','api_key','default',1,true, now(), now())`,
        [TENANT],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('re-scopes api_keys, email_provider_configs and custom_providers to the tenant', async () => {
    for (const [table, id] of [
      ['api_keys', 'mig-key1'],
      ['email_provider_configs', 'mig-email1'],
      ['custom_providers', 'mig-cp1'],
    ] as const) {
      const rows = await ds.query(
        `SELECT tenant_id, created_by_user_id FROM "${table}" WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([{ tenant_id: TENANT, created_by_user_id: USER }]);
      expect(await columnNames(ds, table)).not.toContain('user_id');
    }
  });

  it('drops user_id from routing config and backfills header_tiers.tenant_id from the agent', async () => {
    for (const table of ['tier_assignments', 'specificity_assignments', 'agent_model_params', 'notification_rules']) {
      expect(await columnNames(ds, table)).not.toContain('user_id');
    }
    const ht = await ds.query(`SELECT tenant_id FROM "header_tiers" WHERE id = 'mig-ht1'`);
    expect(ht).toEqual([{ tenant_id: TENANT }]);
    expect(await columnNames(ds, 'header_tiers')).not.toContain('user_id');
  });

  it('renames playground_runs.user_id to created_by_user_id (author audit)', async () => {
    const rows = await ds.query(
      `SELECT tenant_id, created_by_user_id FROM "playground_runs" WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'`,
    );
    expect(rows).toEqual([{ tenant_id: TENANT, created_by_user_id: USER }]);
    expect(await columnNames(ds, 'playground_runs')).not.toContain('user_id');
  });
});
