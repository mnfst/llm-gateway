import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_API_KEY, TEST_TENANT_ID } from './helpers';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

/**
 * Tier-addressed model params (`mnfst routing params`): the CLI names a route
 * by tier + model, and the rows it writes must be the same ones the dashboard
 * reads through the scope-keyed `/model-params` endpoint.
 */
let app: INestApplication;
const BASE = '/api/v1/routing/test-agent';
const PRIMARY = { provider: 'openai', authType: 'api_key', model: 'gpt-4o' };
const FALLBACK = { provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' };

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  await ds.query(
    `INSERT INTO tier_assignments (id, agent_id, tier, override_route, fallback_routes, updated_at)
     VALUES ($1, $2, 'default', $3::jsonb, $4::jsonb, now())
     ON CONFLICT (agent_id, tier) DO UPDATE
       SET override_route = EXCLUDED.override_route, fallback_routes = EXCLUDED.fallback_routes`,
    ['tier-default-params', TEST_AGENT_ID, JSON.stringify(PRIMARY), JSON.stringify([FALLBACK])],
  );
  await ds.query(
    `INSERT INTO header_tiers (id, tenant_id, agent_id, name, header_key, header_value, badge_color, override_route)
     VALUES ('ht-deep', $1, $2, 'Deep', 'x-manifest-tier', 'deep', 'indigo', $3::jsonb)`,
    [TEST_TENANT_ID, TEST_AGENT_ID, JSON.stringify(FALLBACK)],
  );
  app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
}, 30000);

afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());

describe('GET /api/v1/routing/:agent/tiers/:tier/model-params', () => {
  it('describes the default tier primary with its accepted params', async () => {
    const res = await api()
      .get(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(res.body).toMatchObject({
      tier: 'default',
      route: PRIMARY,
      models: ['gpt-4o', 'gpt-4o-mini'],
    });
    const temperature = res.body.params.find((p: { path: string }) => p.path === 'temperature');
    expect(temperature).toMatchObject({ type: 'number', current: null });
  });

  it('404s an unknown tier', async () => {
    const res = await api()
      .get(`${BASE}/tiers/nope/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .expect(404);
    expect(res.body.message).toContain('Available tiers: default, Deep');
  });

  it('400s a model the tier does not route to', async () => {
    await api()
      .get(`${BASE}/tiers/default/model-params`)
      .query({ model: 'claude-opus-4-6' })
      .set('x-api-key', TEST_API_KEY)
      .expect(400);
  });
});

describe('PATCH /api/v1/routing/:agent/tiers/:tier/model-params', () => {
  it('sets a param on a custom tier and the dashboard endpoint reads it back', async () => {
    const res = await api()
      .patch(`${BASE}/tiers/deep/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { temperature: 0.4 } })
      .expect(200);
    expect(res.body.route).toEqual(FALLBACK);
    expect(res.body.params.find((p: { path: string }) => p.path === 'temperature').current).toBe(
      0.4,
    );

    const rows = await api().get(`${BASE}/model-params`).set('x-api-key', TEST_API_KEY).expect(200);
    expect(rows.body).toContainEqual({
      provider: 'openai',
      authType: 'api_key',
      model: 'gpt-4o-mini',
      scope: 'header:ht-deep',
      params: { temperature: 0.4 },
    });
  });

  it('keeps the default tier separate from the custom tier for the same model', async () => {
    await api()
      .patch(`${BASE}/tiers/deep/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { temperature: 0.4 } })
      .expect(200);
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .query({ model: 'gpt-4o-mini' })
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { temperature: 1.2 } })
      .expect(200);
    const deep = await api()
      .get(`${BASE}/tiers/Deep/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(deep.body.params.find((p: { path: string }) => p.path === 'temperature').current).toBe(
      0.4,
    );
  });

  it('unsetting the last param deletes the row', async () => {
    await api()
      .patch(`${BASE}/tiers/deep/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { temperature: 0.4 } })
      .expect(200);
    await api()
      .patch(`${BASE}/tiers/deep/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ unset: ['temperature'] })
      .expect(200);
    const rows = await api().get(`${BASE}/model-params`).set('x-api-key', TEST_API_KEY).expect(200);
    expect(rows.body.some((r: { scope: string }) => r.scope === 'header:ht-deep')).toBe(false);
  });

  it('rejects an invalid value, an unknown param, and a malformed body', async () => {
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { temperature: 'hot' } })
      .expect(400);
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ set: { not_a_param: 1 } })
      .expect(400);
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ unset: 'temperature' })
      .expect(400);
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ unset: ['__proto__.polluted'] })
      .expect(400);
    await api()
      .patch(`${BASE}/tiers/default/model-params`)
      .set('x-api-key', TEST_API_KEY)
      .send({ extra: true })
      .expect(400);
  });
});
