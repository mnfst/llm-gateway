/**
 * End-to-end regression for #1871 — `/v1/messages` cache token round-trip.
 *
 * Drives a real Anthropic-Messages-shaped POST through the proxy stack with a
 * stubbed Anthropic upstream that returns deterministic cache token counts.
 * Asserts both the client-visible response usage AND the `agent_messages` row
 * surface the cache creation / cache read counts that Anthropic reported.
 *
 * Without the fix:
 *   - `chatCompletionsResponseToMessages` hardcoded `cache_creation_input_tokens: 0`
 *   - `parseUsageObject` Anthropic branch read cache reads from the wrong key
 *   ⇒ both client response and DB row showed 0/0 even when Anthropic cached.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import {
  createTestApp,
  TEST_AGENT_ID,
  TEST_OTLP_KEY,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from './helpers';
import { encrypt, getEncryptionSecret } from '../src/common/utils/crypto.util';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { PricingSyncService } from '../src/database/pricing-sync.service';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

let app: INestApplication;
let originalFetch: typeof global.fetch;
let nextAnthropicUsage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_HOST = 'api.anthropic.com';

beforeAll(async () => {
  app = await createTestApp();

  const sync = app.get(PricingSyncService);
  (sync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>).set(
    `anthropic/${MODEL}`,
    { input: 0.000001, output: 0.000005, contextWindow: 200000 },
  );
  await app.get(ModelPricingCacheService).reload();

  const ds = app.get(DataSource);
  const secret = getEncryptionSecret();
  const enc = (s: string) => encrypt(s, secret);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$9,$10)`,
    [
      'up-anthropic-1871',
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_AGENT_ID,
      'anthropic',
      'api_key',
      enc('fake-anthropic-key'),
      now,
      'sk-ant',
      JSON.stringify([
        {
          id: MODEL,
          displayName: MODEL,
          provider: 'anthropic',
          authType: 'api_key',
          contextWindow: 200000,
          inputPricePerToken: 0.000001,
          outputPricePerToken: 0.000005,
          qualityScore: 5,
        },
      ]),
    ],
  );

  // Enable the user-level provider for the test agent (PR3 requires
  // explicit rows in agent_enabled_providers for per-agent filtering).
  await ds.query(
    `INSERT INTO agent_enabled_providers (agent_id, tenant_provider_id) VALUES ($1,$2)`,
    [TEST_AGENT_ID, 'up-anthropic-1871'],
  );

  await ds.query(
    `INSERT INTO tier_assignments
       (id, agent_id, tier, override_route, auto_assigned_route, fallback_routes, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NULL,$5::jsonb,$6)
     ON CONFLICT (agent_id, tier) DO UPDATE SET
       override_route = EXCLUDED.override_route,
       fallback_routes = EXCLUDED.fallback_routes`,
    [
      'tier-default-1871',
      TEST_AGENT_ID,
      'default',
      JSON.stringify({ provider: 'anthropic', authType: 'api_key', model: MODEL }),
      JSON.stringify([]),
      now,
    ],
  );

  // Lock routing to the default tier so the scorer can't pick something else.
  await ds.query(`UPDATE agents SET complexity_routing_enabled = false WHERE id = $1`, [
    TEST_AGENT_ID,
  ]);

  // Stub Anthropic upstream. Returns whatever `nextAnthropicUsage` says, so
  // each test case can dial in cache_creation vs cache_read independently.
  originalFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Non-absolute URL falls through to the real fetch.
    }
    if (hostname === ANTHROPIC_HOST) {
      return new Response(
        JSON.stringify({
          id: 'msg_test_1871',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: nextAnthropicUsage,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch!(input, init);
  }) as typeof fetch;
}, 60000);

afterAll(async () => {
  if (originalFetch) global.fetch = originalFetch;
  if (app) await app.close();
});

async function postMessages(body: Record<string, unknown>): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/v1/messages')
    .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
    .set('anthropic-version', '2023-06-01')
    .send(body)
    .expect(200);
}

async function waitForRecordedMessage(ds: DataSource): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    rows = await ds.query(
      `SELECT input_tokens, cache_read_tokens, cache_creation_tokens, status
         FROM agent_messages WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [TEST_AGENT_ID],
    );
    if (rows[0] && rows[0].status !== 'pending') return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return rows;
}

describe('/v1/messages cache token round-trip (#1871)', () => {
  it('preserves cache_creation_input_tokens through the response AND the DB row', async () => {
    const ds = app.get(DataSource);
    await ds.query(`DELETE FROM agent_messages WHERE agent_id = $1`, [TEST_AGENT_ID]);
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);

    nextAnthropicUsage = {
      input_tokens: 7,
      output_tokens: 2,
      cache_creation_input_tokens: 3006,
      cache_read_input_tokens: 0,
    };

    const res = await postMessages({
      model: MODEL,
      max_tokens: 32,
      system: [
        {
          type: 'text',
          text: 'background context follows '.repeat(300),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'Say pong.' }],
    });

    expect(res.body.usage).toEqual({
      input_tokens: 7,
      output_tokens: 2,
      cache_creation_input_tokens: 3006,
      cache_read_input_tokens: 0,
    });

    const rows = await waitForRecordedMessage(ds);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    // input_tokens stores the chat-shape total (uncached + cache reads + creation).
    expect(Number(rows[0].input_tokens)).toBe(3013);
    expect(Number(rows[0].cache_read_tokens)).toBe(0);
    expect(Number(rows[0].cache_creation_tokens)).toBe(3006);
  });

  it('preserves cache_read_input_tokens through the response AND the DB row', async () => {
    const ds = app.get(DataSource);
    await ds.query(`DELETE FROM agent_messages WHERE agent_id = $1`, [TEST_AGENT_ID]);
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);

    nextAnthropicUsage = {
      input_tokens: 7,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3006,
    };

    const res = await postMessages({
      model: MODEL,
      max_tokens: 32,
      system: [
        {
          type: 'text',
          text: 'background context follows '.repeat(300),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'Say pong.' }],
    });

    expect(res.body.usage).toEqual({
      input_tokens: 7,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3006,
    });

    const rows = await waitForRecordedMessage(ds);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].input_tokens)).toBe(3013);
    expect(Number(rows[0].cache_read_tokens)).toBe(3006);
    expect(Number(rows[0].cache_creation_tokens)).toBe(0);
  });
});
