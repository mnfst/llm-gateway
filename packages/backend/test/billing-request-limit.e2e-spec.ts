import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_OTLP_KEY, TEST_USER_ID } from './helpers';
import { PlanService } from '../src/billing/plan.service';
import { REQUEST_USAGE_CUTOVER_STATE } from '../src/billing/request-quota-window';

// Enforces the monthly routed-request cap on the /v1/* proxy. The schema-only
// harness enables billing after app init because it does not install the Cloud
// quota trigger. We drive the block with PLAN_LIMIT_FREE_REQUESTS=0 so the gate
// trips before any upstream call. Env is restored in afterAll.
let app: INestApplication;
let ds: DataSource;

const envSnapshots: Record<string, string | undefined> = {};
const BILLING_ENV_VARS = [
  'MANIFEST_MODE',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRO_PRICE_ID',
  'PLAN_LIMIT_FREE_REQUESTS',
];

/** Poll a COUNT query until it reaches `minimum` (the blocked-request rows are
 *  written asynchronously, after the 402 has already been sent). Returns the
 *  last observed count either way so assertions still fail loudly on timeout. */
async function waitForCount(sql: string, params: unknown[], minimum: number): Promise<number> {
  const deadline = Date.now() + 1000;
  let count = 0;
  do {
    const rows = await ds.query(sql, params);
    count = rows[0].n;
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return count;
}

const MANIFEST_BLOCK_COUNT_SQL = `SELECT COUNT(*)::int AS n
     FROM requests
    WHERE tenant_id = $1
      AND error_origin = 'policy'
      AND error_class = 'plan_request_limit_exceeded'
      AND error_http_status = 402`;

async function waitForManifestBlockCount(tenantId: string, minimum: number): Promise<number> {
  return waitForCount(MANIFEST_BLOCK_COUNT_SQL, [tenantId], minimum);
}

beforeAll(async () => {
  for (const key of BILLING_ENV_VARS) envSnapshots[key] = process.env[key];
  process.env['MANIFEST_MODE'] = 'cloud';
  process.env['PLAN_LIMIT_FREE_REQUESTS'] = '0';
  delete process.env['STRIPE_SECRET_KEY'];
  delete process.env['STRIPE_WEBHOOK_SECRET'];
  delete process.env['STRIPE_PRO_PRICE_ID'];

  app = await createTestApp();
  ds = app.get(DataSource);
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_dummy';
  process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_dummy';
  process.env['STRIPE_PRO_PRICE_ID'] = 'price_dummy';
  // better-auth's runMigrations doesn't run in the e2e harness, so create the
  // Stripe plugin's subscription table shape ourselves (PlanService.getPlan
  // queries it). camelCase quoted columns match the real schema.
  await ds.query(`CREATE TABLE IF NOT EXISTS "subscription" (
    "id" text PRIMARY KEY,
    "plan" text NOT NULL,
    "referenceId" text NOT NULL,
    "stripeCustomerId" text,
    "stripeSubscriptionId" text,
    "status" text NOT NULL,
    "periodStart" timestamptz,
    "periodEnd" timestamptz,
    "cancelAtPeriodEnd" boolean DEFAULT false
  )`);
  await ds.query(
    `INSERT INTO "backfill_state" ("name", "completed_at")
     VALUES ($1, clock_timestamp() AT TIME ZONE 'UTC')
     ON CONFLICT ("name") DO NOTHING`,
    [REQUEST_USAGE_CUTOVER_STATE],
  );
});

afterAll(async () => {
  if (ds) {
    await ds.query(`DELETE FROM "subscription" WHERE "referenceId" = $1`, [TEST_USER_ID]);
  }
  for (const key of BILLING_ENV_VARS) {
    if (envSnapshots[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshots[key];
  }
  if (app) await app.close();
});

describe('request limit gate (/v1 proxy)', () => {
  // Every case sets its own plan. A subscription row left by a killed run would
  // otherwise turn the Free cases into Pro or fail a fixed-id INSERT.
  beforeEach(async () => {
    await ds.query(`DELETE FROM "subscription" WHERE "referenceId" = $1`, [TEST_USER_ID]);
  });

  it('blocks a free tenant over the monthly request cap with a real 402 for tool callers', async () => {
    const tenantRows = await ds.query(`SELECT id FROM tenants WHERE owner_user_id = $1 LIMIT 1`, [
      TEST_USER_ID,
    ]);
    const tenantId = tenantRows[0].id;
    const blocksBefore = await ds.query(
      `SELECT COUNT(*)::int AS n
         FROM requests
        WHERE tenant_id = $1
          AND error_origin = 'policy'
          AND error_class = 'plan_request_limit_exceeded'
          AND error_http_status = 402`,
      [tenantId],
    );
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .set('Accept', 'application/json')
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
      .expect(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REQUESTS');
    expect(res.body.error.type).toBe('insufficient_quota');
    expect(res.body.error.message).toContain('Upgrade to Pro');
    expect(res.body.limit).toBe(0);
    expect(await waitForManifestBlockCount(tenantId, blocksBefore[0].n + 1)).toBe(
      blocksBefore[0].n + 1,
    );
  });

  it('records the blocked request as a visible Manifest failure without counting it toward quota', async () => {
    const tenantRows = await ds.query(`SELECT id FROM tenants WHERE owner_user_id = $1 LIMIT 1`, [
      TEST_USER_ID,
    ]);
    const tenantId = tenantRows[0].id;
    const monthStartMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    const planService = app.get(PlanService);
    const billableBefore = await planService.countRequestsSince(tenantId, monthStartMs);
    const before = await ds.query(`SELECT COUNT(*)::int AS n FROM requests WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const attemptsBefore = await ds.query(
      `SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id = $1`,
      [tenantId],
    );
    const manifestBlocksBefore = await ds.query(
      `SELECT COUNT(*)::int AS n
         FROM requests
        WHERE tenant_id = $1
          AND error_origin = 'policy'
          AND error_class = 'plan_request_limit_exceeded'
          AND error_http_status = 402`,
      [tenantId],
    );
    await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .set('Accept', 'application/json')
      .send({ model: 'auto', messages: [{ role: 'user', content: 'again' }] })
      .expect(402);
    const manifestBlocksAfter = await waitForManifestBlockCount(
      tenantId,
      manifestBlocksBefore[0].n + 1,
    );
    const after = await ds.query(`SELECT COUNT(*)::int AS n FROM requests WHERE tenant_id = $1`, [
      tenantId,
    ]);
    // The attempt row is a separate asynchronous insert from the requests row
    // the block-count wait already covered — poll it too, or a slow runner
    // reads 1 attempt where 2 have been ordered (the CI flake this fixes).
    const attemptsAfterN = await waitForCount(
      `SELECT COUNT(*)::int AS n FROM agent_messages WHERE tenant_id = $1`,
      [tenantId],
      attemptsBefore[0].n + 1,
    );
    const latestBlock = await ds.query(
      `SELECT status, error_origin, error_class, error_http_status, error_code
         FROM requests
        WHERE tenant_id = $1
          AND error_origin = 'policy'
          AND error_class = 'plan_request_limit_exceeded'
          AND error_http_status = 402
        ORDER BY timestamp DESC
        LIMIT 1`,
      [tenantId],
    );
    const billableAfter = await planService.countRequestsSince(tenantId, monthStartMs);

    expect(after[0].n).toBe(before[0].n + 1);
    expect(attemptsAfterN).toBe(attemptsBefore[0].n + 1);
    expect(manifestBlocksAfter).toBe(manifestBlocksBefore[0].n + 1);
    expect(latestBlock[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error_origin: 'policy',
        error_class: 'plan_request_limit_exceeded',
        error_http_status: 402,
        error_code: 'M204',
      }),
    );
    expect(billableAfter).toBe(billableBefore);
  });

  // A failed renewal leaves the subscription past_due while Stripe retries it.
  // Showing that tenant as Free offered "Upgrade", and checkout then started a
  // second subscription next to the one still being retried.
  it.each([
    ['active', 'pro'],
    ['trialing', 'pro'],
    ['past_due', 'pro'],
    ['unpaid', 'free'],
    ['canceled', 'free'],
    ['incomplete', 'free'],
    ['incomplete_expired', 'free'],
  ])('resolves a %s pro subscription to the %s plan', async (status, expected) => {
    const tenantRows = await ds.query(`SELECT id FROM tenants WHERE owner_user_id = $1 LIMIT 1`, [
      TEST_USER_ID,
    ]);
    try {
      await ds.query(
        `INSERT INTO "subscription" ("id", "plan", "referenceId", "status") VALUES ('sub-status-e2e', 'pro', $1, $2)`,
        [TEST_USER_ID, status],
      );
      const plan = await app
        .get(PlanService)
        .getPlan({ tenantId: tenantRows[0].id, userId: TEST_USER_ID });
      expect(plan).toBe(expected);
    } finally {
      await ds.query(`DELETE FROM "subscription" WHERE "id" = 'sub-status-e2e'`);
    }
  });

  it('allows requests once the tenant is on an active pro subscription (unlimited)', async () => {
    await ds.query(
      `INSERT INTO "subscription" ("id", "plan", "referenceId", "status") VALUES ('sub-req-e2e-1', 'pro', $1, 'active')`,
      [TEST_USER_ID],
    );
    // Pro is unlimited, so the request-limit gate must NOT return 402. The
    // request proceeds past the gate (it may fail downstream for lack of a real
    // provider, but never with our PLAN_LIMIT_REQUESTS block).
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_OTLP_KEY}`)
      .set('Accept', 'application/json')
      .send({ model: 'auto', messages: [{ role: 'user', content: 'pro' }] });
    expect(res.status).not.toBe(402);
  });
});
