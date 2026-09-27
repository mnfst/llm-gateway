import { AutofixAnalyticsController } from './autofix-analytics.controller';

describe('AutofixAnalyticsController', () => {
  const service = {
    getWorkspaceStatus: jest.fn(),
    enableAll: jest.fn(),
    getStats: jest.fn(),
    getTimeseries: jest.fn(),
    getPerAgentStats: jest.fn(),
    getPerProviderStats: jest.fn(),
  };
  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const controller = new AutofixAnalyticsController(service as never, cache as never);
  const ctx = { tenantId: 'tenant' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('delegates every Autofix analytics route with tenant scope', async () => {
    service.getWorkspaceStatus.mockResolvedValue({
      any_enabled: true,
      enabled_agents: ['demo'],
      needs_enable_all: false,
      consented: true,
    });
    service.getStats.mockResolvedValue({ autofix_saves: { value: 1 } });
    service.getTimeseries.mockResolvedValue({ buckets: [] });
    service.getPerAgentStats.mockResolvedValue([]);
    service.getPerProviderStats.mockResolvedValue([]);

    await controller.getStatus(ctx);
    await controller.getStats({ range: '30d', agent_name: 'demo' }, ctx);
    await controller.getTimeseries(
      { range: '24h', agent_name: 'demo', by: 'autofix', failed_only: 'true' },
      ctx,
    );
    await controller.getPerAgent({ range: '7d' }, ctx);
    await controller.getPerProvider({ range: '90d', agent_name: 'demo' }, ctx);

    expect(service.getWorkspaceStatus).toHaveBeenCalledWith('tenant');
    expect(service.getStats).toHaveBeenCalledWith({
      tenantId: 'tenant',
      range: '30d',
      agentName: 'demo',
    });
    expect(service.getTimeseries).toHaveBeenCalledWith({
      tenantId: 'tenant',
      range: '24h',
      by: 'autofix',
      agentName: 'demo',
      failedOnly: true,
    });
    expect(service.getPerAgentStats).toHaveBeenCalledWith({ tenantId: 'tenant', range: '7d' });
    expect(service.getPerProviderStats).toHaveBeenCalledWith({
      tenantId: 'tenant',
      range: '90d',
      agentName: 'demo',
    });
  });

  it('treats non-true failed_only values as false', async () => {
    await controller.getTimeseries({ failed_only: 'false' }, ctx);
    expect(service.getTimeseries).toHaveBeenCalledWith({
      tenantId: 'tenant',
      range: undefined,
      by: undefined,
      agentName: undefined,
      failedOnly: false,
    });
  });

  it('delegates enable-all to the stats service and busts the status cache', async () => {
    service.enableAll.mockResolvedValue({
      any_enabled: true,
      enabled_agents: ['demo'],
      needs_enable_all: false,
      consented: true,
    });
    await expect(controller.enableAll(ctx)).resolves.toEqual({
      any_enabled: true,
      enabled_agents: ['demo'],
      needs_enable_all: false,
      consented: true,
    });
    expect(service.enableAll).toHaveBeenCalledWith('tenant');
    expect(cache.del).toHaveBeenCalledWith('tenant:/api/v1/autofix/status');
  });

  it('rejects enable-all without a resolved tenant', async () => {
    await expect(controller.enableAll({ tenantId: null } as never)).rejects.toThrow(
      'No workspace resolved',
    );
    expect(service.enableAll).not.toHaveBeenCalled();
  });
});
