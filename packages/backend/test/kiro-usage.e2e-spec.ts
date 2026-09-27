/**
 * End-to-end regression for #2884 — Kiro token usage is always 0 in request
 * logs.
 *
 * Drives a real OpenAI-compatible POST through the proxy stack with a stubbed
 * Kiro `GenerateAssistantResponse` upstream that returns an AWS event stream.
 * Asserts the `agent_messages` row carries non-zero input/output tokens for the
 * stream shape live Kiro actually returns (`initial-response`,
 * `assistantResponseEvent`, credit-only `meteringEvent`), and that cache counts
 * Kiro reports in a `tokenUsage` block reach the cache columns instead of being
 * dropped by `normalizeUsage`.
 *
 * Without the fix:
 *   - usage was only read from a `metadataEvent.tokenUsage` block Kiro never
 *     sends, so every row logged 0
 *   - `normalizeUsage` returned only prompt/completion/total, so cache fields
 *     never reached `cache_read_tokens` / `cache_creation_tokens`
 */
import { Buffer } from 'node:buffer';
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
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

const MODEL = 'claude-sonnet-4.5';
const KIRO_HOST = 'q.us-east-1.amazonaws.com';

let app: INestApplication;
let originalFetch: typeof global.fetch;
let nextKiroEvents: Uint8Array[] = [];

function stringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name);
  const valueBytes = Buffer.from(value);
  const valueLength = Buffer.alloc(2);
  valueLength.writeUInt16BE(valueBytes.length, 0);
  return Buffer.concat([
    Buffer.from([nameBytes.length]),
    nameBytes,
    Buffer.from([7]),
    valueLength,
    valueBytes,
  ]);
}

function eventFrame(eventType: string, payload: unknown): Uint8Array {
  const headers = Buffer.concat([
    stringHeader(':message-type', 'event'),
    stringHeader(':event-type', eventType),
  ]);
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12);
  payloadBytes.copy(frame, 12 + headers.length);
  return frame;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

beforeAll(async () => {
  app = await createTestApp();

  const ds = app.get(DataSource);
  const secret = getEncryptionSecret();
  const enc = (s: string) => encrypt(s, secret);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  await ds.query(
    `INSERT INTO tenant_providers
       (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$9,$10)`,
    [
      'up-kiro-2884',
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_AGENT_ID,
      'kiro',
      'api_key',
      enc('fake-kiro-key'),
      now,
      'fake',
      JSON.stringify([
        {
          id: MODEL,
          displayName: MODEL,
          provider: 'kiro',
          contextWindow: 200000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          qualityScore: 3,
        },
      ]),
    ],
  );

  await ds.query(
    `INSERT INTO agent_enabled_providers (agent_id, tenant_provider_id) VALUES ($1,$2)`,
    [TEST_AGENT_ID, 'up-kiro-2884'],
  );

  await ds.query(
    `INSERT INTO tier_assignments
       (id, agent_id, tier, override_route, auto_assigned_route, fallback_routes, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NULL,$5::jsonb,$6)
     ON CONFLICT (agent_id, tier) DO UPDATE SET
       override_route = EXCLUDED.override_route,
       fallback_routes = EXCLUDED.fallback_routes`,
    [
      'tier-default-2884',
      TEST_AGENT_ID,
      'default',
      JSON.stringify({ provider: 'kiro', authType: 'api_key', model: MODEL }),
      JSON.stringify([]),
      now,
    ],
  );

  await ds.query(`UPDATE agents SET complexity_routing_enabled = false WHERE id = $1`, [
    TEST_AGENT_ID,
  ]);

  // Stub the Kiro upstream. Each test dials in the event stream it wants.
  originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Non-absolute URL falls through to the real fetch.
    }
    if (hostname === KIRO_HOST) {
      return new Response(streamFrom(nextKiroEvents), {
        status: 200,
        headers: { 'content-type': 'application/vnd.amazon.eventstream' },
      });
    }
    return originalFetch!(input, init);
  }) as typeof fetch;
}, 60000);

afterAll(async () => {
  if (originalFetch) global.fetch = originalFetch;
  if (app) await app.close();
});

async function waitForRecordedMessage(ds: DataSource): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    rows = await ds.query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, status
         FROM agent_messages WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [TEST_AGENT_ID],
    );
    if (rows[0] && rows[0].status !== 'pending') return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return rows;
}

async function prepare(): Promise<DataSource> {
  const ds = app.get(DataSource);
  await ds.query(`DELETE FROM agent_messages WHERE agent_id = $1`, [TEST_AGENT_ID]);
  app.get(RoutingCacheService).invalidateAgent(TEST_AGENT_ID);
  return ds;
}

function realKiroStream(content: string): Uint8Array[] {
  // The shape live GenerateAssistantResponse actually returns: no tokenUsage
  // and no contextUsageEvent, just content and a credit metering event.
  return [
    eventFrame('initial-response', { conversationId: 'c1' }),
    eventFrame('assistantResponseEvent', { content }),
    eventFrame('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.0099 }),
  ];
}

describe('Kiro token usage round-trip (#2884)', () => {
  it('records estimated input/output tokens for a real Kiro stream', async () => {
    const ds = await prepare();
    nextKiroEvents = realKiroStream('Pong');

    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .send({
        model: MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'Say pong.' }],
      })
      .expect(200);

    // The client-visible SSE carries an estimated usage block.
    expect(res.text).toContain('"estimated":true');

    const rows = await waitForRecordedMessage(ds);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(Number(rows[0].input_tokens)).toBeGreaterThan(0);
    expect(Number(rows[0].output_tokens)).toBeGreaterThan(0);
  });

  it('records estimated tokens for a real Kiro stream (non-streaming)', async () => {
    const ds = await prepare();
    nextKiroEvents = realKiroStream('Pong');

    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .send({
        model: MODEL,
        stream: false,
        messages: [{ role: 'user', content: 'Say pong.' }],
      })
      .expect(200);

    expect(res.body.usage.estimated).toBe(true);
    expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(res.body.usage.completion_tokens).toBeGreaterThan(0);

    const rows = await waitForRecordedMessage(ds);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].input_tokens)).toBe(res.body.usage.prompt_tokens);
    expect(Number(rows[0].output_tokens)).toBe(res.body.usage.completion_tokens);
  });

  it('fills the cache columns when a tokenUsage block is present', async () => {
    const ds = await prepare();
    nextKiroEvents = [
      eventFrame('assistantResponseEvent', { content: 'pong' }),
      eventFrame('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 4,
          cacheReadInputTokens: 100,
          cacheWriteInputTokens: 20,
          outputTokens: 3,
          totalTokens: 127,
        },
      }),
    ];

    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .send({
        model: MODEL,
        stream: false,
        messages: [{ role: 'user', content: 'Say pong.' }],
      })
      .expect(200);

    expect(res.body.usage).toMatchObject({
      prompt_tokens: 124,
      completion_tokens: 3,
      total_tokens: 127,
      cache_read_tokens: 100,
      cache_creation_tokens: 20,
    });

    const rows = await waitForRecordedMessage(ds);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(Number(rows[0].input_tokens)).toBe(124);
    expect(Number(rows[0].output_tokens)).toBe(3);
    expect(Number(rows[0].cache_read_tokens)).toBe(100);
    expect(Number(rows[0].cache_creation_tokens)).toBe(20);
  });
});
