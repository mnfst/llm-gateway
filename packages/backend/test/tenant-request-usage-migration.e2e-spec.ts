import { DataSource } from 'typeorm';
import { AddTenantRequestUsage1801300000000 } from '../src/database/migrations/1801300000000-AddTenantRequestUsage';
import { PlanService } from '../src/billing/plan.service';
import { REQUEST_QUOTA_RESET_AT_ENV } from '../src/billing/request-quota-window';
import { toLocalSqlTimestamp, toSqlTimestamp } from '../src/common/utils/postgres-sql';

const TENANT = 'usage-tenant';
const AGENT = 'usage-agent';
const PLAYGROUND = 'usage-playground';

// A tenant's quota window is `GREATEST(date_trunc('month', row_timestamp),
// PLAN_REQUEST_QUOTA_RESET_AT)` — see the trigger in the migration and
// `requestQuotaWindowStartMs()`. The shipped reset default (2026-07-09) only
// *is* that window while the clock sits inside July 2026: from 2026-08-01 on,
// the trigger buckets live rows into the calendar-month window while a fixture
// pinned to the reset instant keeps reading the July row, so every "live"
// assertion silently saw only the historical baseline. Anchor the whole fixture
// to a reset instant inside the current window instead, so these tests pin the
// counter's behaviour rather than the month they were written in.
const NOW_MS = Date.now();
const NOW = new Date(NOW_MS);
const MONTH_START_MS = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1);
// Clamped to the month start so the reset never precedes the calendar window it
// is meant to dominate (otherwise `GREATEST` would pick the month start back).
const RESET_AT_MS = Math.max(NOW_MS - 2 * 60 * 60 * 1000, MONTH_START_MS);
const WINDOW_START = toSqlTimestamp(new Date(RESET_AT_MS));
// Historical fixture rows: inside the quota window, before the cutover the
// migration stamps with `clock_timestamp()` when it runs.
const REQUEST_TIMESTAMP = toLocalSqlTimestamp(new Date((RESET_AT_MS + NOW_MS) / 2));
let afterCutoverTimestamp: string;
let futureTimestamp: string;
let futureWindow: string;

async function runMigration(
  ds: DataSource,
  direction: 'up' | 'down',
  migration = new AddTenantRequestUsage1801300000000(),
): Promise<void> {
  const queryRunner = ds.createQueryRunner();
  try {
    await migration[direction](queryRunner);
  } finally {
    await queryRunner.release();
  }
}

async function insertRequest(
  ds: DataSource,
  id: string,
  agentId = AGENT,
  timestamp = REQUEST_TIMESTAMP,
): Promise<void> {
  await ds.query(
    `INSERT INTO "requests" ("id", "tenant_id", "agent_id", "timestamp", "status")
     VALUES ($1, $2, $3, $4, 'success')`,
    [id, TENANT, agentId, timestamp],
  );
}

async function insertAttempt(
  ds: DataSource,
  id: string,
  opts: {
    requestId?: string | null;
    agentId?: string;
    timestamp?: string;
    superseded?: boolean;
    errorOrigin?: string | null;
  } = {},
): Promise<void> {
  await ds.query(
    `INSERT INTO "agent_messages" (
       "id", "request_id", "tenant_id", "agent_id", "agent_name", "timestamp",
       "status", "input_tokens", "output_tokens", "cache_read_tokens",
       "cache_creation_tokens", "superseded", "error_origin"
     )
     VALUES ($1, $2, $3, $4, $4, $5, 'success', 0, 0, 0, 0, $6, $7)`,
    [
      id,
      opts.requestId ?? null,
      TENANT,
      opts.agentId ?? AGENT,
      opts.timestamp ?? REQUEST_TIMESTAMP,
      opts.superseded ?? false,
      opts.errorOrigin ?? null,
    ],
  );
}

async function usageRow(
  ds: DataSource,
  windowStart = WINDOW_START,
): Promise<{ count: number; initialized: boolean } | null> {
  const rows: Array<{ request_count: string; baseline_counted: boolean }> = await ds.query(
    `SELECT "request_count", "baseline_counted"
       FROM "tenant_request_usage"
      WHERE "tenant_id" = $1
        AND "window_start" = $2`,
    [TENANT, windowStart],
  );
  if (!rows[0]) return null;
  return {
    count: Number(rows[0].request_count),
    initialized: rows[0].baseline_counted,
  };
}

describe('AddTenantRequestUsage migration (e2e)', () => {
  let ds: DataSource;
  let originalManifestMode: string | undefined;
  let originalQuotaResetAt: string | undefined;

  beforeAll(async () => {
    originalManifestMode = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'cloud';
    // Must be set before the migration runs: `up()` reads it to build the
    // trigger's window expression.
    originalQuotaResetAt = process.env[REQUEST_QUOTA_RESET_AT_ENV];
    process.env[REQUEST_QUOTA_RESET_AT_ENV] = new Date(RESET_AT_MS).toISOString();
    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    await runMigration(ds, 'down');

    await ds.query(`INSERT INTO "tenants" ("id", "name", "is_active") VALUES ($1, $1, true)`, [
      TENANT,
    ]);
    await ds.query(
      `INSERT INTO "agents" ("id", "tenant_id", "name", "display_name", "is_playground")
       VALUES ($1, $3, $1, $1, false), ($2, $3, $2, $2, true)`,
      [AGENT, PLAYGROUND, TENANT],
    );

    await insertRequest(ds, 'seed-linked');
    await insertAttempt(ds, 'seed-linked-attempt', { requestId: 'seed-linked' });

    await insertRequest(ds, 'seed-playground', PLAYGROUND);
    await insertAttempt(ds, 'seed-playground-attempt', {
      requestId: 'seed-playground',
      agentId: PLAYGROUND,
    });

    await insertRequest(ds, 'seed-zero-attempt');
    await insertAttempt(ds, 'seed-legacy');
    await insertAttempt(ds, 'seed-legacy-superseded', { superseded: true });
    await insertAttempt(ds, 'seed-manifest-rejection', { errorOrigin: 'policy' });

    await runMigration(ds, 'up');
    const cutoverTimes = await ds.query(
      `SELECT
         to_char(
           (
             ("completed_at" + interval '1 minute') AT TIME ZONE 'UTC'
           ) AT TIME ZONE $1::text,
           'YYYY-MM-DD HH24:MI:SS'
         ) AS "afterCutover",
         to_char(
           (
             (
               date_trunc('month', "completed_at") + interval '1 month 12 hours'
             ) AT TIME ZONE 'UTC'
           ) AT TIME ZONE $1::text,
           'YYYY-MM-DD HH24:MI:SS'
         ) AS "futureTimestamp",
         to_char(
           date_trunc('month', "completed_at") + interval '1 month',
           'YYYY-MM-DD HH24:MI:SS'
         ) AS "futureWindow"
       FROM "backfill_state"
      WHERE "name" = 'tenant_request_usage_cutover_v1'`,
      [Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'],
    );
    afterCutoverTimestamp = cutoverTimes[0].afterCutover;
    futureTimestamp = cutoverTimes[0].futureTimestamp;
    futureWindow = cutoverTimes[0].futureWindow;
  }, 60_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (originalManifestMode === undefined) {
      delete process.env['MANIFEST_MODE'];
    } else {
      process.env['MANIFEST_MODE'] = originalManifestMode;
    }
    if (originalQuotaResetAt === undefined) {
      delete process.env[REQUEST_QUOTA_RESET_AT_ENV];
    } else {
      process.env[REQUEST_QUOTA_RESET_AT_ENV] = originalQuotaResetAt;
    }
  });

  it('publishes only schema and cutover metadata during migration', async () => {
    expect(await usageRow(ds)).toBeNull();

    const requests = await ds.query(
      `SELECT "id", "quota_counted"
         FROM "requests"
        WHERE "id" LIKE 'seed-%'
     ORDER BY "id"`,
    );
    expect(requests).toEqual([
      { id: 'seed-linked', quota_counted: false },
      { id: 'seed-playground', quota_counted: false },
      { id: 'seed-zero-attempt', quota_counted: false },
    ]);

    const legacyColumn = await ds.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_name = 'agent_messages'
          AND column_name = 'legacy_quota_counted'`,
    );
    expect(legacyColumn).toEqual([]);
  });

  it('accepts the installed trigger timezone at Cloud boot', async () => {
    const previousStripeEnv = {
      secret: process.env['STRIPE_SECRET_KEY'],
      webhook: process.env['STRIPE_WEBHOOK_SECRET'],
      price: process.env['STRIPE_PRO_PRICE_ID'],
    };
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
    process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';
    try {
      await expect(new PlanService({} as never, ds).onModuleInit()).resolves.toBeUndefined();
    } finally {
      if (previousStripeEnv.secret === undefined) delete process.env['STRIPE_SECRET_KEY'];
      else process.env['STRIPE_SECRET_KEY'] = previousStripeEnv.secret;
      if (previousStripeEnv.webhook === undefined) delete process.env['STRIPE_WEBHOOK_SECRET'];
      else process.env['STRIPE_WEBHOOK_SECRET'] = previousStripeEnv.webhook;
      if (previousStripeEnv.price === undefined) delete process.env['STRIPE_PRO_PRICE_ID'];
      else process.env['STRIPE_PRO_PRICE_ID'] = previousStripeEnv.price;
    }
  });

  it('initializes the exact historical baseline once in the background', async () => {
    const planService = new PlanService({} as never, ds);

    // The hot path returns the live counter immediately (no row yet → 0) and
    // schedules the one-shot historical baseline off the request path.
    expect(await planService.countRequestsSince(TENANT, MONTH_START_MS)).toBe(0);

    // The background init lands the exact baseline and flips the flag.
    const deadline = Date.now() + 10_000;
    let row = await usageRow(ds);
    while (!row?.initialized && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await usageRow(ds);
    }
    expect(row).toEqual({ count: 2, initialized: true });

    // Steady state: subsequent reads serve the initialized counter directly.
    expect(await planService.countRequestsSince(TENANT, MONTH_START_MS)).toBe(2);
    expect(await usageRow(ds)).toEqual({ count: 2, initialized: true });
  });

  it('counts each live Request once and keeps exclusions out', async () => {
    await insertRequest(ds, 'live-request', AGENT, afterCutoverTimestamp);
    await insertAttempt(ds, 'live-attempt-1', {
      requestId: 'live-request',
      timestamp: afterCutoverTimestamp,
    });
    await insertAttempt(ds, 'live-attempt-2', {
      requestId: 'live-request',
      timestamp: afterCutoverTimestamp,
    });
    expect(await usageRow(ds)).toEqual({ count: 3, initialized: true });

    await insertRequest(ds, 'live-playground', PLAYGROUND, afterCutoverTimestamp);
    await insertAttempt(ds, 'live-playground-attempt', {
      requestId: 'live-playground',
      agentId: PLAYGROUND,
      timestamp: afterCutoverTimestamp,
    });
    await insertRequest(ds, 'live-manifest-rejection', AGENT, afterCutoverTimestamp);
    await insertAttempt(ds, 'live-manifest-rejection-attempt', {
      requestId: 'live-manifest-rejection',
      timestamp: afterCutoverTimestamp,
      errorOrigin: 'policy',
    });

    expect(await usageRow(ds)).toEqual({ count: 3, initialized: true });
  });

  it('does not double-count historical attempts that are linked or retried after cutover', async () => {
    await insertRequest(ds, 'legacy-parent');
    await ds.query(
      `UPDATE "agent_messages"
          SET "request_id" = $1, "attempt_number" = 1
        WHERE "id" = 'seed-legacy'`,
      ['legacy-parent'],
    );

    await insertAttempt(ds, 'seed-linked-post-cutover-fallback', {
      requestId: 'seed-linked',
      timestamp: afterCutoverTimestamp,
    });
    expect(await usageRow(ds)).toEqual({ count: 3, initialized: true });

    const historicalRequests = await ds.query(
      `SELECT "id", "quota_counted"
         FROM "requests"
        WHERE "id" IN ('legacy-parent', 'seed-linked')
     ORDER BY "id"`,
    );
    expect(historicalRequests).toEqual([
      { id: 'legacy-parent', quota_counted: false },
      { id: 'seed-linked', quota_counted: true },
    ]);
  });

  it('counts a post-cutover unlinked attempt when the request backfill links it', async () => {
    await insertRequest(ds, 'live-link-parent', AGENT, afterCutoverTimestamp);
    await insertAttempt(ds, 'live-link-attempt', { timestamp: afterCutoverTimestamp });
    await ds.query(
      `UPDATE "agent_messages"
          SET "request_id" = $1, "attempt_number" = 1
        WHERE "id" = 'live-link-attempt'`,
      ['live-link-parent'],
    );

    expect(await usageRow(ds)).toEqual({ count: 4, initialized: true });
  });

  it('creates future quota windows fully initialized without a historical scan', async () => {
    await insertRequest(ds, 'future-request', AGENT, futureTimestamp);
    await insertAttempt(ds, 'future-attempt', {
      requestId: 'future-request',
      timestamp: futureTimestamp,
    });

    expect(await usageRow(ds, futureWindow)).toEqual({ count: 1, initialized: true });
  });

  it('fails within the lock timeout instead of queueing a busy deployment', async () => {
    const blocker = ds.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query(`LOCK TABLE "requests" IN ACCESS SHARE MODE`);
      const startedAt = Date.now();

      await expect(runMigration(ds, 'up')).rejects.toMatchObject({ code: '55P03' });

      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(3_000);
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
  });
});

describe('AddTenantRequestUsage self-hosted migration (e2e)', () => {
  let ds: DataSource;
  let originalManifestMode: string | undefined;

  beforeAll(async () => {
    originalManifestMode = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'selfhosted';
    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
  }, 60_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (originalManifestMode === undefined) {
      delete process.env['MANIFEST_MODE'];
    } else {
      process.env['MANIFEST_MODE'] = originalManifestMode;
    }
  });

  it('does not create the Cloud quota counter schema or trigger', async () => {
    const artifacts = await ds.query(`
      SELECT
        to_regclass('tenant_request_usage') AS "usageTable",
        EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_name = 'requests'
             AND column_name = 'quota_counted'
        ) AS "requestFlag",
        EXISTS (
          SELECT 1
            FROM pg_trigger
           WHERE tgname = 'TRG_agent_messages_count_tenant_request_usage'
        ) AS "usageTrigger"
    `);

    expect(artifacts).toEqual([
      {
        usageTable: null,
        requestFlag: false,
        usageTrigger: false,
      },
    ]);
  });
});
