import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { json } from 'express';
import {
  API_BODY_LIMIT,
  PROXY_BODY_LIMIT,
  createProxyBodyBudgetMiddleware,
} from '../src/common/middleware/body-parser-limits';
import { INestApplication } from '@nestjs/common';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_API_KEY } from './helpers';
import { collectResponsesSseResponse } from '../src/routing/proxy/responses-adapter';

type Json = Record<string, any>;
const fn = {
  type: 'function',
  name: 'lookup',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  },
  strict: true,
};
const tools = [fn, { type: 'namespace', name: 'crm', tools: [fn] }, { type: 'web_search' }];
const input = [
  { role: 'developer', content: 'Use tools to answer.' },
  { role: 'user', content: 'Look up Paris.' },
];

// A real HTTP upstream: only provider generation is scripted. Onboarding,
// key authentication, route selection, transport, SSE and recording are real.
describe('Codex Responses tool loop (e2e)', () => {
  let app: INestApplication;
  let upstream: Server;
  let apiKey: string;
  let agentId: string;
  const received: Json[] = [];
  const upstreamErrors: string[] = [];
  let makeReply: (body: Json) => Json;
  let recordedBefore = 0;

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        received.push(body);
        expect(req.url).toBe('/v1/chat/completions');
        expect(req.headers.authorization).toBe('Bearer fixture-provider-key');
        expect(
          body.messages.every((m: Json) =>
            ['system', 'user', 'assistant', 'tool'].includes(m.role),
          ),
        ).toBe(true);
        expect(body.tools.every((t: Json) => t.type === 'function')).toBe(true);
        const reply = makeReply(body);
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const message = reply.choices[0].message;
          // Deliberately split arguments across events and transport writes.
          const deltas = message.tool_calls
            ? [
                {
                  role: 'assistant',
                  tool_calls: message.tool_calls.map((t: Json, index: number) => ({
                    ...t,
                    index,
                    function: { ...t.function, arguments: t.function.arguments.slice(0, 5) },
                  })),
                },
                {
                  tool_calls: message.tool_calls.map((t: Json, index: number) => ({
                    index,
                    function: { arguments: t.function.arguments.slice(5) },
                  })),
                },
              ]
            : [{ role: 'assistant', content: message.content }];
          for (const delta of deltas) {
            const event = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
            res.write(event.slice(0, 11));
            res.write(event.slice(11));
          }
          res.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: reply.usage })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply));
        }
      } catch (error) {
        upstreamErrors.push(String(error));
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Fixture validation failed' } }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    app = await createTestApp({
      configureApp: (app) => {
        app.use('/v1', createProxyBodyBudgetMiddleware(), json({ limit: PROXY_BODY_LIMIT }));
        app.use(json({ limit: API_BODY_LIMIT }));
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/v1/agents')
      .set('x-api-key', TEST_API_KEY)
      .send({
        name: 'Codex E2E',
        agent_category: 'coding',
        agent_platform: 'codex',
        autofix_enabled: false,
      })
      .expect(201);
    apiKey = created.body.apiKey;
    agentId = created.body.agent.id;
    expect(apiKey).toMatch(/^mnfst_/);
    const provider = await request(app.getHttpServer())
      .post('/api/v1/routing/codex-e2e/custom-providers')
      .set('x-api-key', TEST_API_KEY)
      .send({
        name: 'Codex fixture',
        base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
        apiKey: 'fixture-provider-key',
        models: [{ model_name: 'codex-fixture' }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .put('/api/v1/routing/codex-e2e/tiers/default')
      .set('x-api-key', TEST_API_KEY)
      .send({
        model: `custom:${provider.body.id}/codex-fixture`,
        provider: `custom:${provider.body.id}`,
        authType: 'api_key',
      })
      .expect(200);
  }, 30000);

  beforeEach(async () => {
    received.length = 0;
    upstreamErrors.length = 0;
    makeReply = () => {
      throw new Error('Unexpected provider request');
    };
    const [row] = await app
      .get(DataSource)
      .query('SELECT COUNT(*)::int AS count FROM requests WHERE agent_id = $1', [agentId]);
    recordedBefore = row.count;
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  function completion(message: Json): Json {
    return {
      id: 'chatcmpl_fixture',
      object: 'chat.completion',
      model: 'codex-fixture',
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  it('rejects a missing or invalid agent key before calling the provider', async () => {
    await request(app.getHttpServer()).post('/v1/responses').send({ input: 'Hello' }).expect(401);
    await request(app.getHttpServer())
      .post('/v1/responses')
      .set('Authorization', 'Bearer mnfst_invalid')
      .send({ input: 'Hello' })
      .expect(401);
    expect(received).toHaveLength(0);
  });

  it.each([false, true])(
    'completes the parallel namespaced tool loop (stream=%s)',
    async (stream) => {
      makeReply = (body) => {
        expect(body.tools).toHaveLength(2);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'Use tools to answer.' });
        const results = body.messages.filter((m: Json) => m.role === 'tool');
        if (results.length) {
          const assistant = body.messages.find((m: Json) => m.tool_calls);
          expect(assistant.tool_calls).toHaveLength(2);
          expect(assistant.tool_calls.map((t: Json) => t.function.name)).toEqual(
            body.tools.map((t: Json) => t.function.name),
          );
          expect(results).toEqual([
            { role: 'tool', tool_call_id: 'plain_call', content: 'Paris' },
            { role: 'tool', tool_call_id: 'crm_call', content: 'France' },
          ]);
          return completion({ role: 'assistant', content: 'Paris is in France.' });
        }
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: body.tools.map((t: Json, index: number) => ({
            id: index ? 'crm_call' : 'plain_call',
            type: 'function',
            function: { name: t.function.name, arguments: '{"q":"Paris"}' },
          })),
        });
      };
      const call = (items: unknown[]) =>
        request(app.getHttpServer())
          .post('/v1/responses')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({ model: 'auto', input: items, tools, stream });
      const first = await call(input).expect(200);
      const firstBody = stream ? collectResponsesSseResponse(first.text) : first.body;
      const output = firstBody.output as Json[];
      expect(output).toEqual([
        expect.objectContaining({
          type: 'function_call',
          name: 'lookup',
          call_id: 'plain_call',
          arguments: '{"q":"Paris"}',
        }),
        expect.objectContaining({
          type: 'function_call',
          name: 'lookup',
          namespace: 'crm',
          call_id: 'crm_call',
          arguments: '{"q":"Paris"}',
        }),
      ]);
      const second = await call([
        ...input,
        ...output,
        { type: 'function_call_output', call_id: 'plain_call', output: 'Paris' },
        { type: 'function_call_output', call_id: 'crm_call', output: 'France' },
      ]).expect(200);
      const result = stream ? collectResponsesSseResponse(second.text) : second.body;
      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: 'Paris is in France.', annotations: [] }],
        }),
      ]);
      expect(received).toHaveLength(2);
      expect(upstreamErrors).toEqual([]);
      // Recording is queued after delivery; wait for both logical requests.
      let rows: Json[] = [];
      for (let i = 0; i < 50; i++) {
        rows = await app
          .get(DataSource)
          .query('SELECT status FROM requests WHERE agent_id = $1', [agentId]);
        if (
          rows.length >= recordedBefore + received.length &&
          rows.every((row) => row.status === 'success')
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(rows.length).toBe(recordedBefore + received.length);
      expect(rows.every((row) => row.status === 'success')).toBe(true);
    },
  );
  // Opt-in real-client smoke: CODEX_CLI_BINARY=codex npm run test:e2e -- codex-responses.
  // CI always runs the HTTP loops above without needing a Codex installation.
  const codexCli = process.env.CODEX_CLI_BINARY;
  if (codexCli) {
    it('real Codex CLI executes a file write and returns its result through Manifest', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'codex-pr2837-'));
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      let calls = 0;
      makeReply = (body) => {
        calls++;
        const results = body.messages.filter((m: Json) => m.role === 'tool');
        if (results.length) {
          expect(results.at(-1).content).toContain('codex-e2e-ok');
          return completion({ role: 'assistant', content: 'Codex end-to-end passed.' });
        }
        expect(body.tools.some((t: Json) => t.function.name === 'exec_command')).toBe(true);
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'codex_file_write',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: "python3 -c \"from pathlib import Path; Path('codex-e2e.txt').write_text('codex-e2e-ok'); print('codex-e2e-ok')\"",
                  workdir: cwd,
                  max_output_tokens: 100,
                }),
              },
            },
          ],
        });
      };
      try {
        const args = [
          'exec',
          '--ignore-user-config',
          '--ignore-rules',
          '--ephemeral',
          '--skip-git-repo-check',
          '-C',
          cwd,
          '-s',
          'workspace-write',
          '-c',
          'model="auto"',
          '-c',
          'model_provider="manifest"',
          '-c',
          'model_providers.manifest.name="Manifest"',
          '-c',
          `model_providers.manifest.base_url="${url}/v1"`,
          '-c',
          'model_providers.manifest.env_key="MANIFEST_CODEX_TEST_KEY"',
          '-c',
          'model_providers.manifest.wire_api="responses"',
          'Create codex-e2e.txt containing codex-e2e-ok, using exec_command.',
        ];
        const result = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = spawn(codexCli, args, {
              env: { ...process.env, MANIFEST_CODEX_TEST_KEY: apiKey },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            const timer = setTimeout(() => {
              child.kill();
              reject(new Error(output));
            }, 45000);
            child.stdout.on('data', (data) => (output += data));
            child.stderr.on('data', (data) => (output += data));
            child.on('error', reject);
            child.on('close', (code) => {
              clearTimeout(timer);
              resolve({ code, output });
            });
          },
        );
        expect(result).toMatchObject({
          code: 0,
          output: expect.stringContaining('Codex end-to-end passed.'),
        });
        expect(calls).toBe(2);
        expect(readFileSync(join(cwd, 'codex-e2e.txt'), 'utf8')).toBe('codex-e2e-ok');
        expect(upstreamErrors).toEqual([]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 60000);
  }
});
