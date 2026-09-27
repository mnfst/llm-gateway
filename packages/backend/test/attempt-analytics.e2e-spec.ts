import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_API_KEY, TEST_TENANT_ID } from './helpers';

let app: INestApplication;

function sqlTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  const current = sqlTimestamp(new Date());
  const previous = sqlTimestamp(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));

  await ds.query(
    `INSERT INTO agents
       (id, name, display_name, description, is_active, complexity_routing_enabled,
        is_playground, tenant_id, created_at, updated_at)
     VALUES ('playground-attempt-analytics', 'Playground', 'Playground', 'Reserved', true,
             false, true, $1, $2, $2)`,
    [TEST_TENANT_ID, current],
  );
  await ds.query(
    `INSERT INTO agent_messages
       (id, tenant_id, agent_id, agent_name, timestamp, status, model,
        fallback_from_model, autofix_applied, autofix_group_id, autofix_role)
     VALUES
       ('attempt-direct', $1, $2, 'test-agent', $3, 'ok', 'model-a', NULL, false, NULL, NULL),
       ('attempt-fallback-primary', $1, $2, 'test-agent', $3, 'fallback_error', 'model-a',
        NULL, false, NULL, NULL),
       ('attempt-fallback-destination', $1, $2, 'test-agent', $3, 'ok', 'model-b',
        'model-a', false, NULL, NULL),
       ('attempt-autofix-retry', $1, $2, 'test-agent', $3, 'ok', 'model-a', NULL,
        true, 'heal-1', 'retry'),
       ('attempt-previous-primary', $1, $2, 'test-agent', $4, 'fallback_error', 'model-a',
        NULL, false, NULL, NULL),
       ('attempt-previous-fallback', $1, $2, 'test-agent', $4, 'ok', 'model-b',
        'model-a', false, NULL, NULL),
       ('attempt-playground-fallback', $1, 'playground-attempt-analytics', 'Playground', $3,
        'ok', 'model-b', 'model-a', false, NULL, NULL)`,
    [TEST_TENANT_ID, TEST_AGENT_ID, current, previous],
  );
});

afterAll(async () => {
  await app.close();
});

describe('Attempt analytics endpoints', () => {
  it('returns current and previous universal attempt counts', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/overview/attempt-stats?range=7d')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(response.body).toEqual({
      total_attempts: { value: 4, previous: 2 },
      fallbacked_attempts: { value: 1, previous: 1 },
    });
  });

  it('returns aligned attempt and fallback timeseries', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/overview/attempt-timeseries?range=7d&agent_name=test-agent')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(response.body).toEqual({
      range: '7d',
      by: 'metric',
      keys: ['total_attempts', 'fallbacked_attempts'],
      buckets: [{ bucket: expect.any(String), counts: [4, 1] }],
    });
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/overview/attempt-stats').expect(401);
  });
});
