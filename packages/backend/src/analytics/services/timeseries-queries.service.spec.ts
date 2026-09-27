import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeseriesQueriesService } from './timeseries-queries.service';
import { AgentMessage } from '../../entities/agent-message.entity';
import { Agent } from '../../entities/agent.entity';
import {
  MESSAGE_ROW_SELECT_ALIASES,
  EXCLUDE_PLAYGROUND_AGENTS_PREDICATE,
  EXCLUDE_DIRECT_ATTEMPTS_PREDICATE,
  CUSTOM_PROVIDER_JOIN_CONDITION,
  PROVIDER_SERIES_KEY_EXPR,
} from './query-helpers';
import { CustomProvider } from '../../entities/custom-provider.entity';

describe('TimeseriesQueriesService', () => {
  let service: TimeseriesQueriesService;
  let mockGetRawMany: jest.Mock;
  let mockGetMany: jest.Mock;
  let mockTurnQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    leftJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orWhere: jest.Mock;
    groupBy: jest.Mock;
    addGroupBy: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    setParameter: jest.Mock;
    getRawMany: jest.Mock;
    getRawOne: jest.Mock;
    getMany: jest.Mock;
  };
  let mockAgentQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    leftJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orWhere: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    getMany: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    mockGetRawMany = jest.fn().mockResolvedValue([]);
    mockGetMany = jest.fn().mockResolvedValue([]);

    mockTurnQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: mockGetRawMany,
      getRawOne: jest.fn().mockResolvedValue({}),
      getMany: mockGetMany,
    };

    mockAgentQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: mockGetMany,
      getRawMany: mockGetRawMany,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeseriesQueriesService,
        {
          provide: getRepositoryToken(AgentMessage),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(mockTurnQb) },
        },
        {
          provide: getRepositoryToken(Agent),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(mockAgentQb) },
        },
      ],
    }).compile();

    service = module.get<TimeseriesQueriesService>(TimeseriesQueriesService);
  });

  describe('getActiveSkills', () => {
    it('maps DB rows with status field', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          name: 'deploy',
          agent_name: 'bot-1',
          run_count: 5,
          last_active_at: '2026-02-16T10:00:00',
        },
      ]);

      const result = await service.getActiveSkills('24h', 'u1');
      expect(result[0]).toEqual({
        name: 'deploy',
        agent_name: 'bot-1',
        run_count: 5,
        last_active_at: '2026-02-16T10:00:00',
        status: 'active',
      });
    });

    it('returns null agent_name when not present', async () => {
      mockGetRawMany.mockResolvedValue([
        { name: 'scan', agent_name: null, run_count: 1, last_active_at: '2026-02-16' },
      ]);

      const result = await service.getActiveSkills('24h', 'u1');
      expect(result[0].agent_name).toBeNull();
    });

    it('excludes Playground traffic when excludePlayground=true', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getActiveSkills('24h', 'tenant-1', undefined, true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('does not exclude Playground traffic by default', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getActiveSkills('24h', 'tenant-1');
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });
  });

  describe('getCostByModel', () => {
    it('computes share_pct for each model', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          model: 'claude-opus-4-6',
          tokens: 700,
          estimated_cost: 10.0,
          auth_type: 'subscription',
          provider: 'anthropic',
        },
        {
          model: 'gpt-4o',
          tokens: 300,
          estimated_cost: 5.0,
          auth_type: 'api_key',
          provider: 'openai',
        },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(result).toHaveLength(2);
      expect(result[0].share_pct).toBe(70);
      expect(result[1].share_pct).toBe(30);
      expect(result[0].auth_type).toBe('subscription');
      expect(result[1].auth_type).toBe('api_key');
      expect(result[0].provider).toBe('anthropic');
      expect(result[1].provider).toBe('openai');
    });

    it('returns display_name from model_pricing when available', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          model: 'gpt-4o',
          display_name: 'GPT-4o',
          tokens: 500,
          estimated_cost: 2.0,
          auth_type: null,
          provider: 'openai',
        },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(result[0].display_name).toBe('GPT-4o');
    });

    it('falls back to model slug when display_name is missing', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          model: 'custom-model',
          tokens: 100,
          estimated_cost: 1.0,
          auth_type: null,
          provider: null,
        },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(result[0].display_name).toBe('custom-model');
    });

    it('returns 0 share_pct when total tokens is 0', async () => {
      mockGetRawMany.mockResolvedValue([
        { model: 'test', tokens: 0, estimated_cost: 0, provider: null },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(result[0].share_pct).toBe(0);
      expect(result[0].auth_type).toBeNull();
      expect(result[0].provider).toBeNull();
    });

    it('resolves the custom provider display name', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          model: 'custom:u-1/gpt-oss-120b',
          display_name: 'custom:u-1/gpt-oss-120b',
          tokens: 10,
          estimated_cost: 0.5,
          auth_type: 'api_key',
          provider: 'custom:u-1',
          custom_provider_name: 'MyLLM',
        },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(mockTurnQb.leftJoin).toHaveBeenCalledWith(
        CustomProvider,
        'cp',
        CUSTOM_PROVIDER_JOIN_CONDITION,
      );
      expect(mockTurnQb.addSelect).toHaveBeenCalledWith('cp.name', 'custom_provider_name');
      expect(mockTurnQb.addGroupBy).toHaveBeenCalledWith('cp.name');
      expect(result[0]).toMatchObject({
        provider: 'custom:u-1',
        custom_provider_name: 'MyLLM',
      });
    });

    it('returns null custom_provider_name for built-in and deleted custom providers', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          model: 'gpt-4o',
          tokens: 5,
          estimated_cost: 0.1,
          auth_type: null,
          provider: 'openai',
          custom_provider_name: null,
        },
      ]);

      const result = await service.getCostByModel('7d', 'u1');
      expect(result[0].custom_provider_name).toBeNull();
    });

    it('excludes Playground traffic when excludePlayground=true', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getCostByModel('7d', 'tenant-1', undefined, true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('does not exclude Playground traffic by default', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getCostByModel('7d', 'tenant-1');
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });
  });

  describe('getRecentActivity', () => {
    it('returns raw query results', async () => {
      const fakeRows = [{ id: '1', timestamp: '2026-02-16', agent_name: 'bot-1' }];
      mockGetRawMany.mockResolvedValue(fakeRows);
      expect(await service.getRecentActivity('24h', 'u1')).toEqual(fakeRows);
    });

    it('returns empty array when no activity', async () => {
      mockGetRawMany.mockResolvedValue([]);
      expect(await service.getRecentActivity('24h', 'u1', 10)).toEqual([]);
    });

    it('propagates specificity_category rows returned by the helper projection', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          id: '1',
          timestamp: '2026-02-16T10:00:00',
          agent_name: 'bot-1',
          model: 'claude-opus-4-6',
          routing_tier: 'standard',
          routing_reason: 'specificity',
          specificity_category: 'coding',
        },
      ]);
      const rows = (await service.getRecentActivity('24h', 'u1')) as Array<Record<string, unknown>>;
      expect(rows[0]!['specificity_category']).toBe('coding');
    });

    it('projects exactly the columns declared in MESSAGE_ROW_SELECT_ALIASES (regression: helper drift)', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'u1');

      // getRecentActivity routes its column projection through the shared
      // selectMessageRowColumns helper. Any divergence between the helper
      // and this endpoint silently breaks the dashboard message badges, so
      // pin the projected alias set to MESSAGE_ROW_SELECT_ALIASES exactly.
      const projectedAliases = [
        ...mockTurnQb.select.mock.calls.map((call) => call[1] as string),
        ...mockTurnQb.addSelect.mock.calls.map((call) => call[1] as string),
      ];

      expect(mockTurnQb.select).toHaveBeenCalledTimes(1);
      expect(mockTurnQb.addSelect).toHaveBeenCalledTimes(MESSAGE_ROW_SELECT_ALIASES.length - 1);
      expect(projectedAliases).toEqual([...MESSAGE_ROW_SELECT_ALIASES]);
    });

    it('applies tenant isolation via addTenantFilter so cross-tenant data cannot leak', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'tenant-123', 5);

      // When a tenantId is provided the helper filters by tenant_id (not user_id).
      const andWhereCalls = mockTurnQb.andWhere.mock.calls.map((call) => call[0] as string);
      expect(andWhereCalls).toContain('at.tenant_id = :tenantId');
    });

    it('excludes Playground traffic when excludePlayground=true', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'tenant-1', 5, undefined, true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('does not exclude Playground traffic by default', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'tenant-1', 5);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('excludes client-pinned (direct) requests when excludeDirect=true', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'tenant-1', 5, 'bot-1', true, true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });

    it('keeps direct requests by default', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getRecentActivity('24h', 'tenant-1', 5, 'bot-1', true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).not.toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });
  });

  describe('direct-request exclusion', () => {
    const clauses = () => mockTurnQb.andWhere.mock.calls.map((c) => c[0] as string);

    it.each([
      [
        'getTimeseries',
        () =>
          service.getTimeseries(
            '24h',
            't1',
            true,
            'bot-1',
            undefined,
            undefined,
            true,
            undefined,
            undefined,
            true,
          ),
      ],
      ['getActiveSkills', () => service.getActiveSkills('24h', 't1', 'bot-1', true, true)],
      ['getCostByModel', () => service.getCostByModel('24h', 't1', 'bot-1', true, true)],
    ])('%s applies the predicate when excludeDirect=true', async (_name, call) => {
      await call();
      expect(clauses()).toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });

    it.each([
      [
        'getTimeseries',
        () => service.getTimeseries('24h', 't1', true, 'bot-1', undefined, undefined, true),
      ],
      ['getActiveSkills', () => service.getActiveSkills('24h', 't1', 'bot-1', true)],
      ['getCostByModel', () => service.getCostByModel('24h', 't1', 'bot-1', true)],
    ])('%s keeps direct requests by default', async (_name, call) => {
      await call();
      expect(clauses()).not.toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });

    // The per-provider charts render on the SAME harness Overview page as the
    // KPI cards (they feed the card sparklines), so they follow the page's rule
    // implicitly: agent-scoped => this harness's routing only. Their only caller
    // is OverviewController, which passes agentName exactly when the request is
    // for one harness.
    it.each([
      [
        'getPerProviderTimeseries',
        (agent?: string) => service.getPerProviderTimeseries('24h', 't1', true, agent),
      ],
      [
        'getPerProviderMessageTimeseries',
        (agent?: string) => service.getPerProviderMessageTimeseries('24h', 't1', true, agent),
      ],
      [
        'getPerProviderCostTimeseries',
        (agent?: string) => service.getPerProviderCostTimeseries('24h', 't1', true, agent),
      ],
    ])('%s excludes direct when agent-scoped and keeps it globally', async (_name, call) => {
      await call('bot-1');
      expect(clauses()).toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);

      mockTurnQb.andWhere.mockClear();
      await call(undefined);
      expect(clauses()).not.toContain(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
    });
  });

  describe('getTimeseries', () => {
    it('returns merged token, cost, and message timeseries for hourly', async () => {
      mockGetRawMany.mockResolvedValue([
        { hour: '2026-02-16T10:00:00', input_tokens: 100, output_tokens: 50, cost: 1.5, count: 5 },
        { hour: '2026-02-16T11:00:00', input_tokens: 200, output_tokens: 80, cost: 2.0, count: 8 },
      ]);

      const result = await service.getTimeseries('24h', 'tenant-123', true);
      expect(result.tokenUsage).toHaveLength(2);
      expect(result.costUsage).toHaveLength(2);
      expect(result.messageUsage).toHaveLength(2);
      expect(result.tokenUsage[0]).toEqual({
        hour: '2026-02-16T10:00:00',
        input_tokens: 100,
        output_tokens: 50,
      });
      expect(result.costUsage[1]).toEqual({ hour: '2026-02-16T11:00:00', cost: 2.0 });
      expect(result.messageUsage[0]).toEqual({ hour: '2026-02-16T10:00:00', count: 5 });
    });

    it('returns merged timeseries for daily buckets', async () => {
      mockGetRawMany.mockResolvedValue([
        { date: '2026-02-15', input_tokens: 500, output_tokens: 300, cost: 5.0, count: 20 },
      ]);

      const result = await service.getTimeseries('7d', 'tenant-123', false);
      expect(result.tokenUsage).toHaveLength(1);
      expect(result.tokenUsage[0]).toEqual({
        date: '2026-02-15',
        input_tokens: 500,
        output_tokens: 300,
      });
      expect(result.costUsage[0]).toEqual({ date: '2026-02-15', cost: 5.0 });
      expect(result.messageUsage[0]).toEqual({ date: '2026-02-15', count: 20 });
    });

    it('returns empty arrays when no data', async () => {
      mockGetRawMany.mockResolvedValue([]);
      const result = await service.getTimeseries('24h', 'tenant-123', true);
      expect(result.tokenUsage).toEqual([]);
      expect(result.costUsage).toEqual([]);
      expect(result.messageUsage).toEqual([]);
    });

    it('defaults null values to 0', async () => {
      mockGetRawMany.mockResolvedValue([
        {
          hour: '2026-02-16T10:00:00',
          input_tokens: null,
          output_tokens: null,
          cost: null,
          count: null,
        },
      ]);

      const result = await service.getTimeseries('24h', 'tenant-1', true);
      expect(result.tokenUsage[0]).toEqual({
        hour: '2026-02-16T10:00:00',
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(result.costUsage[0]).toEqual({ hour: '2026-02-16T10:00:00', cost: 0 });
      expect(result.messageUsage[0]).toEqual({ hour: '2026-02-16T10:00:00', count: 0 });
    });

    it('passes agentName to tenant filter', async () => {
      mockGetRawMany.mockResolvedValue([]);
      const result = await service.getTimeseries('24h', 'tenant-123', true, 'bot-1');
      expect(result.tokenUsage).toEqual([]);
    });

    it('uses parent requests plus unlinked attempts for request buckets', async () => {
      const makeQb = (rows: unknown[]) => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      });
      const attemptQb = makeQb([
        {
          hour: '2026-07-14T10:00:00Z',
          input_tokens: '10',
          output_tokens: '5',
          cost: '0.2',
          count: '1',
        },
      ]);
      const requestQb = makeQb([{ hour: '2026-07-14T10:00:00Z', count: '2' }]);
      const unlinkedQb = makeQb([{ hour: '2026-07-14T10:00:00Z', count: '1' }]);
      const requestAware = new TimeseriesQueriesService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptQb)
            .mockReturnValueOnce(unlinkedQb),
        } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      const result = await requestAware.getTimeseries(
        '24h',
        'tenant-1',
        true,
        'agent-1',
        undefined,
        undefined,
        true,
      );

      expect(result.tokenUsage).toEqual([
        {
          hour: '2026-07-14T10:00:00Z',
          input_tokens: 10,
          output_tokens: 5,
        },
      ]);
      expect(result.messageUsage).toEqual([{ hour: '2026-07-14T10:00:00Z', count: 3 }]);
      expect(requestQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('deleted_at IS NULL'),
        expect.objectContaining({ requestAgentName: 'agent-1' }),
      );
      expect(requestQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('is_playground = true'),
      );
    });

    it('pins request and unlinked buckets to one repeatable-read transaction', async () => {
      const makeQb = () => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        setQueryRunner: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const attemptQb = makeQb();
      const requestQb = makeQb();
      const unlinkedQb = makeQb();
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue(undefined),
      };
      const requestAware = new TimeseriesQueriesService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptQb)
            .mockReturnValueOnce(unlinkedQb),
        } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
        undefined,
        { createQueryRunner: jest.fn(() => runner) } as never,
      );

      await requestAware.getTimeseries('7d', 'tenant-1', false);

      expect(runner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
      expect(runner.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
      expect(attemptQb.setQueryRunner).not.toHaveBeenCalled();
      expect(requestQb.setQueryRunner).toHaveBeenCalledWith(runner);
      expect(unlinkedQb.setQueryRunner).toHaveBeenCalledWith(runner);
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalledTimes(1);
    });

    it('uses daily request buckets and tolerates missing aggregate values', async () => {
      const makeQb = (rows: unknown[]) => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      });
      const attemptQb = makeQb([
        { date: '2026-07-14', input_tokens: null, output_tokens: null, cost: null, count: null },
      ]);
      const requestQb = makeQb([{ date: '2026-07-14', count: null }]);
      const unlinkedQb = makeQb([{ date: '2026-07-14', count: '2' }]);
      const requestAware = new TimeseriesQueriesService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptQb)
            .mockReturnValueOnce(unlinkedQb),
        } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      const result = await requestAware.getTimeseries('7d', 'tenant-1', false);

      expect(result.messageUsage).toEqual([{ date: '2026-07-14', count: 2 }]);
    });

    it('uses daily rollups for non-hourly overview usage', async () => {
      const daily = {
        supportsRange: jest.fn().mockReturnValue(true),
        getRangeRows: jest.fn().mockResolvedValue([
          {
            agent_name: 'alpha',
            day: '2026-09-20',
            request_count: '2',
            input_tokens: '10',
            output_tokens: '5',
            cost_usd: '1',
          },
          {
            agent_name: 'bravo',
            day: '2026-09-20',
            request_count: '3',
            input_tokens: '20',
            output_tokens: '10',
            cost_usd: '2',
          },
        ]),
      };
      const rollupAware = new TimeseriesQueriesService(
        { createQueryBuilder: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        daily as never,
      );

      await expect(
        rollupAware.getTimeseries('90d', 'tenant-1', false, undefined, undefined, undefined, true),
      ).resolves.toEqual({
        tokenUsage: [{ date: '2026-09-20', input_tokens: 30, output_tokens: 15 }],
        costUsage: [{ date: '2026-09-20', cost: 3 }],
        messageUsage: [{ date: '2026-09-20', count: 5 }],
      });
      expect(daily.getRangeRows).toHaveBeenCalledWith('tenant-1', '90d', {
        agentName: undefined,
        excludeDirect: false,
      });
    });

    it('returns no request buckets when tenant scope is absent', async () => {
      const makeQb = () => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const attemptQb = makeQb();
      const unlinkedQb = makeQb();
      const requestQb = makeQb();
      const requestAware = new TimeseriesQueriesService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptQb)
            .mockReturnValueOnce(unlinkedQb),
        } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      await requestAware.getTimeseries('7d', null, false);

      expect(requestQb.andWhere).toHaveBeenCalledWith('1 = 0');
    });
  });

  describe('getAgentList', () => {
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oldIso = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();

    it('excludes the reserved Playground agent by default', async () => {
      await service.getAgentList('u1');
      const clauses = mockAgentQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).toContain('a.is_playground = false');
    });

    it('includes playground agents when includePlayground is true (Messages filter)', async () => {
      await service.getAgentList('u1', true);
      const clauses = mockAgentQb.andWhere.mock.calls.map((c) => c[0] as string);
      expect(clauses).not.toContain('a.is_playground = false');
    });

    it('uses bounded daily rows after the tenant read cutover', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const oldDay = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const agentQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            name: 'bot-1',
            display_name: 'Bot One',
            agent_category: 'code',
            agent_platform: 'codex',
            created_at: '2026-01-01',
          },
        ]),
      };
      const turnRepo = { createQueryBuilder: jest.fn() };
      const daily = {
        readsEnabledFor: jest.fn().mockReturnValue(true),
        getRows: jest.fn().mockResolvedValue([
          {
            agent_id: 'agent-1',
            day: today,
            request_count: '3',
            input_tokens: '100',
            output_tokens: '50',
            cost_usd: '1.25',
            last_active_at: '2026-09-21T10:00:00.000Z',
          },
          {
            agent_id: 'agent-1',
            day: oldDay,
            request_count: '2',
            input_tokens: '20',
            output_tokens: '5',
            cost_usd: '0.25',
            last_active_at: '2026-09-11T10:00:00.000Z',
          },
        ]),
      };
      const rollupAware = new TimeseriesQueriesService(
        turnRepo as never,
        { createQueryBuilder: jest.fn(() => agentQb) } as never,
        undefined,
        undefined,
        undefined,
        daily as never,
      );

      const result = await rollupAware.getAgentList('tenant-1');

      expect(daily.getRows).toHaveBeenCalledWith('tenant-1');
      expect(turnRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual([
        {
          agent_name: 'bot-1',
          display_name: 'Bot One',
          agent_category: 'code',
          agent_platform: 'codex',
          message_count: 5,
          last_active: '2026-09-21T10:00:00.000Z',
          total_cost: 1.5,
          total_tokens: 175,
          sparkline: [150],
        },
      ]);
    });

    it('defaults missing daily values and agents without usage', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const lastActive = new Date('2026-09-21T10:00:00.000Z');
      const agentQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            name: 'bot-1',
            display_name: 'Bot One',
            created_at: '2026-01-01',
          },
          {
            id: 'agent-2',
            name: 'bot-2',
            display_name: null,
            agent_category: null,
            agent_platform: null,
            created_at: null,
          },
        ]),
      };
      const daily = {
        readsEnabledFor: jest.fn().mockReturnValue(true),
        getRows: jest.fn().mockResolvedValue([
          {
            agent_id: 'agent-1',
            day: today,
            request_count: null,
            input_tokens: null,
            output_tokens: null,
            cost_usd: null,
            last_active_at: lastActive,
          },
          {
            agent_id: 'agent-1',
            day: today,
            request_count: null,
            input_tokens: null,
            output_tokens: null,
            cost_usd: null,
            last_active_at: null,
          },
        ]),
      };
      const rollupAware = new TimeseriesQueriesService(
        { createQueryBuilder: jest.fn() } as never,
        { createQueryBuilder: jest.fn(() => agentQb) } as never,
        undefined,
        undefined,
        undefined,
        daily as never,
      );

      await expect(rollupAware.getAgentList('tenant-1')).resolves.toEqual([
        {
          agent_name: 'bot-1',
          display_name: 'Bot One',
          agent_category: null,
          agent_platform: null,
          message_count: 0,
          last_active: lastActive.toISOString(),
          total_cost: 0,
          total_tokens: 0,
          sparkline: [0, 0],
        },
        {
          agent_name: 'bot-2',
          display_name: 'bot-2',
          agent_category: null,
          agent_platform: null,
          message_count: 0,
          last_active: '',
          total_cost: 0,
          total_tokens: 0,
          sparkline: [],
        },
      ]);
    });

    it('returns agents with sparkline data and display_name', async () => {
      mockGetMany.mockResolvedValueOnce([
        { id: 'agent-1', name: 'bot-1', display_name: 'Bot One', created_at: '2026-02-16' },
      ]);
      mockGetRawMany.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          date: '2026-02-15',
          message_count: 4,
          cost: 2.0,
          tokens: 400,
          spark_tokens: 100,
          last_active: recentIso,
        },
        {
          agent_id: 'agent-1',
          date: '2026-02-16',
          message_count: 6,
          cost: 3.0,
          tokens: 600,
          spark_tokens: 200,
          last_active: recentIso,
        },
      ]);

      const result = await service.getAgentList('u1');
      expect(result).toHaveLength(1);
      expect(result[0].agent_name).toBe('bot-1');
      expect(result[0].display_name).toBe('Bot One');
      expect(result[0].sparkline).toEqual([100, 200]);
      expect(result[0].total_cost).toBe(5.0);
      expect(result[0].total_tokens).toBe(1000);
      expect(result[0].message_count).toBe(10);
    });

    it('uses request parents plus unlinked legacy attempts for agent message counts', async () => {
      const makeQb = (rawRows: unknown[] = [], entities: unknown[] = []) => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rawRows),
        getMany: jest.fn().mockResolvedValue(entities),
      });
      const agentQb = makeQb(
        [],
        [{ id: 'agent-1', name: 'bot-1', display_name: 'Bot One', created_at: oldIso }],
      );
      const attemptQb = makeQb([
        {
          agent_id: 'agent-1',
          date: '2026-02-16',
          message_count: 1,
          cost: 2,
          tokens: 300,
          spark_tokens: 300,
          last_active: recentIso,
        },
      ]);
      const requestLastActive = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const unlinkedLastActive = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const requestQb = makeQb([
        { agent_id: 'agent-1', message_count: null, last_active: requestLastActive },
      ]);
      const unlinkedQb = makeQb([
        { agent_id: 'agent-1', message_count: '3', last_active: unlinkedLastActive },
      ]);
      const requestAware = new TimeseriesQueriesService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptQb)
            .mockReturnValueOnce(unlinkedQb),
        } as never,
        { createQueryBuilder: jest.fn(() => agentQb) } as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      const result = await requestAware.getAgentList('u1');

      expect(result[0]).toEqual(
        expect.objectContaining({
          message_count: 3,
          total_cost: 2,
          total_tokens: 300,
          last_active: unlinkedLastActive.toISOString(),
        }),
      );
      expect(unlinkedQb.where).toHaveBeenCalledWith('at.request_id IS NULL');
    });

    it('falls back to agent_name when display_name is null', async () => {
      mockGetMany.mockResolvedValueOnce([
        { id: 'agent-1', name: 'bot-1', display_name: null, created_at: '2026-02-16' },
      ]);
      mockGetRawMany.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          date: '2026-02-16',
          message_count: 10,
          cost: 5.0,
          tokens: 1000,
          spark_tokens: 0,
          last_active: oldIso,
        },
      ]);

      const result = await service.getAgentList('u1');
      expect(result[0].display_name).toBe('bot-1');
    });

    it('returns empty sparkline for agent with no spark data', async () => {
      mockGetMany.mockResolvedValueOnce([
        { id: 'agent-2', name: 'lonely-bot', display_name: null, created_at: '2026-02-16' },
      ]);
      mockGetRawMany.mockResolvedValueOnce([
        {
          agent_id: 'agent-2',
          date: '2026-02-01',
          message_count: 1,
          cost: 0,
          tokens: 0,
          spark_tokens: 0,
          last_active: oldIso,
        },
      ]);

      const result = await service.getAgentList('u1');
      expect(result[0].sparkline).toEqual([]);
    });

    it('returns agent with zero stats when no telemetry exists', async () => {
      mockGetMany.mockResolvedValueOnce([
        { id: 'agent-3', name: 'new-bot', display_name: null, created_at: '2026-02-16' },
      ]);
      mockGetRawMany.mockResolvedValueOnce([]);

      const result = await service.getAgentList('u1');
      expect(result).toHaveLength(1);
      expect(result[0].agent_name).toBe('new-bot');
      expect(result[0].display_name).toBe('new-bot');
      expect(result[0].message_count).toBe(0);
      expect(result[0].total_cost).toBe(0);
      expect(result[0].sparkline).toEqual([]);
    });
  });

  describe('getTimeseries with authType/provider filters', () => {
    it('applies auth_type and provider andWhere clauses', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getTimeseries('24h', 'tenant-1', true, 'agent-x', 'subscription', 'openai');
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain('at.auth_type = :authType');
      expect(clauses).toContain('at.provider = :provider');
    });

    it('excludes the reserved Playground agent when excludePlayground=true', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getTimeseries('24h', 'tenant-1', true, undefined, undefined, undefined, true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      // Semi-join exclusion adds no LEFT JOIN of its own.
      expect(mockTurnQb.leftJoin).not.toHaveBeenCalled();
    });

    it('does not exclude playground agents by default', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getTimeseries('24h', 'tenant-1', true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).not.toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
    });

    it('scopes the aggregate timeseries to a connection label when provided', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getTimeseries(
        '24h',
        'tenant-1',
        true,
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
      );
      const labelCall = mockTurnQb.andWhere.mock.calls.find(
        (c) => c[0] === "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)",
      );
      expect(labelCall![1]).toEqual({ keyLabel: 'Work' });
    });
  });

  describe('per-agent pivoted timeseries (hourly)', () => {
    const rows = [
      { hour: '01', agent_name: 'bravo', tokens: 5, messages: 2, cost: 0.5 },
      { hour: '01', agent_name: 'alpha', tokens: 10, messages: 1, cost: 1.0 },
      { hour: '02', agent_name: 'alpha', tokens: 3, messages: 4, cost: 0.3 },
    ];

    it('getPerAgentTimeseries pivots tokens with sorted agents and zero-fill', async () => {
      mockGetRawMany.mockResolvedValue(rows);
      const out = await service.getPerAgentTimeseries(
        '24h',
        'tenant-1',
        true,
        'subscription',
        'openai',
      );
      expect(out.agents).toEqual(['alpha', 'bravo']);
      expect(out.timeseries).toEqual([
        { hour: '01', alpha: 10, bravo: 5 },
        { hour: '02', alpha: 3, bravo: 0 },
      ]);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      expect(clauses).toContain('at.auth_type = :authType');
      expect(clauses).toContain('at.provider = :provider');
      // The NOT EXISTS semi-join matches a playground agent by id OR name and is a
      // pure existence test, so a soft-deleted agent sharing a slug with a live
      // one can never multiply the per-agent SUM. It adds no LEFT JOIN.
      expect(mockTurnQb.leftJoin).not.toHaveBeenCalled();
      // Matching by name (not just id) means a Playground row carrying only
      // agent_name (NULL agent_id) is excluded too — no leak.
      expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).toContain('at.agent_id IN (SELECT plg.id');
      expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).toContain(
        '(at.tenant_id, at.agent_name) IN (SELECT plg.tenant_id, plg.name',
      );
    });

    it('getPerAgentMessageTimeseries pivots message counts', async () => {
      mockGetRawMany.mockResolvedValue(rows);
      const out = await service.getPerAgentMessageTimeseries('24h', 'u1', true);
      expect(out.timeseries[0]).toEqual({ hour: '01', alpha: 1, bravo: 2 });
    });

    it('counts parent requests plus unlinked synthetic rows per agent', async () => {
      const makeRequestQb = (rows: unknown[]) => {
        const qb = {
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          addGroupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue(rows),
        };
        return qb;
      };
      const requestQb = makeRequestQb([{ hour: '01', agent_name: 'alpha', messages: '1' }]);
      const unlinkedQb = makeRequestQb([
        { hour: '01', agent_name: 'alpha', messages: '2' },
        { hour: '01', agent_name: 'bravo', messages: '1' },
      ]);
      const requestAware = new TimeseriesQueriesService(
        { createQueryBuilder: jest.fn(() => unlinkedQb) } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      const out = await requestAware.getPerAgentMessageTimeseries('24h', 'tenant-1', true);

      expect(out.timeseries).toEqual([{ hour: '01', alpha: 3, bravo: 1 }]);
      expect(requestQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('(r.tenant_id, r.agent_name) IN (SELECT plg.tenant_id, plg.name'),
      );
    });

    it('uses daily request buckets without a tenant and defaults missing counts to zero', async () => {
      const makeRequestQb = (rows: unknown[]) => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      });
      const requestQb = makeRequestQb([
        { date: '2026-07-14', agent_name: 'alpha', messages: null },
      ]);
      const unlinkedQb = makeRequestQb([
        { date: '2026-07-14', agent_name: 'alpha', messages: '2' },
      ]);
      const requestAware = new TimeseriesQueriesService(
        { createQueryBuilder: jest.fn(() => unlinkedQb) } as never,
        {} as never,
        { createQueryBuilder: jest.fn(() => requestQb) } as never,
      );

      const out = await requestAware.getPerAgentMessageTimeseries('7d', null, false);

      expect(out.timeseries).toEqual([{ date: '2026-07-14', alpha: 2 }]);
      expect(requestQb.andWhere).toHaveBeenCalledWith('1 = 0');
    });

    it('getPerAgentCostTimeseries pivots cost (non-hourly date bucket)', async () => {
      mockGetRawMany.mockResolvedValue([{ date: '2026-01-01', agent_name: 'alpha', cost: 2.5 }]);
      const out = await service.getPerAgentCostTimeseries('7d', 'u1', false);
      expect(out.agents).toEqual(['alpha']);
      expect(out.timeseries).toEqual([{ date: '2026-01-01', alpha: 2.5 }]);
    });

    it('getAgentUsageTimeseries pivots tokens, messages, and cost from one query', async () => {
      mockGetRawMany.mockResolvedValue(rows);
      const out = await service.getAgentUsageTimeseries('24h', 'u1', true);

      expect(out.tokenUsage.timeseries[0]).toEqual({ hour: '01', alpha: 10, bravo: 5 });
      expect(out.messageUsage.timeseries[0]).toEqual({ hour: '01', alpha: 1, bravo: 2 });
      expect(out.costUsage.timeseries[0]).toEqual({ hour: '01', alpha: 1, bravo: 0.5 });
      expect(mockGetRawMany).toHaveBeenCalledTimes(1);
    });

    it('getAgentUsageTimeseries supports date buckets and provider filters', async () => {
      mockGetRawMany.mockResolvedValue([
        { date: '2026-01-01', agent_name: 'alpha', tokens: 10, messages: 2, cost: 1.25 },
      ]);
      const out = await service.getAgentUsageTimeseries(
        '7d',
        'u1',
        false,
        'subscription',
        'openai',
      );

      expect(out.tokenUsage.timeseries[0]).toEqual({ date: '2026-01-01', alpha: 10 });
      expect(out.messageUsage.timeseries[0]).toEqual({ date: '2026-01-01', alpha: 2 });
      expect(out.costUsage.timeseries[0]).toEqual({ date: '2026-01-01', alpha: 1.25 });
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain('at.auth_type = :authType');
      expect(clauses).toContain('at.provider = :provider');
    });

    it('pivots daily rollups by agent for long overview ranges', async () => {
      const daily = {
        supportsRange: jest.fn().mockReturnValue(true),
        getRangeRows: jest.fn().mockResolvedValue([
          {
            agent_name: 'alpha',
            day: '2026-09-20',
            request_count: '2',
            input_tokens: '10',
            output_tokens: '5',
            cost_usd: '1.5',
          },
        ]),
      };
      const rollupAware = new TimeseriesQueriesService(
        { createQueryBuilder: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        daily as never,
      );

      const result = await rollupAware.getAgentUsageTimeseries('365d', 'tenant-1', false);

      expect(result.tokenUsage.timeseries).toEqual([{ date: '2026-09-20', alpha: 15 }]);
      expect(result.messageUsage.timeseries).toEqual([{ date: '2026-09-20', alpha: 2 }]);
      expect(result.costUsage.timeseries).toEqual([{ date: '2026-09-20', alpha: 1.5 }]);
    });

    const labelClause = "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)";

    it('scopes each per-agent timeseries to a connection label when provided', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getPerAgentTimeseries('24h', 't1', true, 'api_key', 'openai', 'Work');
      await service.getPerAgentMessageTimeseries('24h', 't1', true, 'api_key', 'openai', 'Work');
      await service.getPerAgentCostTimeseries('24h', 't1', true, 'api_key', 'openai', 'Work');
      const labelCalls = mockTurnQb.andWhere.mock.calls.filter((c) => c[0] === labelClause);
      expect(labelCalls).toHaveLength(3);
      for (const call of labelCalls) expect(call[1]).toEqual({ keyLabel: 'Work' });
    });

    it('treats a legacy empty connection label as Default in the per-agent filter', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getPerAgentTimeseries('24h', 't1', true, 'api_key', 'openai', '');
      const labelCall = mockTurnQb.andWhere.mock.calls.find((c) => c[0] === labelClause);
      expect(labelCall![1]).toEqual({ keyLabel: 'Default' });
    });

    it('omits the label filter when no label is given', async () => {
      mockGetRawMany.mockResolvedValue([]);
      await service.getPerAgentTimeseries('24h', 't1', true, 'api_key', 'openai');
      expect(mockTurnQb.andWhere.mock.calls.some((c) => c[0] === labelClause)).toBe(false);
    });
  });

  describe('per-provider / per-model pivoted timeseries', () => {
    it('getPerProviderTimeseries filters by agentName and pivots tokens', async () => {
      mockGetRawMany.mockResolvedValue([
        { hour: '01', provider: 'openai', tokens: 7 },
        { hour: '01', provider: 'anthropic', tokens: 3 },
      ]);
      const out = await service.getPerProviderTimeseries('24h', 'tenant-1', true, 'agent-x');
      expect(out.agents).toEqual(['anthropic', 'openai']);
      expect(out.timeseries[0]).toEqual({ hour: '01', anthropic: 3, openai: 7 });
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      // Scope to the LIVE agent owning the slug (agent_id subquery), not a raw
      // name match — a soft-deleted agent sharing the slug must not leak rows.
      const liveAgentClause = clauses.find(
        (c) =>
          typeof c === 'string' &&
          c.includes('at.agent_id = (') &&
          c.includes('deleted_at IS NULL'),
      );
      expect(liveAgentClause).toBeDefined();
      expect(clauses).not.toContain('at.agent_name = :agentName');
      const liveAgentCall = mockTurnQb.andWhere.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('at.agent_id = ('),
      );
      expect(liveAgentCall![1]).toEqual({ liveAgentName: 'agent-x', liveTenantId: 'tenant-1' });
      // Playground (is_playground) usage must be excluded from per-provider totals,
      // via the same NOT EXISTS semi-join as the per-agent endpoints (no join).
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      // Custom provider names resolve via the cp join (built-ins join to NULL).
      expect(mockTurnQb.leftJoin).toHaveBeenCalledWith(
        CustomProvider,
        'cp',
        CUSTOM_PROVIDER_JOIN_CONDITION,
      );
    });

    it('resolves custom series keys via the CASE expression in all per-provider pivots', async () => {
      mockGetRawMany.mockResolvedValue([
        { hour: '01', provider: 'MyLLM', tokens: 7 },
        { hour: '01', provider: 'openai', tokens: 3 },
      ]);
      const out = await service.getPerProviderTimeseries('24h', 'u1', true);
      expect(mockTurnQb.addSelect).toHaveBeenCalledWith(PROVIDER_SERIES_KEY_EXPR, 'provider');
      expect(mockTurnQb.addGroupBy).toHaveBeenCalledWith(PROVIDER_SERIES_KEY_EXPR);
      expect(out.agents).toEqual(['MyLLM', 'openai']);

      for (const call of [
        () => service.getPerProviderMessageTimeseries('24h', 'u1', true),
        () => service.getPerProviderCostTimeseries('24h', 'u1', true),
      ]) {
        mockTurnQb.addSelect.mockClear();
        mockTurnQb.addGroupBy.mockClear();
        mockTurnQb.leftJoin.mockClear();
        await call();
        expect(mockTurnQb.leftJoin).toHaveBeenCalledWith(
          CustomProvider,
          'cp',
          CUSTOM_PROVIDER_JOIN_CONDITION,
        );
        expect(mockTurnQb.addSelect).toHaveBeenCalledWith(PROVIDER_SERIES_KEY_EXPR, 'provider');
        expect(mockTurnQb.addGroupBy).toHaveBeenCalledWith(PROVIDER_SERIES_KEY_EXPR);
      }
    });

    it('getPerModelTimeseries scopes to the live agent id when an agent is given', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', model: 'gpt-4o', tokens: 9 }]);
      await service.getPerModelTimeseries('24h', 'tenant-1', true, 'agent-x');
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      const liveAgentClause = clauses.find(
        (c) =>
          typeof c === 'string' &&
          c.includes('at.agent_id = (') &&
          c.includes('deleted_at IS NULL'),
      );
      expect(liveAgentClause).toBeDefined();
      expect(clauses).not.toContain('at.agent_name = :agentName');
    });

    it('omits the agent filter entirely when no agent is given', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', provider: 'openai', tokens: 1 }]);
      await service.getPerProviderTimeseries('24h', 'tenant-1', true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses.some((c) => typeof c === 'string' && c.includes('at.agent_id = ('))).toBe(
        false,
      );
    });

    it('getPerModelTimeseries scopes to the live agent id when an agent is given', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', model: 'gpt-4o', tokens: 9 }]);
      await service.getPerModelTimeseries('24h', 'tenant-1', true, 'agent-x');
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      const liveAgentClause = clauses.find(
        (c) =>
          typeof c === 'string' &&
          c.includes('at.agent_id = (') &&
          c.includes('deleted_at IS NULL'),
      );
      expect(liveAgentClause).toBeDefined();
      expect(clauses).not.toContain('at.agent_name = :agentName');
    });

    it('omits the agent filter entirely when no agent is given', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', provider: 'openai', tokens: 1 }]);
      await service.getPerProviderTimeseries('24h', 'tenant-1', true);
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses.some((c) => typeof c === 'string' && c.includes('at.agent_id = ('))).toBe(
        false,
      );
    });

    it('getPerProviderMessageTimeseries pivots message counts', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', provider: 'openai', messages: 4 }]);
      const out = await service.getPerProviderMessageTimeseries('24h', 'u1', true);
      expect(out.timeseries).toEqual([{ hour: '01', openai: 4 }]);
    });

    it('getPerProviderCostTimeseries pivots cost', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', provider: 'openai', cost: 1.25 }]);
      const out = await service.getPerProviderCostTimeseries('24h', 'u1', true);
      expect(out.timeseries).toEqual([{ hour: '01', openai: 1.25 }]);
    });

    it('getProviderUsageTimeseries pivots tokens, messages, and cost from one query', async () => {
      mockGetRawMany.mockResolvedValue([
        { hour: '01', provider: 'openai', tokens: 10, messages: 2, cost: 1.5 },
        { hour: '01', provider: 'anthropic', tokens: 5, messages: 1, cost: 0.5 },
      ]);
      const out = await service.getProviderUsageTimeseries('24h', 'u1', true);

      expect(out.tokenUsage.timeseries[0]).toEqual({ hour: '01', anthropic: 5, openai: 10 });
      expect(out.messageUsage.timeseries[0]).toEqual({ hour: '01', anthropic: 1, openai: 2 });
      expect(out.costUsage.timeseries[0]).toEqual({ hour: '01', anthropic: 0.5, openai: 1.5 });
      expect(mockGetRawMany).toHaveBeenCalledTimes(1);
    });

    it('getProviderUsageTimeseries supports date buckets', async () => {
      mockGetRawMany.mockResolvedValue([
        { date: '2026-01-01', provider: 'openai', tokens: 10, messages: 2, cost: 1.5 },
      ]);
      const out = await service.getProviderUsageTimeseries('7d', 'u1', false, 'agent-x');

      expect(out.tokenUsage.timeseries[0]).toEqual({ date: '2026-01-01', openai: 10 });
      expect(out.messageUsage.timeseries[0]).toEqual({ date: '2026-01-01', openai: 2 });
      expect(out.costUsage.timeseries[0]).toEqual({ date: '2026-01-01', openai: 1.5 });
    });

    it('getPerModelTimeseries pivots tokens', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', model: 'gpt-4o', tokens: 9 }]);
      const out = await service.getPerModelTimeseries('24h', 'tenant-1', true, 'agent-x');
      expect(out.agents).toEqual(['gpt-4o']);
      expect(out.timeseries).toEqual([{ hour: '01', 'gpt-4o': 9 }]);
      // Playground (is_playground) usage must be excluded from per-model totals.
      const clauses = mockTurnQb.andWhere.mock.calls.map((c) => c[0]);
      expect(clauses).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      expect(mockTurnQb.leftJoin).not.toHaveBeenCalled();
    });

    it('getPerModelMessageTimeseries pivots message counts', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', model: 'gpt-4o', messages: 2 }]);
      const out = await service.getPerModelMessageTimeseries('24h', 'u1', true);
      expect(out.timeseries).toEqual([{ hour: '01', 'gpt-4o': 2 }]);
    });

    it('getPerModelCostTimeseries pivots cost', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', model: 'gpt-4o', cost: 0.9 }]);
      const out = await service.getPerModelCostTimeseries('24h', 'u1', true);
      expect(out.timeseries).toEqual([{ hour: '01', 'gpt-4o': 0.9 }]);
    });

    it('zero-fills missing values from null', async () => {
      mockGetRawMany.mockResolvedValue([{ hour: '01', provider: 'openai', tokens: null }]);
      const out = await service.getPerProviderTimeseries('24h', 'u1', true);
      expect(out.timeseries).toEqual([{ hour: '01', openai: 0 }]);
    });
  });

  describe('getAgentNamesByAuthType', () => {
    it('returns distinct agent names excluding playground agents', async () => {
      mockGetRawMany.mockResolvedValue([{ agent_name: 'a' }, { agent_name: 'b' }]);
      const out = await service.getAgentNamesByAuthType('subscription', 'tenant-1');
      expect(out).toEqual(['a', 'b']);
      expect(mockTurnQb.andWhere.mock.calls.map((c) => c[0])).toContain(
        EXCLUDE_PLAYGROUND_AGENTS_PREDICATE,
      );
      // No LEFT JOIN on agents anymore — exclusion is a pure semi-join.
      expect(mockTurnQb.leftJoin).not.toHaveBeenCalled();
    });
  });
});
