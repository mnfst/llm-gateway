/**
 * Verifies the multi-key-per-provider HTTP surface end to end:
 *
 *  - POST /providers with `label` adds extra keys
 *  - PATCH /providers/:provider/keys/:label renames a key
 *  - PUT /providers/:provider/keys/order rewrites priorities by index
 *  - DELETE /providers/:provider?label=… removes one key from the chain
 *    while leaving the provider connected (and renumbers priorities)
 *  - DELETE /providers/:provider with no label keeps legacy whole-provider
 *    teardown semantics
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  stubProviderDiscoveryFetch,
  TEST_AGENT_ID,
  TEST_API_KEY,
} from './helpers';

let app: INestApplication;
let restoreDiscoveryFetch: () => void;

beforeAll(async () => {
  app = await createTestApp();
  restoreDiscoveryFetch = stubProviderDiscoveryFetch();
}, 30000);

afterAll(async () => {
  restoreDiscoveryFetch?.();
  await app.close();
});

const api = () => request(app.getHttpServer());
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

async function listProviders(): Promise<
  Array<{
    provider: string;
    auth_type: string;
    label: string;
    priority: number;
    is_active: boolean;
  }>
> {
  const res = await auth(api().get('/api/v1/routing/test-agent/providers')).expect(200);
  return res.body;
}

async function listActiveOpenAi() {
  const all = await listProviders();
  return all
    .filter((r) => r.provider === 'openai' && r.auth_type === 'api_key' && r.is_active)
    .sort((a, b) => a.priority - b.priority);
}

describe('Multi-key per provider — HTTP', () => {
  beforeEach(async () => {
    // Each test starts from a clean OpenAI provider state by deactivating
    // anything left behind from a previous test (the test app shares the DB).
    await auth(api().post('/api/v1/routing/test-agent/providers/deactivate-all')).expect(201);
  });

  it('initial connect (no label) creates a row labeled "Default" with priority 0', async () => {
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-personal' })
      .expect(201);

    const rows = await listActiveOpenAi();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Default');
    expect(rows[0].priority).toBe(0);
  });

  it('connecting a second key with a label appends to the chain at next priority', async () => {
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-personal' })
      .expect(201);
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-work', label: 'Work' })
      .expect(201);

    const rows = await listActiveOpenAi();
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('Default');
    expect(rows[1].label).toBe('Work');
    expect(rows[1].priority).toBeGreaterThan(rows[0].priority);
  });

  it('accepts more than 5 keys for the same (provider, auth_type)', async () => {
    for (let i = 1; i <= 6; i++) {
      await auth(api().post('/api/v1/routing/test-agent/providers'))
        .send({ provider: 'openai', apiKey: `sk-${i}`, label: `Key ${i}` })
        .expect(201);
    }

    expect(await listActiveOpenAi()).toHaveLength(6);
  });

  it('accepts custom labels for subscription auth_type', async () => {
    const res = await auth(api().post('/api/v1/routing/test-agent/providers')).send({
      provider: 'anthropic',
      apiKey: 'sub-token',
      authType: 'subscription',
      label: 'Pro',
    });
    // Multi-key chains apply to subscription too — multiple Anthropic Pro
    // tokens, multiple ChatGPT Plus accounts, etc.
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Pro');
    expect(res.body.auth_type).toBe('subscription');
  });

  it('PATCH /providers/:provider/keys/:label renames a key', async () => {
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-personal' })
      .expect(201);
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-work', label: 'Work' })
      .expect(201);

    const res = await auth(api().patch('/api/v1/routing/test-agent/providers/openai/keys/Work'))
      .send({ newLabel: 'Office' })
      .expect(200);
    expect(res.body.label).toBe('Office');

    const rows = await listActiveOpenAi();
    expect(rows.find((r) => r.label === 'Office')).toBeDefined();
    expect(rows.find((r) => r.label === 'Work')).toBeUndefined();
  });

  it('PUT /providers/:provider/keys/order writes priority by index', async () => {
    // Use distinct key values per test to avoid the sameKey-reactivation
    // shortcut (which would otherwise map 'sk-work-order' to an older
    // inactive row that has a different label and break the expected state).
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-order-default' })
      .expect(201);
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-order-work', label: 'Work' })
      .expect(201);

    const res = await auth(api().put('/api/v1/routing/test-agent/providers/openai/keys/order'))
      .send({ labels: ['Work', 'Default'] })
      .expect(200);
    expect(res.body[0].label).toBe('Work');
    expect(res.body[0].priority).toBe(0);
    expect(res.body[1].label).toBe('Default');
    expect(res.body[1].priority).toBe(1);
  });

  it('DELETE /providers/:provider?label=… removes one key and renumbers priorities', async () => {
    // Use distinct key values per test to avoid the sameKey-reactivation
    // shortcut matching an older inactive row with a different label.
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-del-default' })
      .expect(201);
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-del-work', label: 'Work' })
      .expect(201);

    await auth(api().delete('/api/v1/routing/test-agent/providers/openai?label=Default')).expect(
      200,
    );

    const rows = await listActiveOpenAi();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Work');
    expect(rows[0].priority).toBe(0);
  });

  it('DELETE /providers/:provider without label keeps legacy whole-provider teardown', async () => {
    await auth(api().post('/api/v1/routing/test-agent/providers'))
      .send({ provider: 'openai', apiKey: 'sk-personal' })
      .expect(201);

    await auth(api().delete('/api/v1/routing/test-agent/providers/openai')).expect(200);
    // Legacy semantics: whole-provider deactivation. The active set drops the
    // Default key entirely (any leftover rows from earlier tests are still
    // inactive after the beforeEach `deactivate-all`).
    const active = await listActiveOpenAi();
    expect(active).toHaveLength(0);
  });
});
