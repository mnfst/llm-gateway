import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Brackets } from 'typeorm';
import { AggregationService } from './aggregation.service';
import { AgentMessage } from '../../entities/agent-message.entity';
import {
  EXCLUDE_PLAYGROUND_AGENTS_PREDICATE,
  EXCLUDE_DIRECT_ATTEMPTS_PREDICATE,
} from './query-helpers';

describe('AggregationService', () => {
  let service: AggregationService;
  let mockGetRawOne: jest.Mock;
  let mockQb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockGetRawOne = jest.fn().mockResolvedValue({ total: 0 });

    mockQb = {
      select: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orWhere: jest.fn(),
      groupBy: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      limit: jest.fn(),
      clone: jest.fn(),
      leftJoin: jest.fn(),
      getRawOne: mockGetRawOne,
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const chainableMethods = [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orWhere',
      'groupBy',
      'orderBy',
      'addOrderBy',
      'limit',
      'clone',
      'leftJoin',
    ];
    for (const method of chainableMethods) {
      mockQb[method].mockImplementation((...args: unknown[]) => {
        const arg = args[0];
        if (arg instanceof Brackets && typeof (arg as any).whereFactory === 'function') {
          (arg as any).whereFactory(mockQb);
        }
        return mockQb;
      });
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AggregationService,
        {
          provide: getRepositoryToken(AgentMessage),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(mockQb) },
        },
      ],
    }).compile();

    service = module.get<AggregationService>(AggregationService);
  });

  describe('hasAnyData', () => {
    it('returns true when a row exists', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      const result = await service.hasAnyData('test-user');
      expect(result).toBe(true);
    });

    it('returns false when no rows exist', async () => {
      mockGetRawOne.mockResolvedValueOnce(null);
      const result = await service.hasAnyData('test-user');
      expect(result).toBe(false);
    });

    it('returns false when getRawOne returns undefined', async () => {
      mockGetRawOne.mockResolvedValueOnce(undefined);
      const result = await service.hasAnyData('test-user');
      expect(result).toBe(false);
    });

    it('passes agentName to tenant filter when provided', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      const result = await service.hasAnyData('test-user', 'my-agent');
      expect(result).toBe(true);
    });

    it('excludes Playground traffic when excludePlayground=true', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      await service.hasAnyData('tenant-1', undefined, true);
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('treats a zero-attempt request as data', async () => {
      const attemptQb = {
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      };
      const requestQb = {
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ '?column?': 1 }),
      };
      const requestAware = new AggregationService(
        { createQueryBuilder: jest.fn(() => attemptQb) } as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      await expect(requestAware.hasAnyData('tenant-1', undefined, true)).resolves.toBe(true);
      expect(requestQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('(r.tenant_id, r.agent_name) IN (SELECT plg.tenant_id, plg.name'),
      );
    });

    it('scopes request-only data by live agent and handles a missing tenant', async () => {
      const attemptQb = {
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      };
      const requestQb = {
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      };
      const requestAware = new AggregationService(
        { createQueryBuilder: jest.fn(() => attemptQb) } as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      await expect(requestAware.hasAnyData('tenant-1', 'agent-1')).resolves.toBe(false);
      expect(requestQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('deleted_at IS NULL'),
        { requestAgentName: 'agent-1' },
      );
      await expect(requestAware.hasAnyData(null)).resolves.toBe(false);
      expect(requestQb.where).toHaveBeenCalledWith('1 = 0');
    });

    it('does not exclude Playground traffic by default', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      await service.hasAnyData('tenant-1');
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('excludes client-pinned (direct) requests when excludeDirect=true', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      await service.hasAnyData('tenant-1', 'bot-1', true, true);
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });

    it('keeps direct requests by default', async () => {
      mockGetRawOne.mockResolvedValueOnce({ '?column?': 1 });
      await service.hasAnyData('tenant-1', 'bot-1', true);
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).not.toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });
  });

  describe('getPreviousTokenTotal', () => {
    it('returns previous period token total', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 4000 });
      const result = await service.getPreviousTokenTotal('24h', 'test-user');
      expect(result).toBe(4000);
    });

    it('returns 0 when no previous data', async () => {
      mockGetRawOne.mockResolvedValueOnce(null);
      const result = await service.getPreviousTokenTotal('24h', 'test-user');
      expect(result).toBe(0);
    });

    it('passes agentName to tenant filter', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 500 });
      const result = await service.getPreviousTokenTotal('7d', 'test-user', 'my-agent');
      expect(result).toBe(500);
    });
  });

  describe('getPreviousCostTotal', () => {
    it('returns previous period cost total', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 2.5 });
      const result = await service.getPreviousCostTotal('7d', 'test-user');
      expect(result).toBe(2.5);
    });

    it('returns 0 when no previous data', async () => {
      mockGetRawOne.mockResolvedValueOnce(null);
      const result = await service.getPreviousCostTotal('7d', 'test-user');
      expect(result).toBe(0);
    });

    it('passes agentName to tenant filter', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 1.0 });
      const result = await service.getPreviousCostTotal('30d', 'test-user', 'my-agent');
      expect(result).toBe(1.0);
    });
  });

  describe('getSummaryMetrics', () => {
    it('returns merged token, cost, and message metrics with trends', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 50, inp: 3000, out: 2000, cost: 5.5 })
        .mockResolvedValueOnce({ msg_count: 40, tokens: 4000, cost: 4.0 });

      const result = await service.getSummaryMetrics('24h', 'tenant-123');
      expect(result.tokens.tokens_today.value).toBe(5000);
      expect(result.tokens.tokens_today.trend_pct).toBe(25);
      expect(result.tokens.tokens_today.sub_values).toEqual({ input: 3000, output: 2000 });
      expect(result.tokens.input_tokens).toBe(3000);
      expect(result.tokens.output_tokens).toBe(2000);
      expect(result.cost.value).toBe(5.5);
      expect(result.cost.trend_pct).toBeGreaterThan(0);
      expect(result.messages.value).toBe(50);
      expect(result.messages.trend_pct).toBe(25);
    });

    it('handles null query results gracefully', async () => {
      mockGetRawOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const result = await service.getSummaryMetrics('24h', 'tenant-123');
      expect(result.tokens.tokens_today.value).toBe(0);
      expect(result.tokens.input_tokens).toBe(0);
      expect(result.tokens.output_tokens).toBe(0);
      expect(result.cost.value).toBe(0);
      expect(result.messages.value).toBe(0);
    });

    it('passes agentName to tenant filter', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 10, inp: 100, out: 50, cost: 1.0 })
        .mockResolvedValueOnce({ msg_count: 8, tokens: 120, cost: 0.8 });

      const result = await service.getSummaryMetrics('7d', 'tenant-123', 'bot-1');
      expect(result.messages.value).toBe(10);
    });

    it('returns zero trends when no previous data', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 10, inp: 100, out: 50, cost: 1.0 })
        .mockResolvedValueOnce({ msg_count: 0, tokens: 0, cost: 0 });

      const result = await service.getSummaryMetrics('24h', 'tenant-1');
      expect(result.tokens.tokens_today.trend_pct).toBe(0);
      expect(result.cost.trend_pct).toBe(0);
      expect(result.messages.trend_pct).toBe(0);
    });

    it('applies auth_type and provider filters to current + previous windows', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 5, inp: 50, out: 25, cost: 0.5 })
        .mockResolvedValueOnce({ msg_count: 4, tokens: 60, cost: 0.4 });

      await service.getSummaryMetrics('24h', 'tenant-123', undefined, 'subscription', 'openai');

      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).toContain('at.auth_type = :authType');
      expect(clauses).toContain('at.provider = :provider');
    });

    it('excludes the reserved Playground agent from both windows when excludePlayground=true', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 5, inp: 50, out: 25, cost: 0.5 })
        .mockResolvedValueOnce({ msg_count: 4, tokens: 60, cost: 0.4 });

      await service.getSummaryMetrics('24h', 'tenant-123', undefined, undefined, undefined, true);

      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      // Both the current and previous window builders add the semi-join guard.
      // It adds no join of its own (pure NOT EXISTS existence test).
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      expect(mockQb.leftJoin).not.toHaveBeenCalled();
    });

    it('does not exclude playground agents by default (excludePlayground omitted)', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 5, inp: 50, out: 25, cost: 0.5 })
        .mockResolvedValueOnce({ msg_count: 4, tokens: 60, cost: 0.4 });

      await service.getSummaryMetrics('24h', 'tenant-123');

      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    const labelClause = "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)";

    it('scopes both windows to a connection label when provided', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 5, inp: 50, out: 25, cost: 0.5 })
        .mockResolvedValueOnce({ msg_count: 4, tokens: 60, cost: 0.4 });

      await service.getSummaryMetrics(
        '24h',
        'tenant-123',
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
      );

      const labelCalls = mockQb.andWhere.mock.calls.filter((c: unknown[]) => c[0] === labelClause);
      // Current + previous window builders each add the label predicate.
      expect(labelCalls).toHaveLength(2);
      for (const call of labelCalls)
        expect(call[1]).toEqual(expect.objectContaining({ keyLabel: 'Work' }));
    });

    it('does not add the label filter when no label is given', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({ msg_count: 5, inp: 50, out: 25, cost: 0.5 })
        .mockResolvedValueOnce({ msg_count: 4, tokens: 60, cost: 0.4 });

      await service.getSummaryMetrics('24h', 'tenant-123');

      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).not.toContain(labelClause);
    });
  });

  describe('getPreviousWindowMetrics', () => {
    it('uses daily rows for long dashboard trends', async () => {
      const daily = {
        supportsRange: jest.fn().mockReturnValue(true),
        getRangeRows: jest.fn().mockResolvedValue([
          { input_tokens: '100', output_tokens: '50', cost_usd: '1.5', request_count: '4' },
          { input_tokens: '20', output_tokens: '10', cost_usd: '0.5', request_count: '2' },
        ]),
      };
      const rollupAware = new AggregationService({} as never, undefined, daily as never);

      await expect(
        rollupAware.getPreviousWindowMetrics('365d', 'tenant-1', 'bot-1', true, true),
      ).resolves.toEqual({ tokens: 180, cost: 2, messages: 6 });
      expect(daily.getRangeRows).toHaveBeenCalledWith('tenant-1', '365d', {
        agentName: 'bot-1',
        previous: true,
        excludeDirect: true,
      });
    });

    it('keeps the raw fallback when rollup reads do not support the range', async () => {
      const daily = {
        supportsRange: jest.fn().mockReturnValue(false),
        getRangeRows: jest.fn(),
      };
      const rollupAware = new AggregationService(
        { createQueryBuilder: jest.fn().mockReturnValue(mockQb) } as never,
        undefined,
        daily as never,
      );
      mockGetRawOne.mockResolvedValueOnce({ msg_count: 4, tokens: 100, cost: 1 });

      await expect(
        rollupAware.getPreviousWindowMetrics('365d', 'tenant-1', undefined, true),
      ).resolves.toEqual({ tokens: 100, cost: 1, messages: 4 });
      expect(daily.supportsRange).toHaveBeenCalledWith('tenant-1', '365d');
      expect(daily.getRangeRows).not.toHaveBeenCalled();
      expect(mockGetRawOne).toHaveBeenCalledTimes(1);
    });

    it('returns previous-window token, cost, and message totals', async () => {
      mockGetRawOne.mockResolvedValueOnce({ msg_count: 40, tokens: 4000, cost: 4.0 });

      const result = await service.getPreviousWindowMetrics('24h', 'tenant-123');
      expect(result).toEqual({ tokens: 4000, cost: 4.0, messages: 40 });
      // Only one query — the current window is derived from the timeseries.
      expect(mockGetRawOne).toHaveBeenCalledTimes(1);
    });

    it('returns zeros when there is no previous-window data', async () => {
      mockGetRawOne.mockResolvedValueOnce(null);

      const result = await service.getPreviousWindowMetrics('24h', 'tenant-123');
      expect(result).toEqual({ tokens: 0, cost: 0, messages: 0 });
    });

    it('excludes Playground traffic when requested', async () => {
      mockGetRawOne.mockResolvedValueOnce({ msg_count: 8, tokens: 120, cost: 0.8 });

      const result = await service.getPreviousWindowMetrics('7d', 'tenant-123', 'bot-1', true);
      expect(result.messages).toBe(8);
      // The Playground-exclusion predicate is applied to the previous-window query.
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(
        clauses.some((c: unknown) => typeof c === 'string' && c.includes('is_playground')),
      ).toBe(true);
    });

    it('excludes client-pinned (direct) requests when excludeDirect=true', async () => {
      mockGetRawOne.mockResolvedValueOnce({ msg_count: 8, tokens: 120, cost: 0.8 });
      await service.getPreviousWindowMetrics('7d', 'tenant-123', 'bot-1', true, true);
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });

    it('keeps direct requests by default', async () => {
      mockGetRawOne.mockResolvedValueOnce({ msg_count: 8, tokens: 120, cost: 0.8 });
      await service.getPreviousWindowMetrics('7d', 'tenant-123', 'bot-1', true);
      const clauses = mockQb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
      expect(clauses).not.toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });
  });

  describe('getRequestReliability', () => {
    it('returns zero metrics without a tenant', async () => {
      await expect(service.getRequestReliability('24h', null)).resolves.toEqual({
        total: 0,
        successful: 0,
        success_rate: 0,
        attempt_success_rate: 0,
        manifest_lift_pct: 0,
        recovered: 0,
        previous_total: 0,
      });
    });

    it('combines request and attempt reliability with agent and Playground scopes', async () => {
      const query = jest.fn().mockResolvedValue([
        {
          total: '4',
          successful: '3',
          attempts: '6',
          successful_attempts: '4',
          recovered: '2',
          previous_total: '5',
        },
      ]);
      const requestAware = new AggregationService({ query } as never, {} as never);

      const result = await requestAware.getRequestReliability('24h', 'tenant-1', 'agent-1', true);

      expect(result).toEqual({
        total: 4,
        successful: 3,
        success_rate: 75,
        attempt_success_rate: (4 / 6) * 100,
        manifest_lift_pct: 75 - (4 / 6) * 100,
        recovered: 2,
        previous_total: 5,
      });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('scoped_requests'), [
        'tenant-1',
        expect.any(String),
        expect.any(String),
        'agent-1',
      ]);
      expect(query.mock.calls[0][0]).toContain('is_playground = true');
    });

    it('excludes client-pinned (direct) traffic from both scoped_requests branches', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const requestAware = new AggregationService({ query } as never, {} as never);

      await requestAware.getRequestReliability('24h', 'tenant-1', 'agent-1', true, true);

      const sql = query.mock.calls[0][0] as string;
      // Linked requests are dropped via NOT EXISTS over their attempts...
      expect(sql).toContain('direct_attempt.request_id = r.id');
      // ...and unlinked legacy attempts, which are their own synthetic request,
      // are tested on the attempt row itself.
      expect(sql).toContain("pa.routing_reason IS DISTINCT FROM 'direct'");
    });

    it('keeps direct traffic by default', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const requestAware = new AggregationService({ query } as never, {} as never);

      await requestAware.getRequestReliability('24h', 'tenant-1', 'agent-1', true);

      const sql = query.mock.calls[0][0] as string;
      expect(sql).not.toContain('direct_attempt');
      expect(sql).not.toContain('routing_reason');
    });

    it('avoids division by zero when no scoped rows exist', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const requestAware = new AggregationService({ query } as never, {} as never);

      await expect(requestAware.getRequestReliability('7d', 'tenant-1')).resolves.toEqual({
        total: 0,
        successful: 0,
        success_rate: 0,
        attempt_success_rate: 0,
        manifest_lift_pct: 0,
        recovered: 0,
        previous_total: 0,
      });
      expect(query.mock.calls[0][1]).toHaveLength(3);
    });
  });

  describe('buildSummary', () => {
    it('assembles summary cards with trends from current and previous totals', () => {
      const result = AggregationService.buildSummary(
        { input: 3000, output: 2000, cost: 5.5, messages: 50 },
        { tokens: 4000, cost: 4.0, messages: 40 },
      );
      expect(result.tokens.tokens_today.value).toBe(5000);
      expect(result.tokens.tokens_today.trend_pct).toBe(25); // (5000-4000)/4000
      expect(result.tokens.tokens_today.sub_values).toEqual({ input: 3000, output: 2000 });
      expect(result.tokens.input_tokens).toBe(3000);
      expect(result.tokens.output_tokens).toBe(2000);
      expect(result.cost.value).toBe(5.5);
      expect(result.cost.trend_pct).toBe(38); // 37.5 rounded
      expect(result.messages.value).toBe(50);
      expect(result.messages.trend_pct).toBe(25);
    });

    it('returns zero trends when previous totals are zero', () => {
      const result = AggregationService.buildSummary(
        { input: 100, output: 50, cost: 1.0, messages: 10 },
        { tokens: 0, cost: 0, messages: 0 },
      );
      expect(result.tokens.tokens_today.value).toBe(150);
      expect(result.tokens.tokens_today.trend_pct).toBe(0);
      expect(result.cost.trend_pct).toBe(0);
      expect(result.messages.trend_pct).toBe(0);
    });
  });
});
