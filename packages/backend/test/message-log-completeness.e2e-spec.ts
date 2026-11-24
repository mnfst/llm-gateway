/**
 * Regression test for mnfst/llm-gateway#2513 — "Some requests aren't logged in
 * the Messages view".
 *
 * The culprit was `ProxyMessageDedup.findExistingSuccessMessage()`, reached
 * from `ProxyMessageRecorder.recordSuccessMessage()`. It treated distinct
 * successful requests as duplicates via three match paths — matching
 * request_id, matching trace_id with no time window, and a heuristic on
 * agent+model+identical token counts within a short window — and silently
 * collapsed them onto a single row. `ProxyMessageDedup` has been deleted;
 * `recordSuccessMessage` now always inserts (or updates its own pending
 * Provider Attempt row), never someone else's.
 *
 * This test fires 12 back-to-back successful proxied requests in shapes that
 * used to maximally trip each dedup match path, and asserts 12 rows land in
 * both `requests` and `agent_messages` every time.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import {
  createTestApp,
  TEST_OTLP_KEY,
  TEST_API_KEY,
  TEST_AGENT_ID,
  TEST_TENANT_ID,
} from './helpers';
import { PricingSyncService } from '../src/database/pricing-sync.service';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';
import { ModelDiscoveryService } from '../src/model-discovery/model-discovery.service';

const N = 12;
const PROVIDER_URL = 'https://api.openai.com/v1/chat/completions';

let app: INestApplication;
let ds: DataSource;
let originalFetch: typeof global.fetch;

/** Usage block the stubbed provider returns; mutated per variant. */
let stubUsage: { prompt_tokens: number; completion_tokens: number } | null = null;

/**
 * Streaming shape the stubbed provider emits, or null for the non-streaming
 * JSON body. Mutated per variant.
 *  - 'usage'    : content deltas + a final `stream_options.include_usage` chunk + [DONE]
 *  - 'no-usage' : content deltas + [DONE], never any usage (opencode-zen free-model shape)
 */
let stubStream: 'usage' | 'no-usage' | null = null;

const enc = new TextEncoder();

function sseChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

function buildSseBody(shape: NonNullable<typeof stubStream>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(sseChunk({ role: 'assistant', content: '' })));
      controller.enqueue(enc.encode(sseChunk({ content: 'hel' })));
      controller.enqueue(enc.encode(sseChunk({ content: 'lo' })));

      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            id: 'chatcmpl-final',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'gpt-4o-mini',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        ),
      );
      if (shape === 'usage') {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-usage',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'gpt-4o-mini',
              choices: [],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            })}\n\n`,
          ),
        );
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function stubProviderFetch(): void {
  originalFetch = global.fetch;
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(PROVIDER_URL)) {
      if (stubStream) {
        return new Response(buildSseBody(stubStream), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      const body: Record<string, unknown> = {
        id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      };
      if (stubUsage) {
        body['usage'] = {
          prompt_tokens: stubUsage.prompt_tokens,
          completion_tokens: stubUsage.completion_tokens,
          total_tokens: stubUsage.prompt_tokens + stubUsage.completion_tokens,
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

async function counts(): Promise<{ requests: number; messages: number }> {
  const [r] = await ds.query(`SELECT count(*)::int AS c FROM requests WHERE tenant_id = $1`, [
    TEST_TENANT_ID,
  ]);
  const [m] = await ds.query(`SELECT count(*)::int AS c FROM agent_messages WHERE tenant_id = $1`, [
    TEST_TENANT_ID,
  ]);
  return { requests: r.c, messages: m.c };
}

/** `status` histogram for `requests`, so a stuck `pending` row is visible. */
async function pendingRequestCount(): Promise<number> {
  const [row] = await ds.query(
    `SELECT count(*)::int AS c FROM requests WHERE tenant_id = $1 AND status = 'pending'`,
    [TEST_TENANT_ID],
  );
  return row.c;
}

/**
 * Poll until the async recorders settle. Both writers run off-request:
 * `recordSuccessMessage` is fired through `recordSafely()` without an await,
 * so the HTTP response can land before its `agent_messages` row commits.
 * Waits on `agent_messages` as well as `requests`, otherwise a slow runner
 * counts one row short. Returns on timeout so the caller's assertions, not
 * this helper, report the failure.
 */
async function settle(expected: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await counts();
    const pending = await pendingRequestCount();
    if (c.requests >= expected && c.messages >= expected && pending === 0) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function truncate(): Promise<void> {
  // Recording-enabled responses can finish before the terminal Request upsert.
  // Wait for that writer before deleting rows so it cannot recreate a prior
  // test's Request after cleanup.
  await settle(0);
  if ((await pendingRequestCount()) !== 0) {
    throw new Error('Timed out waiting for pending Requests before cleanup');
  }
  await ds.query(`DELETE FROM agent_messages WHERE tenant_id = $1`, [TEST_TENANT_ID]);
  await ds.query(`DELETE FROM requests WHERE tenant_id = $1`, [TEST_TENANT_ID]);
}

async function fire(headers: Record<string, string> = {}): Promise<number> {
  const req = request(app.getHttpServer())
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${TEST_OTLP_KEY}`);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  const res = await req.send({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  return res.status;
}

/** Streaming request; resolves with the HTTP status once the SSE body ends. */
async function fireStream(headers: Record<string, string> = {}): Promise<number> {
  const req = request(app.getHttpServer())
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
    .set('Accept', 'text/event-stream');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  const res = await req
    .send({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true })
    .catch((e: { status?: number }) => ({ status: e?.status ?? 0 }));
  return res.status;
}

beforeAll(async () => {
  app = await createTestApp();
  ds = app.get(DataSource);

  const pricingSync = app.get(PricingSyncService);
  (
    pricingSync.getAll() as Map<string, { input: number; output: number; contextWindow?: number }>
  ).set('openai/gpt-4o-mini', { input: 0.00000015, output: 0.0000006, contextWindow: 128000 });
  await app.get(ModelPricingCacheService).reload();

  await request(app.getHttpServer())
    .post('/api/v1/routing/test-agent/providers')
    .set('x-api-key', TEST_API_KEY)
    .send({ provider: 'openai', apiKey: 'sk-fake-test-key' })
    .expect(201);

  await ds.query(
    `UPDATE tenant_providers SET cached_models = $1 WHERE tenant_id = $2 AND provider = $3`,
    [
      JSON.stringify([
        {
          id: 'gpt-4o-mini',
          displayName: 'gpt-4o-mini',
          provider: 'openai',
          contextWindow: 128000,
          inputPricePerToken: 0.00000015,
          outputPricePerToken: 0.0000006,
          capabilityReasoning: false,
          capabilityCode: true,
          qualityScore: 2,
        },
      ]),
      TEST_TENANT_ID,
      'openai',
    ],
  );

  app.get(ModelDiscoveryService).invalidate(TEST_AGENT_ID);
  for (const tier of ['simple', 'standard', 'complex', 'reasoning', 'default']) {
    await ds.query(
      `INSERT INTO tier_assignments (id, agent_id, tier, override_route, updated_at)
       VALUES ($1,$2,$3,$4::jsonb, now())
       ON CONFLICT (agent_id, tier) DO UPDATE SET override_route = EXCLUDED.override_route`,
      [
        `tier-${tier}-2513`,
        TEST_AGENT_ID,
        tier,
        JSON.stringify({ provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' }),
      ],
    );
  }
  const routingCache = app.get(RoutingCacheService);
  routingCache.invalidateAgent(TEST_AGENT_ID);
  routingCache.invalidateTenant(TEST_TENANT_ID);

  stubProviderFetch();
}, 60000);

afterAll(async () => {
  if (originalFetch) global.fetch = originalFetch;
  const server = app.getHttpServer();
  if (server.listening) await new Promise<void>((r) => server.close(() => r()));
  await app.close();
});

describe('Message log completeness — #2513 regression', () => {
  it('records N distinct rows when the provider reports no usage on every request', async () => {
    // The dedup heuristic branch matched on agent+model+identical token
    // counts within a short window — 0/0 tokens on every call maximally
    // trips it.
    await truncate();
    stubUsage = null;

    const statuses: number[] = [];
    for (let i = 0; i < N; i++) statuses.push(await fire());
    expect(statuses.every((s) => s === 200)).toBe(true);
    await settle(N);

    const c = await counts();
    expect(c.requests).toBe(N);
    expect(c.messages).toBe(N);
  }, 120000);

  it('records N distinct rows when the provider reports identical usage on every request', async () => {
    // Same heuristic branch, non-zero token counts.
    await truncate();
    stubUsage = { prompt_tokens: 100, completion_tokens: 50 };

    const statuses: number[] = [];
    for (let i = 0; i < N; i++) statuses.push(await fire());
    expect(statuses.every((s) => s === 200)).toBe(true);
    await settle(N);

    const c = await counts();
    expect(c.requests).toBe(N);
    expect(c.messages).toBe(N);
  }, 120000);

  it('records N distinct rows when the client sends the same traceparent on every request', async () => {
    // The trace_id match path had no time window, so any two requests
    // sharing a traceparent (e.g. an agent reusing one root span) collapsed.
    await truncate();
    stubUsage = { prompt_tokens: 100, completion_tokens: 50 };
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    const statuses: number[] = [];
    for (let i = 0; i < N; i++) statuses.push(await fire({ traceparent }));
    expect(statuses.every((s) => s === 200)).toBe(true);
    await settle(N);

    const c = await counts();
    expect(c.requests).toBe(N);
    expect(c.messages).toBe(N);
  }, 120000);

  it('records N distinct rows for streaming requests with a final usage chunk', async () => {
    await truncate();
    stubUsage = null;
    stubStream = 'usage';
    try {
      for (let i = 0; i < N; i++) await fireStream();
      await settle(N);

      const c = await counts();
      expect(c.requests).toBe(N);
      expect(c.messages).toBe(N);
      expect(await pendingRequestCount()).toBe(0);
    } finally {
      stubStream = null;
    }
  }, 180000);

  it('records N distinct rows for streaming requests with no usage chunk', async () => {
    // opencode-zen free-model shape: content deltas + [DONE], never usage.
    await truncate();
    stubUsage = null;
    stubStream = 'no-usage';
    try {
      for (let i = 0; i < N; i++) await fireStream();
      await settle(N);

      const c = await counts();
      expect(c.requests).toBe(N);
      expect(c.messages).toBe(N);
      expect(await pendingRequestCount()).toBe(0);
    } finally {
      stubStream = null;
    }
  }, 180000);
});
