import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { createTestApp, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';
import { AddRequestsAutofixHealedIndex1802200000000 } from '../src/database/migrations/1802200000000-AddRequestsAutofixHealedIndex';

/**
 * Exercises the real SQL against real Postgres. The unit specs mock the
 * DataSource entirely, so this is the only place a syntax error, a bad column
 * name, or an invalid index definition would surface.
 */

const SECRET = 'e2e-crm-metrics-secret-at-least-32-chars';
const HEALED_INDEX = 'IDX_requests_autofix_healed';
const TENANT_TIMESTAMP_INDEX = 'IDX_requests_tenant_timestamp';

const OWNER_ID = 'crm-owner-001';
const OWNER_EMAIL = 'healed.user@example.com';

/** Local wall clock, matching how the pg driver writes these naive columns. */
function localSqlTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

describe('Internal CRM metrics (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let previousMode: string | undefined;

  beforeAll(async () => {
    process.env['CRM_METRICS_SECRET'] = SECRET;
    // The migration and the module registration are both Cloud-only. Pin the
    // mode so this suite does not depend on whether the runner happens to look
    // containerised to `isSelfHosted()`.
    previousMode = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'cloud';
    app = await createTestApp();
    ds = app.get(DataSource);

    // Better Auth owns the `user` table and its migrations do not run in e2e.
    await ds.query(
      `CREATE TABLE IF NOT EXISTS "user" (
         id VARCHAR PRIMARY KEY,
         name VARCHAR,
         email VARCHAR,
         "emailVerified" BOOLEAN,
         "createdAt" TIMESTAMPTZ
       )`,
    );

    // The partial index lives in a migration, not on the entity, so
    // synchronize() never creates it. Run the real migration rather than a
    // copy of its DDL: a hand-copied index would keep passing even if the
    // migration drifted, which is exactly the defect this suite exists to
    // catch. CONCURRENTLY needs to be outside a transaction, and a bare
    // queryRunner autocommits.
    const runner = ds.createQueryRunner();
    try {
      await runner.connect();
      await new AddRequestsAutofixHealedIndex1802200000000().up(runner);
    } finally {
      await runner.release();
    }

    // The signups feed refuses to run without this one, because the lateral
    // degrades to a sequential scan of `requests` per row (22s and 6.9 GB of
    // reads, measured). Production gets it from migration 1801000000000, which
    // also creates the tables synchronize() has already built here — so run
    // just the index. It is a plain two-column btree with no partial predicate
    // to drift, unlike the healed index above.
    await ds.query(
      `CREATE INDEX IF NOT EXISTS "${TENANT_TIMESTAMP_INDEX}" ON "requests" ("tenant_id", "timestamp")`,
    );

    const [built] = (await ds.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [
      HEALED_INDEX,
    ])) as Array<{ indexdef: string }>;
    expect(built?.indexdef).toContain('INCLUDE (status)');
    expect(built?.indexdef).toContain(`WHERE ((autofix_status)::text = 'retry_succeeded'::text)`);
  });

  afterAll(async () => {
    await app.close();
    delete process.env['CRM_METRICS_SECRET'];
    // Restore rather than delete: e2e runs --runInBand, so every spec shares one
    // process, and a shell that exports MANIFEST_MODE would otherwise lose it
    // for every sibling suite that reads isSelfHosted().
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM agent_messages');
    await ds.query('DELETE FROM requests');
    await ds.query('DELETE FROM waitlist_claims');
    await ds.query('DELETE FROM "user"');
    await ds.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt")
       VALUES ($1, $2, $3, true, now() - interval '10 days')`,
      [OWNER_ID, 'Healed User', OWNER_EMAIL],
    );
    await ds.query(`UPDATE tenants SET owner_user_id = $1 WHERE id = $2`, [
      OWNER_ID,
      TEST_TENANT_ID,
    ]);
  });

  async function seedHealedRequest(ageDays: number, status = 'success'): Promise<void> {
    const requestId = uuid();
    const at = localSqlTimestamp(new Date(Date.now() - ageDays * 86_400_000));
    await ds.query(
      `INSERT INTO requests (id, tenant_id, agent_id, agent_name, timestamp, status, autofix_status)
       VALUES ($1, $2, $3, 'demo-agent', $4, $5, 'retry_succeeded')`,
      [requestId, TEST_TENANT_ID, TEST_AGENT_ID, at, status],
    );
    await ds.query(
      `INSERT INTO agent_messages (id, tenant_id, agent_id, agent_name, request_id, timestamp, provider, model, autofix_applied)
       VALUES ($1, $2, $3, 'demo-agent', $4, $5, $6, 'some-model', true)`,
      [uuid(), TEST_TENANT_ID, TEST_AGENT_ID, requestId, at, 'openai'],
    );
  }

  const get = (path: string) =>
    request(app.getHttpServer()).get(`/api/v1/internal/crm-metrics${path}`);

  /**
   * Results are memoised per window for 60s, which outlives this suite, so each
   * cohort assertion asks for its own `days` value. They are all far shorter
   * than the 40-day-old row seeded below, so the window itself never matters —
   * only that the cache keys differ.
   */
  let windowDays = 6;
  const nextWindow = () => `?days=${++windowDays}`;

  describe('auth', () => {
    it('rejects a request with no secret', async () => {
      await get('').expect(401);
    });

    it('rejects a request with the wrong secret', async () => {
      await get('').set('x-internal-secret', 'wrong').expect(401);
    });

    it('rejects the conversions route without the secret', async () => {
      await get('/conversions').expect(401);
    });
  });

  describe('validation', () => {
    it('rejects an out-of-range window', async () => {
      await get('?days=0').set('x-internal-secret', SECRET).expect(400);
      await get('?days=400').set('x-internal-secret', SECRET).expect(400);
    });

    it('rejects an undeclared query parameter', async () => {
      await get('?nope=1').set('x-internal-secret', SECRET).expect(400);
    });
  });

  describe('cohort', () => {
    it('returns a healed user with their counts', async () => {
      await seedHealedRequest(1);
      await seedHealedRequest(2);
      await seedHealedRequest(3);

      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        email: OWNER_EMAIL,
        name: 'Healed User',
        healed_recent: 3,
        healed_all: 3,
      });
    });

    it('counts older heals in the all-time total but not the window', async () => {
      await seedHealedRequest(1);
      await seedHealedRequest(40);

      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body[0]).toMatchObject({ healed_recent: 1, healed_all: 2 });
    });

    it('ignores a retry that succeeded on a request which still failed', async () => {
      await seedHealedRequest(1, 'failed');

      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toEqual([]);
    });

    it('omits users whose email is unverified', async () => {
      await seedHealedRequest(1);
      await ds.query(`UPDATE "user" SET "emailVerified" = false WHERE id = $1`, [OWNER_ID]);

      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toEqual([]);
    });

    it('omits internal addresses', async () => {
      await seedHealedRequest(1);
      await ds.query(`UPDATE "user" SET email = 'bruno@buddyweb.fr' WHERE id = $1`, [OWNER_ID]);

      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toEqual([]);
    });

    it('returns an empty list when nothing was healed', async () => {
      const res = await get(nextWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toEqual([]);
    });
  });

  describe('conversions', () => {
    it('returns waitlist claims in the window, lowercased', async () => {
      await ds.query(
        `INSERT INTO waitlist_claims (id, email, source, claimed_at) VALUES ($1, $2, $3, now())`,
        [uuid(), 'Converted@Example.com', 'cloud'],
      );
      await ds.query(
        `INSERT INTO waitlist_claims (id, email, source, claimed_at)
         VALUES ($1, $2, $3, now() - interval '200 days')`,
        [uuid(), 'ancient@example.com', 'cloud'],
      );

      const res = await get('/conversions?days=90').set('x-internal-secret', SECRET).expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ email: 'converted@example.com', source: 'cloud' });
    });
  });

  describe('signups', () => {
    // Same cache caveat as the cohort block: distinct windows per assertion.
    let signupWindow = 100;
    const nextSignupWindow = () => `/signups?days=${++signupWindow}`;

    /** A corporate address, so the filters in crm-metrics.filters.ts keep it. */
    const addUser = async (
      id: string,
      email: string,
      opts: { tenantId?: string; name?: string } = {},
    ): Promise<void> => {
      await ds.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt")
         VALUES ($1, $2, $3, true, now() - interval '5 days')`,
        [id, opts.name ?? 'Ada Lovelace', email],
      );
      if (opts.tenantId) {
        await ds.query(`UPDATE tenants SET owner_user_id = $1 WHERE id = $2`, [id, opts.tenantId]);
      }
    };

    interface SignupRow {
      email: string;
      last_request_at: string | null;
    }

    const signupFor = (body: unknown[], email: string): SignupRow | undefined =>
      (body as SignupRow[]).find((row) => row.email === email);

    it('returns a corporate signup that never sent a request', async () => {
      await addUser('signup-1', 'ada@acmecorp.io', { tenantId: TEST_TENANT_ID });

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'ada@acmecorp.io')).toMatchObject({
        email: 'ada@acmecorp.io',
        name: 'Ada Lovelace',
        domain: 'acmecorp.io',
        last_request_at: null,
        has_traffic: false,
        domain_signups: 1,
      });
    });

    it('keeps a verified user who never created a tenant', async () => {
      // The regression this exists for. Tenants are created lazily on first
      // agent creation, so this user has no tenant row at all — and is exactly
      // who the campaign targets. An inner join would drop them silently.
      await addUser('signup-orphan', 'grace@orphancorp.io');

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'grace@orphancorp.io')).toMatchObject({
        has_traffic: false,
        last_request_at: null,
      });
    });

    it('marks a signup whose tenant has sent a request', async () => {
      await addUser('signup-2', 'ada@trafficcorp.io', { tenantId: TEST_TENANT_ID });
      await ds.query(
        `INSERT INTO requests (id, tenant_id, agent_id, agent_name, timestamp, status)
         VALUES ($1, $2, $3, 'demo-agent', $4, 'success')`,
        [uuid(), TEST_TENANT_ID, TEST_AGENT_ID, localSqlTimestamp(new Date())],
      );

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);
      const signup = signupFor(res.body, 'ada@trafficcorp.io');

      expect(signup).toMatchObject({ has_traffic: true });
      expect(signup?.last_request_at).not.toBeNull();
    });

    it('counts people sharing a domain', async () => {
      await addUser('signup-3a', 'ada@teamcorp.io');
      await addUser('signup-3b', 'grace@teamcorp.io');

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'ada@teamcorp.io')).toMatchObject({ domain_signups: 2 });
      expect(signupFor(res.body, 'grace@teamcorp.io')).toMatchObject({ domain_signups: 2 });
    });

    it('omits consumer mailboxes and role addresses', async () => {
      await addUser('signup-4', 'ada@gmail.com');
      await addUser('signup-5', 'support@acmecorp.io');

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'ada@gmail.com')).toBeUndefined();
      expect(signupFor(res.body, 'support@acmecorp.io')).toBeUndefined();
    });

    it('omits anyone who claimed the pivot waiting list', async () => {
      // Waitlist people are contacted by hand. Match is case-insensitive,
      // because the claim form and the auth record need not agree on case.
      await addUser('signup-wl', 'ada@waitlisted.io');
      await ds.query(
        `INSERT INTO waitlist_claims (id, email, source, claimed_at) VALUES ($1, $2, 'self-hosted', now())`,
        [uuid(), 'Ada@Waitlisted.io'],
      );

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'ada@waitlisted.io')).toBeUndefined();
    });

    it('omits unverified signups', async () => {
      await ds.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt")
         VALUES ($1, 'Un Verified', $2, false, now())`,
        ['signup-6', 'ada@unverifiedcorp.io'],
      );

      const res = await get(nextSignupWindow()).set('x-internal-secret', SECRET).expect(200);

      expect(signupFor(res.body, 'ada@unverifiedcorp.io')).toBeUndefined();
    });

    it('requires the secret', async () => {
      await get('/signups').expect(401);
    });
  });
});
