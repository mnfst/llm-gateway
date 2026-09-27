import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_API_KEY } from './helpers';
import { PricingSyncService } from '../src/database/pricing-sync.service';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';

let app: INestApplication;
let originalFetch: typeof fetch;

beforeAll(async () => {
  app = await createTestApp();

  // Seed pricing so playground cost computation has data to work with
  const pricingSync = app.get(PricingSyncService);
  (
    pricingSync.getAll() as Map<
      string,
      { input: number; output: number; contextWindow?: number }
    >
  ).set('openai/gpt-4o-mini', {
    input: 0.00000015,
    output: 0.0000006,
    contextWindow: 128000,
  });
  await app.get(ModelPricingCacheService).reload();

  // Connect the openai provider for TEST_AGENT_ID
  await request(app.getHttpServer())
    .post('/api/v1/routing/test-agent/providers')
    .set('x-api-key', TEST_API_KEY)
    .send({ provider: 'openai', apiKey: 'sk-fake-test-key' })
    .expect(201);
}, 30000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

const api = () => request(app.getHttpServer());
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

function isOpenAiChatCompletionsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.hostname === 'api.openai.com' && parsed.pathname.endsWith('/chat/completions');
}

/**
 * Stub api.openai.com/v1/chat/completions with a streamed SSE body so the
 * playground's `consumeProviderStream` path is exercised end-to-end.
 */
function stubOpenAiChatStream(
  deltas: string[],
  usage: Record<string, number>,
  init: { status?: number; headers?: Record<string, string> } = {},
): void {
  const prev = global.fetch;
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    opts?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (isOpenAiChatCompletionsUrl(url)) {
      const encoder = new TextEncoder();
      const lines = [
        ...deltas.map(
          (d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`,
        ),
        `data: ${JSON.stringify({ usage })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const l of lines) controller.enqueue(encoder.encode(l));
          controller.close();
        },
      });
      return new Response(body, {
        status: init.status ?? 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-ratelimit-remaining-requests': '49',
          ...(init.headers ?? {}),
        },
      });
    }
    return prev(input, opts);
  }) as typeof fetch;
}

function stubOpenAiChatError(status: number, bodyText: string): void {
  const prev = global.fetch;
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    opts?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (isOpenAiChatCompletionsUrl(url)) {
      return new Response(bodyText, { status });
    }
    return prev(input, opts);
  }) as typeof fetch;
}

/** Parse a raw SSE response body into typed events. */
function parseSse(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (line) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return events;
}

/**
 * POST /playground/run and return the raw SSE body text. The endpoint streams
 * under Nest's default @Post() status (201); supertest's default JSON parser
 * would choke on `text/event-stream`, so we buffer + drain the bytes ourselves.
 * The custom parser's value lands on `res.body`.
 */
async function postRun(body: Record<string, unknown>): Promise<string> {
  const res = await auth(api().post('/api/v1/playground/run'))
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.on('data', (chunk: Buffer) => (data += chunk.toString()));
      r.on('end', () => cb(null, data));
    })
    .expect(201);
  return (res.body as string) ?? (res.text as string) ?? '';
}

describe('Playground E2E — POST /api/v1/playground/run (SSE)', () => {
  it('streams deltas + a done event and records a provider attempt on happy path', async () => {
    stubOpenAiChatStream(['hello ', 'world'], { prompt_tokens: 7, completion_tokens: 3 });

    const sseText = await postRun({
      agentName: 'test-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'say hi' }],
    });

    const events = parseSse(sseText);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.map((d) => d.text).join('')).toBe('hello world');

    const done = events.find((e) => e.type === 'done') as Record<string, unknown>;
    expect(done).toBeDefined();
    expect(done.content).toBe('hello world');
    expect(typeof done.columnId).toBe('string');
    const metrics = done.metrics as Record<string, unknown>;
    expect(metrics).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(typeof metrics.durationMs).toBe('number');
    const headers = done.headers as Record<string, string>;
    expect(headers['x-ratelimit-remaining-requests']).toBe('49');
    expect(headers['set-cookie']).toBeUndefined();

    // The run records under the reserved per-tenant "Playground" agent (created
    // on first use), not the client-supplied agentName — so it shows as
    // "Playground" in global Messages.
    const ds = app.get(DataSource);
    const [playgroundAgent] = await ds.query(
      `SELECT id FROM agents WHERE is_playground = true AND deleted_at IS NULL LIMIT 1`,
    );
    const rows = await ds.query(
      `SELECT routing_reason, routing_tier, status, provider, model, input_tokens, output_tokens, agent_name FROM agent_messages WHERE agent_id = $1 AND routing_tier = $2`,
      [playgroundAgent.id, 'playground'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      routing_tier: 'playground',
      routing_reason: null,
      status: 'success',
      provider: 'openai',
      model: 'gpt-4o-mini',
      input_tokens: 7,
      output_tokens: 3,
      agent_name: 'Playground',
    });
  });

  it('returns a 502 JSON error (not a stream) when the upstream returns a non-2xx', async () => {
    stubOpenAiChatError(429, 'rate limited');

    const res = await auth(api().post('/api/v1/playground/run'))
      .send({
        agentName: 'test-agent',
        model: 'gpt-4o-mini',
        provider: 'openai',
        authType: 'api_key',
        messages: [{ role: 'user', content: 'say hi' }],
      })
      .expect(502);

    expect(res.body.message).toContain('Provider returned 429');
  });

  it('returns 404 when the requested provider is not connected for this agent', async () => {
    const res = await auth(api().post('/api/v1/playground/run'))
      .send({
        agentName: 'test-agent',
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        authType: 'api_key',
        messages: [{ role: 'user', content: 'say hi' }],
      })
      .expect(404);

    expect(res.body.message).toContain('anthropic');
  });

  it('ignores the client-supplied agentName and runs under the reserved Playground agent', async () => {
    stubOpenAiChatStream(['hi'], { prompt_tokens: 2, completion_tokens: 1 });

    // A bogus / cross-user agentName is irrelevant now — the Playground always
    // resolves the current user's reserved agent, so this streams normally.
    const sseText = await postRun({
      agentName: 'someone-elses-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'say hi' }],
    });
    const done = parseSse(sseText).find((e) => e.type === 'done');
    expect(done).toBeDefined();
  });

  it('returns 400 when messages payload is missing', async () => {
    await auth(api().post('/api/v1/playground/run'))
      .send({
        agentName: 'test-agent',
        model: 'gpt-4o-mini',
        provider: 'openai',
        authType: 'api_key',
      })
      .expect(400);
  });
});

describe('Playground history — GET /api/v1/playground/runs', () => {
  const runId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

  it('lists runs after successful playgrounds and replays a run by id', async () => {
    stubOpenAiChatStream(['one'], { prompt_tokens: 2, completion_tokens: 1 });
    await postRun({
      agentName: 'test-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'hello there' }],
      runId,
      position: 0,
    });

    stubOpenAiChatStream(['two'], { prompt_tokens: 3, completion_tokens: 2 });
    await postRun({
      agentName: 'test-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'hello there' }],
      runId,
      position: 1,
    });

    const list = await auth(
      api().get('/api/v1/playground/runs').query({ agentName: 'test-agent' }),
    ).expect(200);
    const runs = list.body as Array<{
      id: string;
      prompt: string;
      modelCount: number;
      bestColumnId: string | null;
    }>;
    const target = runs.find((r) => r.id === runId);
    expect(target).toBeDefined();
    expect(target?.prompt).toBe('hello there');
    expect(target?.modelCount).toBe(2);
    expect(target?.bestColumnId).toBeNull();

    const detail = await auth(
      api().get(`/api/v1/playground/runs/${runId}`).query({ agentName: 'test-agent' }),
    ).expect(200);
    expect(detail.body.columns).toHaveLength(2);
    const contents = detail.body.columns.map((c: { content: string }) => c.content);
    expect(contents).toEqual(expect.arrayContaining(['one', 'two']));
    expect(detail.body.columns[0].position).toBeLessThan(detail.body.columns[1].position);
    expect(detail.body.bestColumnId).toBeNull();
  });

  it('returns 404 when the run id does not belong to the current user', async () => {
    await auth(
      api()
        .get('/api/v1/playground/runs/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb')
        .query({ agentName: 'test-agent' }),
    ).expect(404);
  });

  it('returns 400 for a malformed run id', async () => {
    await auth(
      api().get('/api/v1/playground/runs/not-a-uuid').query({ agentName: 'test-agent' }),
    ).expect(400);
  });
});

describe('Playground best-column — PATCH /api/v1/playground/runs/:runId/best', () => {
  const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let columnIds: string[] = [];

  beforeAll(async () => {
    stubOpenAiChatStream(['a'], { prompt_tokens: 1, completion_tokens: 1 });
    const r1 = await postRun({
      agentName: 'test-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'best?' }],
      runId,
      position: 0,
    });

    stubOpenAiChatStream(['b'], { prompt_tokens: 1, completion_tokens: 1 });
    const r2 = await postRun({
      agentName: 'test-agent',
      model: 'gpt-4o-mini',
      provider: 'openai',
      authType: 'api_key',
      messages: [{ role: 'user', content: 'best?' }],
      runId,
      position: 1,
    });

    const id1 = (parseSse(r1).find((e) => e.type === 'done') as {
      columnId: string;
    }).columnId;
    const id2 = (parseSse(r2).find((e) => e.type === 'done') as {
      columnId: string;
    }).columnId;
    columnIds = [id1, id2];
  }, 30000);

  it('sets, then toggles/clears the best column for a run', async () => {
    const set = await auth(api().patch(`/api/v1/playground/runs/${runId}/best`))
      .send({ columnId: columnIds[0] })
      .expect(200);
    expect(set.body).toEqual({ bestColumnId: columnIds[0] });

    // Re-point to the other column.
    const repoint = await auth(api().patch(`/api/v1/playground/runs/${runId}/best`))
      .send({ columnId: columnIds[1] })
      .expect(200);
    expect(repoint.body).toEqual({ bestColumnId: columnIds[1] });

    // Detail now reflects the pick.
    const detail = await auth(
      api().get(`/api/v1/playground/runs/${runId}`).query({ agentName: 'test-agent' }),
    ).expect(200);
    expect(detail.body.bestColumnId).toBe(columnIds[1]);

    // Clear it (null).
    const clear = await auth(api().patch(`/api/v1/playground/runs/${runId}/best`))
      .send({ columnId: null })
      .expect(200);
    expect(clear.body).toEqual({ bestColumnId: null });
  });

  it('returns 404 when the column belongs to a different run', async () => {
    // A syntactically valid uuid that is not a column of this run.
    await auth(api().patch(`/api/v1/playground/runs/${runId}/best`))
      .send({ columnId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
      .expect(404);
  });

  it('returns 404 when the run does not exist / is not owned by the user', async () => {
    await auth(
      api().patch('/api/v1/playground/runs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/best'),
    )
      .send({ columnId: null })
      .expect(404);
  });

  it('returns 400 for a malformed run id', async () => {
    await auth(api().patch('/api/v1/playground/runs/not-a-uuid/best'))
      .send({ columnId: null })
      .expect(400);
  });

  it('returns 400 when columnId is missing entirely', async () => {
    await auth(api().patch(`/api/v1/playground/runs/${runId}/best`)).send({}).expect(400);
  });
});
