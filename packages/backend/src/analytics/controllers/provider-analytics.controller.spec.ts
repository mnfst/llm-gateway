import { ProviderAnalyticsController } from './provider-analytics.controller';
import type { AggregationService } from '../services/aggregation.service';
import type { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import type { Repository } from 'typeorm';
import type { TenantProvider } from '../../entities/tenant-provider.entity';
import type { AgentMessage } from '../../entities/agent-message.entity';
import type { TenantContext } from '../../common/decorators/tenant-context.decorator';

const ctx: TenantContext = { tenantId: 'tenant-1', userId: 'u1' };

interface ConnectionDetailFull {
  connection: { last_used_at: string | null; [k: string]: unknown };
  agents: Array<Record<string, unknown>>;
  model_usage: Array<Record<string, unknown>>;
  recent_messages: Array<Record<string, unknown>>;
}

/**
 * A chainable QueryBuilder mock whose terminal getRawOne/getRawMany return
 * values are supplied per-instance. The controller builds a fresh builder for
 * each query, so each createQueryBuilder() call shifts the next scripted result.
 */
function makeQb(result: { rawOne?: unknown; rawMany?: unknown[] }) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue(result.rawOne),
    getRawMany: jest.fn().mockResolvedValue(result.rawMany ?? []),
  };
  for (const k of Object.keys(qb)) {
    if (!k.startsWith('getRaw')) qb[k].mockReturnValue(qb);
  }
  return qb;
}

describe('ProviderAnalyticsController', () => {
  let aggregation: { getSummaryMetrics: jest.Mock };
  let timeseries: {
    getTimeseries: jest.Mock;
    getPerAgentTimeseries: jest.Mock;
    getPerAgentMessageTimeseries: jest.Mock;
    getPerAgentCostTimeseries: jest.Mock;
    getAgentNamesByAuthType: jest.Mock;
  };
  let providerRepo: { findOne: jest.Mock };
  let autofixStats: { getConnectionTimeseries: jest.Mock };
  let attemptStats: {
    getConnectionStatusTimeseries: jest.Mock;
    getConnectionAttemptsByAgentTimeseries: jest.Mock;
  };
  let messageRepo: { createQueryBuilder: jest.Mock };
  let controller: ProviderAnalyticsController;

  beforeEach(() => {
    aggregation = {
      getSummaryMetrics: jest.fn().mockResolvedValue({
        messages: { value: 5 },
        tokens: { tokens_today: { value: 100 } },
      }),
    };
    timeseries = {
      getTimeseries: jest
        .fn()
        .mockResolvedValue({ tokenUsage: [{ hour: '01' }], messageUsage: [{ hour: '01' }] }),
      getPerAgentTimeseries: jest.fn().mockResolvedValue({ agents: ['a'], timeseries: [] }),
      getPerAgentMessageTimeseries: jest.fn().mockResolvedValue({ agents: ['a'], timeseries: [] }),
      getPerAgentCostTimeseries: jest.fn().mockResolvedValue({ agents: ['a'], timeseries: [] }),
      getAgentNamesByAuthType: jest.fn().mockResolvedValue(['agent-1']),
    };
    providerRepo = { findOne: jest.fn() };
    autofixStats = {
      getConnectionTimeseries: jest
        .fn()
        .mockResolvedValue({ range: '7d', by: 'disposition', keys: [], buckets: [] }),
    };
    attemptStats = {
      getConnectionStatusTimeseries: jest
        .fn()
        .mockResolvedValue({ range: '7d', by: 'metric', keys: ['success', 'error'], buckets: [] }),
      getConnectionAttemptsByAgentTimeseries: jest
        .fn()
        .mockResolvedValue({ agents: [], timeseries: [] }),
    };
    messageRepo = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(makeQb({ rawOne: { total: 0, successful: 0 } })),
    };

    controller = new ProviderAnalyticsController(
      aggregation as unknown as AggregationService,
      timeseries as unknown as TimeseriesQueriesService,
      autofixStats as never,
      attemptStats as never,
      providerRepo as unknown as Repository<TenantProvider>,
      messageRepo as unknown as Repository<AgentMessage>,
    );
  });

  describe('getAnalytics', () => {
    it('returns summary + timeseries for default range (24h, hourly)', async () => {
      const out = await controller.getAnalytics(ctx, 'subscription');
      // Final `true` arg = excludePlayground: Playground usage must not pollute
      // provider analytics aggregates. Trailing `undefined` = no connection_id.
      expect(aggregation.getSummaryMetrics).toHaveBeenCalledWith(
        '24h',
        'tenant-1',
        undefined,
        'subscription',
        undefined,
        true,
        undefined,
        undefined,
      );
      expect(timeseries.getTimeseries).toHaveBeenCalledWith(
        '24h',
        'tenant-1',
        true,
        undefined,
        'subscription',
        undefined,
        true,
        undefined,
        undefined,
      );
      expect(out.summary.messages).toEqual({ value: 5 });
      expect(out.token_usage).toEqual([{ hour: '01' }]);
    });

    it('defaults missing provider-attempt reliability aggregates to zero', async () => {
      messageRepo.createQueryBuilder.mockReturnValueOnce(makeQb({ rawOne: undefined }));

      const out = await controller.getAnalytics(ctx, 'subscription');

      expect(out.attempts).toEqual({ total: 0, successful: 0, success_rate: 0 });
    });

    it('honors 7d range (non-hourly) and agent + provider filters', async () => {
      await controller.getAnalytics(ctx, 'api_key', '7d', 'agent-x', 'openai');
      expect(timeseries.getTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'agent-x',
        'api_key',
        'openai',
        true,
        undefined,
        undefined,
      );
    });

    it('honors 30d range', async () => {
      await controller.getAnalytics(ctx, undefined, '30d');
      expect(aggregation.getSummaryMetrics).toHaveBeenCalledWith(
        '30d',
        'tenant-1',
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
      );
    });

    it.each(['90d', '365d'])('honors the Connection Detail %s range', async (range) => {
      await controller.getAnalytics(ctx, undefined, range);
      expect(aggregation.getSummaryMetrics).toHaveBeenCalledWith(
        range,
        'tenant-1',
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
      );
    });

    it('passes a null tenantId straight through when the account has no tenant', async () => {
      const noTenant: TenantContext = { tenantId: null, userId: 'u1' };
      await controller.getAnalytics(noTenant, 'subscription');
      expect(timeseries.getTimeseries).toHaveBeenCalledWith(
        '24h',
        null,
        true,
        undefined,
        'subscription',
        undefined,
        true,
        undefined,
        undefined,
      );
    });

    it('scopes summary + timeseries to a connection label', async () => {
      await controller.getAnalytics(ctx, 'api_key', '7d', undefined, 'openai', 'Work');
      expect(aggregation.getSummaryMetrics).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
        undefined,
      );
      expect(timeseries.getTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
        undefined,
      );
    });

    it('scopes summary + timeseries to an exact connection id when connection_id is given', async () => {
      await controller.getAnalytics(ctx, 'api_key', '7d', undefined, 'openai', 'Work', 'conn-123');
      // connection_id rides as the trailing tenantProviderId arg; the services
      // prefer it over the provider/auth_type/label tuple.
      expect(aggregation.getSummaryMetrics).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
        'conn-123',
      );
      expect(timeseries.getTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        undefined,
        'api_key',
        'openai',
        true,
        'Work',
        'conn-123',
      );
    });
  });

  describe('per-agent timeseries endpoints', () => {
    it('getPerAgentTimeseries delegates with hourly default', async () => {
      const out = await controller.getPerAgentTimeseries(ctx, 'subscription', 'openai');
      expect(timeseries.getPerAgentTimeseries).toHaveBeenCalledWith(
        '24h',
        'tenant-1',
        true,
        'subscription',
        'openai',
        undefined,
        undefined,
      );
      expect(out).toEqual({ agents: ['a'], timeseries: [] });
    });

    it('getPerAgentMessageTimeseries honors 30d', async () => {
      await controller.getPerAgentMessageTimeseries(ctx, 'subscription', 'openai', '30d');
      expect(timeseries.getPerAgentMessageTimeseries).toHaveBeenCalledWith(
        '30d',
        'tenant-1',
        false,
        'subscription',
        'openai',
        undefined,
        undefined,
      );
    });

    it('getPerAgentCostTimeseries honors 7d', async () => {
      await controller.getPerAgentCostTimeseries(ctx, 'api_key', 'anthropic', '7d');
      expect(timeseries.getPerAgentCostTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'anthropic',
        undefined,
        undefined,
      );
    });

    it('uses 365d for matching provider timeseries endpoints', async () => {
      await controller.getPerAgentMessageTimeseries(ctx, 'api_key', 'openai', '365d');
      expect(timeseries.getPerAgentMessageTimeseries).toHaveBeenCalledWith(
        '365d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        undefined,
        undefined,
      );
    });

    it('forwards the connection label to every per-agent timeseries query', async () => {
      await controller.getPerAgentTimeseries(ctx, 'api_key', 'openai', '7d', 'Work');
      await controller.getPerAgentMessageTimeseries(ctx, 'api_key', 'openai', '7d', 'Work');
      await controller.getPerAgentCostTimeseries(ctx, 'api_key', 'openai', '7d', 'Work');
      expect(timeseries.getPerAgentTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        undefined,
      );
      expect(timeseries.getPerAgentMessageTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        undefined,
      );
      expect(timeseries.getPerAgentCostTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        undefined,
      );
    });

    it('forwards connection_id to every per-agent timeseries query', async () => {
      await controller.getPerAgentTimeseries(ctx, 'api_key', 'openai', '7d', 'Work', 'conn-9');
      await controller.getPerAgentMessageTimeseries(
        ctx,
        'api_key',
        'openai',
        '7d',
        'Work',
        'conn-9',
      );
      await controller.getPerAgentCostTimeseries(ctx, 'api_key', 'openai', '7d', 'Work', 'conn-9');
      expect(timeseries.getPerAgentTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        'conn-9',
      );
      expect(timeseries.getPerAgentMessageTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        'conn-9',
      );
      expect(timeseries.getPerAgentCostTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-1',
        false,
        'api_key',
        'openai',
        'Work',
        'conn-9',
      );
    });
  });

  describe('getAgents', () => {
    it('returns agent names with explicit auth_type', async () => {
      const out = await controller.getAgents(ctx, 'api_key');
      expect(timeseries.getAgentNamesByAuthType).toHaveBeenCalledWith('api_key', 'tenant-1');
      expect(out).toEqual({ agents: ['agent-1'] });
    });

    it('defaults auth_type to subscription', async () => {
      await controller.getAgents(ctx);
      expect(timeseries.getAgentNamesByAuthType).toHaveBeenCalledWith('subscription', 'tenant-1');
    });
  });

  describe('getConnectionDetail', () => {
    it('returns empty shape (incl. model_usage) when connection_id is missing', async () => {
      const out = await controller.getConnectionDetail(ctx, undefined);
      expect(out).toEqual({ connection: null, agents: [], model_usage: [], recent_messages: [] });
    });

    it('returns empty shape (incl. model_usage) when the connection is not found / not owned', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      const out = await controller.getConnectionDetail(ctx, 'c1');
      expect(providerRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'c1', tenant_id: 'tenant-1' },
      });
      expect(out).toEqual({ connection: null, agents: [], model_usage: [], recent_messages: [] });
    });

    it('returns connection-only shape when the account has no tenant', async () => {
      const noTenant: TenantContext = { tenantId: null, userId: 'u1' };
      const out = await controller.getConnectionDetail(noTenant, 'c1');
      // No tenant → no connection lookup, just the empty shape.
      expect(providerRepo.findOne).not.toHaveBeenCalled();
      expect(out).toEqual({ connection: null, agents: [], model_usage: [], recent_messages: [] });
    });

    it('aggregates agents, models and recent messages with percentages', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'c1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'My OpenAI',
        cached_models: null, // non-array -> count 0
        key_prefix: 'sk-abc',
        connected_at: '2026-01-01',
        is_active: true,
      });

      const lastUsedDate = new Date('2026-02-01T10:00:00Z');
      // Query order in controller: lastUsed, agentRows, modelRows, recentMessages
      messageRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb({ rawOne: { last_used_at: lastUsedDate } }))
        .mockReturnValueOnce(
          makeQb({
            rawMany: [
              {
                agent_name: 'agent-a',
                tokens: 80,
                cost: 1.5,
                messages: 3,
                last_used: lastUsedDate,
                agent_platform: 'openclaw',
              },
              {
                agent_name: 'agent-b',
                tokens: 20,
                cost: 0.5,
                messages: 1,
                last_used: '2026-02-01T09:00:00Z',
                agent_platform: null,
              },
            ],
          }),
        )
        .mockReturnValueOnce(
          makeQb({
            rawMany: [
              { model: 'gpt-4o', tokens: 60, cost: 1.0, messages: 2 },
              { model: 'gpt-4o-mini', tokens: 40, cost: 0.2, messages: 2 },
            ],
          }),
        )
        .mockReturnValueOnce(makeQb({ rawMany: [{ id: 'msg-1' }] }));

      const out = (await controller.getConnectionDetail(
        ctx,
        'c1',
      )) as unknown as ConnectionDetailFull;

      expect(providerRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'c1', tenant_id: 'tenant-1' },
      });
      expect(out.connection).toMatchObject({
        id: 'c1',
        cached_model_count: 0,
        is_active: true,
        last_used_at: lastUsedDate.toISOString(),
      });
      // agent percentages: 80/100=80, 20/100=20
      expect(out.agents[0]).toMatchObject({
        agent_name: 'agent-a',
        agent_platform: 'openclaw',
        pct_of_total: 80,
        last_used: lastUsedDate.toISOString(),
      });
      expect(out.agents[1]).toMatchObject({
        agent_name: 'agent-b',
        agent_platform: null,
        pct_of_total: 20,
        last_used: '2026-02-01T09:00:00Z',
      });
      // model percentages: 60/100=60, 40/100=40
      expect(out.model_usage[0]).toMatchObject({ model: 'gpt-4o', pct_of_total: 60 });
      expect(out.model_usage[1]).toMatchObject({ model: 'gpt-4o-mini', pct_of_total: 40 });
      expect(out.recent_messages).toEqual([{ id: 'msg-1' }]);
    });

    it('handles zero totals (pct 0), null last_used and string last_used_at', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'c1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'My OpenAI',
        cached_models: null,
        key_prefix: null,
        connected_at: '2026-01-01',
        is_active: false,
      });

      messageRepo.createQueryBuilder
        // last_used_at as a raw string (not a Date)
        .mockReturnValueOnce(makeQb({ rawOne: { last_used_at: '2026-02-01T00:00:00Z' } }))
        .mockReturnValueOnce(
          makeQb({
            rawMany: [{ agent_name: 'agent-a', tokens: 0, cost: 0, messages: 0, last_used: null }],
          }),
        )
        .mockReturnValueOnce(
          makeQb({ rawMany: [{ model: 'gpt-4o', tokens: 0, cost: 0, messages: 0 }] }),
        )
        .mockReturnValueOnce(makeQb({ rawMany: [] }));

      const out = (await controller.getConnectionDetail(
        ctx,
        'c1',
      )) as unknown as ConnectionDetailFull;
      expect(out.connection.last_used_at).toBe('2026-02-01T00:00:00Z');
      expect(out.agents[0].pct_of_total).toBe(0);
      expect(out.agents[0].last_used).toBeNull();
      expect(out.model_usage[0].pct_of_total).toBe(0);
    });

    it('scopes every usage query to the connection id, not the provider/auth/label tuple', async () => {
      // Two keys can share provider+auth_type+label; only user_provider_id is
      // unique per key, so every usage query must filter on conn.id — and must
      // NOT fall back to the old provider_key_label predicate.
      providerRepo.findOne.mockResolvedValue({
        id: 'c1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Work',
        cached_models: [],
        key_prefix: 'sk',
        connected_at: '2026-01-01',
        is_active: true,
      });

      const qbs = [
        makeQb({ rawOne: { last_used_at: null } }),
        makeQb({ rawMany: [] }),
        makeQb({ rawMany: [] }),
        makeQb({ rawMany: [] }),
      ];
      messageRepo.createQueryBuilder
        .mockReturnValueOnce(qbs[0])
        .mockReturnValueOnce(qbs[1])
        .mockReturnValueOnce(qbs[2])
        .mockReturnValueOnce(qbs[3]);

      await controller.getConnectionDetail(ctx, 'c1');

      for (const qb of qbs) {
        const idCall = qb.andWhere.mock.calls.find((c) =>
          String(c[0]).includes('at.tenant_provider_id = :tenantProviderId'),
        );
        expect(idCall).toBeDefined();
        expect(idCall![1]).toEqual({ tenantProviderId: 'c1' });
        // The legacy label predicate must be gone — that was the merge bug.
        const labelCall = qb.andWhere.mock.calls.find((c) =>
          String(c[0]).includes("LOWER(COALESCE(at.provider_key_label, 'Default'))"),
        );
        expect(labelCall).toBeUndefined();
      }
    });

    it('scopes by connection id even when the connection label is null', async () => {
      // A legacy connection with a NULL label still has a unique id; the detail
      // resolves by that id rather than collapsing a label to 'Default'.
      providerRepo.findOne.mockResolvedValue({
        id: 'c1',
        provider: 'openai',
        auth_type: 'api_key',
        label: null,
        cached_models: [],
        key_prefix: 'sk',
        connected_at: '2026-01-01',
        is_active: true,
      });

      const firstQb = makeQb({ rawOne: { last_used_at: null } });
      messageRepo.createQueryBuilder
        .mockReturnValueOnce(firstQb)
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));

      await controller.getConnectionDetail(ctx, 'c1');

      const idCall = firstQb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('at.tenant_provider_id = :tenantProviderId'),
      );
      expect(idCall![1]).toEqual({ tenantProviderId: 'c1' });
    });

    it('returns null last_used_at when no rows have ever been recorded', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'c1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'My OpenAI',
        cached_models: [],
        key_prefix: 'sk',
        connected_at: '2026-01-01',
        is_active: true,
      });

      messageRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb({ rawOne: { last_used_at: null } }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));

      const out = (await controller.getConnectionDetail(
        ctx,
        'c1',
      )) as unknown as ConnectionDetailFull;
      expect(out.connection.last_used_at).toBeNull();
      expect(out.agents).toEqual([]);
      expect(out.model_usage).toEqual([]);
    });
  });
});
