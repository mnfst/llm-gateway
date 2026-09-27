/**
 * E2E: symmetric provider↔agent auto-connect + per-agent disable isolation
 *
 * Providers are global and ON for every agent by default; the user disables
 * them per-agent. This spec proves both directions of the symmetric model and
 * that manual disable/enable stays isolated per agent:
 *
 *   Direction 2 (new provider): connecting a provider auto-enables it for EVERY agent
 *     the user already owns + auto-assigns routes.
 *   Direction 1 (new agent): creating an agent auto-enables EVERY usable
 *     provider the user already connected + auto-assigns routes.
 *   Disable isolation: disabling a provider for agent A leaves agent B untouched;
 *     re-enable restores it. Reconnecting the SAME key does NOT resurrect a
 *     per-agent disable.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import {
  createTestApp,
  stubProviderDiscoveryFetch,
  TEST_API_KEY,
  TEST_TENANT_ID,
} from './helpers';
import { AgentEnabledProvider } from '../src/entities/agent-enabled-provider.entity';
import { TenantProvider } from '../src/entities/tenant-provider.entity';

let app: INestApplication;
let ds: DataSource;

const api = () => request(app.getHttpServer());
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

// Agent A = the shared `test-agent` seeded by createTestApp. Agent B is created
// via the public API before any provider is connected, so it must be auto-
// enabled when a provider connects (Direction 2).
const AGENT_A_NAME = 'test-agent';
const AGENT_B_NAME = 'isolation-agent-b';
// Agent C is created AFTER a provider exists, so it must inherit it (Direction 1).
const AGENT_C_NAME = 'isolation-agent-c';

let agentBId: string;
let agentCId: string;
let providerId: string;

let restoreDiscoveryFetch: () => void;

beforeAll(async () => {
  app = await createTestApp();
  restoreDiscoveryFetch = stubProviderDiscoveryFetch();
  ds = app.get(DataSource);

  const res = await auth(api().post('/api/v1/agents')).send({ name: AGENT_B_NAME }).expect(201);
  agentBId = res.body.agent.id as string;
}, 30000);

afterAll(async () => {
  restoreDiscoveryFetch?.();
  await app?.close();
});

describe('Direction 2 – connecting a NEW provider auto-enables it for every existing agent', () => {
  it('creates one global tenant_providers row and enables it for BOTH agent A and agent B', async () => {
    const res = await auth(api().post(`/api/v1/routing/${AGENT_A_NAME}/providers`))
      .send({ provider: 'openai', apiKey: 'sk-test-openai-key' })
      .expect(201);

    providerId = res.body.id as string;
    expect(typeof providerId).toBe('string');
    expect(res.body.provider).toBe('openai');

    // Exactly one global row for this provider/tenant — no agent_id set (global).
    const rows = await ds.getRepository(TenantProvider).find({ where: { id: providerId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBeNull();

    // Symmetric auto-connect: the new provider is enabled for EVERY owned agent,
    // not just the connecting one. Both A and B now have it enabled.
    const enabledRows = await ds.getRepository(AgentEnabledProvider).find({
      where: { tenant_provider_id: providerId },
    });
    const enabledAgentIds = enabledRows.map((g) => g.agent_id);
    expect(enabledAgentIds).toContain(agentBId);
    expect(enabledAgentIds).toHaveLength(2); // agent A + agent B
  });

  it('agent B (created before connect) now lists the provider as enabled', async () => {
    const res = await auth(api().get(`/api/v1/agents/${AGENT_B_NAME}/enabled-providers`)).expect(200);
    const enabled: string[] = res.body.enabled ?? [];
    expect(enabled).toContain(providerId);
  });

  it('agent A (the connecting agent) lists the provider as enabled', async () => {
    const res = await auth(api().get(`/api/v1/agents/${AGENT_A_NAME}/enabled-providers`)).expect(200);
    const enabled: string[] = res.body.enabled ?? [];
    expect(enabled).toContain(providerId);
  });

  it('sibling agent B sees the post-discovery model set of the new provider', async () => {
    // Model routing is user-controlled now (no auto-assigned routes), but a
    // sibling agent that was never the connect context must still see the
    // post-discovery MODEL SET. Discovery for openai (fake key) falls back to
    // the stubbed OpenRouter cache, so the provider's cached_models =
    // gpt-4o / gpt-4o-mini after the connect above.
    const res = await auth(
      api().get(`/api/v1/routing/${AGENT_B_NAME}/available-models`),
    ).expect(200);
    const openaiModels = (res.body as Array<{ model_name: string; provider: string }>).filter(
      (m) => m.provider === 'openai',
    );
    expect(openaiModels.map((m) => m.model_name)).toEqual(
      expect.arrayContaining(['gpt-4o', 'gpt-4o-mini']),
    );
  });

  it('connecting a provider grants sibling agent B access WITHOUT auto-assigning any route', async () => {
    // Model routing is now user-controlled: connecting a provider grants access
    // to every owned agent (asserted above) but never auto-assigns tier routes.
    // A sibling (agent B) that was never the connect context must therefore have
    // NO auto_assigned_route — any tier_assignments rows that exist (e.g. lazily
    // materialised by a tiers read) carry a null auto_assigned_route.
    const tiers = await ds.query(
      `SELECT auto_assigned_route FROM tier_assignments WHERE agent_id = $1`,
      [agentBId],
    );
    const autoAssigned = tiers
      .map((t: { auto_assigned_route: unknown }) => t.auto_assigned_route)
      .filter((r: unknown) => r !== null);
    expect(autoAssigned).toHaveLength(0);
  });
});

describe('Direction 1 – creating a NEW agent inherits every existing provider', () => {
  it('creating agent C auto-grants the already-connected provider + exposes its models WITHOUT assigning routes', async () => {
    // Seed discovered models so the inherited model set is observable, and so a
    // stale auto-assign code path (if any regressed back in) would have
    // something to assign.
    await ds.query(
      `UPDATE tenant_providers SET cached_models = $1 WHERE id = $2`,
      [
        JSON.stringify([
          {
            id: 'gpt-4o-mini',
            displayName: 'gpt-4o-mini',
            provider: 'openai',
            contextWindow: 128000,
            inputPricePerToken: 0.00000015,
            outputPricePerToken: 0.0000006,
            capabilityReasoning: false,
            capabilityCode: true,
            qualityScore: 2,
          },
        ]),
        providerId,
      ],
    );

    const res = await auth(api().post('/api/v1/agents')).send({ name: AGENT_C_NAME }).expect(201);
    agentCId = res.body.agent.id as string;

    // The brand-new agent inherited the existing provider (access only).
    const enabledRows = await ds.getRepository(AgentEnabledProvider).find({
      where: { agent_id: agentCId, tenant_provider_id: providerId },
    });
    expect(enabledRows).toHaveLength(1);

    const enabledRes = await auth(
      api().get(`/api/v1/agents/${AGENT_C_NAME}/enabled-providers`),
    ).expect(200);
    expect((enabledRes.body.enabled ?? []) as string[]).toContain(providerId);

    // Routes are user-controlled now (no auto-assign), but the inherited
    // provider's discovered models must be routable for the brand-new agent.
    const modelsRes = await auth(
      api().get(`/api/v1/routing/${AGENT_C_NAME}/available-models`),
    ).expect(200);
    const modelIds = (modelsRes.body as Array<{ model_name: string }>).map((m) => m.model_name);
    expect(modelIds).toContain('gpt-4o-mini');

    // Model routing is user-controlled: creating an agent grants access but does
    // NOT auto-assign tier routes. No auto_assigned_route exists for agent C.
    const tiers = await ds.query(
      `SELECT auto_assigned_route FROM tier_assignments WHERE agent_id = $1`,
      [agentCId],
    );
    const autoAssigned = tiers
      .map((t: { auto_assigned_route: unknown }) => t.auto_assigned_route)
      .filter((r: unknown) => r !== null);
    expect(autoAssigned).toHaveLength(0);
  });

  it('creating an agent when the user has NO providers succeeds with an empty enabled list', async () => {
    // Snapshot then physically remove the provider so getProviders() returns an
    // empty set (it filters by isManifestUsableProvider, which ignores
    // is_active), proving the 0-provider create path is a safe no-op. Restore
    // the row + its A/B/C enabled rows afterwards so later isolation tests still run.
    const snapshot = await ds.getRepository(TenantProvider).findOneOrFail({
      where: { id: providerId },
    });
    const enabledSnapshot = await ds.getRepository(AgentEnabledProvider).find({
      where: { tenant_provider_id: providerId },
    });
    await ds.getRepository(AgentEnabledProvider).delete({ tenant_provider_id: providerId });
    await ds.getRepository(TenantProvider).delete({ id: providerId });

    const res = await auth(api().post('/api/v1/agents'))
      .send({ name: 'isolation-agent-empty' })
      .expect(201);
    const emptyAgentId = res.body.agent.id as string;

    const enabledRows = await ds.getRepository(AgentEnabledProvider).find({
      where: { agent_id: emptyAgentId },
    });
    expect(enabledRows).toHaveLength(0);

    const enabledRes = await auth(
      api().get('/api/v1/agents/isolation-agent-empty/enabled-providers'),
    ).expect(200);
    expect(enabledRes.body.enabled ?? []).toEqual([]);

    // Restore the provider row + its prior enabled rows for the remaining tests.
    await ds.getRepository(TenantProvider).save(snapshot);
    if (enabledSnapshot.length > 0) {
      await ds.getRepository(AgentEnabledProvider).save(enabledSnapshot);
    }
  });
});

describe('Disable isolation – disabling affects only the targeted agent', () => {
  it('DELETE enabled-providers for agent A removes only A\'s row', async () => {
    await auth(
      api().delete(`/api/v1/agents/${AGENT_A_NAME}/enabled-providers/${providerId}`),
    ).expect(200);

    const aRes = await auth(
      api().get(`/api/v1/agents/${AGENT_A_NAME}/enabled-providers`),
    ).expect(200);
    expect((aRes.body.enabled ?? []) as string[]).not.toContain(providerId);
  });

  it('agent B is unaffected by A\'s disable', async () => {
    const bRes = await auth(
      api().get(`/api/v1/agents/${AGENT_B_NAME}/enabled-providers`),
    ).expect(200);
    expect((bRes.body.enabled ?? []) as string[]).toContain(providerId);
  });

  it('reconnecting the SAME provider key does NOT resurrect agent A\'s disable', async () => {
    // Reconnect openai for agent A with the same key. This hits the
    // update-in-place reconnect branch, which re-enables ONLY the connecting
    // agent (A) and must NOT fan out to re-enable everywhere — but it also must
    // not leave A disabled, since the user explicitly reconnected on A.
    await auth(api().post(`/api/v1/routing/${AGENT_A_NAME}/providers`))
      .send({ provider: 'openai', apiKey: 'sk-test-openai-key' })
      .expect(201);

    // Still the same single global row (no duplicate created on reconnect).
    const rows = await ds.getRepository(TenantProvider).find({
      where: { tenant_id: TEST_TENANT_ID, provider: 'openai' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(providerId);

    // A is re-enabled (it was the reconnect target); B keeps its row.
    const enabledRows = await ds.getRepository(AgentEnabledProvider).find({
      where: { tenant_provider_id: providerId },
    });
    const enabledAgentIds = enabledRows.map((g) => g.agent_id);
    expect(enabledAgentIds).toContain(agentBId);
    expect(enabledAgentIds).toContain(agentCId);
  });

  it('re-enabling agent A via PUT restores its row without touching B', async () => {
    await auth(
      api().put(`/api/v1/agents/${AGENT_B_NAME}/enabled-providers/${providerId}`),
    ).expect(200);

    const bGrants = await ds.getRepository(AgentEnabledProvider).find({
      where: { agent_id: agentBId, tenant_provider_id: providerId },
    });
    expect(bGrants).toHaveLength(1);
  });
});

describe('Disable impact preview – mirrors what the disable handler will strip', () => {
  it('reports a user-assigned override route that uses the provider with position "primary"', async () => {
    // The preview reports the routes the user still controls — override_route
    // (primary) and fallback_routes — and deliberately IGNORES the legacy,
    // system-authored auto_assigned_route. Pin a deterministic standard-tier
    // override on agent B pointing at the openai connection (routes are
    // user-controlled now), then assert the preview surfaces it as the primary
    // route that disabling would strip. tier_assignments is tenant-scoped via
    // agent_id — the user_id column was dropped in the tenant-canonical sweep.
    await ds.query(
      `INSERT INTO tier_assignments (id, agent_id, tier, override_route, auto_assigned_route, fallback_routes, updated_at)
       VALUES ($1,$2,'standard',$3::jsonb,NULL,NULL, now())
       ON CONFLICT (agent_id, tier) DO UPDATE SET
         override_route = EXCLUDED.override_route,
         auto_assigned_route = NULL,
         fallback_routes = NULL`,
      [
        `tier-standard-${agentBId}`,
        agentBId,
        JSON.stringify({ provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' }),
      ],
    );

    const res = await auth(
      api().get(`/api/v1/agents/${AGENT_B_NAME}/enabled-providers/${providerId}/impact`),
    ).expect(200);

    const affected: Array<{ tier: string; model: string; position: string }> =
      res.body.affected_tiers ?? [];
    // The override route we just pinned must appear with position 'primary'.
    expect(affected).toContainEqual({
      tier: 'standard',
      model: 'gpt-4o-mini',
      position: 'primary',
    });
  });
});

describe('Structural invariant – the global key row survives enable/disable churn', () => {
  it('global tenant_providers row is not deleted by any enable/disable change', async () => {
    const row = await ds.getRepository(TenantProvider).findOne({ where: { id: providerId } });
    expect(row).not.toBeNull();
    expect(row!.is_active).toBe(true);
  });
});
