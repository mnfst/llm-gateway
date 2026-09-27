import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RequestRecordingStorageService } from '../src/common/services/request-recording-storage.service';
import { decodeRequestRecording } from '../src/common/utils/request-recording-codec';
import { RequestRecordingRetentionService } from '../src/database/request-recording-retention.service';
import { createTestApp, TEST_API_KEY, TEST_OTLP_KEY, TEST_TENANT_ID } from './helpers';

type AttemptRecordingPointer = {
  attempt_id: string;
  request_id: string;
  recording_key: string;
};

const expectedBackend = process.env['E2E_RECORDING_BACKEND'] === 's3' ? 's3' : 'filesystem';
const canBreakStorage =
  expectedBackend === 'filesystem' || Boolean(process.env['E2E_S3_CONTAINER_NAME']);
const storageFailureTest = canBreakStorage ? it : it.skip;
const execFileAsync = promisify(execFile);
const previousEnv = new Map<string, string | undefined>();
const recordingEnvKeys = [
  'REQUEST_RECORDING_STORAGE',
  'REQUEST_RECORDING_FILESYSTEM_PATH',
  'REQUEST_RECORDING_RETENTION_DAYS',
];

let app: INestApplication;
let dataSource: DataSource;
let storage: RequestRecordingStorageService;
let mockServer: http.Server;
let mockPort: number;
let filesystemRoot: string | null = null;
let customProviderId: string;
let jsonRecording: AttemptRecordingPointer;
let jsonResponseBody: unknown;
let streamRecording: AttemptRecordingPointer;
const providerRequestBodies: Record<string, unknown>[] = [];

const api = () => request(app.getHttpServer());
const dashboardAuth = (test: request.Test) => test.set('x-api-key', TEST_API_KEY);
const agentAuth = (test: request.Test) => test.set('Authorization', `Bearer ${TEST_OTLP_KEY}`);
const modelKey = () => `custom:${customProviderId}/recording-model`;

beforeAll(async () => {
  for (const key of recordingEnvKeys) previousEnv.set(key, process.env[key]);

  process.env['REQUEST_RECORDING_STORAGE'] = 'auto';
  process.env['REQUEST_RECORDING_RETENTION_DAYS'] = '1';
  if (expectedBackend === 'filesystem') {
    filesystemRoot = await mkdtemp(join(tmpdir(), 'manifest-recordings-e2e-'));
    process.env['REQUEST_RECORDING_FILESYSTEM_PATH'] = filesystemRoot;
  }

  await startMockProvider();
  app = await createTestApp();
  refreshAppReferences();
  await configureRecordingAgent();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await closeMockProvider();
  if (filesystemRoot) {
    await rm(filesystemRoot, { recursive: true, force: true });
    await rm(`${filesystemRoot}-backup`, { recursive: true, force: true });
  }
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe(`Provider Attempt recording E2E (${expectedBackend})`, () => {
  it('records the exact provider JSON exchange outside PostgreSQL and serves it through the authenticated drawer API', async () => {
    const largeTail = `${'complete-payload-'.repeat(3_500)}__END_OF_REQUEST__`;
    const requestBody = {
      model: modelKey(),
      messages: [{ role: 'user', content: largeTail }],
      temperature: 0.42,
      stream: false,
    };

    const response = await agentAuth(api().post('/v1/chat/completions'))
      .send(requestBody)
      .expect(200);
    jsonResponseBody = response.body;
    jsonRecording = await waitForLatestRecording();
    const providerRequestBody = providerRequestBodies.at(-1)!;

    expect(storage.backend).toBe(expectedBackend);
    expect(jsonRecording.recording_key).toBe(
      `request-recordings/v1/tenants/${TEST_TENANT_ID}` +
        `/requests/${jsonRecording.request_id}` +
        `/attempts/${jsonRecording.attempt_id}.json.gz`,
    );

    const columns = (await dataSource.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'agent_messages'
       ORDER BY ordinal_position`,
    )) as Array<{ column_name: string }>;
    expect(columns.map((column) => column.column_name)).toContain('recording_key');
    expect(columns.map((column) => column.column_name)).not.toEqual(
      expect.arrayContaining(['request_body', 'response_body']),
    );
    const metadataTables = (await dataSource.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'request_recordings'`,
    )) as Array<{ table_name: string }>;
    expect(metadataTables).toHaveLength(0);

    const objectBytes = await storage.get(jsonRecording.recording_key);
    // Encrypted envelope, not gzip: the on-disk object must not expose the exchange.
    expect(objectBytes.subarray(0, 4).toString('ascii')).toBe('MRE1');
    expect(objectBytes.includes(Buffer.from(largeTail, 'utf8'))).toBe(false);
    await expect(decodeRequestRecording(objectBytes)).resolves.toEqual({
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: providerRequestBody,
      response_body: { type: 'json', body: response.body },
    });

    const details = await dashboardAuth(
      api().get(`/api/v1/messages/${jsonRecording.request_id}/details`),
    ).expect(200);
    const attempt = details.body.message.attempts.find(
      (item: { id: string }) => item.id === jsonRecording.attempt_id,
    );
    expect(attempt.recording).toEqual({
      request_body: providerRequestBody,
      response_body: { type: 'json', body: response.body },
      wire_format: 'openai_chat_completions',
    });
    expect(details.body.recording).toBeUndefined();
    expect(JSON.stringify(details.body)).not.toContain(jsonRecording.recording_key);
  });

  it('captures the exact upstream SSE stream on its Provider Attempt', async () => {
    const requestBody = {
      model: modelKey(),
      messages: [{ role: 'user', content: 'stream this response' }],
      stream: true,
    };
    const response = await agentAuth(api().post('/v1/chat/completions'))
      .set('Accept', 'text/event-stream')
      .send(requestBody)
      .expect(200);
    streamRecording = await waitForLatestRecording(jsonRecording.request_id, 10_000);

    const payload = await decodeRequestRecording(await storage.get(streamRecording.recording_key));
    expect(payload.wire_format).toBe('openai_chat_completions');
    expect(payload.request_body).toEqual(providerRequestBodies.at(-1));
    expect(payload.response_body).toEqual({
      type: 'stream',
      raw_sse: response.text,
    });

    const details = await dashboardAuth(
      api().get(`/api/v1/messages/${streamRecording.request_id}/details`),
    ).expect(200);
    const attempt = details.body.message.attempts.find(
      (item: { id: string }) => item.id === streamRecording.attempt_id,
    );
    expect(attempt.recording.response_body.raw_sse).toBe(response.text);
  }, 15_000);

  it('stores no inline image bytes while still forwarding them to the provider', async () => {
    const base64 = 'A'.repeat(4096);
    const known = new Set([jsonRecording.recording_key, streamRecording.recording_key]);

    await agentAuth(api().post('/v1/chat/completions'))
      .send({
        model: modelKey(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this screenshot' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          },
        ],
        stream: false,
      })
      .expect(200);

    const imageRecording = await waitForRecordingOutside(known);
    const stored = JSON.stringify(
      await decodeRequestRecording(await storage.get(imageRecording.recording_key)),
    );
    expect(stored).not.toContain(base64);
    expect(stored).toContain('[inline image: image/png,');
    expect(stored).toContain('describe this screenshot');
    expect(JSON.stringify(providerRequestBodies.at(-1))).toContain(base64);
  });

  it('does not expose a recording across tenant boundaries', async () => {
    const timestamp = new Date().toISOString();
    await dataSource.query(
      `INSERT INTO tenants
        (id, name, owner_user_id, organization_name, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $5)`,
      ['intruder-tenant', 'intruder', 'intruder-user', 'Intruder Org', timestamp],
    );

    await dashboardAuth(
      api()
        .get(`/api/v1/messages/${jsonRecording.request_id}/details`)
        .set('x-test-user-id', 'intruder-user'),
    ).expect(404);

    await expect(storage.get(jsonRecording.recording_key)).resolves.toBeInstanceOf(Buffer);
  });

  it('stops creating payload objects immediately when recording is disabled', async () => {
    const before = await recordingCount();

    await dashboardAuth(api().patch('/api/v1/routing/test-agent/recording'))
      .send({ enabled: false })
      .expect(200, { enabled: false });
    await agentAuth(api().post('/v1/chat/completions'))
      .send({
        model: modelKey(),
        messages: [{ role: 'user', content: 'do not record this' }],
        stream: false,
      })
      .expect(200);

    expect(await recordingCount()).toBe(before);

    await dashboardAuth(api().patch('/api/v1/routing/test-agent/recording'))
      .send({ enabled: true })
      .expect(200, { enabled: true });
  });

  storageFailureTest(
    'keeps successful proxy traffic successful when storage fails',
    async () => {
      const before = await recordingCount();
      const backup = filesystemRoot ? `${filesystemRoot}-backup` : null;

      if (expectedBackend === 'filesystem') {
        await rename(filesystemRoot!, backup!);
        await writeFile(filesystemRoot!, 'this file deliberately blocks the storage directory');
      } else {
        await execFileAsync('docker', ['stop', process.env['E2E_S3_CONTAINER_NAME']!]);
      }

      try {
        const response = await agentAuth(api().post('/v1/chat/completions'))
          .send({
            model: modelKey(),
            messages: [{ role: 'user', content: 'storage can fail independently' }],
            stream: false,
          })
          .expect(200);
        expect(response.body.choices[0].message.content).toBe('recorded JSON response');

        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await recordingCount()).toBe(before);
      } finally {
        if (expectedBackend === 'filesystem') {
          await rm(filesystemRoot!, { force: true });
          await rename(backup!, filesystemRoot!);
        } else {
          await execFileAsync('docker', ['start', process.env['E2E_S3_CONTAINER_NAME']!]);
          await waitForStorageObject(jsonRecording);
        }
      }
    },
    30_000,
  );

  it('can read the same private object after the application restarts', async () => {
    await app.close();
    app = await createTestApp({ dropSchema: false, seed: false });
    refreshAppReferences();

    const details = await dashboardAuth(
      api().get(`/api/v1/messages/${jsonRecording.request_id}/details`),
    ).expect(200);
    const attempt = details.body.message.attempts.find(
      (item: { id: string }) => item.id === jsonRecording.attempt_id,
    );
    expect(attempt.recording.response_body).toEqual({
      type: 'json',
      body: jsonResponseBody,
    });
    await expect(storage.get(jsonRecording.recording_key)).resolves.toBeInstanceOf(Buffer);
  });

  it('retention removes the object before clearing its attempt pointer and preserves the parent Request', async () => {
    await dataSource.query(
      `UPDATE agent_messages
       SET timestamp = CURRENT_TIMESTAMP - INTERVAL '10 days'
       WHERE id = $1`,
      [jsonRecording.attempt_id],
    );
    const retention = new RequestRecordingRetentionService(
      dataSource,
      {
        get: (key: string) => (key === 'app.requestRecordingRetentionDays' ? 1 : undefined),
      } as ConfigService,
      storage,
    );

    await expect(retention.deleteExpiredRecordings()).resolves.toBe(1);

    const metadata = await dataSource.query(
      `SELECT recording_key FROM agent_messages WHERE id = $1`,
      [jsonRecording.attempt_id],
    );
    expect(metadata).toEqual([{ recording_key: null }]);
    await expect(storage.get(jsonRecording.recording_key)).rejects.toBeDefined();
    const parent = await dataSource.query(`SELECT id FROM requests WHERE id = $1`, [
      jsonRecording.request_id,
    ]);
    expect(parent).toHaveLength(1);
  });
});

function refreshAppReferences(): void {
  dataSource = app.get(DataSource);
  storage = app.get(RequestRecordingStorageService);
}

async function configureRecordingAgent(): Promise<void> {
  await dashboardAuth(api().patch('/api/v1/routing/test-agent/recording'))
    .send({ enabled: true })
    .expect(200, { enabled: true });

  const provider = await dashboardAuth(api().post('/api/v1/routing/test-agent/custom-providers'))
    .send({
      name: 'Recording E2E Provider',
      base_url: `http://127.0.0.1:${mockPort}`,
      apiKey: 'recording-e2e-key',
      models: [
        {
          model_name: 'recording-model',
          input_price_per_million_tokens: 0,
          output_price_per_million_tokens: 0,
        },
      ],
    })
    .expect(201);
  customProviderId = provider.body.id as string;

  for (const tier of ['simple', 'standard', 'complex', 'reasoning', 'default']) {
    await dashboardAuth(api().put(`/api/v1/routing/test-agent/tiers/${tier}`))
      .send({ model: modelKey() })
      .expect(200);
  }
}

async function recordingCount(): Promise<number> {
  const rows = (await dataSource.query(
    `SELECT COUNT(*)::int AS count
     FROM agent_messages
     WHERE recording_key IS NOT NULL`,
  )) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

async function waitForLatestRecording(
  excludeRequestId?: string,
  timeoutMs = 5_000,
): Promise<AttemptRecordingPointer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parameters: string[] = [];
    const exclusion = excludeRequestId ? 'AND request_id <> $1' : '';
    if (excludeRequestId) parameters.push(excludeRequestId);
    const rows = (await dataSource.query(
      `SELECT id AS attempt_id, request_id, recording_key
       FROM agent_messages
       WHERE recording_key IS NOT NULL
       ${exclusion}
       ORDER BY timestamp DESC, id DESC
       LIMIT 1`,
      parameters,
    )) as AttemptRecordingPointer[];
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const attempts = await dataSource.query(
    `SELECT id, request_id, status, recording_key
     FROM agent_messages
     ORDER BY timestamp DESC, id DESC
     LIMIT 5`,
  );
  throw new Error(
    `Timed out waiting for a Provider Attempt recording: ${JSON.stringify(attempts)}`,
  );
}

async function waitForRecordingOutside(
  knownKeys: Set<string>,
  timeoutMs = 5_000,
): Promise<AttemptRecordingPointer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await dataSource.query(
      `SELECT id AS attempt_id, request_id, recording_key
       FROM agent_messages
       WHERE recording_key IS NOT NULL
       ORDER BY timestamp DESC, id DESC
       LIMIT 5`,
    )) as AttemptRecordingPointer[];
    const fresh = rows.find((row) => !knownKeys.has(row.recording_key));
    if (fresh) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the inline-image Provider Attempt recording');
}

async function waitForStorageObject(recording: AttemptRecordingPointer): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await storage.get(recording.recording_key);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for recording storage to recover');
}

async function startMockProvider(): Promise<void> {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((incoming, outgoing) => {
      let raw = '';
      incoming.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      incoming.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown> & {
          model: string;
          stream?: boolean;
        };
        providerRequestBodies.push(body);
        if (body.stream) {
          outgoing.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          outgoing.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-recording-stream',
              object: 'chat.completion.chunk',
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'recorded stream response' },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          outgoing.end('data: [DONE]\n\n');
          return;
        }

        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end(
          JSON.stringify({
            id: 'chatcmpl-recording-json',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'recorded JSON response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        );
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
}

async function closeMockProvider(): Promise<void> {
  if (!mockServer) return;
  await new Promise<void>((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
}
