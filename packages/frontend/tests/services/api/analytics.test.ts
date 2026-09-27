import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as analytics from '../../../src/services/api/analytics';

vi.mock('../../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function setupFetch(response: unknown = {}, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('analytics API client', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getOverview defaults range to 24h and omits agent_name when absent', async () => {
    const fetchMock = setupFetch({});
    await analytics.getOverview();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/overview');
    expect(url).toContain('range=24h');
    expect(url).not.toContain('agent_name=');
  });

  it('getOverview forwards agent_name when provided', async () => {
    const fetchMock = setupFetch({});
    await analytics.getOverview('7d', 'demo');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('range=7d');
    expect(url).toContain('agent_name=demo');
  });

  it('getOverview supports the fast response and loads details separately', async () => {
    let fetchMock = setupFetch({});
    await analytics.getOverview('365d', 'demo', true);
    let url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/overview');
    expect(url).toContain('fast=true');

    fetchMock = setupFetch({});
    await analytics.getOverviewDetails('365d', 'demo');
    url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/overview/details');
    expect(url).toContain('range=365d');
    expect(url).toContain('agent_name=demo');
  });

  it('getAttemptStats uses the stats route and optional agent scope', async () => {
    const fetchMock = setupFetch({});
    await analytics.getAttemptStats('30d', 'demo');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/overview/attempt-stats');
    expect(url).toContain('range=30d');
    expect(url).toContain('agent_name=demo');
  });

  it('getAttemptStats defaults to seven days without an agent scope', async () => {
    const fetchMock = setupFetch({});
    await analytics.getAttemptStats();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('range=7d');
    expect(url).not.toContain('agent_name=');
  });

  it('getAttemptTimeseries supports scoped and unscoped requests', async () => {
    let fetchMock = setupFetch({});
    await analytics.getAttemptTimeseries();
    let url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/overview/attempt-timeseries');
    expect(url).toContain('range=7d');
    expect(url).not.toContain('agent_name=');

    fetchMock = setupFetch({});
    await analytics.getAttemptTimeseries('24h', 'demo');
    url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('range=24h');
    expect(url).toContain('agent_name=demo');
  });

  it('calls the Autofix analytics routes with their optional scopes', async () => {
    let fetchMock = setupFetch({});
    await analytics.getWorkspaceAutofixStatus();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/autofix/status');

    fetchMock = setupFetch({});
    await analytics.getAutofixStats('30d', 'demo');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/overview/autofix-stats');
    expect(fetchMock.mock.calls[0][0]).toContain('agent_name=demo');

    fetchMock = setupFetch({});
    await analytics.getAutofixTimeseries('24h', 'autofix', 'demo', true);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/overview/autofix-timeseries');
    expect(fetchMock.mock.calls[0][0]).toContain('failed_only=true');

    fetchMock = setupFetch({});
    await analytics.getPerProviderReliability('7d', 'demo');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/overview/autofix-per-provider');
    expect(fetchMock.mock.calls[0][0]).toContain('agent_name=demo');

    fetchMock = setupFetch({});
    await analytics.getPerAgentReliability('90d');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/overview/autofix-per-agent');

    fetchMock = setupFetch({});
    await analytics.getErrorBreakdown('30d', 'demo');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/errors/breakdown');
    expect(fetchMock.mock.calls[0][0]).toContain('agent_name=demo');
  });

  it('uses Autofix analytics defaults without optional filters', async () => {
    const calls = [
      () => analytics.getAutofixStats(),
      () => analytics.getAutofixTimeseries(),
      () => analytics.getPerProviderReliability(),
      () => analytics.getErrorBreakdown(),
    ];
    for (const call of calls) {
      const fetchMock = setupFetch({});
      await call();
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).not.toContain('agent_name=');
      expect(url).not.toContain('failed_only=');
    }
  });

  it('getHealth GETs /health', async () => {
    const fetchMock = setupFetch({ ok: true });
    await analytics.getHealth();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/health');
  });

  it('getModelPrices GETs /model-prices', async () => {
    const fetchMock = setupFetch([]);
    await analytics.getModelPrices();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/model-prices');
  });

  it('getProviderAnalytics forwards auth_type, range and optional filters', async () => {
    const fetchMock = setupFetch({});
    await analytics.getProviderAnalytics('subscription', '7d', 'demo', 'openai');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/provider-analytics');
    expect(url).toContain('auth_type=subscription');
    expect(url).toContain('range=7d');
    expect(url).toContain('agent_name=demo');
    expect(url).toContain('provider=openai');
  });

  it('getProviderAnalytics omits agent_name, provider and connection_id when absent', async () => {
    const fetchMock = setupFetch({});
    await analytics.getProviderAnalytics('api_key');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('auth_type=api_key');
    expect(url).toContain('range=24h');
    expect(url).not.toContain('agent_name=');
    expect(url).not.toContain('provider=');
    expect(url).not.toContain('connection_id=');
  });

  it('getProviderAnalytics forwards connection_id when provided', async () => {
    const fetchMock = setupFetch({});
    await analytics.getProviderAnalytics('api_key', '7d', undefined, 'openai', 'Work', 'conn-1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('connection_id=conn-1');
  });

  it('getProviderAnalyticsAgents forwards auth_type', async () => {
    const fetchMock = setupFetch({ agents: [] });
    await analytics.getProviderAnalyticsAgents('subscription');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/provider-analytics/agents');
    expect(url).toContain('auth_type=subscription');
  });

  it('per-agent timeseries endpoints forward auth_type + provider + range', async () => {
    const fns: Array<[(a: string, p: string, r?: string) => unknown, string]> = [
      [analytics.getPerAgentTimeseries, 'per-agent-timeseries'],
      [analytics.getPerAgentMessageTimeseries, 'per-agent-message-timeseries'],
      [analytics.getPerAgentCostTimeseries, 'per-agent-cost-timeseries'],
    ];
    for (const [fn, path] of fns) {
      const fetchMock = setupFetch({ agents: [], timeseries: [] });
      await fn('subscription', 'openai', '30d');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`/api/v1/provider-analytics/${path}`);
      expect(url).toContain('auth_type=subscription');
      expect(url).toContain('provider=openai');
      expect(url).toContain('range=30d');
      expect(url).not.toContain('connection_id=');
    }
  });

  it('per-agent timeseries endpoints forward connection_id when provided', async () => {
    const fns: Array<
      [(a: string, p: string, r?: string, l?: string, c?: string) => unknown, string]
    > = [
      [analytics.getPerAgentTimeseries, 'per-agent-timeseries'],
      [analytics.getPerAgentMessageTimeseries, 'per-agent-message-timeseries'],
      [analytics.getPerAgentCostTimeseries, 'per-agent-cost-timeseries'],
    ];
    for (const [fn, path] of fns) {
      const fetchMock = setupFetch({ agents: [], timeseries: [] });
      await fn('subscription', 'openai', '30d', 'Work', 'conn-7');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`/api/v1/provider-analytics/${path}`);
      expect(url).toContain('connection_id=conn-7');
    }
  });

  it('getConnectionDetail forwards connection_id', async () => {
    const fetchMock = setupFetch({});
    await analytics.getConnectionDetail('conn-1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/provider-analytics/connection-detail');
    expect(url).toContain('connection_id=conn-1');
  });

  it('global per-* timeseries endpoints forward range', async () => {
    const fns: Array<[(r?: string) => unknown, string]> = [
      [analytics.getGlobalPerAgentTimeseries, 'per-agent-timeseries'],
      [analytics.getGlobalPerAgentMessageTimeseries, 'per-agent-message-timeseries'],
      [analytics.getGlobalPerAgentCostTimeseries, 'per-agent-cost-timeseries'],
      [analytics.getOverviewAgentUsage, 'agents/usage'],
      [analytics.getGlobalPerProviderTimeseries, 'per-provider-timeseries'],
      [analytics.getGlobalPerProviderMessageTimeseries, 'per-provider-message-timeseries'],
      [analytics.getGlobalPerProviderCostTimeseries, 'per-provider-cost-timeseries'],
      [analytics.getOverviewProviderUsage, 'providers/usage'],
      [analytics.getGlobalPerModelTimeseries, 'per-model-timeseries'],
      [analytics.getGlobalPerModelMessageTimeseries, 'per-model-message-timeseries'],
      [analytics.getGlobalPerModelCostTimeseries, 'per-model-cost-timeseries'],
    ];
    for (const [fn, path] of fns) {
      const fetchMock = setupFetch({ agents: [], timeseries: [] });
      await fn('7d');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`/api/v1/overview/${path}`);
      expect(url).toContain('range=7d');
    }
  });

  it('agent-scoped per-provider timeseries endpoints forward agent_name + range', async () => {
    const fns: Array<[(a: string, r?: string) => unknown, string]> = [
      [analytics.getPerProviderTimeseries, 'per-provider-timeseries'],
      [analytics.getPerProviderMessageTimeseries, 'per-provider-message-timeseries'],
      [analytics.getPerProviderCostTimeseries, 'per-provider-cost-timeseries'],
    ];
    for (const [fn, path] of fns) {
      const fetchMock = setupFetch({ agents: [], timeseries: [] });
      await fn('demo', '30d');
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`/api/v1/overview/${path}`);
      expect(url).toContain('agent_name=demo');
      expect(url).toContain('range=30d');
    }
  });
});
