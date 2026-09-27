import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

let app: INestApplication;

/** Only ever used by the unlinked `direct` attempt — an unambiguous signal. */
const DIRECT_ONLY_MODEL = 'client-pinned-only-model';
/** Only ever used by the `direct` attempt hanging off a real `requests` row. */
const LINKED_DIRECT_MODEL = 'client-pinned-linked-model';

beforeAll(async () => {
  app = await createTestApp();

  // Seed test data via direct DB inserts
  const ds = app.get(DataSource);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  await ds.query(
    `INSERT INTO agent_messages (id, tenant_id, agent_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      uuid(),
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      'ok',
      'claude-opus-4-6',
      2000,
      1000,
      0,
      0,
      'User query processed',
      'agent',
      'test-agent',
      'test-user-001',
    ],
  );

  await ds.query(
    `INSERT INTO agent_messages (id, tenant_id, agent_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      uuid(),
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      'ok',
      'gpt-4o',
      500,
      300,
      0,
      0,
      'Browser task completed',
      'browser',
      'test-agent',
      'test-user-001',
    ],
  );

  // A request whose model the CALLER pinned in the request body: Manifest's
  // routing never chose it (routing_reason='direct'). It must stay visible on
  // the cross-harness overview but disappear from the harness's own.
  await ds.query(
    `INSERT INTO agent_messages (id, tenant_id, agent_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id, routing_tier, routing_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      uuid(),
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      'ok',
      DIRECT_ONLY_MODEL,
      7777,
      0,
      0,
      0,
      'Client-pinned model',
      'agent',
      'test-agent',
      'test-user-001',
      'direct',
      'direct',
    ],
  );

  // The same thing in the request-first shape: a parent `requests` row with a
  // linked attempt. `routing_reason` lives only on the attempt, so this is the
  // row that exercises the NOT EXISTS path rather than the legacy unlinked one.
  const linkedRequestId = uuid();
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, agent_name, user_id, timestamp, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [linkedRequestId, TEST_TENANT_ID, TEST_AGENT_ID, 'test-agent', 'test-user-001', now, 'success'],
  );
  await ds.query(
    `INSERT INTO agent_messages (id, tenant_id, agent_id, request_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id, routing_tier, routing_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      uuid(),
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      linkedRequestId,
      now,
      'success',
      LINKED_DIRECT_MODEL,
      1234,
      0,
      0,
      0,
      'Client-pinned model on a linked request',
      'agent',
      'test-agent',
      'test-user-001',
      'direct',
      'direct',
    ],
  );
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/v1/overview', () => {
  it('returns overview data with summary cards', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/overview?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('tokens_today');
    expect(res.body.summary).toHaveProperty('cost_today');
    expect(res.body.summary).toHaveProperty('messages');
    expect(res.body.summary.tokens_today).toHaveProperty('value');
    expect(res.body.summary.tokens_today).toHaveProperty('trend_pct');
    expect(res.body.has_data).toBe(true);
    expect(res.body.summary.tokens_today.value).toBeGreaterThan(0);
    expect(res.body.summary.messages.value).toBeGreaterThan(0);
  });

  it('returns cost by model with data', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/overview?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('cost_by_model');
    expect(Array.isArray(res.body.cost_by_model)).toBe(true);
    expect(res.body.cost_by_model.length).toBeGreaterThan(0);
  });

  it('returns recent activity with data', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/overview?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('recent_activity');
    expect(Array.isArray(res.body.recent_activity)).toBe(true);
    expect(res.body.recent_activity.length).toBeGreaterThan(0);
  });

  it('returns token usage data', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/overview?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body).toHaveProperty('token_usage');
    expect(Array.isArray(res.body.token_usage)).toBe(true);
  });

  it('accepts time range parameter', async () => {
    for (const range of ['1h', '6h', '24h', '7d', '30d']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/overview?range=${range}`)
        .set('x-api-key', TEST_API_KEY)
        .expect(200);
      expect(res.body).toHaveProperty('summary');
    }
  });

  it('rejects request without API key with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/overview?range=24h').expect(401);
  });
});

describe('GET /api/v1/overview — client-pinned (direct) requests', () => {
  const get = (qs: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/overview?range=24h${qs}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

  const models = (body: { cost_by_model?: { model: string }[] }) =>
    (body.cost_by_model ?? []).map((r) => r.model);
  const activityModels = (body: { recent_activity?: { model: string }[] }) =>
    (body.recent_activity ?? []).map((r) => r.model);

  it('hides them from the harness overview — rows, breakdown and totals alike', async () => {
    const { body } = await get('&agent_name=test-agent');

    // The harness overview answers "what did MY routing do", so a model the
    // caller pinned (routing never chose it) is not this harness's traffic.
    // Both shapes must go: the unlinked attempt and the linked request whose
    // `direct` marker only exists on its child attempt.
    expect(activityModels(body)).not.toContain(DIRECT_ONLY_MODEL);
    expect(activityModels(body)).not.toContain(LINKED_DIRECT_MODEL);
    expect(models(body)).not.toContain(DIRECT_ONLY_MODEL);
    expect(models(body)).not.toContain(LINKED_DIRECT_MODEL);
    // ...and the cards must agree with the rows, or the page contradicts itself:
    // neither direct row's tokens may reach the summary.
    expect(body.summary.tokens_today.value).toBe(3800); // 2000+1000 + 500+300
  });

  it('keeps them on the cross-harness overview, where spend reconciles', async () => {
    const { body } = await get('');

    expect(activityModels(body)).toEqual(
      expect.arrayContaining([DIRECT_ONLY_MODEL, LINKED_DIRECT_MODEL]),
    );
    expect(models(body)).toEqual(expect.arrayContaining([DIRECT_ONLY_MODEL, LINKED_DIRECT_MODEL]));
    expect(body.summary.tokens_today.value).toBe(12811); // 3800 + 7777 + 1234
  });

  it('keeps rows recorded before a route was chosen (NULL routing_reason)', async () => {
    // Pending/cancelled rows carry no routing_reason. A naive `!= 'direct'`
    // would drop them (NULL comparison yields NULL); the predicate uses
    // IS DISTINCT FROM so they survive on the harness overview.
    const { body } = await get('&agent_name=test-agent');
    expect(activityModels(body)).toEqual(expect.arrayContaining(['claude-opus-4-6', 'gpt-4o']));
  });
});
