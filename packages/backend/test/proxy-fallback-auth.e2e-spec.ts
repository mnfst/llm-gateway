/**
 * End-to-end reproduction for #1173 — fallback success records the wrong
 * `auth_type` (and therefore the wrong `cost_usd`) when the chain mixes
 * `api_key` and `subscription` auth.
 *
 * Drives a real /v1/chat/completions request through the full proxy stack
 * (resolver, fallback chain, response handler, recorder) and asserts on the
 * row that lands in `agent_messages`.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_OTLP_KEY, TEST_TENANT_ID, TEST_USER_ID } from './helpers';
import { encrypt, getEncryptionSecret } from '../src/common/utils/crypto.util';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { PricingSyncService } from '../src/database/pricing-sync.service';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

let app: INestApplication;
let originalFetch: typeof global.fetch;
const calls: { url: string; status: number }[] = [];
let primaryStatus = 503;

const PRIMARY_MODEL = 'claude-sonnet-4';
const FALLBACK_MODEL = 'gpt-4o-mini';

beforeAll(async () => {
  app = await createTestApp();

  // Pricing for the fallback model — cost computation reads this.
  const sync = app.get(PricingSyncService);
  (sync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>).set(
    'openai/gpt-4o-mini',
    { input: 0.00000015, output: 0.0000006, contextWindow: 128000 },
  );
  await app.get(ModelPricingCacheService).reload();

  const ds = app.get(DataSource);
  const secret = getEncryptionSecret();
  const enc = (s: string) => encrypt(s, secret);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  // Two real (registry) providers so the cleanup that deactivates unsupported
  // subscription rows leaves them alone:
  //   - anthropic / api_key   (primary)
  //   - openai    / subscription (fallback)
  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$9,$10)`,
    [
      'up-anthropic',
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
          id: PRIMARY_MODEL,
          displayName: PRIMARY_MODEL,
          provider: 'anthropic',
          authType: 'api_key',
          contextWindow: 200000,
          inputPricePerToken: 0.000003,
          outputPricePerToken: 0.000015,
          qualityScore: 5,
        },
      ]),
    ],
  );
  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$9,$10)`,
    [
      'up-openai-sub',
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_AGENT_ID,
      'openai',
      'subscription',
      enc('fake-openai-sub-token'),
      now,
      'sk-sub',
      JSON.stringify([
        {
          id: FALLBACK_MODEL,
          displayName: FALLBACK_MODEL,
          provider: 'openai',
          authType: 'subscription',
          contextWindow: 128000,
          inputPricePerToken: 0.00000015,
          outputPricePerToken: 0.0000006,
          qualityScore: 3,
        },
      ]),
    ],
  );

  // Enable both user-level providers for the test agent (PR3 requires
  // explicit rows in agent_enabled_providers for per-agent filtering).
  await ds.query(
    `INSERT INTO agent_enabled_providers (agent_id, tenant_provider_id) VALUES ($1,$2),($1,$3)`,
    [TEST_AGENT_ID, 'up-anthropic', 'up-openai-sub'],
  );

  // Wire the default tier with the bug scenario: api_key primary -> subscription fallback.
  // Tiers are created lazily on first `getTiers()` call, so INSERT (not UPDATE)
  // and use ON CONFLICT in case another code path beat us to it.
  await ds.query(
    `INSERT INTO tier_assignments
       (id, agent_id, tier, override_route, auto_assigned_route, fallback_routes, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NULL,$5::jsonb,$6)
     ON CONFLICT (agent_id, tier) DO UPDATE SET
       override_route = EXCLUDED.override_route,
       fallback_routes = EXCLUDED.fallback_routes`,
    [
      'tier-default',
      TEST_AGENT_ID,
      'default',
      JSON.stringify({ provider: 'anthropic', authType: 'api_key', model: PRIMARY_MODEL }),
      JSON.stringify([{ provider: 'openai', authType: 'subscription', model: FALLBACK_MODEL }]),
      now,
    ],
  );

  // Disable complexity scoring so the resolver always lands on the default tier
  // (otherwise the scorer might pick `simple`/`standard` and miss our setup).
  await ds.query(`UPDATE agents SET complexity_routing_enabled = false WHERE id = $1`, [
    TEST_AGENT_ID,
  ]);

  // Stub fetch so the primary upstream returns 503 and the fallback upstream
  // returns 200 with deterministic token usage. Match by exact hostname (not
  // substring) so the rule keeps holding even if the proxy adds query strings
  // or path segments that happen to share characters with these brand names.
  const PRIMARY_HOSTS = new Set(['api.anthropic.com']);
  const FALLBACK_HOSTS = new Set(['chatgpt.com', 'api.openai.com']);
  originalFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Non-absolute URL — fall through to the real fetch.
    }
    if (PRIMARY_HOSTS.has(hostname)) {
      calls.push({ url, status: primaryStatus });
      return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
        status: primaryStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    // OpenAI subscription routes through chatgpt.com; the Codex backend speaks
    // SSE Responses-API. Return a minimal SSE payload with usage so the
    // recorder can compute cost (or zero it, with the fix).
    if (FALLBACK_HOSTS.has(hostname)) {
      calls.push({ url, status: 200 });
      const sse = [
        `event: response.created`,
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'mock-1', model: FALLBACK_MODEL } })}`,
        ``,
        `event: response.completed`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'mock-1',
            model: FALLBACK_MODEL,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'pong' }],
              },
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              total_tokens: 1500,
            },
          },
        })}`,
        ``,
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return originalFetch!(input, init);
  }) as typeof fetch;
}, 60000);

afterAll(async () => {
  if (originalFetch) global.fetch = originalFetch;
  if (app) await app.close();
});

describe('Proxy fallback success — auth_type/cost_usd attribution (#1173)', () => {
  beforeEach(() => {
    primaryStatus = 503;
    calls.length = 0;
  });

  it('records fallback auth_type=subscription and cost_usd=0 on subscription fallback success', async () => {
    const ds = app.get(DataSource);
    await ds.query(`DELETE FROM agent_messages WHERE agent_id = $1`, [TEST_AGENT_ID]);

    // The seeder + auto-assign warm the routing cache before the test's DB
    // writes, so flush it now or the resolver keeps using the stale tier.
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);

    await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .send({ messages: [{ role: 'user', content: 'hello' }] })
      .expect(200);

    // recordFallbackSuccess fires off the response — poll until it flushes
    // (a fixed sleep was flaky on slow CI runners).
    type AttemptRow = {
      model: string;
      provider: string;
      auth_type: string;
      cost_usd: string;
      fallback_from_model: string | null;
      status: string;
      superseded: boolean;
    };
    const deadline = Date.now() + 10000;
    let rows: AttemptRow[] = [];
    let success: AttemptRow | undefined;
    do {
      rows = await ds.query(
        `SELECT model, provider, auth_type, cost_usd, fallback_from_model, status, superseded
           FROM agent_messages
          WHERE agent_id = $1
          ORDER BY timestamp DESC`,
        [TEST_AGENT_ID],
      );
      success = rows.find((r) => r.status === 'success');
      if (!success) await new Promise((r) => setTimeout(r, 100));
    } while (!success && Date.now() < deadline);
    expect(success).toBeDefined();
    if (!success) throw new Error('unreachable');
    // Without the fix, success.auth_type carried 'api_key' (the primary's)
    // and cost_usd was computed from token pricing — non-zero.
    expect(success.auth_type).toBe('subscription');
    expect(Number(success.cost_usd)).toBe(0);
    expect(success.fallback_from_model).toBe(PRIMARY_MODEL);
    expect(success.provider).toBe('openai');

    // The primary failure row should keep the primary's auth_type so cost
    // dashboards still attribute the failure to the right credential. The
    // superseded primary now stores the canonical `failed` status; the
    // recovered-hop signal lives on `superseded`, not the old `fallback_error`.
    const primaryFailure = rows.find(
      (r) => r.status === 'failed' && r.superseded === true && r.fallback_from_model === null,
    );
    expect(primaryFailure).toBeDefined();
    if (!primaryFailure) throw new Error('unreachable');
    expect(primaryFailure.auth_type).toBe('api_key');
    expect(primaryFailure.model).toBe(PRIMARY_MODEL);
  });

  it('falls back when the primary upstream returns 401', async () => {
    primaryStatus = 401;

    // The seeder + auto-assign warm the routing cache before the test's DB
    // writes, so flush it now or the resolver keeps using the stale tier.
    app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);

    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .send({ messages: [{ role: 'user', content: 'hello' }] })
      .expect(200);

    expect(res.headers['x-manifest-fallback-from']).toBe(PRIMARY_MODEL);
    expect(res.headers['x-manifest-fallback-index']).toBe('0');
    expect(calls.map((c) => c.status)).toEqual([401, 200]);
  });
});
