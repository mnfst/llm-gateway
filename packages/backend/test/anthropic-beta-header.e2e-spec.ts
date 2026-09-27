/**
 * End-to-end cover for the `anthropic-beta` passthrough.
 *
 * Manifest builds the upstream header set from scratch, so a beta flag the
 * caller sent never reached Anthropic, and a body field gated behind that flag
 * was rejected as an extra input.
 *
 * This asserts transport only. The stubbed upstream always answers 200, so it
 * shows which headers Manifest emits, never what Anthropic makes of them.
 *
 * The unit tests call `ProviderClient.forward` directly. This one drives a real
 * `POST /v1/messages` through the whole stack — Express header handling, key
 * auth, routing, credential resolution, the provider client — and asserts on
 * the headers of the request that actually crossed the transport boundary.
 * Only the Anthropic upstream is stubbed.
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

let app: INestApplication;
let originalFetch: typeof global.fetch;
/** Headers of every request that reached the stubbed Anthropic upstream. */
const upstreamHeaders: Record<string, string>[] = [];

const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_HOST = 'api.anthropic.com';
const PROVIDER_ROW = 'up-anthropic-beta';

beforeAll(async () => {
  app = await createTestApp();

  const sync = app.get(PricingSyncService);
  (sync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>).set(
    `anthropic/${MODEL}`,
    { input: 0.000001, output: 0.000005, contextWindow: 200000 },
  );
  await app.get(ModelPricingCacheService).reload();

  const ds = app.get(DataSource);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$9,$10)`,
    [
      PROVIDER_ROW,
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_AGENT_ID,
      'anthropic',
      'api_key',
      encrypt('fake-anthropic-key', getEncryptionSecret()),
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

  await ds.query(
    `INSERT INTO agent_enabled_providers (agent_id, tenant_provider_id) VALUES ($1,$2)`,
    [TEST_AGENT_ID, PROVIDER_ROW],
  );

  await ds.query(
    `INSERT INTO tier_assignments
       (id, agent_id, tier, override_route, auto_assigned_route, fallback_routes, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NULL,$5::jsonb,$6)
     ON CONFLICT (agent_id, tier) DO UPDATE SET
       override_route = EXCLUDED.override_route,
       fallback_routes = EXCLUDED.fallback_routes`,
    [
      'tier-default-beta',
      TEST_AGENT_ID,
      'default',
      JSON.stringify({ provider: 'anthropic', authType: 'api_key', model: MODEL }),
      JSON.stringify([]),
      now,
    ],
  );

  await ds.query(`UPDATE agents SET complexity_routing_enabled = false WHERE id = $1`, [
    TEST_AGENT_ID,
  ]);

  originalFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Non-absolute URL falls through to the real fetch.
    }
    if (hostname === ANTHROPIC_HOST) {
      upstreamHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return new Response(
        JSON.stringify({
          id: 'msg_beta',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
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

beforeEach(() => {
  upstreamHeaders.length = 0;
});

/** POST /v1/messages, optionally carrying the caller's beta flags. */
async function postMessages(beta?: string): Promise<request.Response> {
  const req = request(app.getHttpServer())
    .post('/v1/messages')
    .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
    .set('anthropic-version', '2023-06-01');
  if (beta !== undefined) req.set('anthropic-beta', beta);
  return req
    .send({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] })
    .expect(200);
}

describe('anthropic-beta passthrough (e2e)', () => {
  it("carries the caller's beta flags through to the Anthropic transport", async () => {
    await postMessages('structured-outputs-2025-11-13,context-management-2025-06-27');

    expect(upstreamHeaders).toHaveLength(1);
    const flags = (upstreamHeaders[0]!['anthropic-beta'] ?? '').split(',');
    expect(flags).toContain('structured-outputs-2025-11-13');
    expect(flags).toContain('context-management-2025-06-27');
  });

  it('sends no beta header on the api_key path when the caller sent none', async () => {
    // The pre-change contract for an untouched request, pinned so the merge
    // can never start inventing flags of its own on this path.
    await postMessages();

    expect(upstreamHeaders).toHaveLength(1);
    expect(upstreamHeaders[0]).not.toHaveProperty('anthropic-beta');
  });

  it('drops a malformed flag while keeping the valid ones beside it', async () => {
    // A malformed-only header is observably identical to sending none, so it
    // proves nothing on its own. The mixed case is the one that can go wrong.
    await postMessages('context-management-2025-06-27, Bad Flag, effort-2025-11-24');

    expect(upstreamHeaders).toHaveLength(1);
    const flags = (upstreamHeaders[0]!['anthropic-beta'] ?? '').split(',');
    expect(flags).toEqual(['context-management-2025-06-27', 'effort-2025-11-24']);
  });
});
