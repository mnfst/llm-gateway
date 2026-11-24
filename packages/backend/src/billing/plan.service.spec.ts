import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';
import { PlanService } from './plan.service';
import { Tenant } from '../entities/tenant.entity';
import { toLocalSqlTimestamp, toSqlTimestamp } from '../common/utils/postgres-sql';
import * as billingConfig from './billing.config';

describe('PlanService', () => {
  let service: PlanService;
  let mockTenantFindOne: jest.Mock;
  let mockTenantUpdate: jest.Mock;
  let mockQuery: jest.Mock;
  const saved = { ...process.env };
  const CTX = { tenantId: 't1', userId: 'u1' };
  const FRESH_CTX = { tenantId: null, userId: 'u1' };
  const TENANT = { id: 't1', owner_user_id: 'u1', limit_overrides: null };

  function quotaTriggerDefinition(timeZone: string): string {
    return `IF (NEW."timestamp" AT TIME ZONE '${timeZone}') AT TIME ZONE 'UTC' < counter_cutover_at`;
  }

  function processTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  function enableBilling() {
    process.env['MANIFEST_MODE'] = 'cloud';
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
    process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';
  }

  beforeEach(async () => {
    process.env = { ...saved };
    jest.restoreAllMocks();
    mockTenantFindOne = jest.fn().mockResolvedValue(null);
    mockTenantUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    mockQuery = jest.fn().mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanService,
        {
          provide: getRepositoryToken(Tenant),
          useValue: { findOne: mockTenantFindOne, update: mockTenantUpdate },
        },
        { provide: DataSource, useValue: { query: mockQuery } },
      ],
    }).compile();
    service = module.get(PlanService);
  });

  afterAll(() => {
    process.env = { ...saved };
  });

  describe('onModuleInit', () => {
    it('skips the timezone check for self-hosted mode', async () => {
      process.env['MANIFEST_MODE'] = 'selfhosted';

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts the request storage timezone used by the process', async () => {
      enableBilling();
      mockQuery.mockResolvedValue([{ definition: quotaTriggerDefinition(processTimeZone()) }]);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(mockQuery.mock.calls[0][0]).toContain('pg_get_functiondef');
    });

    it('rejects a request storage timezone mismatch', async () => {
      enableBilling();
      const mismatch = processTimeZone() === 'UTC' ? 'Europe/Paris' : 'UTC';
      mockQuery.mockResolvedValue([{ definition: quotaTriggerDefinition(mismatch) }]);

      await expect(service.onModuleInit()).rejects.toThrow(
        'Request quota storage timezone mismatch',
      );
    });

    it('rejects a missing request quota trigger', async () => {
      enableBilling();
      mockQuery.mockResolvedValue([{ definition: null }]);

      await expect(service.onModuleInit()).rejects.toThrow(
        'Could not read request quota timezone from installed trigger',
      );
    });
  });

  describe('getPlan', () => {
    it('returns free when billing is disabled', async () => {
      expect(await service.getPlan(CTX)).toBe('free');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('resolves the active subscription in the tenant snapshot query', async () => {
      enableBilling();
      mockQuery.mockResolvedValueOnce([{ subscriptionPlan: 'pro' }]);
      expect(await service.getPlan(CTX)).toBe('pro');
      expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'u1']);
      expect(String(mockQuery.mock.calls[0][0])).toContain('LEFT JOIN LATERAL');
      expect(String(mockQuery.mock.calls[0][0])).toContain('t."limit_overrides"');
      expect(String(mockQuery.mock.calls[0][0])).toContain(
        `"status" IN ('active', 'trialing', 'past_due')`,
      );
    });

    it('falls back to ctx.userId when there is no tenant yet', async () => {
      enableBilling();
      mockQuery.mockResolvedValueOnce([{ subscriptionPlan: 'pro' }]);
      expect(await service.getPlan(FRESH_CTX)).toBe('pro');
      expect(mockQuery.mock.calls[0][1]).toEqual([null, 'u1']);
    });

    it('returns free when neither tenant owner nor userId exists', async () => {
      enableBilling();
      expect(await service.getPlan({ tenantId: null, userId: null })).toBe('free');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns free when no active subscription row exists', async () => {
      enableBilling();
      expect(await service.getPlan(CTX)).toBe('free');
    });
  });

  describe('getPlanStatus', () => {
    it('reports billing disabled without querying', async () => {
      expect(await service.getPlanStatus(CTX)).toEqual({ enabled: false, plan: 'free' });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns the resolved plan with a single snapshot query when enabled', async () => {
      enableBilling();
      mockQuery.mockResolvedValueOnce([{ subscriptionPlan: 'pro' }]);
      expect(await service.getPlanStatus(CTX)).toEqual({ enabled: true, plan: 'pro' });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLimits', () => {
    it('returns unlimited when billing is disabled', async () => {
      expect(await service.getLimits(CTX)).toEqual({ requestsPerMonth: null });
    });

    it('returns free plan defaults', async () => {
      enableBilling();
      expect(await service.getLimits(CTX)).toEqual({
        requestsPerMonth: FREE_PLAN_REQUESTS_PER_MONTH,
      });
    });

    it('env var overrides plan default', async () => {
      enableBilling();
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = '3000';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(3000);
    });

    it('ignores a non-numeric env override', async () => {
      enableBilling();
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = 'abc';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(FREE_PLAN_REQUESTS_PER_MONTH);
    });

    it('tenant limit_overrides beats env and defaults', async () => {
      enableBilling();
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = '3000';
      mockQuery.mockResolvedValue([{ limitOverrides: { requestsPerMonth: 50_000 } }]);
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(50_000);
    });

    it('returns pro defaults (unlimited) for pro tenants', async () => {
      enableBilling();
      mockQuery.mockResolvedValue([{ subscriptionPlan: 'pro' }]);
      expect(await service.getLimits(CTX)).toEqual({ requestsPerMonth: null });
    });

    it('can fail open when requested by the proxy hot path', async () => {
      enableBilling();
      mockQuery.mockRejectedValue(new Error('snapshot down'));
      await expect(service.getLimits(CTX, { failOpen: true })).resolves.toEqual({
        requestsPerMonth: null,
      });
    });

    it('throttles the limit failure warning and reports the suppressed count', async () => {
      enableBilling();
      mockQuery.mockRejectedValue(new Error('snapshot down'));
      const warn = jest
        .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const nowSpy = jest.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(2_000_000);
        await service.getLimits(CTX, { failOpen: true }); // first → warns once
        await service.getLimits(CTX, { failOpen: true }); // within window → suppressed
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).not.toContain('suppressed');

        nowSpy.mockReturnValue(2_000_000 + 61_000);
        await service.getLimits(CTX, { failOpen: true }); // window elapsed → warns with tail
        expect(warn).toHaveBeenCalledTimes(2);
        expect(String(warn.mock.calls[1][0])).toContain('1 more suppressed');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('getBillingStatus', () => {
    it('reports disabled with no Stripe call', async () => {
      const status = await service.getBillingStatus(CTX);
      expect(status.enabled).toBe(false);
      expect(status.requests.limit).toBeNull();
    });

    it('reports plan, usage and limits when enabled', async () => {
      enableBilling();
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('FROM "tenant_request_usage"')
          ? Promise.resolve([{ n: 42, baseline_counted: true }])
          : Promise.resolve([{ subscriptionPlan: 'free' }]),
      );
      const status = await service.getBillingStatus(CTX);
      expect(status).toMatchObject({
        enabled: true,
        plan: 'free',
        emailPreferences: { usageAlerts: true },
        requests: { used: 42, limit: FREE_PLAN_REQUESTS_PER_MONTH },
      });
      // periodEnd is the 1st of next month at midnight UTC.
      expect(status.requests.periodEnd).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    });

    it('returns live usage without waiting for the historical baseline scan', async () => {
      enableBilling();
      let resolveBaseline!: (v: Array<{ n: string }>) => void;
      const baselineHang = new Promise<Array<{ n: string }>>((r) => {
        resolveBaseline = r;
      });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('FROM "tenant_request_usage"') && sql.includes('SELECT "request_count"')) {
          return Promise.resolve([{ n: '8', baseline_counted: false }]);
        }
        if (sql.includes('EXTRACT(EPOCH')) {
          return Promise.resolve([{ cutover_ms: String(Date.parse('2026-07-28T09:00:00Z')) }]);
        }
        if (sql.includes('SELECT COUNT(*)')) return baselineHang;
        if (sql.includes('FROM (SELECT 1) seed') || sql.includes('subscriptionPlan')) {
          return Promise.resolve([{ subscriptionPlan: 'free' }]);
        }
        return Promise.resolve([]);
      });

      const status = await service.getBillingStatus(CTX);
      expect(status.requests.used).toBe(8);

      // Unblock the background init so the suite does not leak a hanging promise.
      resolveBaseline([{ n: '1' }]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('billing email preferences', () => {
    it('defaults usage alerts on when no tenant preference is stored', async () => {
      mockTenantFindOne.mockResolvedValue(TENANT);

      await expect(service.getBillingEmailPreferences(CTX)).resolves.toEqual({
        usageAlerts: true,
      });
    });

    it('reads stored usage alert opt-outs', async () => {
      mockTenantFindOne.mockResolvedValue({
        ...TENANT,
        billing_email_preferences: { usageAlerts: false },
      });

      await expect(service.getBillingEmailPreferences(CTX)).resolves.toEqual({
        usageAlerts: false,
      });
    });

    it('updates tenant billing email preferences', async () => {
      await expect(
        service.updateBillingEmailPreferences(CTX, { usageAlerts: false }),
      ).resolves.toEqual({
        usageAlerts: false,
      });

      expect(mockTenantUpdate).toHaveBeenCalledWith(
        { id: 't1' },
        { billing_email_preferences: { usageAlerts: false } },
      );
    });

    it('rejects updates before a workspace exists', async () => {
      await expect(
        service.updateBillingEmailPreferences(FRESH_CTX, { usageAlerts: false }),
      ).rejects.toThrow('A workspace is required');
      expect(mockTenantUpdate).not.toHaveBeenCalled();
    });
  });

  describe('price lookup', () => {
    beforeEach(() => {
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('FROM "tenant_request_usage"')
          ? Promise.resolve([{ n: 0, baseline_counted: true }])
          : Promise.resolve([{ subscriptionPlan: 'free' }]),
      );
    });

    it('fetches, converts cents to dollars, and caches', async () => {
      enableBilling();
      const retrieve = jest.fn().mockResolvedValue({
        currency: 'usd',
        recurring: { interval: 'month' },
        unit_amount: 2000,
      });
      jest
        .spyOn(billingConfig, 'getStripeClient')
        .mockReturnValue({ prices: { retrieve } } as never);

      const first = await service.getBillingStatus(CTX);
      const second = await service.getBillingStatus(CTX);
      expect(first.priceMonthly).toEqual({ amount: 20, currency: 'USD', interval: 'month' });
      expect(second.priceMonthly).toEqual({ amount: 20, currency: 'USD', interval: 'month' });
      expect(retrieve).toHaveBeenCalledTimes(1); // second call served from cache
    });

    it('returns an empty price when Stripe errors, without failing the endpoint', async () => {
      enableBilling();
      jest.spyOn(billingConfig, 'getStripeClient').mockReturnValue({
        prices: { retrieve: jest.fn().mockRejectedValue(new Error('down')) },
      } as never);

      const status = await service.getBillingStatus(CTX);
      expect(status.enabled).toBe(true);
      expect(status.priceMonthly).toEqual({ amount: null, currency: null, interval: null });
    });

    it('falls back to 100 divisor for an invalid currency code', async () => {
      enableBilling();
      jest.spyOn(billingConfig, 'getStripeClient').mockReturnValue({
        prices: {
          retrieve: jest.fn().mockResolvedValue({
            currency: 'INVALID_NOT_A_CURRENCY',
            recurring: { interval: 'month' },
            unit_amount: 5000,
          }),
        },
      } as never);

      const status = await service.getBillingStatus(CTX);
      // 5000 / 100 (fallback divisor) = 50
      expect(status.priceMonthly.amount).toBe(50);
    });

    it('handles a price with no unit_amount', async () => {
      enableBilling();
      jest.spyOn(billingConfig, 'getStripeClient').mockReturnValue({
        prices: {
          retrieve: jest.fn().mockResolvedValue({
            currency: 'eur',
            recurring: { interval: 'month' },
            unit_amount: null,
          }),
        },
      } as never);

      expect((await service.getBillingStatus(CTX)).priceMonthly).toEqual({
        amount: null,
        currency: 'EUR',
        interval: 'month',
      });
    });
  });

  describe('countRequestsSince', () => {
    const START = Date.UTC(2026, 6, 1); // 2026-07-01 UTC
    const ROLLOUT_RESET = Date.parse('2026-07-09T09:06:52Z');

    it('returns 0 for a null tenantId without querying', async () => {
      expect(await service.countRequestsSince(null, START)).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('reads the exact tenant and rollout-window counter row', async () => {
      mockQuery.mockResolvedValue([{ n: 7, baseline_counted: true }]);
      expect(await service.countRequestsSince('t1', START)).toBe(7);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('FROM "tenant_request_usage"');
      expect(sql).not.toContain('COUNT(');
      expect(params).toEqual(['t1', toSqlTimestamp(new Date(ROLLOUT_RESET))]);
    });

    it('casts PostgreSQL bigint counters to numbers', async () => {
      mockQuery.mockResolvedValue([{ n: '7', baseline_counted: true }]);

      const count = await service.countRequestsSince('t1', START);

      expect(count).toBe(7);
      expect(typeof count).toBe('number');
    });

    it('allows the quota reset window to be moved by env override', async () => {
      process.env['PLAN_REQUEST_QUOTA_RESET_AT'] = '2026-07-10T12:34:56Z';
      mockQuery.mockResolvedValue([{ n: 4, baseline_counted: true }]);

      expect(await service.countRequestsSince('t1', START)).toBe(4);

      expect(mockQuery.mock.calls[0][1][1]).toBe(toSqlTimestamp(new Date('2026-07-10T12:34:56Z')));
    });

    it('reads the shared counter on every call instead of serving replica-local state', async () => {
      mockQuery.mockResolvedValue([{ n: 3, baseline_counted: true }]);
      await service.countRequestsSince('t1', START);
      await service.countRequestsSince('t1', START);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('changes the counter key when the month rolls over', async () => {
      mockQuery.mockResolvedValue([{ n: 1, baseline_counted: true }]);
      await service.countRequestsSince('t1', START);
      await service.countRequestsSince('t1', Date.UTC(2026, 7, 1)); // August
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1][1][1]).toBe(toSqlTimestamp(new Date(Date.UTC(2026, 7, 1))));
    });

    it('returns the live counter immediately and baselines history in the background', async () => {
      const cutover = Date.parse('2026-07-28T09:00:00Z');
      mockQuery
        .mockResolvedValueOnce([{ n: '3', baseline_counted: false }])
        .mockResolvedValueOnce([{ cutover_ms: String(cutover) }])
        .mockResolvedValueOnce([{ n: '2' }])
        .mockResolvedValueOnce([{ n: '5' }]);

      // Hot path must not wait on the historical COUNT — only live increments.
      expect(await service.countRequestsSince('t1', START)).toBe(3);

      // Flush the scheduled baseline init.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const [baselineSql, baselineParams] = mockQuery.mock.calls[2];
      expect(baselineSql).toContain('FROM "requests" r');
      expect(baselineSql).toContain('m."request_id" IS NULL');
      expect(baselineSql).toContain('pa."timestamp" < c.local_timestamp');
      expect(baselineSql).toContain('m."timestamp" < c.local_timestamp');
      expect(baselineParams).toEqual([
        't1',
        toLocalSqlTimestamp(new Date(ROLLOUT_RESET)),
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        'tenant_request_usage_cutover_v1',
      ]);
      expect(mockQuery.mock.calls[3][0]).toContain(
        'WHEN "tenant_request_usage"."baseline_counted" THEN 0',
      );
    });

    it('schedules a post-cutover zero-row without blocking or scanning history', async () => {
      const augustStart = Date.UTC(2026, 7, 1);
      const cutover = Date.parse('2026-07-28T09:00:00Z');
      mockQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ cutover_ms: cutover }])
        .mockResolvedValueOnce([{ n: '0' }]);

      expect(await service.countRequestsSince('t1', augustStart)).toBe(0);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(
        mockQuery.mock.calls.every(([sql]) => !String(sql).includes('FROM "requests" r')),
      ).toBe(true);
      expect(mockQuery.mock.calls[2][1]).toEqual(['t1', toSqlTimestamp(new Date(augustStart)), 0]);
    });

    it('coalesces concurrent baseline initialization within one process', async () => {
      const cutover = Date.parse('2026-07-28T09:00:00Z');
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT "request_count"'))
          return Promise.resolve([{ n: 0, baseline_counted: false }]);
        if (sql.includes('EXTRACT(EPOCH')) return Promise.resolve([{ cutover_ms: cutover }]);
        if (sql.includes('SELECT COUNT(*)')) return Promise.resolve([{ n: '4' }]);
        if (sql.includes('INSERT INTO "tenant_request_usage"'))
          return Promise.resolve([{ n: '4' }]);
        return Promise.resolve([]);
      });

      // Both callers return the live counter immediately (0), without awaiting baseline.
      await expect(
        Promise.all([
          service.countRequestsSince('t1', START),
          service.countRequestsSince('t1', START),
        ]),
      ).resolves.toEqual([0, 0]);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        mockQuery.mock.calls.filter(([sql]) => String(sql).includes('EXTRACT(EPOCH')),
      ).toHaveLength(1);
      expect(
        mockQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT COUNT(*)')),
      ).toHaveLength(1);
      expect(
        mockQuery.mock.calls.filter(([sql]) =>
          String(sql).includes('INSERT INTO "tenant_request_usage"'),
        ),
      ).toHaveLength(1);
    });

    it('does not fail the hot path when the migration cutover marker is missing', async () => {
      mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      // Live counter is 0; baseline init fails in the background.
      await expect(service.countRequestsSince('t1', START)).resolves.toBe(0);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });

    it('rethrows a DB error so the next call can retry', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));
      await expect(service.countRequestsSince('t1', START)).rejects.toThrow('boom');
      mockQuery.mockResolvedValueOnce([{ n: 9, baseline_counted: true }]);
      expect(await service.countRequestsSince('t1', START)).toBe(9);
    });

    it('countRequestsThisMonth derives the current UTC month window', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-15T10:00:00Z'));
      try {
        mockQuery.mockResolvedValue([{ n: 2, baseline_counted: true }]);
        expect(await service.countRequestsThisMonth('t1')).toBe(2);
        expect(mockQuery.mock.calls[0][1][1]).toBe(toSqlTimestamp(new Date(Date.UTC(2026, 7, 1))));
      } finally {
        jest.useRealTimers();
      }
    });

    it('countRequestsThisMonth starts at the rollout reset during the rollout month', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T10:00:00Z'));
      try {
        mockQuery.mockResolvedValue([{ n: 2, baseline_counted: true }]);
        expect(await service.countRequestsThisMonth('t1')).toBe(2);
        expect(mockQuery.mock.calls[0][1][1]).toBe(toSqlTimestamp(new Date(ROLLOUT_RESET)));
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('assertWithinRequestLimit', () => {
    // Route subscription lookups vs the request counter lookup to the right result.
    function routeQuery(plan: string, count: number) {
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('FROM "tenant_request_usage"')
          ? Promise.resolve([{ n: count, baseline_counted: true }])
          : Promise.resolve([{ subscriptionPlan: plan }]),
      );
    }

    it('allows when billing is disabled without counting', async () => {
      await expect(service.assertWithinRequestLimit(CTX)).resolves.toBeUndefined();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('allows an unlimited (pro) tenant without counting requests', async () => {
      enableBilling();
      mockQuery.mockResolvedValue([{ subscriptionPlan: 'pro' }]); // plan null limit
      await expect(service.assertWithinRequestLimit(CTX)).resolves.toBeUndefined();
      // Only the subscription lookup ran; no usage lookup.
      expect(
        mockQuery.mock.calls.every(([sql]) => !String(sql).includes('FROM "tenant_request_usage"')),
      ).toBe(true);
    });

    it('allows a free tenant below the request limit', async () => {
      enableBilling();
      routeQuery('free', FREE_PLAN_REQUESTS_PER_MONTH - 1);
      await expect(service.assertWithinRequestLimit(CTX)).resolves.toBeUndefined();
    });

    it('throws 402 PLAN_LIMIT_REQUESTS for a free tenant at the limit', async () => {
      enableBilling();
      routeQuery('free', FREE_PLAN_REQUESTS_PER_MONTH);
      try {
        await service.assertWithinRequestLimit(CTX);
        fail('expected HttpException');
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(402);
        expect(err.getResponse()).toMatchObject({
          code: 'PLAN_LIMIT_REQUESTS',
          limit: FREE_PLAN_REQUESTS_PER_MONTH,
          used: FREE_PLAN_REQUESTS_PER_MONTH,
        });
      }
    });

    it('fails open (allows the request) when the count query errors', async () => {
      enableBilling();
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('FROM "tenant_request_usage"')
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([{ subscriptionPlan: 'free' }]),
      );
      // A usage lookup failure must never block: the soft Free-tier gate fails open.
      await expect(service.assertWithinRequestLimit(CTX)).resolves.toBeUndefined();
    });

    it('fails open (allows the request) when the billing snapshot query errors', async () => {
      enableBilling();
      mockQuery.mockRejectedValue(new Error('snapshot down'));
      await expect(service.assertWithinRequestLimit(CTX)).resolves.toBeUndefined();
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(String(mockQuery.mock.calls[0][0])).not.toContain('FROM "tenant_request_usage"');
    });

    it('throttles the fail-open warning and reports the suppressed count', async () => {
      enableBilling();
      mockQuery.mockImplementation((sql: string) =>
        sql.includes('FROM "tenant_request_usage"')
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([{ subscriptionPlan: 'free' }]),
      );
      const warn = jest
        .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const nowSpy = jest.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_000_000);
        await service.assertWithinRequestLimit(CTX); // first failure → warns once
        await service.assertWithinRequestLimit(CTX); // within window → suppressed
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).not.toContain('suppressed');

        nowSpy.mockReturnValue(1_000_000 + 61_000);
        await service.assertWithinRequestLimit(CTX); // window elapsed → warns with tail
        expect(warn).toHaveBeenCalledTimes(2);
        expect(String(warn.mock.calls[1][0])).toContain('1 more suppressed');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('envLimit hardening', () => {
    it('rejects hex and scientific notation, falling back to the plan default', async () => {
      enableBilling();
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = '0x10';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(FREE_PLAN_REQUESTS_PER_MONTH);
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = '1e3';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(FREE_PLAN_REQUESTS_PER_MONTH);
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = ' 5 ';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(FREE_PLAN_REQUESTS_PER_MONTH);
    });

    it('accepts a plain digits-only override', async () => {
      enableBilling();
      process.env['PLAN_LIMIT_FREE_REQUESTS'] = '7000';
      expect((await service.getLimits(CTX)).requestsPerMonth).toBe(7000);
    });
  });
});
