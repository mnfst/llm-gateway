import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CrmMetricsService } from './crm-metrics.service';
import { toLocalSqlTimestamp } from '../common/utils/postgres-sql';

const NOW = new Date('2026-09-04T12:00:00.000Z');

interface Scripted {
  index?: unknown[];
  cohort?: unknown[];
  claims?: unknown[];
  signups?: unknown[];
}

function cohortRow(over: Record<string, unknown> = {}) {
  return {
    email: 'matheus@example.com',
    user_name: 'Matheus Vitorio',
    tenant_id: 'tenant-a',
    healed_recent: '260',
    healed_all: '1241',
    first_heal_at: '2026-07-30T15:17:31.000Z',
    last_heal_at: '2026-09-04T09:47:30.000Z',
    ...over,
  };
}

function signupRow(over: Record<string, unknown> = {}) {
  return {
    email: 'ada@stripe.com',
    user_name: 'Ada Lovelace',
    signed_up_at: '2026-08-01T10:00:00.000Z',
    last_request_at: null,
    ...over,
  };
}

describe('CrmMetricsService', () => {
  let query: jest.Mock;
  let commitTransaction: jest.Mock;
  let rollbackTransaction: jest.Mock;
  let release: jest.Mock;
  let connect: jest.Mock;
  let startTransaction: jest.Mock;
  let service: CrmMetricsService;
  let scripted: Scripted;

  function setup(next: Scripted = {}): void {
    scripted = { index: [{ '?column?': 1 }], ...next };
    query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SET LOCAL')) return Promise.resolve([]);
      if (sql.includes('pg_index')) return Promise.resolve(scripted.index ?? []);
      // Checked before the cohort branch: both queries join `tenants t`.
      if (sql.includes('WITH signups AS MATERIALIZED'))
        return Promise.resolve(scripted.signups ?? []);
      if (sql.includes('JOIN tenants t')) return Promise.resolve(scripted.cohort ?? []);
      if (sql.includes('FROM waitlist_claims')) return Promise.resolve(scripted.claims ?? []);
      throw new Error(`unexpected SQL: ${sql}`);
    });
    commitTransaction = jest.fn();
    rollbackTransaction = jest.fn();
    release = jest.fn();
    connect = jest.fn();
    startTransaction = jest.fn();
    const runner = {
      connect,
      startTransaction,
      commitTransaction,
      rollbackTransaction,
      release,
      query,
    };
    service = new CrmMetricsService({ createQueryRunner: () => runner } as unknown as DataSource);
  }

  const sqlFor = (needle: string): string =>
    query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes(needle)) ?? '';
  const paramsFor = (needle: string): unknown[] =>
    query.mock.calls.find(([sql]) => String(sql).includes(needle))?.[1] ?? [];

  beforeEach(() => setup());

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('transaction handling', () => {
    it('bounds the work with transaction-scoped timeouts', async () => {
      await service.getHealedCohort(7, NOW);

      expect(sqlFor('lock_timeout')).toBe(`SET LOCAL lock_timeout = '5000ms'`);
      expect(sqlFor('statement_timeout')).toBe(`SET LOCAL statement_timeout = '1500ms'`);
      expect(commitTransaction).toHaveBeenCalled();
    });

    it('rolls back and releases the runner when a query fails', async () => {
      setup();
      query.mockRejectedValueOnce(new Error('boom'));

      await expect(service.getHealedCohort(7, NOW)).rejects.toThrow('boom');
      expect(rollbackTransaction).toHaveBeenCalled();
      expect(commitTransaction).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    });

    it('releases the runner on the happy path too', async () => {
      await service.getHealedCohort(7, NOW);

      expect(release).toHaveBeenCalled();
    });

    it('opens the transaction before setting the timeouts, and commits after the work', async () => {
      setup({ cohort: [cohortRow()] });

      await service.getHealedCohort(7, NOW);

      // `SET LOCAL` outside a transaction is silently a no-op, so hoisting
      // these above startTransaction would disable both bounds without
      // changing a single line of SQL text.
      expect(connect.mock.invocationCallOrder[0]).toBeLessThan(
        startTransaction.mock.invocationCallOrder[0],
      );
      expect(startTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        query.mock.invocationCallOrder[0],
      );
      expect(query.mock.calls.slice(0, 2).map(([sql]) => String(sql))).toEqual([
        `SET LOCAL lock_timeout = '5000ms'`,
        `SET LOCAL statement_timeout = '1500ms'`,
      ]);
      expect(commitTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(
        query.mock.invocationCallOrder[query.mock.invocationCallOrder.length - 1],
      );
    });
  });

  describe('index guard', () => {
    it('refuses to run an unindexed scan when the index is missing or invalid', async () => {
      setup({ index: [], cohort: [cohortRow()] });

      const error = await service.getHealedCohort(7, NOW).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toContain('IDX_requests_autofix_healed');
      // Cohort rows were scripted, so an empty result here would mean the
      // guard let the unindexed scan run and merely found nothing.
      expect(sqlFor('JOIN tenants t')).toBe('');
      expect(rollbackTransaction).toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    });

    it('reports the outage as a rejection, never as an empty cohort', async () => {
      setup({ cohort: [] });
      await expect(service.getHealedCohort(7, NOW)).resolves.toEqual([]);

      setup({ index: [] });
      const outcome = await service.getHealedCohort(7, NOW).then(
        (users) => ({ resolved: users }),
        (error: unknown) => ({ error }),
      );

      // "Nobody was healed" and "the index is gone" must not look alike to the
      // CRM: a `catch { return [] }` here would silently empty the feed.
      expect(outcome).toEqual({ error: expect.any(ServiceUnavailableException) });
    });

    it('probes for the index by name', async () => {
      await service.getHealedCohort(7, NOW);

      expect(paramsFor('pg_index')).toEqual(['IDX_requests_autofix_healed']);
    });
  });

  describe('cohort window', () => {
    it('bounds the cohort query with a local wall-clock cutoff, not UTC', async () => {
      setup({ cohort: [cohortRow()] });

      await service.getHealedCohort(7, NOW);

      const expected = toLocalSqlTimestamp(new Date(NOW.getTime() - 7 * 86_400_000));
      expect(paramsFor('JOIN tenants t')).toEqual([expected]);
    });

    it('never joins agent_messages: that breakdown cost 1.1s against a 1.5s timeout', async () => {
      setup({ cohort: [cohortRow()] });

      await service.getHealedCohort(365, NOW);

      // The provider join scaled with the window and 500d the endpoint at 365
      // days. It fed a field the outreach email no longer uses.
      expect(sqlFor('agent_messages')).toBe('');
    });

    it('defaults to the current time when no clock is injected', async () => {
      setup({ cohort: [cohortRow()] });

      await expect(service.getHealedCohort(7)).resolves.toHaveLength(1);
      await expect(service.getConversions(90)).resolves.toEqual([]);
      await expect(service.getCorporateSignups(365)).resolves.toEqual([]);

      const cutoff = paramsFor('JOIN tenants t')[0] as string;
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('applies the canonical healed predicate, not autofix_status alone', async () => {
      await service.getHealedCohort(7, NOW);

      const sql = sqlFor('JOIN tenants t');
      expect(sql).toContain(`r.autofix_status = 'retry_succeeded'`);
      expect(sql).toContain('r.status IS NULL OR r.status IN');
      expect(sql).toContain('u."emailVerified" = true');
    });

    it('counts every heal ever, but only surfaces people healed inside the window', async () => {
      await service.getHealedCohort(7, NOW);

      const sql = sqlFor('JOIN tenants t');
      expect(sql).toContain('count(*) FILTER (WHERE r.timestamp > $1)');
      expect(sql).toContain('HAVING count(*) FILTER (WHERE r.timestamp > $1) > 0');
      // `healed_all` is deliberately unbounded. Narrowing the WHERE by the
      // cutoff would collapse it onto `healed_recent` and quietly turn the
      // "heals since Autofix shipped" number into a duplicate of the window.
      expect(sql).not.toContain('AND r.timestamp >');
    });
  });

  describe('cohort shaping', () => {
    it('maps a single person', async () => {
      setup({ cohort: [cohortRow()] });

      const [user] = await service.getHealedCohort(7, NOW);

      expect(user).toEqual({
        email: 'matheus@example.com',
        name: 'Matheus Vitorio',
        healed_recent: 260,
        healed_all: 1241,
        first_heal_at: '2026-07-30T15:17:31.000Z',
        last_heal_at: '2026-09-04T09:47:30.000Z',
      });
    });

    it('sums a person who owns more than one tenant', async () => {
      setup({
        cohort: [
          cohortRow({ tenant_id: 'tenant-a', healed_recent: '10', healed_all: '20' }),
          cohortRow({
            tenant_id: 'tenant-b',
            user_name: null,
            healed_recent: '5',
            healed_all: '7',
            first_heal_at: '2026-07-01T00:00:00.000Z',
            last_heal_at: '2026-09-05T00:00:00.000Z',
          }),
        ],
      });

      const [user] = await service.getHealedCohort(7, NOW);

      expect(user.healed_recent).toBe(15);
      expect(user.healed_all).toBe(27);
      expect(user.first_heal_at).toBe('2026-07-01T00:00:00.000Z');
      expect(user.last_heal_at).toBe('2026-09-05T00:00:00.000Z');
      expect(user.name).toBe('Matheus Vitorio');
    });

    it('keeps the first name seen when a later tenant carries a different one', async () => {
      setup({
        cohort: [
          cohortRow({ tenant_id: 'tenant-a', user_name: 'First Name' }),
          cohortRow({ tenant_id: 'tenant-b', user_name: 'Stale Name' }),
        ],
      });

      const [user] = await service.getHealedCohort(7, NOW);

      // First non-null wins; flipping the coalesce to `row.user_name ?? existing`
      // would make the last tenant's copy of the name win instead.
      expect(user.name).toBe('First Name');
    });

    it('leaves the name null when no row for the person ever carried one', async () => {
      setup({
        cohort: [
          cohortRow({ tenant_id: 'tenant-a', user_name: null }),
          cohortRow({ tenant_id: 'tenant-b', user_name: null }),
        ],
      });

      const [user] = await service.getHealedCohort(7, NOW);

      expect(user.name).toBeNull();
      expect(user.email).toBe('matheus@example.com');
    });

    it('keeps a later name when the first row for a person had none', async () => {
      setup({
        cohort: [
          cohortRow({ tenant_id: 'tenant-a', user_name: null }),
          cohortRow({ tenant_id: 'tenant-b', user_name: 'Late Name' }),
        ],
      });

      const [user] = await service.getHealedCohort(7, NOW);

      expect(user.name).toBe('Late Name');
    });

    it('drops excluded addresses before they reach the payload', async () => {
      setup({
        cohort: [
          cohortRow({ email: 'bruno@buddyweb.fr' }),
          cohortRow({ email: 'improving_poison241@dralias.com' }),
          cohortRow({ email: 'real@example.com' }),
        ],
      });

      const users = await service.getHealedCohort(7, NOW);

      expect(users.map((u) => u.email)).toEqual(['real@example.com']);
    });

    it('normalises case and whitespace on the grouping key', async () => {
      setup({
        cohort: [
          cohortRow({ email: '  Matheus@Example.com ', tenant_id: 'tenant-a', healed_recent: '3' }),
          cohortRow({ email: 'matheus@example.com', tenant_id: 'tenant-b', healed_recent: '4' }),
        ],
      });

      const users = await service.getHealedCohort(7, NOW);

      expect(users).toHaveLength(1);
      expect(users[0].healed_recent).toBe(7);
    });

    it('orders people by heals in the window, most first', async () => {
      setup({
        cohort: [
          cohortRow({ email: 'quiet@example.com', tenant_id: 't1', healed_recent: '2' }),
          cohortRow({ email: 'loud@example.com', tenant_id: 't2', healed_recent: '99' }),
        ],
      });

      const users = await service.getHealedCohort(7, NOW);

      expect(users.map((u) => u.email)).toEqual(['loud@example.com', 'quiet@example.com']);
    });
  });

  describe('conversions', () => {
    it('normalises claims and bounds the window in UTC', async () => {
      setup({
        claims: [
          { email: 'Someone@Example.com', source: 'cloud', claimed_at: '2026-09-01T08:00:00.000Z' },
        ],
      });

      const claims = await service.getConversions(90, NOW);

      expect(claims).toEqual([
        { email: 'someone@example.com', source: 'cloud', claimed_at: '2026-09-01T08:00:00.000Z' },
      ]);
      // claimed_at is `timestamp WITH time zone`, unlike requests.timestamp.
      expect(paramsFor('FROM waitlist_claims')).toEqual([
        new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      ]);
    });

    it('runs the claims query alone: no index probe, no cross-tenant scan', async () => {
      setup({ claims: [] });

      await service.getConversions(90, NOW);

      expect(query.mock.calls.map(([sql]) => String(sql).trim().split('\n')[0])).toEqual([
        `SET LOCAL lock_timeout = '5000ms'`,
        `SET LOCAL statement_timeout = '1500ms'`,
        'SELECT email, source, claimed_at',
      ]);
      expect(commitTransaction).toHaveBeenCalled();
    });

    it('reports every claim, including addresses the cohort filters out', async () => {
      setup({
        claims: [
          {
            email: 'bruno@buddyweb.fr',
            source: 'self-hosted',
            claimed_at: '2026-09-02T00:00:00.000Z',
          },
          {
            email: 'info@realcompany.com',
            source: 'cloud',
            claimed_at: '2026-09-01T00:00:00.000Z',
          },
        ],
      });

      const claims = await service.getConversions(90, NOW);

      // Deliverability filtering is about who we may email; a conversion count
      // that quietly drops our own signups would understate the campaign.
      expect(claims.map((claim) => claim.email)).toEqual([
        'bruno@buddyweb.fr',
        'info@realcompany.com',
      ]);
    });
  });

  describe('caching', () => {
    it('serves a repeated cohort request without touching the database', async () => {
      setup({ cohort: [cohortRow()] });

      const first = await service.getHealedCohort(7, NOW);
      const callsAfterFirst = query.mock.calls.length;
      const second = await service.getHealedCohort(7, NOW);

      expect(second).toBe(first);
      expect(query.mock.calls).toHaveLength(callsAfterFirst);
    });

    it('caches per window, so a different day count recomputes', async () => {
      setup({ cohort: [cohortRow()] });

      await service.getHealedCohort(7, NOW);
      const callsAfterFirst = query.mock.calls.length;
      await service.getHealedCohort(30, NOW);

      expect(query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('does not cache a failed scan, so the next call retries the database', async () => {
      setup({ cohort: [cohortRow()] });
      // Target the cohort scan itself, not whichever statement happens to run
      // first: `mockRejectedValueOnce` would otherwise fail `SET LOCAL
      // lock_timeout` and never reach the query this test is named after.
      let failNextScan = true;
      const scan = query.getMockImplementation()!;
      query.mockImplementation((sql: string, ...params: unknown[]) => {
        if (sql.includes('JOIN tenants t') && failNextScan) {
          failNextScan = false;
          return Promise.reject(new Error('canceling statement due to statement timeout'));
        }
        return scan(sql, ...params);
      });

      await expect(service.getHealedCohort(7, NOW)).rejects.toThrow('statement timeout');
      const users = await service.getHealedCohort(7, NOW);

      expect(users.map((u) => u.email)).toEqual(['matheus@example.com']);
      // Both calls reached the scan: the failure was not memoised.
      expect(
        query.mock.calls.filter(([sql]) => String(sql).includes('JOIN tenants t')),
      ).toHaveLength(2);
    });

    it('does not cache a missing index either, so the feed recovers once it is rebuilt', async () => {
      setup({ index: [], cohort: [cohortRow()] });

      await expect(service.getHealedCohort(7, NOW)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      scripted.index = [{ '?column?': 1 }];

      await expect(service.getHealedCohort(7, NOW)).resolves.toHaveLength(1);
    });

    it('caches an empty window too, so an idle feed stops re-scanning', async () => {
      setup({ cohort: [] });

      await expect(service.getHealedCohort(7, NOW)).resolves.toEqual([]);
      const callsAfterFirst = query.mock.calls.length;
      await service.getHealedCohort(7, NOW);

      expect(query.mock.calls).toHaveLength(callsAfterFirst);
    });

    it('keeps the cohort and the conversion caches apart at the same window', async () => {
      setup({
        cohort: [cohortRow()],
        claims: [
          { email: 'someone@example.com', source: 'cloud', claimed_at: '2026-09-01T08:00:00.000Z' },
        ],
      });

      const users = await service.getHealedCohort(7, NOW);
      const claims = await service.getConversions(7, NOW);

      // One cache keyed on `days` alone would hand the cohort array back here.
      expect(users.map((u) => u.email)).toEqual(['matheus@example.com']);
      expect(claims).toEqual([
        { email: 'someone@example.com', source: 'cloud', claimed_at: '2026-09-01T08:00:00.000Z' },
      ]);
    });

    it('recomputes once the 60s ttl lapses', async () => {
      jest.useFakeTimers();
      setup({ cohort: [cohortRow()] });

      await service.getHealedCohort(7, NOW);
      const callsAfterFirst = query.mock.calls.length;

      jest.advanceTimersByTime(59_000);
      await service.getHealedCohort(7, NOW);
      expect(query.mock.calls).toHaveLength(callsAfterFirst);

      jest.advanceTimersByTime(2_000);
      await service.getHealedCohort(7, NOW);
      expect(query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('caches conversions too', async () => {
      setup({ claims: [] });

      const first = await service.getConversions(90, NOW);
      const callsAfterFirst = query.mock.calls.length;
      const second = await service.getConversions(90, NOW);

      expect(second).toBe(first);
      expect(query.mock.calls).toHaveLength(callsAfterFirst);
    });
  });

  describe('getCorporateSignups', () => {
    it('refuses to run when the tenant/timestamp index is missing', async () => {
      setup({ index: [] });

      await expect(service.getCorporateSignups(365, NOW)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(sqlFor('WITH signups AS MATERIALIZED')).toBe('');
    });

    it('excludes anyone on the pivot waiting list, in the query itself', async () => {
      // Those people are worked by hand; the exclusion lives in SQL so no
      // consumer can forget to apply it.
      await service.getCorporateSignups(365, NOW);

      const sql = sqlFor('WITH signups AS MATERIALIZED');
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('FROM waitlist_claims w WHERE lower(w.email) = lower(u.email)');
    });

    it('checks for the index the lateral probe depends on', async () => {
      await service.getCorporateSignups(365, NOW);

      expect(paramsFor('pg_index')).toEqual(['IDX_requests_tenant_timestamp']);
    });

    it('cuts off on a UTC boundary, matching a timestamptz column', async () => {
      await service.getCorporateSignups(30, NOW);

      expect(paramsFor('WITH signups AS MATERIALIZED')).toEqual([
        new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      ]);
    });

    it('maps a signup onto the payload shape', async () => {
      setup({ signups: [signupRow()] });

      expect(await service.getCorporateSignups(365, NOW)).toEqual([
        {
          email: 'ada@stripe.com',
          name: 'Ada Lovelace',
          domain: 'stripe.com',
          signed_up_at: '2026-08-01T10:00:00.000Z',
          last_request_at: null,
          has_traffic: false,
          domain_signups: 1,
        },
      ]);
    });

    it('keeps a verified user who never created a tenant', async () => {
      // Tenants are created lazily on first agent creation, so someone who
      // signed up and never built anything has no tenant row. They are exactly
      // who this feed is for, and an inner join would drop them: 1,274 verified
      // users in production, 144 of them corporate.
      setup({ signups: [signupRow({ last_request_at: null })] });

      const [signup] = await service.getCorporateSignups(365, NOW);

      expect(signup.has_traffic).toBe(false);
      expect(signup.last_request_at).toBeNull();
      expect(sqlFor('WITH signups AS MATERIALIZED')).toContain('LEFT JOIN tenants t');
    });

    it('marks a tenant that has sent a request', async () => {
      setup({ signups: [signupRow({ last_request_at: '2026-09-01T08:00:00.000Z' })] });

      const [signup] = await service.getCorporateSignups(365, NOW);

      expect(signup.has_traffic).toBe(true);
      expect(signup.last_request_at).toBe('2026-09-01T08:00:00.000Z');
    });

    it('normalises the address and derives the domain from it', async () => {
      setup({ signups: [signupRow({ email: '  Ada@Stripe.COM ' })] });

      const [signup] = await service.getCorporateSignups(365, NOW);

      expect(signup.email).toBe('ada@stripe.com');
      expect(signup.domain).toBe('stripe.com');
    });

    it('keeps a missing display name as null', async () => {
      setup({ signups: [signupRow({ user_name: null })] });

      expect((await service.getCorporateSignups(365, NOW))[0].name).toBeNull();
    });

    it('drops consumer and already-excluded addresses', async () => {
      setup({
        signups: [
          signupRow({ email: 'ada@gmail.com' }),
          signupRow({ email: 'support@stripe.com' }),
          signupRow({ email: 'dev@manifest.build' }),
          signupRow({ email: 'ada@stripe.com' }),
        ],
      });

      expect((await service.getCorporateSignups(365, NOW)).map((s) => s.email)).toEqual([
        'ada@stripe.com',
      ]);
    });

    it('counts how many verified signups share a domain', async () => {
      setup({
        signups: [signupRow({ email: 'ada@stripe.com' }), signupRow({ email: 'grace@stripe.com' })],
      });

      const signups = await service.getCorporateSignups(365, NOW);

      expect(signups).toHaveLength(2);
      expect(signups.every((s) => s.domain_signups === 2)).toBe(true);
    });

    it('drops a scripted signup cluster wholesale', async () => {
      setup({
        signups: [
          signupRow({ email: 'a@scraped.com', signed_up_at: '2026-03-01T00:00:00.000Z' }),
          signupRow({ email: 'b@scraped.com', signed_up_at: '2026-03-08T00:00:00.000Z' }),
          signupRow({ email: 'c@scraped.com', signed_up_at: '2026-03-15T00:00:00.000Z' }),
          signupRow({ email: 'ada@stripe.com' }),
        ],
      });

      expect((await service.getCorporateSignups(365, NOW)).map((s) => s.email)).toEqual([
        'ada@stripe.com',
      ]);
    });

    it('drops a domain whose signups all look machine-generated', async () => {
      // Temp-mail domains: Faker names, traffic, and every local part is
      // letters-then-digits. The quiet-cluster rule misses them because they
      // have traffic; this one catches them on the address shape.
      setup({
        signups: [
          signupRow({ email: 'vatiy14692@aratrin.com', user_name: 'Mrs. Beaulah Shanahan' }),
          signupRow({
            email: 'xiyese3594@aratrin.com',
            user_name: 'Test01',
            last_request_at: '2026-09-01T00:00:00.000Z',
          }),
          signupRow({ email: 'ada@stripe.com' }),
        ],
      });

      expect((await service.getCorporateSignups(365, NOW)).map((s) => s.email)).toEqual([
        'ada@stripe.com',
      ]);
    });

    it('keeps a burst where somebody actually used the gateway', async () => {
      setup({
        signups: [
          signupRow({ email: 'a@real.com', signed_up_at: '2026-03-01T00:00:00.000Z' }),
          signupRow({ email: 'b@real.com', signed_up_at: '2026-03-08T00:00:00.000Z' }),
          signupRow({
            email: 'c@real.com',
            signed_up_at: '2026-03-15T00:00:00.000Z',
            last_request_at: '2026-04-01T00:00:00.000Z',
          }),
        ],
      });

      expect(await service.getCorporateSignups(365, NOW)).toHaveLength(3);
    });

    it('orders by domain size, then by newest signup', async () => {
      setup({
        signups: [
          signupRow({ email: 'solo@alone.com', signed_up_at: '2026-08-20T00:00:00.000Z' }),
          signupRow({ email: 'older@team.com', signed_up_at: '2026-01-01T00:00:00.000Z' }),
          signupRow({ email: 'newer@team.com', signed_up_at: '2026-08-01T00:00:00.000Z' }),
        ],
      });

      expect((await service.getCorporateSignups(365, NOW)).map((s) => s.email)).toEqual([
        'newer@team.com',
        'older@team.com',
        'solo@alone.com',
      ]);
    });

    it('returns nothing when no signup survives the filters', async () => {
      setup({ signups: [signupRow({ email: 'ada@gmail.com' })] });

      expect(await service.getCorporateSignups(365, NOW)).toEqual([]);
    });

    it('caches signups per window', async () => {
      setup({ signups: [signupRow()] });

      const first = await service.getCorporateSignups(365, NOW);
      const callsAfterFirst = query.mock.calls.length;
      const second = await service.getCorporateSignups(365, NOW);

      expect(second).toBe(first);
      expect(query.mock.calls).toHaveLength(callsAfterFirst);
    });
  });
});
