import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_USER_ID } from './helpers';
// The SHIPPED predicate, imported rather than re-typed. The cross-tenant test
// below must exercise this, not a copy: a copy would pass even if the real
// helper forgot the tenant scope, which is the mutation most likely to happen.
import { sqlExcludePlayground } from '../src/analytics/services/query-helpers';

/**
 * Behavioural guard for the Playground exclusion (`sqlExcludePlayground`).
 *
 * Roughly forty analytics call sites drop the reserved Playground agent's
 * traffic through that one predicate, and until this file the only thing
 * standing behind them was string matching on generated SQL. A rewrite could
 * keep every `toContain` assertion green while quietly changing which rows
 * come back — which is exactly the failure mode worth guarding, because the
 * predicate has now been through three different SQL shapes chasing a 25
 * second query.
 *
 * So these tests assert ROWS, through HTTP, against a real database. The
 * predicate matches a Playground agent by id OR by name, and both arms carry
 * their own way of going wrong:
 *
 *  - The id arm is deliberately NOT tenant-scoped (agent ids are globally
 *    unique, and removing the correlation is what lets Postgres hash the
 *    subquery once instead of re-running it per row). `hides a playground
 *    agent by id` covers it.
 *  - The name arm compares the `(tenant_id, name)` PAIR, because agent names
 *    are unique only per tenant and every tenant's Playground agent shares a
 *    name. Compare the bare name and you silently delete other tenants'
 *    traffic from their own dashboards. `keeps another tenant's agent that
 *    merely shares the name` is the regression test for that, and it is the
 *    one a careless rewrite is most likely to trip.
 */

let app: INestApplication;

const PLAYGROUND_AGENT_ID = uuid();
const NORMAL_AGENT_ID = uuid();
const NAME_ONLY_AGENT_ID = uuid();

const OTHER_TENANT_ID = uuid();
const OTHER_TENANT_AGENT_ID = uuid();
const ORPHAN_REQUEST_ID = uuid();

/** Timestamps inside every default dashboard range. */
const TS = new Date(Date.now() - 60 * 60 * 1000)
  .toISOString()
  .replace('T', ' ')
  .replace('Z', '')
  .slice(0, 19);

async function seedAgent(
  ds: DataSource,
  opts: { id: string; tenantId: string; name: string; isPlayground: boolean },
): Promise<void> {
  await ds.query(
    `INSERT INTO agents (id, tenant_id, name, is_playground, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5)`,
    [opts.id, opts.tenantId, opts.name, opts.isPlayground, TS],
  );
}

/** One request plus its single successful attempt, the shape the dashboards read. */
async function seedTraffic(
  ds: DataSource,
  opts: { tenantId: string; agentId: string | null; agentName: string },
): Promise<void> {
  const requestId = uuid();
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, user_id, agent_name, timestamp, status)
     VALUES ($1,$2,$3,$4,$5,$6,'success')`,
    [requestId, opts.tenantId, opts.agentId, TEST_USER_ID, opts.agentName, TS],
  );
  await ds.query(
    `INSERT INTO agent_messages (id, request_id, tenant_id, agent_id, agent_name, timestamp, status, model, provider, auth_type, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,'ok','gpt-4o','openai','api_key',100,50,0,0,0.01,$7)`,
    [uuid(), requestId, opts.tenantId, opts.agentId, opts.agentName, TS, TEST_USER_ID],
  );
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);

  await seedAgent(ds, {
    id: PLAYGROUND_AGENT_ID,
    tenantId: TEST_TENANT_ID,
    name: 'Playground',
    isPlayground: true,
  });
  await seedAgent(ds, {
    id: NORMAL_AGENT_ID,
    tenantId: TEST_TENANT_ID,
    name: 'excl-normal-agent',
    isPlayground: false,
  });
  await seedAgent(ds, {
    id: NAME_ONLY_AGENT_ID,
    tenantId: TEST_TENANT_ID,
    name: 'excl-name-only',
    isPlayground: false,
  });

  // A second tenant whose ordinary agent happens to be called `Playground`.
  // Nothing stops a user naming an agent that, and every tenant's reserved
  // agent carries the same name, so a name match that forgets the tenant would
  // erase this row from ITS owner's dashboard.
  await ds.query(`INSERT INTO tenants (id, name, created_at) VALUES ($1,$2,$3)`, [
    OTHER_TENANT_ID,
    'other-tenant',
    TS,
  ]);
  await seedAgent(ds, {
    id: OTHER_TENANT_AGENT_ID,
    tenantId: OTHER_TENANT_ID,
    name: 'Playground',
    isPlayground: false,
  });

  // Carries the Playground agent ID but a DIFFERENT name, so only the id arm
  // can catch it. This is the row a name-only match leaks.
  await seedTraffic(ds, {
    tenantId: TEST_TENANT_ID,
    agentId: PLAYGROUND_AGENT_ID,
    agentName: 'pg-renamed',
  });
  await seedTraffic(ds, {
    tenantId: TEST_TENANT_ID,
    agentId: NORMAL_AGENT_ID,
    agentName: 'excl-normal-agent',
  });
  // Carries the Playground NAME but a different agent id: only the name arm
  // can catch it. This is the row an id-only match leaks.
  await seedTraffic(ds, {
    tenantId: TEST_TENANT_ID,
    agentId: NAME_ONLY_AGENT_ID,
    agentName: 'Playground',
  });
  await seedTraffic(ds, {
    tenantId: OTHER_TENANT_ID,
    agentId: OTHER_TENANT_AGENT_ID,
    agentName: 'Playground',
  });

  // Orphan telemetry: both agent columns NULL. All four are nullable, so this
  // is reachable. `x IN (subquery)` yields NULL rather than false here, and
  // `NOT NULL` is NULL, so without the COALESCE guards the row is silently
  // dropped instead of kept -- a row vanishing from the dashboards with no
  // error anywhere.
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, user_id, agent_name, timestamp, status)
     VALUES ($1,$2,NULL,$3,NULL,$4,'success')`,
    [ORPHAN_REQUEST_ID, TEST_TENANT_ID, TEST_USER_ID, TS],
  );
});

afterAll(async () => {
  await app?.close();
});

const api = () => request(app.getHttpServer());
const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);

describe('Playground exclusion (behavioural, not SQL-shape)', () => {
  /**
   * The reference semantics, as the correlated form expressed them. Used as an
   * oracle so the assertions below are not circular: they compare the shipped
   * predicate's effect against an independently written definition of "is this
   * row Playground traffic", rather than against itself.
   */
  const ORACLE = `EXISTS (
    SELECT 1 FROM agents playag
     WHERE playag.tenant_id = r.tenant_id
       AND playag.is_playground = true
       AND (playag.id = r.agent_id OR playag.name = r.agent_name)
  )`;

  it('drops a row matched only by agent id', async () => {
    // agent_id = the Playground agent, agent_name = 'pg-renamed'. A name-only
    // match keeps this row.
    const res = await auth(api().get('/api/v1/overview?range=24h')).expect(200);
    const names = (res.body.recent_activity as Array<{ agent_name: string }>).map(
      (r) => r.agent_name,
    );

    expect(names).not.toContain('pg-renamed');
  });

  it('drops a row matched only by agent name', async () => {
    // agent_id = an ordinary agent, agent_name = 'Playground'. An id-only match
    // keeps this row, which is how Playground traffic leaks into the numbers.
    const res = await auth(api().get('/api/v1/overview?range=24h')).expect(200);
    const names = (res.body.recent_activity as Array<{ agent_name: string }>).map(
      (r) => r.agent_name,
    );

    expect(names).not.toContain('Playground');
  });

  it('keeps ordinary traffic', async () => {
    const res = await auth(api().get('/api/v1/overview?range=24h')).expect(200);
    const names = (res.body.recent_activity as Array<{ agent_name: string }>).map(
      (r) => r.agent_name,
    );

    expect(names).toContain('excl-normal-agent');
  });

  it('keeps another tenant\u2019s agent that merely shares the name', async () => {
    // The other tenant's `Playground` agent is NOT a playground agent, so its
    // own dashboard must still show it. A bare `agent_name IN (playground
    // names)` match deletes it, and no SQL-shape assertion would notice.
    const ds = app.get(DataSource);
    // `sqlExcludePlayground` returns the KEEP predicate, so this counts the
    // rows the shipped helper lets through for the other tenant.
    const rows = (await ds.query(
      `SELECT count(*)::int AS kept FROM requests r
        WHERE r.tenant_id = $1 AND ${sqlExcludePlayground('r')}`,
      [OTHER_TENANT_ID],
    )) as Array<{ kept: number }>;

    expect(rows[0].kept).toBe(1);
  });

  it('keeps a row whose agent columns are both NULL', async () => {
    // Guards the COALESCE wrappers. Without them this row evaluates to NULL
    // and is filtered out, losing real traffic.
    const ds = app.get(DataSource);
    const rows = (await ds.query(
      `SELECT count(*)::int AS kept FROM requests r
        WHERE r.id = $1 AND ${sqlExcludePlayground('r')}`,
      [ORPHAN_REQUEST_ID],
    )) as Array<{ kept: number }>;

    expect(rows[0].kept).toBe(1);
  });

  it('charts exactly the rows the reference predicate keeps', async () => {
    const res = await auth(
      api().get('/api/v1/overview/autofix-timeseries?range=24h&by=disposition'),
    ).expect(200);
    const charted = (res.body.buckets as Array<{ counts: number[] }>).reduce(
      (sum, b) => sum + b.counts.reduce((a, c) => a + Number(c), 0),
      0,
    );

    const ds = app.get(DataSource);
    const rows = (await ds.query(
      `SELECT count(*) FILTER (WHERE NOT ${ORACLE})::int AS expected,
              count(*) FILTER (WHERE ${ORACLE})::int      AS excluded
         FROM requests r
        WHERE r.tenant_id = $1
          AND r.timestamp >= now() - interval '24 hours'
          AND (r.status IS NULL OR r.status NOT IN ('pending','cancelled'))`,
      [TEST_TENANT_ID],
    )) as Array<{ expected: number; excluded: number }>;

    // The fixture really does seed Playground traffic, so this is not vacuous.
    expect(rows[0].excluded).toBeGreaterThan(0);
    expect(charted).toBe(rows[0].expected);
  });
});
