import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { OverviewController } from './overview.controller';
import { AggregationService } from '../services/aggregation.service';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import { ProviderService } from '../../routing/routing-core/provider.service';
import { ResolveAgentService } from '../../routing/routing-core/resolve-agent.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';

function mockAggregation(): Record<string, jest.Mock> {
  return {
    // Previous-window totals power the trend arrows; the current-window summary
    // is derived from the timeseries buckets below.
    getPreviousWindowMetrics: jest.fn().mockResolvedValue({ tokens: 900, cost: 4.0, messages: 45 }),
    getRequestReliability: jest.fn().mockResolvedValue({
      total: 50,
      successful: 48,
      success_rate: 96,
      attempt_success_rate: 90,
      manifest_lift_pct: 6,
      recovered: 3,
      previous_total: 45,
    }),
    hasAnyData: jest.fn().mockResolvedValue(true),
  };
}

function mockTimeseries(): Record<string, jest.Mock> {
  return {
    getTimeseries: jest.fn().mockResolvedValue({
      tokenUsage: [{ input_tokens: 600, output_tokens: 400 }],
      costUsage: [{ cost: 5.0 }],
      messageUsage: [{ count: 50 }],
    }),
    getCostByModel: jest.fn().mockResolvedValue([]),
    getRecentActivity: jest.fn().mockResolvedValue([]),
    getActiveSkills: jest.fn().mockResolvedValue([]),
    getPerAgentTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerAgentMessageTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerAgentCostTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getAgentUsageTimeseries: jest.fn().mockResolvedValue({
      tokenUsage: { agents: [], timeseries: [] },
      messageUsage: { agents: [], timeseries: [] },
      costUsage: { agents: [], timeseries: [] },
    }),
    getPerProviderTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerProviderMessageTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerProviderCostTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getProviderUsageTimeseries: jest.fn().mockResolvedValue({
      tokenUsage: { agents: [], timeseries: [] },
      messageUsage: { agents: [], timeseries: [] },
      costUsage: { agents: [], timeseries: [] },
    }),
    getPerModelTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerModelMessageTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
    getPerModelCostTimeseries: jest.fn().mockResolvedValue({ agents: [], timeseries: [] }),
  };
}

describe('OverviewController', () => {
  let controller: OverviewController;
  let agg: Record<string, jest.Mock>;
  let ts: Record<string, jest.Mock>;
  let mockResolveAgent: jest.Mock;
  let mockGetProviders: jest.Mock;
  let mockAccessFind: jest.Mock;

  const ctx = { tenantId: 'tenant-123', userId: 'u1' };

  beforeEach(async () => {
    agg = mockAggregation();
    ts = mockTimeseries();
    mockResolveAgent = jest.fn().mockResolvedValue({ id: 'agent-uuid-1' });
    mockGetProviders = jest.fn().mockResolvedValue([]);
    mockAccessFind = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [OverviewController],
      providers: [
        { provide: AggregationService, useValue: agg },
        { provide: TimeseriesQueriesService, useValue: ts },
        { provide: ProviderService, useValue: { getProviders: mockGetProviders } },
        { provide: ResolveAgentService, useValue: { resolve: mockResolveAgent } },
        { provide: getRepositoryToken(AgentEnabledProvider), useValue: { find: mockAccessFind } },
      ],
    }).compile();

    controller = module.get<OverviewController>(OverviewController);
  });

  it('returns overview with hourly timeseries for 24h range', async () => {
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    expect(result.summary.tokens_today).toBeDefined();
    expect(result.summary.cost_today).toBeDefined();
    expect(result.summary.messages).toBeDefined();
    // The overview excludes Playground traffic everywhere (excludePlayground=true)
    // so the summary cards, aggregate charts, breakdowns and has_data agree.
    expect(ts.getTimeseries).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      true,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      false,
    );
  });

  it('derives token and cost totals from buckets and messages from requests', async () => {
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    // Tokens and cost come from attempt buckets; the message total comes from
    // request reliability (the fixtures intentionally both contain 50).
    expect(result.summary.tokens_today.value).toBe(1000);
    expect(result.summary.tokens_today.sub_values).toEqual({ input: 600, output: 400 });
    expect(result.summary.cost_today.value).toBe(5.0);
    expect(result.summary.messages.value).toBe(50);
    // Trends are computed against the previous-window totals.
    expect(result.summary.tokens_today.trend_pct).toBe(11); // (1000-900)/900
    expect(result.summary.cost_today.trend_pct).toBe(25); // (5-4)/4
    expect(result.summary.messages.trend_pct).toBe(11); // (50-45)/45
    expect(result.request_reliability).toEqual({
      total: 50,
      successful: 48,
      success_rate: 96,
      attempt_success_rate: 90,
      manifest_lift_pct: 6,
      recovered: 3,
      previous_total: 45,
    });
  });

  it('returns overview with daily timeseries for 7d range', async () => {
    const result = await controller.getOverview({ range: '7d' }, ctx as never);

    expect(result.token_usage).toBeDefined();
    expect(ts.getTimeseries).toHaveBeenCalledWith(
      '7d',
      'tenant-123',
      false,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      false,
    );
  });

  it('returns the critical overview without waiting for detail queries', async () => {
    const result = await controller.getOverview({ range: '90d', fast: 'true' }, ctx as never);

    expect(result.summary.messages).toEqual({ value: 50, trend_pct: 11 });
    expect(result.cost_by_model).toEqual([]);
    expect(result.recent_activity).toEqual([]);
    expect(result.request_reliability).toBeNull();
    expect(result.has_data).toBe(true);
    expect(agg.getPreviousWindowMetrics).toHaveBeenCalledWith(
      '90d',
      'tenant-123',
      undefined,
      true,
      false,
    );
    expect(ts.getTimeseries).toHaveBeenCalledWith(
      '90d',
      'tenant-123',
      false,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      false,
    );
    expect(agg.hasAnyData).toHaveBeenCalledWith('tenant-123', undefined, true, false);
    expect(agg.getRequestReliability).not.toHaveBeenCalled();
    expect(ts.getCostByModel).not.toHaveBeenCalled();
    expect(ts.getRecentActivity).not.toHaveBeenCalled();
    expect(ts.getActiveSkills).not.toHaveBeenCalled();
  });

  it('loads slow overview details independently', async () => {
    const requestItems = [{ id: 'request-1' }];
    const messagesQuery = { getMessages: jest.fn().mockResolvedValue({ items: requestItems }) };
    const requestAwareController = new OverviewController(
      agg as never,
      ts as never,
      { getProviders: mockGetProviders } as never,
      { resolve: mockResolveAgent } as never,
      { find: mockAccessFind } as never,
      messagesQuery as never,
    );
    ts.getCostByModel.mockResolvedValueOnce([{ model: 'gpt-5', tokens: 10 }]);

    await expect(
      requestAwareController.getOverviewDetails({ range: '365d' }, ctx as never),
    ).resolves.toEqual({
      cost_by_model: [{ model: 'gpt-5', tokens: 10 }],
      recent_activity: requestItems,
      request_reliability: expect.objectContaining({ total: 50 }),
      active_skills: [],
    });
    expect(messagesQuery.getMessages).toHaveBeenCalledWith({
      range: '365d',
      tenantId: 'tenant-123',
      agent_name: undefined,
      limit: 5,
      include_total: false,
      include_filter_options: false,
      exclude_playground: true,
      exclude_direct: false,
    });
    expect(ts.getCostByModel).toHaveBeenCalledWith('365d', 'tenant-123', undefined, true, false);
    expect(agg.getRequestReliability).toHaveBeenCalledWith(
      '365d',
      'tenant-123',
      undefined,
      true,
      false,
    );
    expect(ts.getActiveSkills).toHaveBeenCalledWith('365d', 'tenant-123', undefined, true, false);
  });

  it('uses request rows for recent activity when the request query service is available', async () => {
    const requestItems = [{ id: 'request-1', status: 'ok' }];
    const messagesQuery = { getMessages: jest.fn().mockResolvedValue({ items: requestItems }) };
    const requestAwareController = new OverviewController(
      agg as never,
      ts as never,
      { getProviders: mockGetProviders } as never,
      { resolve: mockResolveAgent } as never,
      { find: mockAccessFind } as never,
      messagesQuery as never,
    );

    const result = await requestAwareController.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      ctx as never,
    );

    expect(result.recent_activity).toEqual(requestItems);
    expect(messagesQuery.getMessages).toHaveBeenCalledWith({
      range: '24h',
      tenantId: 'tenant-123',
      agent_name: 'bot-1',
      limit: 5,
      include_total: false,
      include_filter_options: false,
      exclude_playground: true,
      exclude_direct: true,
    });
    expect(ts.getRecentActivity).not.toHaveBeenCalled();
  });

  it('keeps direct requests in the recent-activity query on the global overview', async () => {
    // Recent activity is served by the request log, which is also what backs the
    // Requests page — so the exclusion has to be opt-in per call, not baked in.
    const messagesQuery = { getMessages: jest.fn().mockResolvedValue({ items: [] }) };
    const requestAwareController = new OverviewController(
      agg as never,
      ts as never,
      { getProviders: mockGetProviders } as never,
      { resolve: mockResolveAgent } as never,
      { find: mockAccessFind } as never,
      messagesQuery as never,
    );

    await requestAwareController.getOverview({ range: '24h' }, ctx as never);

    expect(messagesQuery.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ agent_name: undefined, exclude_direct: false }),
    );
  });

  it('returns combined agent usage timeseries', async () => {
    await controller.getOverviewAgentsUsage({ range: '24h' }, ctx as never);
    expect(ts.getAgentUsageTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true);
  });

  it('returns combined provider usage timeseries with agent scope', async () => {
    await controller.getOverviewProvidersUsage({ range: '7d', agent_name: 'bot-1' }, ctx as never);
    expect(ts.getProviderUsageTimeseries).toHaveBeenCalledWith('7d', 'tenant-123', false, 'bot-1');
  });

  it('defaults range to 24h when not specified', async () => {
    await controller.getOverview({}, ctx as never);

    expect(agg.getPreviousWindowMetrics).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      undefined,
      true,
      false,
    );
  });

  it('passes agent_name and tenantId to all calls, excluding Playground everywhere', async () => {
    await controller.getOverview({ range: '24h', agent_name: 'bot-1' }, ctx as never);

    expect(agg.getPreviousWindowMetrics).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      'bot-1',
      true,
      true,
    );
    expect(agg.getRequestReliability).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      'bot-1',
      true,
      true,
    );
    expect(ts.getTimeseries).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      true,
      'bot-1',
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      true,
    );
    expect(ts.getCostByModel).toHaveBeenCalledWith('24h', 'tenant-123', 'bot-1', true, true);
    expect(ts.getRecentActivity).toHaveBeenCalledWith('24h', 'tenant-123', 5, 'bot-1', true, true);
    expect(ts.getActiveSkills).toHaveBeenCalledWith('24h', 'tenant-123', 'bot-1', true, true);
    expect(agg.hasAnyData).toHaveBeenCalledWith('tenant-123', 'bot-1', true, true);
  });

  it('keeps client-pinned (direct) requests on the global overview', async () => {
    // No agent_name => the cross-harness view, which must stay complete: it is
    // where direct requests are accounted for and where total spend reconciles.
    await controller.getOverview({ range: '24h' }, ctx as never);

    expect(ts.getRecentActivity).toHaveBeenCalledWith(
      '24h',
      'tenant-123',
      5,
      undefined,
      true,
      false,
    );
    expect(ts.getCostByModel).toHaveBeenCalledWith('24h', 'tenant-123', undefined, true, false);
    expect(ts.getActiveSkills).toHaveBeenCalledWith('24h', 'tenant-123', undefined, true, false);
    expect(agg.hasAnyData).toHaveBeenCalledWith('tenant-123', undefined, true, false);
  });

  it('includes services_hit placeholder in summary', async () => {
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    expect(result.summary.services_hit).toEqual({ total: 0, healthy: 0, issues: 0 });
  });

  it('includes has_data boolean in response', async () => {
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    expect(result.has_data).toBe(true);
  });

  it('returns has_data false when no data exists', async () => {
    agg.hasAnyData.mockResolvedValueOnce(false);
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    expect(result.has_data).toBe(false);
  });

  it('passes null tenantId straight through when tenant not resolved', async () => {
    const nullCtx = { tenantId: null, userId: 'u1' };
    await controller.getOverview({ range: '24h' }, nullCtx as never);

    expect(agg.getPreviousWindowMetrics).toHaveBeenCalledWith('24h', null, undefined, true, false);
  });

  it('returns has_providers true when agent has active providers', async () => {
    mockGetProviders.mockResolvedValueOnce([{ id: 'provider-1', is_active: true }]);
    mockAccessFind.mockResolvedValueOnce([
      { agent_id: 'agent-uuid-1', tenant_provider_id: 'provider-1' },
    ]);
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      ctx as never,
    );

    expect(result.has_providers).toBe(true);
    expect(mockResolveAgent).toHaveBeenCalledWith('tenant-123', 'bot-1');
    expect(mockGetProviders).toHaveBeenCalledWith('tenant-123');
    expect(mockAccessFind).toHaveBeenCalledWith({ where: { agent_id: 'agent-uuid-1' } });
  });

  it('returns has_providers false when active providers are not enabled for the agent', async () => {
    mockGetProviders.mockResolvedValueOnce([{ id: 'provider-1', is_active: true }]);
    mockAccessFind.mockResolvedValueOnce([
      { agent_id: 'agent-uuid-1', tenant_provider_id: 'provider-2' },
    ]);
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      ctx as never,
    );

    expect(result.has_providers).toBe(false);
  });

  it('returns has_providers false when no providers exist', async () => {
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      ctx as never,
    );

    expect(result.has_providers).toBe(false);
  });

  it('returns has_providers false when agent_name is not provided', async () => {
    const result = await controller.getOverview({ range: '24h' }, ctx as never);

    expect(result.has_providers).toBe(false);
    expect(mockResolveAgent).not.toHaveBeenCalled();
  });

  it('returns has_providers false when tenant is null', async () => {
    const nullCtx = { tenantId: null, userId: 'u1' };
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      nullCtx as never,
    );

    expect(result.has_providers).toBe(false);
    expect(mockResolveAgent).not.toHaveBeenCalled();
  });

  it('returns has_providers false when agent resolution fails', async () => {
    mockResolveAgent.mockRejectedValueOnce(new Error('Not found'));
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'missing-agent' },
      ctx as never,
    );

    expect(result.has_providers).toBe(false);
  });

  it('returns has_providers false when all providers are inactive', async () => {
    mockGetProviders.mockResolvedValueOnce([{ is_active: false }, { is_active: false }]);
    const result = await controller.getOverview(
      { range: '24h', agent_name: 'bot-1' },
      ctx as never,
    );

    expect(result.has_providers).toBe(false);
  });

  describe('per-agent / per-provider / per-model timeseries endpoints', () => {
    it('getPerAgentTimeseries delegates with hourly range', async () => {
      await controller.getPerAgentTimeseries({ range: '24h' }, ctx as never);
      expect(ts.getPerAgentTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true);
    });

    it('getPerAgentMessageTimeseries defaults range to 24h', async () => {
      await controller.getPerAgentMessageTimeseries({}, ctx as never);
      expect(ts.getPerAgentMessageTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true);
    });

    it('getPerAgentCostTimeseries delegates with daily range', async () => {
      await controller.getPerAgentCostTimeseries({ range: '7d' }, ctx as never);
      expect(ts.getPerAgentCostTimeseries).toHaveBeenCalledWith('7d', 'tenant-123', false);
    });

    it('getPerProviderTimeseries forwards agent_name', async () => {
      await controller.getPerProviderTimeseries(
        { range: '24h', agent_name: 'bot-1' },
        ctx as never,
      );
      expect(ts.getPerProviderTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true, 'bot-1');
    });

    it('getPerProviderMessageTimeseries defaults range and undefined agent', async () => {
      await controller.getPerProviderMessageTimeseries({}, ctx as never);
      expect(ts.getPerProviderMessageTimeseries).toHaveBeenCalledWith(
        '24h',
        'tenant-123',
        true,
        undefined,
      );
    });

    it('getPerProviderCostTimeseries delegates', async () => {
      await controller.getPerProviderCostTimeseries(
        { range: '30d', agent_name: 'bot-1' },
        ctx as never,
      );
      expect(ts.getPerProviderCostTimeseries).toHaveBeenCalledWith(
        '30d',
        'tenant-123',
        false,
        'bot-1',
      );
    });

    it('getPerModelTimeseries delegates', async () => {
      await controller.getPerModelTimeseries({ range: '24h' }, ctx as never);
      expect(ts.getPerModelTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true, undefined);
    });

    it('getPerModelMessageTimeseries delegates', async () => {
      await controller.getPerModelMessageTimeseries(
        { range: '7d', agent_name: 'bot-1' },
        ctx as never,
      );
      expect(ts.getPerModelMessageTimeseries).toHaveBeenCalledWith(
        '7d',
        'tenant-123',
        false,
        'bot-1',
      );
    });

    it('getPerModelCostTimeseries delegates', async () => {
      await controller.getPerModelCostTimeseries(
        { range: '24h', agent_name: 'bot-1' },
        ctx as never,
      );
      expect(ts.getPerModelCostTimeseries).toHaveBeenCalledWith('24h', 'tenant-123', true, 'bot-1');
    });

    it('passes null tenantId straight through when unresolved', async () => {
      const nullCtx = { tenantId: null, userId: 'u1' };
      await controller.getPerAgentTimeseries({ range: '24h' }, nullCtx as never);
      expect(ts.getPerAgentTimeseries).toHaveBeenCalledWith('24h', null, true);
    });
  });
});
