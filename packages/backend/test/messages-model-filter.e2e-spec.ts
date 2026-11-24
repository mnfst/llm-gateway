import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

/**
 * Model filter on the Requests log.
 *
 * The filter matches the model of ANY provider attempt on the request — the
 * same semantics the provider filter already uses — so filtering by the
 * primary of a fallback chain still surfaces the request it was recovered on.
 * A request that never reached a provider (a Manifest-blocked M###) has no
 * attempt to match, so it falls back to `requests.requested_model`, which is
 * what the Model column renders for those rows.
 */

// Distinct names so a shared e2e database cannot leak rows between specs.
const ALPHA = 'model-filter-probe-alpha';
const BETA = 'model-filter-probe-beta';
const BLOCKED = 'model-filter-probe-blocked';

let app: INestApplication;
let alphaRequestId: string;
let betaRequestId: string;
let blockedRequestId: string;
let fallbackRequestId: string;
let reroutedRequestId: string;

async function insertRequest(
  ds: DataSource,
  opts: { requestedModel: string; status?: string; attemptModels?: string[] },
): Promise<string> {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  const requestId = uuid();
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, timestamp, status, requested_model, agent_name, user_id, api_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      requestId,
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      opts.status ?? 'ok',
      opts.requestedModel,
      'test-agent',
      'test-user-001',
      'chat_completions',
    ],
  );
  for (const model of opts.attemptModels ?? []) {
    await ds.query(
      `INSERT INTO agent_messages (id, request_id, tenant_id, agent_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        uuid(),
        requestId,
        TEST_TENANT_ID,
        TEST_AGENT_ID,
        now,
        opts.status ?? 'ok',
        model,
        100,
        50,
        0,
        0,
        'model filter probe',
        'agent',
        'test-agent',
        'test-user-001',
      ],
    );
  }
  return requestId;
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);

  alphaRequestId = await insertRequest(ds, {
    requestedModel: ALPHA,
    attemptModels: [ALPHA],
  });
  betaRequestId = await insertRequest(ds, {
    requestedModel: BETA,
    attemptModels: [BETA],
  });
  // Never reached a provider: only `requests.requested_model` identifies it.
  blockedRequestId = await insertRequest(ds, {
    requestedModel: BLOCKED,
    status: 'error',
    attemptModels: [],
  });
  // Primary ALPHA failed, recovered on BETA — one request, two attempt models.
  fallbackRequestId = await insertRequest(ds, {
    requestedModel: ALPHA,
    attemptModels: [ALPHA, BETA],
  });
  // `requested_model` names something no attempt ran on. The seeder writes
  // 'auto' here and the playground writes the caller's raw dto.model, so the
  // two columns genuinely diverge; the filter must follow the attempts.
  reroutedRequestId = await insertRequest(ds, {
    requestedModel: 'model-filter-probe-requested-only',
    attemptModels: [BETA],
  });
});

afterAll(async () => {
  const ds = app.get(DataSource);
  for (const id of [
    alphaRequestId,
    betaRequestId,
    blockedRequestId,
    fallbackRequestId,
    reroutedRequestId,
  ]) {
    await ds.query('DELETE FROM agent_messages WHERE request_id = $1', [id]);
    await ds.query('DELETE FROM requests WHERE id = $1', [id]);
  }
  await app.close();
});

const ids = (body: { items: { id: string }[] }): string[] => body.items.map((i) => i.id);

describe('GET /api/v1/messages?model=', () => {
  it('returns only requests holding an attempt on that model', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages?range=24h&model=${BETA}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    // Exact: the rerouted request belongs here too (its one attempt ran on
    // BETA), and an exact set is what pins the "any attempt" semantics.
    expect(new Set(ids(res.body))).toEqual(
      new Set([betaRequestId, fallbackRequestId, reroutedRequestId]),
    );
  });

  it('accepts several models as a comma-separated list', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages?range=24h&model=${ALPHA},${BETA}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).toEqual(
      expect.arrayContaining([alphaRequestId, betaRequestId, fallbackRequestId]),
    );
  });

  it('matches a request that never reached a provider on its requested model', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages?range=24h&model=${BLOCKED}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).toContain(blockedRequestId);
  });

  it('ignores requested_model when the request did reach a provider', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&model=model-filter-probe-requested-only')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).not.toContain(reroutedRequestId);
  });

  it('returns an empty page for a model this tenant never used', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&model=model-filter-probe-absent')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.items).toEqual([]);
  });
});

describe('GET /api/v1/messages/filter-options', () => {
  it('lists the distinct models the tenant has used', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages/filter-options?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.models).toEqual(expect.arrayContaining([ALPHA, BETA]));
  });

  it('includes a model that only ever appeared on a request with no attempt', async () => {
    // Otherwise the log renders BLOCKED in the Model column while the filter
    // that matches it is missing from the dropdown.
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages/filter-options?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.models).toContain(BLOCKED);
  });
});
