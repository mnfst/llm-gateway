import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

// Request counts must mean the same thing on every surface. A failed caller
// request is still one request, so Overview, the agent grid, and the complete
// Requests log all include every terminal outcome exactly once.

const OK_COUNT = 5;
const ERROR_STATUSES = ['error', 'fallback_error', 'rate_limited'] as const;
// One row per surface, plus a pre-feature row that predates the column.
const ERROR_API_MODES = ['responses', 'messages', null] as const;
const REQUEST_COUNT = OK_COUNT + ERROR_STATUSES.length;

let app: INestApplication;

async function insertMessage(ds: DataSource, status: string, apiMode: string | null = null) {
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
      status,
      'gpt-4o',
      'test-agent',
      'test-user-001',
      apiMode,
    ],
  );
  await ds.query(
    `INSERT INTO agent_messages (id, request_id, tenant_id, agent_id, timestamp, status, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, description, service_type, agent_name, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      uuid(),
      requestId,
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      status,
      'gpt-4o',
      100,
      50,
      0,
      0,
      'consistency probe',
      'agent',
      'test-agent',
      'test-user-001',
    ],
  );
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  // Five successful requests…
  for (let i = 0; i < OK_COUNT; i++) await insertMessage(ds, 'ok', 'chat_completions');
  // …plus one of every error status, each still a caller request.
  for (const [i, status] of ERROR_STATUSES.entries())
    await insertMessage(ds, status, ERROR_API_MODES[i]);
});

afterAll(async () => {
  await app.close();
});

describe('message-count consistency (F1)', () => {
  it('Overview summary card counts every caller request', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/overview?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(res.body.summary.messages.value).toBe(REQUEST_COUNT);
  });

  it('Agent grid message_count equals the Overview card', async () => {
    const [overview, agents] = await Promise.all([
      request(app.getHttpServer())
        .get('/api/v1/overview?range=24h')
        .set('x-api-key', TEST_API_KEY)
        .expect(200),
      request(app.getHttpServer())
        .get('/api/v1/agents?range=24h')
        .set('x-api-key', TEST_API_KEY)
        .expect(200),
    ]);
    const agent = agents.body.agents.find(
      (a: { agent_name: string }) => a.agent_name === 'test-agent',
    );
    expect(agent.message_count).toBe(REQUEST_COUNT);
    expect(agent.message_count).toBe(overview.body.summary.messages.value);
  });

  it('Messages log total still includes error rows (complete event listing)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&agent_name=test-agent&include_total=true&limit=50')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(res.body.total_count).toBe(REQUEST_COUNT);
  });

  it('Messages log rows carry the API surface each request came in on', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&agent_name=test-agent&limit=50')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const items = res.body.items as Array<{ api_mode: string | null }>;
    expect(items).toHaveLength(REQUEST_COUNT);
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      const key = item.api_mode ?? 'null';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      chat_completions: OK_COUNT,
      responses: 1,
      messages: 1,
      // Rows written before the column existed stay NULL rather than guessing.
      null: 1,
    });
  });
});
