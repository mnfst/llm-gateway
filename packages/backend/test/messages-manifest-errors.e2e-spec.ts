/**
 * The Messages log must show every Manifest-authored failure.
 *
 * Regression e2e for the bug that motivated the error-code work: a "Failed:
 * Setup" row rendered in the Overview's Recent Messages panel but was filtered
 * out of GET /api/v1/messages, so clicking through to the log found nothing and
 * no filter could bring it back.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

let app: INestApplication;

const SETUP_ERROR = '[🦚 Manifest M100] No anthropic API key yet.';
const BAD_REQUEST_ERROR = '[🦚 Manifest M300] `messages` array is required.';

async function seed(
  ds: DataSource,
  row: {
    status: string;
    error_message: string | null;
    error_code: string | null;
    error_origin: string | null;
    error_class: string | null;
  },
): Promise<string> {
  const id = uuid();
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  await ds.query(
    `INSERT INTO agent_messages
       (id, tenant_id, agent_id, agent_name, timestamp, status, error_message, error_code,
        error_origin, error_class, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES ($1,$2,$3,'test-agent',$4,$5,$6,$7,$8,$9, 0,0,0,0)`,
    [
      id,
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      now,
      row.status,
      row.error_message,
      row.error_code,
      row.error_origin,
      row.error_class,
    ],
  );
  return id;
}

let setupErrorId: string;
let badRequestId: string;
let providerErrorId: string;

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);

  setupErrorId = await seed(ds, {
    status: 'error',
    error_message: SETUP_ERROR,
    error_code: 'M100',
    error_origin: 'config',
    error_class: 'no_provider_key',
  });
  badRequestId = await seed(ds, {
    status: 'error',
    error_message: BAD_REQUEST_ERROR,
    error_code: 'M300',
    error_origin: 'request',
    error_class: 'invalid_request',
  });
  providerErrorId = await seed(ds, {
    status: 'error',
    error_message: 'Overloaded',
    error_code: null,
    error_origin: 'provider',
    error_class: 'server_error',
  });
});

afterAll(async () => {
  await app.close();
});

const list = (query = ''): request.Test =>
  request(app.getHttpServer())
    .get(`/api/v1/messages?range=24h${query}`)
    .set('x-api-key', TEST_API_KEY)
    .expect(200);

describe('Manifest-authored errors in the Messages log', () => {
  it('lists a setup error by default — it is a message, not hidden noise', async () => {
    const res = await list();
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(setupErrorId);
  });

  it('carries the error code and the actionable message a user can debug from', async () => {
    const res = await list();
    const row = res.body.items.find((i: { id: string }) => i.id === setupErrorId);

    expect(row.error_code).toBe('M100');
    // The rendered text, naming the provider — not a generic stand-in.
    expect(row.error_message).toBe(SETUP_ERROR);
    expect(row.error_origin).toBe('config');
  });

  it('lists a malformed-request error on the request origin', async () => {
    const res = await list();
    const row = res.body.items.find((i: { id: string }) => i.id === badRequestId);

    expect(row.error_origin).toBe('request');
    expect(row.error_code).toBe('M300');
  });

  it('narrows to every Manifest origin at once with origin=manifest', async () => {
    const res = await list('&origin=manifest');
    const ids = res.body.items.map((i: { id: string }) => i.id);

    expect(ids).toContain(setupErrorId);
    expect(ids).toContain(badRequestId);
    expect(ids).not.toContain(providerErrorId);
  });

  it('narrows to one origin when a specific one is requested', async () => {
    const res = await list('&origin=request');
    const ids = res.body.items.map((i: { id: string }) => i.id);

    expect(ids).toEqual([badRequestId]);
  });

  it('rejects an unknown origin instead of silently ignoring it', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/messages?range=24h&origin=nonsense')
      .set('x-api-key', TEST_API_KEY)
      .expect(400);
  });

  it('exposes the error code on the message detail endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages/${setupErrorId}/details`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    expect(res.body.message.error_code).toBe('M100');
    expect(res.body.message.error_origin).toBe('config');
  });
});
