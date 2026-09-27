import { DataSource } from 'typeorm';
import { LiftProvidersToUserLevel1791000000000 } from '../src/database/migrations/1791000000000-LiftProvidersToUserLevel';
import { RenameProviderAccessToEnabledProviders1791800000000 } from '../src/database/migrations/1791800000000-RenameProviderAccessToEnabledProviders';
import { AddUserProviderIdToAgentMessages1792000000000 } from '../src/database/migrations/1792000000000-AddUserProviderIdToAgentMessages';
import { TenantOwnerColumn1792400000000 } from '../src/database/migrations/1792400000000-TenantOwnerColumn';
import { TenantProviders1792500000000 } from '../src/database/migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from '../src/database/migrations/1792600000000-TenantScopedConfigs';
import { DropUserScopeFromRouting1792700000000 } from '../src/database/migrations/1792700000000-DropUserScopeFromRouting';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';
import { runMessageProviderBackfill } from '../src/database/backfills/backfill-message-providers';
import { TypeOrmBackfillGateway } from '../src/database/backfills/backfill-message-providers.gateway';

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/manifest_duprepro';

/**
 * Live-upgrade reproduction for the message → connection attribution backfill.
 * A real pre-lift database has the SAME provider connected on multiple agents,
 * all labeled 'Default'. LiftProvidersToUserLevel then RELABELS the colliding
 * rows ('Default' → 'from <agent>'), so a naive single-pass user-level
 * (provider, auth_type, label) backfill matched NOTHING for those users and
 * left every pre-upgrade message NULL. The three-pass backfill must instead
 * anchor on the connection's agent_id (kept by the lift) and stamp each message
 * with the RIGHT connection.
 *
 * That backfill no longer runs inside the migration (it would lock
 * agent_messages for the whole deploy); it runs post-deploy via
 * runMessageProviderBackfill, against the FINAL schema (user_providers →
 * tenant_providers, user_provider_id → tenant_provider_id). So this spec builds
 * the migrated schema, rewinds to the pre-lift shape, seeds pre-lift data,
 * replays the real upgrade chain THROUGH the tenant rename, then runs the
 * out-of-band backfill and asserts the stamping.
 */
describe('agent-message attribution backfill after provider lift (e2e)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: DB_URL,
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    const schemaQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().down(schemaQr);
    await schemaQr.release();

    // Clean slate (FK-safe order), then rewind to the pre-lift schema by
    // reverting the relevant migrations in reverse chronological order. The
    // providers table is named `tenant_providers` at HEAD (after next's rename).
    await ds.query(`DELETE FROM "agent_messages"`);
    await ds.query(`DELETE FROM "agent_enabled_providers"`);
    await ds.query(`DELETE FROM "tenant_providers"`);
    await ds.query(`DELETE FROM "agents"`);
    await ds.query(`DELETE FROM "tenants"`);

    const rewindQr = ds.createQueryRunner();
    await new DropUserScopeFromRouting1792700000000().down(rewindQr);
    await new TenantScopedConfigs1792600000000().down(rewindQr);
    await new TenantProviders1792500000000().down(rewindQr);
    await new TenantOwnerColumn1792400000000().down(rewindQr);
    await new AddUserProviderIdToAgentMessages1792000000000().down(rewindQr);
    await new RenameProviderAccessToEnabledProviders1791800000000().down(rewindQr);
    await new LiftProvidersToUserLevel1791000000000().down(rewindQr);
    await rewindQr.release();

    // Pre-lift seed: one user (tenant.name = user id), three agents.
    await ds.query(`INSERT INTO "tenants" ("id","name","is_active") VALUES ('t1','u-1',true)`);
    await ds.query(
      `INSERT INTO "agents" ("id","name","display_name","tenant_id")
       VALUES ('a1','agent-one','Agent One','t1'),
              ('a2','agent-two','Agent Two','t1'),
              ('a3','agent-three','Agent Three','t1')`,
    );

    // Pre-lift connections (agent_id NOT NULL, unique per
    // (agent_id, provider, auth_type, LOWER(label))):
    // - anthropic 'Default' on BOTH a1 and a2 → the lift will relabel both.
    // - a2 holds TWO distinct openai keys ('Work' / 'Personal').
    // - a3 holds the user's only gemini key.
    await ds.query(
      `INSERT INTO "user_providers"
         ("id","user_id","agent_id","provider","api_key_encrypted","auth_type","label","priority","is_active","connected_at","updated_at")
       VALUES
         ('up-a1-anthropic','u-1','a1','anthropic','enc-1','api_key','Default',0,true, now(), now()),
         ('up-a2-anthropic','u-1','a2','anthropic','enc-2','api_key','Default',0,true, now(), now()),
         ('up-a2-openai-work','u-1','a2','openai','enc-3','api_key','Work',0,true, now(), now()),
         ('up-a2-openai-personal','u-1','a2','openai','enc-4','api_key','Personal',1,true, now(), now()),
         ('up-a3-gemini','u-1','a3','gemini','enc-5','api_key','Default',0,true, now(), now())`,
    );

    // Pre-upgrade messages (the attribution column does not exist yet).
    await ds.query(
      `INSERT INTO "agent_messages"
         ("id","tenant_id","agent_id","timestamp","provider","auth_type","provider_key_label")
       VALUES
         ('msg-a1-anthropic','t1','a1', now(),'anthropic','api_key','Default'),
         ('msg-a2-anthropic','t1','a2', now(),'anthropic','api_key','Default'),
         ('msg-a2-openai-work','t1','a2', now(),'openai','api_key','Work'),
         ('msg-a2-openai-ambiguous','t1','a2', now(),'openai','api_key',NULL),
         ('msg-deleted-agent','t1',NULL, now(),'gemini','api_key','Default')`,
    );

    // Replay the real upgrade chain, including the tenant rename that turns
    // user_provider_id into tenant_provider_id.
    const upgradeQr = ds.createQueryRunner();
    await new LiftProvidersToUserLevel1791000000000().up(upgradeQr);
    await new RenameProviderAccessToEnabledProviders1791800000000().up(upgradeQr);
    await new AddUserProviderIdToAgentMessages1792000000000().up(upgradeQr);
    await new TenantOwnerColumn1792400000000().up(upgradeQr);
    await new TenantProviders1792500000000().up(upgradeQr);
    await upgradeQr.release();

    const requestSchemaUpQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().up(requestSchemaUpQr);
    await requestSchemaUpQr.release();

    // The migration leaves the column NULL; the historical stamping runs
    // post-deploy, against the renamed schema. This is the exact code the
    // boot task and `npm run backfill:message-providers` invoke.
    await runMessageProviderBackfill(new TypeOrmBackfillGateway(ds), { throttleMs: 0 });
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('sanity: the lift relabeled both colliding anthropic connections away from Default', async () => {
    const rows: { id: string; label: string }[] = await ds.query(
      `SELECT "id","label" FROM "tenant_providers"
        WHERE "id" IN ('up-a1-anthropic','up-a2-anthropic') ORDER BY "id"`,
    );
    expect(rows).toEqual([
      { id: 'up-a1-anthropic', label: 'from Agent One' },
      { id: 'up-a2-anthropic', label: 'from Agent Two' },
    ]);
  });

  it('pass 2 stamps relabeled single-key-per-agent messages with the RIGHT connection per agent', async () => {
    // Both messages carry label 'Default', which no anthropic connection has
    // anymore — a user-level backfill would leave BOTH NULL. The agent anchor
    // resolves each to its own agent's key.
    const rows: { id: string; tenant_provider_id: string | null }[] = await ds.query(
      `SELECT "id","tenant_provider_id" FROM "agent_messages"
        WHERE "id" IN ('msg-a1-anthropic','msg-a2-anthropic') ORDER BY "id"`,
    );
    expect(rows).toEqual([
      { id: 'msg-a1-anthropic', tenant_provider_id: 'up-a1-anthropic' },
      { id: 'msg-a2-anthropic', tenant_provider_id: 'up-a2-anthropic' },
    ]);
  });

  it('pass 1 stamps a label-exact message even when the agent has multiple keys for the provider', async () => {
    const rows: { tenant_provider_id: string | null }[] = await ds.query(
      `SELECT "tenant_provider_id" FROM "agent_messages" WHERE "id" = 'msg-a2-openai-work'`,
    );
    expect(rows).toEqual([{ tenant_provider_id: 'up-a2-openai-work' }]);
  });

  it('leaves a genuinely ambiguous message NULL (two keys on the agent, no label match)', async () => {
    const rows: { tenant_provider_id: string | null }[] = await ds.query(
      `SELECT "tenant_provider_id" FROM "agent_messages" WHERE "id" = 'msg-a2-openai-ambiguous'`,
    );
    expect(rows).toEqual([{ tenant_provider_id: null }]);
  });

  it('pass 3 still resolves deleted-agent (NULL agent_id) messages via the user-level label match', async () => {
    const rows: { tenant_provider_id: string | null }[] = await ds.query(
      `SELECT "tenant_provider_id" FROM "agent_messages" WHERE "id" = 'msg-deleted-agent'`,
    );
    expect(rows).toEqual([{ tenant_provider_id: 'up-a3-gemini' }]);
  });

  it('the migration left the FK (ON DELETE SET NULL) and covering index in place (renamed)', async () => {
    const fks: { confdeltype: string }[] = await ds.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conname = 'FK_agent_messages_tenant_provider'
          AND conrelid = '"agent_messages"'::regclass`,
    );
    expect(fks).toHaveLength(1);
    expect(fks[0].confdeltype).toBe('n'); // n = SET NULL

    const idx: { indexname: string }[] = await ds.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'agent_messages'
          AND indexname = 'IDX_agent_messages_tenant_provider'`,
    );
    expect(idx).toHaveLength(1);
  });
});
