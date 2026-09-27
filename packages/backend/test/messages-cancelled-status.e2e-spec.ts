import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

/**
 * `cancelled` is a first-class request status (`REQUEST_STATUSES` in
 * error-taxonomy), but the Requests log had no way to select it: the `failed`
 * filter was "anything that is not a success", which swept cancelled and
 * in-flight requests in with real failures.
 *
 * A cancelled request is the caller hanging up — neither Manifest nor the
 * provider failed — so it gets its own filter value and leaves `failed`,
 * matching `sqlIsFailedStatus`, the taxonomy's own definition of a failure.
 */

let app: INestApplication;
let cancelledId: string;
let failedId: string;

async function insertRequest(ds: DataSource, status: string): Promise<string> {
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
      'status-probe-model',
      'test-agent',
      'test-user-001',
      'chat_completions',
    ],
  );
  return requestId;
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  cancelledId = await insertRequest(ds, 'cancelled');
  failedId = await insertRequest(ds, 'error');
});

afterAll(async () => {
  await app.close();
});

const ids = (body: { items: { id: string }[] }): string[] => body.items.map((i) => i.id);

describe('GET /api/v1/messages?status=cancelled', () => {
  it('selects cancelled requests', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&status=cancelled')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).toContain(cancelledId);
    expect(ids(res.body)).not.toContain(failedId);
  });

  it('keeps cancelled requests out of the failed filter', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&status=failed')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).toContain(failedId);
    expect(ids(res.body)).not.toContain(cancelledId);
  });

  it('still lists cancelled requests when no status filter is applied', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(ids(res.body)).toEqual(expect.arrayContaining([cancelledId, failedId]));
  });
});
