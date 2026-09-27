import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

// End-to-end guard for the error taxonomy: /api/v1/errors/breakdown must split a
// provider's own failures from Manifest's config/policy/internal rejections and
// from transport errors, so "my errors" never conflates "the provider is down"
// with "I forgot to add an API key".

let app: INestApplication;

async function insertMessage(
  ds: DataSource,
  row: { status: string; error_origin: string | null; error_class: string | null },
) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  await ds.query(
    `INSERT INTO agent_messages (id, tenant_id, agent_id, timestamp, status, error_origin, error_class, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, agent_name, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      uuid(),
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      row.status,
      row.error_origin,
      row.error_class,
      'gpt-4o',
      100,
      50,
      0,
      0,
      'test-agent',
      'test-user-001',
    ],
  );
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  // 5 successful messages.
  for (let i = 0; i < 5; i++)
    await insertMessage(ds, { status: 'ok', error_origin: null, error_class: null });
  // 3 provider failures (2 rate limits + 1 server error).
  await insertMessage(ds, { status: 'rate_limited', error_origin: 'provider', error_class: 'rate_limit' });
  await insertMessage(ds, { status: 'rate_limited', error_origin: 'provider', error_class: 'rate_limit' });
  await insertMessage(ds, { status: 'error', error_origin: 'provider', error_class: 'server_error' });
  // 2 Manifest-origin config errors (missing key) — NOT provider failures.
  await insertMessage(ds, { status: 'error', error_origin: 'config', error_class: 'no_provider_key' });
  await insertMessage(ds, { status: 'error', error_origin: 'config', error_class: 'no_provider_key' });
  // 1 transport timeout.
  await insertMessage(ds, { status: 'error', error_origin: 'transport', error_class: 'timeout' });
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/v1/errors/breakdown', () => {
  it('separates provider, transport and Manifest-origin errors', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/errors/breakdown?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.successful).toBe(5);
    expect(res.body.total_errors).toBe(6);
    expect(res.body.provider_errors).toBe(3);
    expect(res.body.manifest_errors).toBe(2);
    expect(res.body.transport_errors).toBe(1);
  });

  it('groups counts by origin and by class', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/errors/breakdown?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.by_origin).toMatchObject({ provider: 3, config: 2, transport: 1 });
    expect(res.body.by_class).toMatchObject({
      rate_limit: 2,
      server_error: 1,
      no_provider_key: 2,
      timeout: 1,
    });
  });

  it('reports provider_error_rate as provider / (provider + successful)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/errors/breakdown?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    // 3 provider errors out of (3 + 5 successful) = 0.375.
    expect(res.body.provider_error_rate).toBeCloseTo(0.375, 6);
  });
});
