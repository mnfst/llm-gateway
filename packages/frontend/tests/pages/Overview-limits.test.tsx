import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';

let mockAgentName = 'test-agent';
vi.mock('@solidjs/router', () => ({
  useParams: () => ({ agentName: mockAgentName }),
  useLocation: () => ({ pathname: `/harnesses/${mockAgentName}`, state: null }),
  useNavigate: () => vi.fn(),
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockGetOverview = vi.fn();
const mockGetOverviewDetails = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getOverview: (...args: unknown[]) => mockGetOverview(...args),
  getOverviewDetails: (...args: unknown[]) => mockGetOverviewDetails(...args),
  getCustomProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../src/services/sse.js', () => ({
  pingCount: () => 0,
  messagePing: () => 0,
  analyticsPing: () => 0,
  agentPing: () => 0,
  routingPing: () => 0,
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) => s,
  formatErrorOrigin: (o: string | null | undefined) => o ?? null,
  formatTime: (t: string) => t,
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderFromModel: () => null,
  inferProviderName: () => '',
  stripCustomPrefix: (m: string) => m,
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

// The per-agent Overview now renders ProviderChartCard → MultiAgentTokenChart
// (uPlot) and fetches per-provider timeseries; stub both so jsdom doesn't load
// the real chart (which calls matchMedia).
vi.mock('../../src/services/api/analytics.js', () => ({
  RECOVERED_REQUESTS_TOOLTIP: 'Successful requests that were recovered by Autofix or fallback.',
  REQUEST_SUCCESS_RATE_TOOLTIP:
    'Successful requests over all requests. Recovered requests count as successful.',
  totalAttemptsTooltip: (doctor: boolean) =>
    doctor
      ? 'Every provider call counts here, including fallback retries and autofixed attempts. One request can produce several attempts.'
      : 'Every provider call counts here, including fallback retries. One request can produce several attempts.',
  MODEL_SUCCESS_RATE_TOOLTIP: 'Successful attempts over all attempts for this model.',
  PROVIDER_SUCCESS_RATE_TOOLTIP: 'Successful attempts over all attempts for this provider.',
  CONNECTION_SUCCESS_RATE_TOOLTIP_30D:
    'Successful attempts over all attempts for this connection, over the last 30 days.',
  CONNECTION_SUCCESS_RATE_TOOLTIP:
    'Successful attempts over all attempts for this connection, on the filtered period.',
  CONNECTION_HARNESS_SUCCESS_RATE_TOOLTIP:
    'Successful attempts over all attempts for this harness on this connection.',
  HARNESS_SUCCESS_RATE_TOOLTIP: 'Successful requests over all requests for this harness.',
  HARNESS_TOTAL_REQUESTS_TOOLTIP:
    'Logical requests from this harness, one per call, whatever the number of attempts.',
  attemptSuccessRate: (row: { attempts: number; succeeded?: number }) =>
    !row.attempts || row.succeeded == null ? null : row.succeeded / row.attempts,
  getPerProviderTimeseries: () => Promise.resolve({ agents: [], timeseries: [] }),
  getPerProviderMessageTimeseries: () => Promise.resolve({ agents: [], timeseries: [] }),
  getPerProviderCostTimeseries: () => Promise.resolve({ agents: [], timeseries: [] }),
  getAttemptStats: () =>
    Promise.resolve({
      total_attempts: { value: 0, previous: 0 },
      fallbacked_attempts: { value: 0, previous: 0 },
    }),
  getAttemptTimeseries: () => Promise.resolve({ range: '7d', by: 'metric', keys: [], buckets: [] }),
  getWorkspaceAutofixStatus: () =>
    Promise.resolve({ any_enabled: false, enabled_agents: [], consented: true }),
  getAutofixStats: () => Promise.resolve(null),
  getAutofixTimeseries: () =>
    Promise.resolve({ range: '7d', by: 'disposition', keys: [], buckets: [] }),
  getPerProviderReliability: () => Promise.resolve([]),
  getPerModelReliability: () => Promise.resolve([]),
  getErrorBreakdown: () => Promise.resolve({ by_class: {}, by_origin: {}, auto_fixed: 0 }),
}));

vi.mock('../../src/services/api/routing.js', () => ({
  getAutofix: () => Promise.resolve({ enabled: false }),
}));
vi.mock('../../src/components/MultiAgentTokenChart.jsx', () => ({
  AGENT_COLORS: ['#111111', '#222222'],
  default: () => <div data-testid="multi-agent-chart" />,
}));
vi.mock('../../src/components/SetupModal.jsx', () => ({
  default: (props: any) => (
    <div data-testid="setup-modal" data-open={props.open ? 'true' : 'false'} />
  ),
}));
vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: () => <span data-testid="info-tooltip" />,
}));
vi.mock('../../src/components/Select.jsx', () => ({
  default: (props: any) => (
    <select
      data-testid="select"
      value={props.value}
      onChange={(e: any) => props.onChange(e.target.value)}
    >
      {props.options?.map((o: any) => (
        <option value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

vi.mock('../../src/services/recent-agents.js', () => ({
  isRecentlyCreated: () => false,
  isSetupPending: () => false,
  clearSetupPending: vi.fn(),
}));

import Overview from '../../src/pages/Overview';

const overviewData = {
  summary: {
    tokens_today: { value: 50000, trend_pct: 12 },
    cost_today: { value: 3.5, trend_pct: -5 },
    messages: { value: 42, trend_pct: 8 },
    services_hit: { total: 3, healthy: 3, issues: 0 },
  },
  token_usage: [{ hour: '2026-02-18 10:00:00', input_tokens: 1000, output_tokens: 500 }],
  cost_usage: [{ hour: '2026-02-18 10:00:00', cost: 0.5 }],
  message_usage: [{ hour: '2026-02-18 10:00:00', count: 5 }],
  cost_by_model: [],
  recent_activity: [
    {
      id: 'msg-12345678',
      timestamp: '2026-02-18T10:00:00Z',
      agent_name: 'test-agent',
      model: 'gpt-4o',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost: 0.01,
      status: 'ok',
    },
  ],
  has_data: true,
};

describe('Overview - trend badges and status display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('manifest_global_group', 'provider');
    mockAgentName = 'test-agent';
    mockGetOverviewDetails.mockResolvedValue({});
  });

  it('does not render trend badge when trend_pct is 0', async () => {
    const zeroTrendData = {
      ...overviewData,
      summary: {
        ...overviewData.summary,
        tokens_today: { value: 50000, trend_pct: 0 },
        cost_today: { value: 3.5, trend_pct: 0 },
        messages: { value: 42, trend_pct: 0 },
      },
    };
    mockGetOverview.mockResolvedValue(zeroTrendData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
    });
    const trendBadges = container.querySelectorAll('.trend');
    expect(trendBadges.length).toBe(0);
  });

  it('renders a provider rate_limited row as a plain error, not a limits-page link', async () => {
    const rateLimitedData = {
      ...overviewData,
      recent_activity: [
        {
          id: 'msg-ratelimit1',
          timestamp: '2026-02-18T10:00:00Z',
          agent_name: 'test-agent',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: null,
          cost: null,
          status: 'rate_limited',
        },
      ],
    };
    mockGetOverview.mockResolvedValue(rateLimitedData);
    mockGetOverviewDetails.mockResolvedValue({
      recent_activity: rateLimitedData.recent_activity,
      cost_by_model: [],
    });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      // Binary status: a provider rate limit is just a "Failed" pill now.
      const badge = container.querySelector('.status-badge--error');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('Failed');
    });
    expect(container.textContent).not.toContain('rate_limited');
    // A provider rate limit is a plain error — it must not link to the Manifest
    // spend-limits page (that page is for the user's own software limits).
    expect(container.querySelector('.status-badge--error a')).toBeNull();
  });

  it('renders routing tier badge when routing_tier is set', async () => {
    const routedData = {
      ...overviewData,
      recent_activity: [
        {
          ...overviewData.recent_activity[0],
          routing_tier: 'complex',
        },
      ],
    };
    mockGetOverview.mockResolvedValue(routedData);
    mockGetOverviewDetails.mockResolvedValue({
      recent_activity: routedData.recent_activity,
      cost_by_model: [],
    });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const tierBadge = container.querySelector('.tier-badge--complex');
      expect(tierBadge).not.toBeNull();
      expect(tierBadge?.textContent).toBe('complex');
    });
  });

  it('renders the negative cost trend badge on the chart card', async () => {
    // ProviderChartCard renders neutral trend badges (no inverted up-bad /
    // down-good styling).
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const badges = Array.from(container.querySelectorAll('.trend--neutral'));
      expect(badges.some((b) => b.textContent?.includes('-5%'))).toBe(true);
    });
  });

  it('renders the positive token trend badge on the chart card', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const badges = Array.from(container.querySelectorAll('.trend--neutral'));
      expect(badges.some((b) => b.textContent?.includes('+12%'))).toBe(true);
    });
  });

  it('renders status-specific class on status badge', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    mockGetOverviewDetails.mockResolvedValue({
      recent_activity: overviewData.recent_activity,
      cost_by_model: [],
    });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.querySelector('.status-badge--ok')).not.toBeNull();
    });
  });
});
