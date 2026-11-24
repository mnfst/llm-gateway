import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { v4 as uuid } from 'uuid';
import { toLocalSqlTimestamp } from '../src/common/utils/postgres-sql';
import { AgentUsageDailyService } from '../src/analytics/services/agent-usage-daily.service';
import { AddAgentUsageDaily1802800000000 } from '../src/database/migrations/1802800000000-AddAgentUsageDaily';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID } from './helpers';

let app: INestApplication;
const foreignTenant = uuid();
const liveId = uuid();
const retiredId = uuid();
const otherId = uuid();
const foreignId = uuid();
const harness = 'scope-reused-name';

// Each harness has three logical requests but three provider attempts:
// a recovered request (two attempts), an unlinked success, and a setup failure
// with no provider call. Distinct amounts make accidental scope leaks visible.
async function seedHarness(
  ds: DataSource,
  tenantId: string,
  agentId: string,
  name: string,
  factor: number,
  deleted = false,
) {
  const timestamp = toLocalSqlTimestamp(new Date(Date.now() - 10 * 60_000));
  await ds.query(
    `INSERT INTO agents (id, tenant_id, name, display_name, deleted_at)
     VALUES ($1, $2, $3, $3, $4)`,
    [agentId, tenantId, name, deleted ? timestamp : null],
  );
  const requestId = uuid();
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, agent_name, timestamp, status)
     VALUES ($1, $2, $3, $4, $5, 'success'), ($6, $2, $3, $4, $5, 'error')`,
    [requestId, tenantId, agentId, name, timestamp, uuid()],
  );
  for (const [index, tokens] of [10, 30, 50].entries()) {
    await ds.query(
      `INSERT INTO agent_messages
       (id, tenant_id, agent_id, agent_name, request_id, timestamp, status,
        model, provider, auth_type, input_tokens, output_tokens, cost_usd,
        error_origin, error_class, superseded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'openai', 'api_key', $9, 0, $10,
               $11, $12, $13)`,
      [
        uuid(),
        tenantId,
        agentId,
        name,
        index < 2 ? requestId : null,
        timestamp,
        index === 0 ? 'error' : 'success',
        `${agentId}-model`,
        tokens * factor,
        (tokens * factor) / 100,
        index === 0 ? 'provider' : null,
        index === 0 ? 'rate_limit' : null,
        index === 0,
      ],
    );
  }
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  await ds.query(
    `INSERT INTO tenants (id, name, owner_user_id) VALUES ($1, 'Foreign', 'scope-foreign-user')`,
    [foreignTenant],
  );
  await seedHarness(ds, TEST_TENANT_ID, retiredId, harness, 10, true);
  await seedHarness(ds, TEST_TENANT_ID, liveId, harness, 1);
  await seedHarness(ds, TEST_TENANT_ID, otherId, 'scope-other', 100);
  await seedHarness(ds, foreignTenant, foreignId, harness, 1000);
});

afterAll(async () => {
  await app?.close();
});

async function get(path: string, agentName?: string, userId?: string) {
  const call = request(app.getHttpServer())
    .get(`/api/v1/${path}`)
    .query({ range: '24h', ...(agentName ? { agent_name: agentName } : {}) })
    .set('x-api-key', TEST_API_KEY);
  if (userId) call.set('x-test-user-id', userId);
  return (await call.expect(200)).body;
}

const surfaces = [
  'messages',
  'overview',
  'overview/details',
  'tokens',
  'costs',
  'overview/autofix-stats',
  'overview/autofix-timeseries',
  'overview/attempt-stats',
  'errors/breakdown',
  'provider-analytics',
] as const;

function assertTotals(
  surface: (typeof surfaces)[number],
  body: any,
  requests: number,
  tokens: number,
) {
  switch (surface) {
    case 'messages':
      expect(body.total_count).toBe(requests);
      expect(body.items).toHaveLength(requests);
      break;
    case 'overview':
      expect(body.summary.messages.value).toBe(requests);
      expect(body.summary.tokens_today.value).toBe(tokens);
      expect(body.summary.cost_today.value).toBeCloseTo(tokens / 100);
      expect(body.request_reliability.recovered).toBe(requests / 3);
      break;
    case 'overview/details':
      expect(body.request_reliability.total).toBe(requests);
      expect(
        body.cost_by_model.reduce((sum: number, row: any) => sum + row.estimated_cost, 0),
      ).toBeCloseTo(tokens / 100);
      break;
    case 'tokens':
      expect(body.summary.total_tokens.value).toBe(tokens);
      break;
    case 'costs':
      expect(body.summary.weekly_cost.value).toBeCloseTo(tokens / 100);
      break;
    case 'overview/autofix-stats':
      expect(body.total_requests.value).toBe(requests);
      expect(body.errors_remaining.value).toBe(requests / 3);
      break;
    case 'overview/autofix-timeseries':
      expect(
        body.buckets.reduce(
          (sum: number, row: any) => sum + row.counts.reduce((a: number, b: number) => a + b, 0),
          0,
        ),
      ).toBe(requests);
      break;
    case 'overview/attempt-stats':
      expect(body.total_attempts.value).toBe(requests);
      break;
    case 'errors/breakdown':
      expect(body.provider_errors).toBe(requests / 3);
      expect(body.successful).toBe((requests * 2) / 3);
      break;
    case 'provider-analytics':
      expect(body.summary.tokens.value).toBe(tokens);
      expect(body.summary.messages.value).toBe((requests * 2) / 3);
      expect(body.attempts.total).toBe(requests);
      break;
  }
}

describe.each(surfaces)('analytics scope: GET %s', (surface) => {
  it('selects only the live harness, including linked and legacy rows', async () => {
    assertTotals(surface, await get(surface, harness), 3, 90);
  });

  it('keeps historical and other-harness data in the tenant-wide view', async () => {
    assertTotals(surface, await get(surface), 9, 9990);
  });

  it('resolves the same name independently in another tenant', async () => {
    assertTotals(surface, await get(surface, harness, 'scope-foreign-user'), 3, 90000);
  });

  it('returns empty data for a missing harness', async () => {
    assertTotals(surface, await get(surface, 'scope-missing'), 0, 0);
  });

  it('returns empty data for an authenticated user without a tenant', async () => {
    assertTotals(surface, await get(surface, harness, 'scope-no-tenant-user'), 0, 0);
  });
});

it('keeps list rows and filter options free of the retired and foreign harnesses', async () => {
  const body = await get('messages', harness);
  expect(body.items.filter((row: any) => row.model).map((row: any) => row.model)).toEqual([
    `${liveId}-model`,
    `${liveId}-model`,
  ]);
  expect(body.models).toEqual([`${liveId}-model`]);
});

it.each(surfaces)(
  'resolves %s once and binds the harness ID in its data queries',
  async (surface) => {
    const ds = app.get(DataSource);
    const executed: Array<{ sql: string; parameters?: unknown[] }> = [];
    const log = jest.spyOn(ds.logger, 'logQuery').mockImplementation((sql, parameters) => {
      executed.push({ sql, parameters });
    });
    try {
      // Use a fresh URL to avoid the dashboard response cache.
      const body = await request(app.getHttpServer())
        .get(`/api/v1/${surface}?range=6h`)
        .query({ agent_name: harness })
        .set('x-api-key', TEST_API_KEY)
        .expect(200);
      assertTotals(surface, body.body, 3, 90);
      const nameLookups = executed.filter(
        ({ sql, parameters }) => /FROM\s+"?agents"?/i.test(sql) && parameters?.includes(harness),
      );
      expect(nameLookups).toHaveLength(1);
      expect(executed.some(({ sql }) => /\.?"?agent_id"?\s*=\s*\(\s*SELECT/i.test(sql))).toBe(
        false,
      );
      expect(
        executed.some(
          ({ sql, parameters }) =>
            /FROM\s+"?agent_messages"?/i.test(sql) && parameters?.includes(liveId),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  },
);

it.each([
  'overview/per-agent-timeseries',
  'overview/per-agent-message-timeseries',
  'overview/per-agent-cost-timeseries',
  'overview/agents/usage',
])('does not resolve an unused harness selection for %s', async (surface) => {
  const executed: Array<{ sql: string; parameters?: unknown[] }> = [];
  const log = jest
    .spyOn(app.get(DataSource).logger, 'logQuery')
    .mockImplementation((sql, parameters) => executed.push({ sql, parameters }));
  try {
    await get(surface, harness);
    expect(
      executed.filter(
        ({ sql, parameters }) => /FROM\s+"?agents"?/i.test(sql) && parameters?.includes(harness),
      ),
    ).toHaveLength(0);
  } finally {
    log.mockRestore();
  }
});

it('keeps missing-harness filter options empty after warming the global model cache', async () => {
  await get('messages');
  const body = await get('messages', 'scope-missing-after-global');
  expect(body.items).toEqual([]);
  expect(body.models).toEqual([]);
});

it('refreshes filters when a harness name is reused while its old models are cached', async () => {
  const ds = app.get(DataSource);
  const name = 'scope-cached-reuse';
  const oldId = uuid();
  const newId = uuid();
  await seedHarness(ds, TEST_TENANT_ID, oldId, name, 2);
  expect((await get('messages', name)).models).toEqual([`${oldId}-model`]);
  await ds.query('UPDATE agents SET deleted_at = NOW() WHERE id = $1', [oldId]);
  expect((await get('messages', name)).items).toEqual([]);
  await seedHarness(ds, TEST_TENANT_ID, newId, name, 3);
  const body = await get('messages', name);
  assertTotals('messages', body, 3, 270);
  expect(body.models).toEqual([`${newId}-model`]);
});

it('preserves scope and direct-traffic exclusions when Overview uses daily rollups', async () => {
  const ds = app.get(DataSource);
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    // The standard HTTP helper synchronizes entities; this read model is
    // migration-owned. Apply the existing migration only to the test database.
    await new AddAgentUsageDaily1802800000000().up(runner);
  } finally {
    await runner.release();
  }
  await ds.query('UPDATE requests SET agent_usage_rolled_up_at = NULL');
  await ds.query('UPDATE agent_messages SET agent_usage_rolled_up_at = NULL');
  await ds.query(
    `UPDATE agent_messages SET routing_reason = 'direct'
     WHERE agent_id = $1 AND request_id IS NULL`,
    [liveId],
  );
  await app.get(AgentUsageDailyService).processBatch(250);
  const oldReads = process.env['AGENT_USAGE_DAILY_READS'];
  process.env['AGENT_USAGE_DAILY_READS'] = 'true';
  try {
    const scoped = await request(app.getHttpServer())
      .get('/api/v1/overview?range=7d')
      .query({ agent_name: harness })
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(scoped.body.summary.tokens_today.value).toBe(40);
    expect(scoped.body.summary.messages.value).toBe(2);
    expect(scoped.body.summary.cost_today.value).toBeCloseTo(0.4);
    const missing = await request(app.getHttpServer())
      .get('/api/v1/overview?range=7d&agent_name=scope-rollup-missing')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(missing.body.summary.tokens_today.value).toBe(0);
    expect(missing.body.summary.messages.value).toBe(0);
    const global = await request(app.getHttpServer())
      .get('/api/v1/overview?range=7d')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(global.body.summary.tokens_today.value).toBe(10440);
    expect(global.body.summary.messages.value).toBe(15);
  } finally {
    if (oldReads === undefined) delete process.env['AGENT_USAGE_DAILY_READS'];
    else process.env['AGENT_USAGE_DAILY_READS'] = oldReads;
  }
});
