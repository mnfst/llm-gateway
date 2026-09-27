import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

// Controllable SSE ping: lets a test bump `messagePing()` to drive a background
// refetch and assert it does NOT flash the skeleton (unlike a range change).
const pingBox = vi.hoisted(() => ({ read: (): number => 0, set: (_: number) => {} }));

let mockAgentName = 'test-agent';
let mockLocationState: any = null;
const mockNavigate = vi.fn();
// Reactive agent-name source for `useParams().agentName`. Solid's router
// returns a reactive params store, so switching agents (e.g. via the sidebar)
// updates `agentName` in place without remounting the route component — a
// plain object here would miss that. The getter re-reads the signal on every
// access, which is enough for Solid's tracking to pick it up as a dependency.
const agentNameBox = vi.hoisted(() => ({
  read: (): string => 'test-agent',
  set: (_: string) => {},
}));
vi.mock('@solidjs/router', () => ({
  useParams: () => ({
    get agentName() {
      return agentNameBox.read();
    },
  }),
  useLocation: () => ({ pathname: `/harnesses/${mockAgentName}`, state: mockLocationState }),
  useNavigate: () => mockNavigate,
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: (props: any) => <meta name={props.name ?? ''} content={props.content ?? ''} />,
}));

const mockGetOverview = vi.fn();
const mockGetCustomProviders = vi.fn();
const mockSetMessageFeedback = vi.fn();
const mockClearMessageFeedback = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getOverview: (...args: unknown[]) => mockGetOverview(...args),
  getOverviewDetails: () => Promise.resolve({}),
  getCustomProviders: (...args: unknown[]) => mockGetCustomProviders(...args),
  setMessageFeedback: (...args: unknown[]) => mockSetMessageFeedback(...args),
  clearMessageFeedback: (...args: unknown[]) => mockClearMessageFeedback(...args),
}));

vi.mock('../../src/services/sse.js', () => ({
  pingCount: () => 0,
  messagePing: () => 0,
  analyticsPing: () => pingBox.read(),
  agentPing: () => 0,
  routingPing: () => 0,
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug.replace(/^custom:[^/]+\//, ''),
  preloadModelDisplayNames: () => {},
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) => s,
  formatErrorOrigin: (o: string | null | undefined) => o ?? null,
  formatTime: (t: string) => t,
  formatErrorMessage: (s: string) => s,
  customProviderColor: vi.fn(() => '#6366f1'),
}));

const mockCheckIsSelfHosted = vi.fn(() => Promise.resolve(false));
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

// The per-agent Overview renders ProviderChartCard → MultiAgentTokenChart.
// Stub the chart to a marker exposing its series, and the per-view provider
// timeseries endpoints to a controllable resolver.
const mockPerProvider = vi.fn(() => Promise.resolve({ agents: [], timeseries: [] }));
const mockPerProviderTokens = vi.fn((...a: unknown[]) => mockPerProvider(...a));
const mockPerProviderMessages = vi.fn((...a: unknown[]) => mockPerProvider(...a));
const mockPerProviderCosts = vi.fn((...a: unknown[]) => mockPerProvider(...a));
const mockGetAutofixStats = vi.fn();
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
  getPerProviderTimeseries: (...a: unknown[]) => mockPerProviderTokens(...a),
  getPerProviderMessageTimeseries: (...a: unknown[]) => mockPerProviderMessages(...a),
  getPerProviderCostTimeseries: (...a: unknown[]) => mockPerProviderCosts(...a),
  getAttemptStats: () =>
    Promise.resolve({
      total_attempts: { value: 50, previous: 40 },
      fallbacked_attempts: { value: 5, previous: 4 },
    }),
  getAttemptTimeseries: () => Promise.resolve({ range: '7d', by: 'metric', keys: [], buckets: [] }),
  getWorkspaceAutofixStatus: () =>
    Promise.resolve({ any_enabled: false, enabled_agents: [], consented: true }),
  getAutofixStats: (...a: unknown[]) => mockGetAutofixStats(...a),
  getAutofixTimeseries: () =>
    Promise.resolve({ range: '7d', by: 'disposition', keys: [], buckets: [] }),
  getPerProviderReliability: () => Promise.resolve([]),
  getPerModelReliability: () => Promise.resolve([]),
  getErrorBreakdown: () => Promise.resolve({ by_class: {}, by_origin: {}, auto_fixed: 0 }),
}));

vi.mock('../../src/services/api/routing.js', () => ({
  getAutofix: () => Promise.resolve({ enabled: false }),
}));

import { resetPlanStore } from '../../src/services/plan-store';

vi.mock('../../src/components/MultiAgentTokenChart.jsx', () => ({
  AGENT_COLORS: ['#111111', '#222222', '#333333'],
  default: (props: any) => (
    <div
      data-testid="multi-agent-chart"
      data-series={((props.agents ?? []) as string[]).join(',')}
      data-range={props.range}
      data-colors={Object.keys(props.colorMap ?? {}).length}
    />
  ),
}));

vi.mock('../../src/components/FeedbackModal.jsx', () => ({
  default: (props: any) => (
    <div data-testid="feedback-modal" data-open={props.open ? 'true' : 'false'}>
      <button data-testid="feedback-submit" onClick={() => props.onSubmit?.(['Too slow'], 'test')}>
        Submit
      </button>
      <button data-testid="feedback-close" onClick={() => props.onClose?.()}>
        Close
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/SetupModal.jsx', () => ({
  default: (props: any) => (
    <div
      data-testid="setup-modal"
      data-open={props.open ? 'true' : 'false'}
      data-agent={props.agentName ?? ''}
      data-api-key={props.apiKey ?? ''}
      data-platform={props.agentPlatform ?? ''}
      data-category={props.agentCategory ?? ''}
    >
      <button data-testid="setup-close" onClick={() => props.onClose?.()}>
        Close
      </button>
      <button data-testid="setup-done" onClick={() => props.onDone?.()}>
        Done
      </button>
      <button data-testid="setup-go-routing" onClick={() => props.onGoToRouting?.()}>
        Go to routing
      </button>
    </div>
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
        <option value={o.value} disabled={o.disabled}>
          {o.label}
          {o.badge ? ' - PRO' : ''}
        </option>
      ))}
    </select>
  ),
}));

const mockIsRecentlyCreated = vi.fn(() => false);
const mockIsSetupPending = vi.fn(() => false);
const mockClearSetupPending = vi.fn();
vi.mock('../../src/services/recent-agents.js', () => ({
  isRecentlyCreated: (...args: unknown[]) => mockIsRecentlyCreated(...args),
  isSetupPending: (...args: unknown[]) => mockIsSetupPending(...args),
  clearSetupPending: (...args: unknown[]) => mockClearSetupPending(...args),
}));

import Overview from '../../src/pages/Overview';

const overviewData = {
  summary: {
    tokens_today: { value: 50000, trend_pct: 12, sub_values: { input: 30000, output: 20000 } },
    cost_today: { value: 3.5, trend_pct: -5 },
    messages: { value: 42, trend_pct: 8 },
    services_hit: { total: 3, healthy: 3, issues: 0 },
  },
  token_usage: [{ hour: '2026-02-18 10:00:00', input_tokens: 1000, output_tokens: 500 }],
  cost_usage: [{ hour: '2026-02-18 10:00:00', cost: 0.5 }],
  message_usage: [{ hour: '2026-02-18 10:00:00', count: 5 }],
  cost_by_model: [
    { model: 'gpt-4o', tokens: 30000, share_pct: 60, estimated_cost: 2.1, auth_type: 'api_key' },
    {
      model: 'claude-3.5-sonnet',
      tokens: 20000,
      share_pct: 40,
      estimated_cost: 1.4,
      auth_type: 'subscription',
    },
  ],
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

const emptyOverviewData = {
  summary: {
    tokens_today: { value: 0, trend_pct: 0 },
    cost_today: { value: 0, trend_pct: 0 },
    messages: { value: 0, trend_pct: 0 },
    services_hit: { total: 0, healthy: 0, issues: 0 },
  },
  token_usage: [],
  cost_usage: [],
  message_usage: [],
  cost_by_model: [],
  recent_activity: [],
  has_data: false,
  has_providers: false,
};

describe('Overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('manifest_global_group', 'provider');
    sessionStorage.clear();
    const [ping, setPing] = createSignal(0);
    pingBox.read = ping;
    pingBox.set = setPing;
    mockIsRecentlyCreated.mockReturnValue(false);
    mockIsSetupPending.mockReturnValue(false);
    mockAgentName = 'test-agent';
    mockLocationState = null;
    const [agentName, setAgentName] = createSignal(mockAgentName);
    agentNameBox.read = agentName;
    agentNameBox.set = setAgentName;
    mockGetAutofixStats.mockResolvedValue({
      success_rate: { value: 0.9, previous: 0.8 },
      autofix_saves: { value: 7, previous: 5 },
      fallback_saves: { value: 2, previous: 1 },
      total_requests: { value: 100, previous: 90 },
      errors_remaining: { value: 3, previous: 4 },
      coverage: { rate: 0.7, previous_rate: 5 / 9 },
    });
    mockGetCustomProviders.mockResolvedValue([]);
    mockPerProvider.mockResolvedValue({ agents: [], timeseries: [] });
    resetPlanStore({ enabled: false, plan: 'free' });
  });

  it('renders Overview heading with agent name', () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    expect(container.textContent).toContain('Overview');
  });

  it('does not render duplicate agent-name H1 or breadcrumb subtitle (AgentDetail owns the H1)', () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    // The breadcrumb "Real-time summary…" must no longer be rendered inside Overview,
    // because AgentDetail already shows the agent name as an H1 above the tabs.
    expect(container.querySelector('.breadcrumb')).toBeNull();
    // No H1 element should be rendered by Overview itself.
    expect(container.querySelector('h1')).toBeNull();
  });

  it('shows loading skeleton while fetching', () => {
    mockGetOverview.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <Overview />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows the loading skeleton when the range changes', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
    });

    // Change the range; the new fetch never resolves.
    mockGetOverview.mockReturnValue(new Promise(() => {}));
    const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: '24h' } });

    // Stale data is replaced by the skeleton while the new range loads.
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });
    expect(container.textContent).not.toContain('$3.50');
  });

  it('shows the loading skeleton when switching to a different agent (issue #2267)', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
    });

    // Switch agents (e.g. clicking a different agent in the sidebar). The
    // route component stays mounted — only the reactive `agentName` param
    // changes — and the new agent's fetch never resolves.
    mockGetOverview.mockReturnValue(new Promise(() => {}));
    agentNameBox.set('other-agent');

    // The previous agent's stale data must not linger; the skeleton takes over.
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });
    expect(container.textContent).not.toContain('$3.50');
  });

  it('renders the new agent before secondary metrics finish loading', async () => {
    const firstAgentStats = {
      success_rate: { value: 0.9, previous: 0.8 },
      autofix_saves: { value: 777, previous: 5 },
      fallback_saves: { value: 2, previous: 1 },
      total_requests: { value: 100, previous: 90 },
      errors_remaining: { value: 3, previous: 4 },
      coverage: { rate: 0.7, previous_rate: 5 / 9 },
    };
    const secondAgentStats = {
      ...firstAgentStats,
      autofix_saves: { value: 888, previous: 6 },
    };
    const secondAgentOverview = {
      ...overviewData,
      summary: {
        ...overviewData.summary,
        cost_today: { value: 9.99, trend_pct: 0 },
      },
    };
    let overviewResolved = false;
    let resolveSecondAgentStats!: (value: typeof secondAgentStats) => void;
    const secondAgentStatsPromise = new Promise<typeof secondAgentStats>((resolve) => {
      resolveSecondAgentStats = resolve;
    });
    mockGetOverview.mockImplementation((_range: string, agent: string) => {
      if (agent !== 'other-agent') return Promise.resolve(overviewData);
      return Promise.resolve(secondAgentOverview).then((value) => {
        overviewResolved = true;
        return value;
      });
    });
    mockGetAutofixStats.mockImplementation((_range: string, agent: string) =>
      agent === 'other-agent' ? secondAgentStatsPromise : Promise.resolve(firstAgentStats),
    );

    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
      expect(container.textContent).toContain('777');
    });

    agentNameBox.set('other-agent');
    await vi.waitFor(() => {
      expect(overviewResolved).toBe(true);
    });
    await Promise.resolve();

    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(container.textContent).toContain('$9.99');
    expect(container.textContent).not.toContain('777');

    resolveSecondAgentStats(secondAgentStats);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$9.99');
      expect(container.textContent).toContain('888');
    });
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(container.textContent).not.toContain('777');
  });

  it('renders the critical overview when switching back before secondary metrics finish', async () => {
    const firstAgentStats = {
      success_rate: { value: 0.9, previous: 0.8 },
      autofix_saves: { value: 777, previous: 5 },
      fallback_saves: { value: 2, previous: 1 },
      total_requests: { value: 100, previous: 90 },
      errors_remaining: { value: 3, previous: 4 },
      coverage: { rate: 0.7, previous_rate: 5 / 9 },
    };
    const secondAgentStats = {
      ...firstAgentStats,
      autofix_saves: { value: 888, previous: 6 },
    };
    const returningAgentStats = {
      ...firstAgentStats,
      autofix_saves: { value: 999, previous: 7 },
    };
    const secondAgentOverview = {
      ...overviewData,
      summary: {
        ...overviewData.summary,
        cost_today: { value: 9.99, trend_pct: 0 },
      },
    };
    let resolveSecondAgentStats!: (value: typeof secondAgentStats) => void;
    let resolveReturningAgentStats!: (value: typeof returningAgentStats) => void;
    const secondAgentStatsPromise = new Promise<typeof secondAgentStats>((resolve) => {
      resolveSecondAgentStats = resolve;
    });
    const returningAgentStatsPromise = new Promise<typeof returningAgentStats>((resolve) => {
      resolveReturningAgentStats = resolve;
    });
    let firstAgentStatsCalls = 0;
    mockGetOverview.mockImplementation((_range: string, agent: string) =>
      Promise.resolve(agent === 'other-agent' ? secondAgentOverview : overviewData),
    );
    mockGetAutofixStats.mockImplementation((_range: string, agent: string) => {
      if (agent === 'other-agent') return secondAgentStatsPromise;
      firstAgentStatsCalls += 1;
      return firstAgentStatsCalls === 1
        ? Promise.resolve(firstAgentStats)
        : returningAgentStatsPromise;
    });

    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
      expect(container.textContent).toContain('777');
    });

    agentNameBox.set('other-agent');
    await vi.waitFor(() => {
      expect(mockGetOverview).toHaveBeenCalledWith('30d', 'other-agent', true);
    });
    agentNameBox.set('test-agent');
    await vi.waitFor(() => {
      expect(firstAgentStatsCalls).toBe(2);
    });
    await Promise.resolve();

    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(container.textContent).toContain('$3.50');
    expect(container.textContent).not.toContain('$9.99');
    expect(container.textContent).not.toContain('777');

    resolveSecondAgentStats(secondAgentStats);
    await Promise.resolve();
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(container.textContent).not.toContain('888');

    resolveReturningAgentStats(returningAgentStats);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
      expect(container.textContent).toContain('999');
    });
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(container.textContent).not.toContain('888');
  });

  it('keeps showing data during a background ping refetch instead of skeletons', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
    });

    // A background SSE ping refetch (same range) never resolves.
    mockGetOverview.mockReturnValue(new Promise(() => {}));
    pingBox.set(1);

    // Old data stays put — no skeleton flash on in-place refreshes.
    await Promise.resolve();
    expect(container.textContent).toContain('$3.50');
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
  });

  it('shows summary stats after data loads', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$3.50');
      expect(container.textContent).toContain('50000');
      expect(container.textContent).toContain('42');
    });
  });

  it('shows trend badges with percentages', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('+12%');
      expect(container.textContent).toContain('-5%');
      expect(container.textContent).toContain('+8%');
    });
  });

  it('shows trend badges even when metric values are zero (trend is still meaningful)', async () => {
    const zeroData = {
      ...overviewData,
      summary: {
        ...overviewData.summary,
        cost_today: { value: 0, trend_pct: -999 },
        tokens_today: { value: 0, trend_pct: 500, sub_values: { input: 0, output: 0 } },
        messages: { value: 0, trend_pct: -100 },
      },
    };
    mockGetOverview.mockResolvedValue(zeroData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$0.00');
      const trends = container.querySelectorAll('.trend');
      expect(trends.length).toBeGreaterThan(0);
    });
  });

  it('clamps absurdly large trend percentages', async () => {
    const absurdData = {
      ...overviewData,
      summary: {
        ...overviewData.summary,
        cost_today: { value: 5.0, trend_pct: 5000000 },
      },
    };
    mockGetOverview.mockResolvedValue(absurdData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('+999%');
      expect(container.textContent).not.toContain('5000000%');
    });
  });

  it('shows recent messages table', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Recent Requests');
      expect(container.textContent).toContain('msg-1234');
      expect(container.textContent).toContain('gpt-4o');
    });
  });

  it('shows cost by model table', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Model usage');
      expect(container.textContent).toContain('gpt-4o');
      expect(container.textContent).toContain('claude-3.5-sonnet');
      expect(container.textContent).toContain('60%');
    });
  });

  it('sorts cost by model rows by estimated_cost descending', async () => {
    const data = {
      ...overviewData,
      cost_by_model: [
        {
          model: 'claude-3.5-sonnet',
          tokens: 20000,
          share_pct: 40,
          estimated_cost: 1.4,
          auth_type: 'subscription',
        },
        {
          model: 'gpt-4o',
          tokens: 30000,
          share_pct: 60,
          estimated_cost: 2.1,
          auth_type: 'api_key',
        },
      ],
    };
    mockGetOverview.mockResolvedValue(data);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const panels = container.querySelectorAll('.panel');
      // Find the Cost by Model panel
      const costPanel = Array.from(panels).find((p) => p.textContent?.includes('Model usage'));
      expect(costPanel).toBeDefined();
      const rows = costPanel!.querySelectorAll('tbody tr');
      expect(rows.length).toBe(2);
      // gpt-4o ($2.1) should come before claude ($1.4) even though claude is first in data
      expect(rows[0].textContent).toContain('gpt-4o');
      expect(rows[1].textContent).toContain('claude-3.5-sonnet');
    });
  });

  it('renders auth badges on cost by model provider icons', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const panels = container.querySelectorAll('.panel');
      const costPanel = Array.from(panels).find((p) => p.textContent?.includes('Model usage'));
      expect(costPanel).toBeDefined();
      const keyBadge = costPanel!.querySelector('.provider-auth-badge--key');
      const subBadge = costPanel!.querySelector('.provider-auth-badge--sub');
      expect(keyBadge).not.toBeNull();
      expect(subBadge).not.toBeNull();
    });
  });

  it('shows empty state for new agent with no data', async () => {
    mockGetOverview.mockResolvedValue(emptyOverviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No activity yet');
    });
  });

  it('calls getOverview on mount', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    render(() => <Overview />);
    await vi.waitFor(() => {
      expect(mockGetOverview).toHaveBeenCalled();
    });
  });

  it('only fetches the visible provider chart series on mount', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    mockPerProvider.mockResolvedValue({
      agents: ['openai'],
      timeseries: [{ hour: '1', openai: 5 }],
    });
    render(() => <Overview />);

    await vi.waitFor(() => {
      expect(mockPerProviderMessages).toHaveBeenCalledWith('test-agent', '30d');
    });
    expect(mockPerProviderMessages).toHaveBeenCalledTimes(1);
    expect(mockPerProviderTokens).not.toHaveBeenCalled();
    expect(mockPerProviderCosts).not.toHaveBeenCalled();
  });

  it('fetches token and cost provider series when those chart views are opened', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    mockPerProvider.mockResolvedValue({
      agents: ['openai'],
      timeseries: [{ hour: '1', openai: 5 }],
    });
    const { container } = render(() => <Overview />);

    await vi.waitFor(() => {
      expect(mockPerProviderMessages).toHaveBeenCalledTimes(1);
      expect(container.querySelectorAll('.chart-card__stat--clickable').length).toBe(4);
    });
    const stats = container.querySelectorAll('.chart-card__stat--clickable');
    fireEvent.click(stats[2]); // cost (Requests=0, Recovered=1, Cost=2, Token usage=3)
    await vi.waitFor(() => {
      expect(mockPerProviderCosts).toHaveBeenCalledWith('test-agent', '30d');
    });
  });

  it('has clickable stat headers for requests, recovered requests, cost and tokens', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const clickable = container.querySelectorAll('.chart-card__stat--clickable');
      expect(clickable.length).toBe(4);
    });
    expect(screen.getAllByText('Recovered requests').length).toBeGreaterThan(0);
  });

  it('loads and renders the self-healed KPIs and tab for every tenant', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    render(() => <Overview />);

    await vi.waitFor(() => {
      expect(screen.getAllByText('Success rate').length).toBeGreaterThan(0);
    });
    expect(mockGetAutofixStats).toHaveBeenCalledWith('30d', 'test-agent');
    // Tab + KPI cards share the label; both surfaces are present.
    expect(screen.getAllByText('Recovered requests').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Recovered by Autofix')).toBeDefined();
    expect(screen.getByText('Recovered by Fallback')).toBeDefined();
  });

  it('switches chart view when stat header clicked', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    mockPerProvider.mockResolvedValue({
      agents: ['openai'],
      timeseries: [{ hour: '1', openai: 5 }],
    });
    const { container } = render(() => <Overview />);
    // The Requests view is status-only now (no per-provider request chart);
    // usage views render the multi-provider chart. Order:
    // Requests / Recovered requests / Cost / Tokens.
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.chart-card__stat--clickable').length).toBe(4);
    });
    expect(container.querySelector('[data-testid="multi-agent-chart"]')).toBeNull();

    const stats = container.querySelectorAll('.chart-card__stat--clickable');

    fireEvent.click(stats[2]); // cost
    await vi.waitFor(() => {
      const active = container.querySelector('.chart-card__stat--active');
      expect(active?.textContent).toContain('Cost');
    });

    fireEvent.click(stats[3]); // tokens — renders the token-view chart
    await vi.waitFor(() => {
      const active = container.querySelector('.chart-card__stat--active');
      expect(active?.textContent).toContain('Token usage');
      expect(container.querySelector('[data-testid="multi-agent-chart"]')).not.toBeNull();
    });
  });

  it('shows View more link to messages page', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const link = container.querySelector('a.view-more-link') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute('href')).toBe('/harnesses/test-agent/messages');
    });
  });

  describe('status cell', () => {
    it('renders a failed row as a Failed badge with no hover tooltip', async () => {
      // The status-cell hover tooltip was removed — error detail is shown in the
      // expanded accordion now, so the cell is just the binary Failed pill.
      const dataWithError = {
        ...overviewData,
        recent_activity: [
          {
            id: 'msg-err12345',
            timestamp: '2026-02-18T10:00:00Z',
            agent_name: 'test-agent',
            model: 'gpt-4o',
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost: 0,
            status: 'error',
            error_origin: 'provider',
            error_message: '401 Unauthorized: invalid API key',
          },
        ],
      };
      mockGetOverview.mockResolvedValue(dataWithError);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const badge = container.querySelector('.status-badge--error');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toContain('Failed');
      });
      expect(container.querySelector('.status-badge-tooltip')).toBeNull();
    });
  });

  describe('custom provider models', () => {
    // The backend resolves the custom provider's name into each row
    // (`custom_provider_name`); the page no longer fetches the list itself.
    const customOverview = {
      ...overviewData,
      recent_activity: [
        {
          id: 'msg-cp1',
          timestamp: '2026-02-18T10:00:00Z',
          agent_name: 'test-agent',
          model: 'custom:abc-123/my-llama',
          provider: 'custom:abc-123',
          custom_provider_name: 'Cohere',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost: 0.01,
          status: 'ok',
        },
      ],
      cost_by_model: [
        {
          model: 'custom:abc-123/my-llama',
          provider: 'custom:abc-123',
          custom_provider_name: 'Cohere',
          tokens: 30000,
          share_pct: 100,
          estimated_cost: 2.1,
          auth_type: 'api_key',
        },
      ],
    };

    it('renders custom provider icon in recent messages', async () => {
      mockGetOverview.mockResolvedValue(customOverview);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const img = container.querySelector('img[alt="Cohere"]');
        expect(img).not.toBeNull();
      });
    });

    it('strips custom prefix from model name display', async () => {
      mockGetOverview.mockResolvedValue(customOverview);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('my-llama');
        expect(container.textContent).not.toContain('custom:abc-123/');
      });
    });

    it('renders custom provider icon in cost by model table', async () => {
      mockGetOverview.mockResolvedValue(customOverview);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const imgs = container.querySelectorAll('img[alt="Cohere"]');
        // At least one in recent messages and one in cost by model
        expect(imgs.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('falls back to model prefix when custom provider was deleted', async () => {
      const deletedProvider = {
        ...customOverview,
        recent_activity: [{ ...customOverview.recent_activity[0], custom_provider_name: null }],
        cost_by_model: [{ ...customOverview.cost_by_model[0], custom_provider_name: null }],
      };
      mockGetOverview.mockResolvedValue(deletedProvider);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('my-llama');
        expect(container.textContent).not.toContain('custom:abc-123/');
      });
    });
  });

  describe('setup modal callbacks', () => {
    it('closes setup modal and sets dismissed flag', async () => {
      mockGetOverview.mockResolvedValue(emptyOverviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('true');
      });

      const closeBtn = container.querySelector('[data-testid="setup-close"]') as HTMLButtonElement;
      fireEvent.click(closeBtn);

      await vi.waitFor(() => {
        expect(localStorage.getItem('setup_dismissed_test-agent')).toBe('1');
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('false');
      });
      expect(mockClearSetupPending).toHaveBeenCalledWith('test-agent');
    });

    it('marks setup as completed when onDone is called', async () => {
      mockGetOverview.mockResolvedValue(emptyOverviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('true');
      });

      const doneBtn = container.querySelector('[data-testid="setup-done"]') as HTMLButtonElement;
      fireEvent.click(doneBtn);

      await vi.waitFor(() => {
        expect(localStorage.getItem('setup_completed_test-agent')).toBe('1');
      });
      expect(mockClearSetupPending).toHaveBeenCalledWith('test-agent');
    });

    it('opens the setup modal on mount when setup is pending (survives a refresh)', async () => {
      // has_data true → showEmptyState() is false, so the empty-state effect
      // does NOT open the modal. The persistent pending flag is the only thing
      // that opens it here, proving the gate survives a refresh.
      mockIsSetupPending.mockReturnValue(true);
      mockGetOverview.mockResolvedValue({
        ...overviewData,
        has_data: true,
        has_providers: true,
      });
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('true');
      });
      expect(mockIsSetupPending).toHaveBeenCalledWith('test-agent');
    });

    it('keeps the setup modal closed on mount when pending but already dismissed', async () => {
      mockIsSetupPending.mockReturnValue(true);
      localStorage.setItem('setup_dismissed_test-agent', '1');
      mockGetOverview.mockResolvedValue({
        ...overviewData,
        has_data: true,
        has_providers: true,
      });
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="setup-modal"]')).not.toBeNull();
      });
      const modal = container.querySelector('[data-testid="setup-modal"]');
      expect(modal?.getAttribute('data-open')).toBe('false');
    });

    it('keeps the setup modal closed on mount when pending but already completed', async () => {
      mockIsSetupPending.mockReturnValue(true);
      localStorage.setItem('setup_completed_test-agent', '1');
      mockGetOverview.mockResolvedValue({
        ...overviewData,
        has_data: true,
        has_providers: true,
      });
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="setup-modal"]')).not.toBeNull();
      });
      const modal = container.querySelector('[data-testid="setup-modal"]');
      expect(modal?.getAttribute('data-open')).toBe('false');
    });
  });

  it('shows waiting banner when has_providers is true but has_data is false', async () => {
    mockGetOverview.mockResolvedValue({ ...emptyOverviewData, has_providers: true });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No activity yet');
      expect(container.querySelector('.waiting-banner')).not.toBeNull();
      expect(container.querySelector('.empty-state')).toBeNull();
    });
  });

  it('shows dashboard with zeros when has_providers is true but has_data is false', async () => {
    mockGetOverview.mockResolvedValue({ ...emptyOverviewData, has_providers: true });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.querySelector('.chart-card__stat--clickable')).not.toBeNull();
      expect(container.textContent).toContain('$0.00');
    });
  });

  it('shows full dashboard when has_data is true regardless of has_providers', async () => {
    mockGetOverview.mockResolvedValue({ ...overviewData, has_data: true, has_providers: false });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.querySelector('.chart-card__stat--clickable')).not.toBeNull();
      expect(container.querySelector('.empty-state')).toBeNull();
    });
  });

  it('does not show waiting banner when has_data is true', async () => {
    mockGetOverview.mockResolvedValue({ ...overviewData, has_data: true, has_providers: true });
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.querySelector('.waiting-banner')).toBeNull();
    });
  });

  it('shows Connect provider button when setupCompleted but no providers and no data', async () => {
    localStorage.setItem('setup_completed_test-agent', '1');
    mockGetOverview.mockResolvedValue(emptyOverviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connect provider');
      expect(container.textContent).toContain('Connect a provider to start routing LLM calls');
      expect(container.textContent).not.toContain('Enable routing');
      const btn = container.querySelector('.empty-state button.btn--primary');
      expect(btn).not.toBeNull();
    });
  });

  it('navigates to routing with openProviders state when Connect provider clicked', async () => {
    localStorage.setItem('setup_completed_test-agent', '1');
    mockGetOverview.mockResolvedValue(emptyOverviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connect provider');
    });
    const btn = container.querySelector('.empty-state button.btn--primary') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/harnesses/test-agent/routing', {
      state: { openProviders: true },
    });
  });

  it('shows Set up harness button when not setupCompleted and no providers', async () => {
    mockGetOverview.mockResolvedValue(emptyOverviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Set up harness');
      expect(container.textContent).not.toContain('Enable routing');
      expect(container.textContent).not.toContain('Connect provider');
    });
  });

  describe('SetupModal callbacks', () => {
    it('sets localStorage and closes modal on onClose', async () => {
      mockGetOverview.mockResolvedValue(emptyOverviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('true');
      });
      fireEvent.click(screen.getByTestId('setup-close'));
      expect(localStorage.getItem('setup_dismissed_test-agent')).toBe('1');
    });

    it('sets localStorage on onDone', async () => {
      mockGetOverview.mockResolvedValue(emptyOverviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const modal = container.querySelector('[data-testid="setup-modal"]');
        expect(modal?.getAttribute('data-open')).toBe('true');
      });
      fireEvent.click(screen.getByTestId('setup-done'));
      expect(localStorage.getItem('setup_completed_test-agent')).toBe('1');
    });

    it('navigates to routing page on onGoToRouting', async () => {
      mockGetOverview.mockResolvedValue(emptyOverviewData);
      render(() => <Overview />);
      await vi.waitFor(() => {
        expect(screen.getByTestId('setup-go-routing')).toBeDefined();
      });
      fireEvent.click(screen.getByTestId('setup-go-routing'));
      expect(mockNavigate).toHaveBeenCalledWith('/harnesses/test-agent/routing', {
        state: { openProviders: true },
      });
    });
  });

  describe('range persistence', () => {
    it('persists range selection in localStorage', async () => {
      mockGetOverview.mockResolvedValue(overviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="select"]')).not.toBeNull();
      });
      const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
      await fireEvent.change(select, { target: { value: '24h' } });
      expect(localStorage.getItem('manifest_chart_range')).toBe('24h');
    });

    it('reads persisted range from localStorage on mount', async () => {
      localStorage.setItem('manifest_chart_range', '24h');
      mockGetOverview.mockResolvedValue(overviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('24h');
      });
    });

    it('defaults to 30d when no localStorage value', async () => {
      mockGetOverview.mockResolvedValue(overviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('30d');
      });
    });

    it('ignores stale localStorage value and defaults to 30d', async () => {
      localStorage.setItem('manifest_chart_range', '1h');
      mockGetOverview.mockResolvedValue(overviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('30d');
      });
    });

    it('limits Free users to 7-day dashboard ranges and labels longer ranges as Pro-only', async () => {
      localStorage.setItem('manifest_chart_range', '365d');
      resetPlanStore({ enabled: true, plan: 'free' });
      mockGetOverview.mockResolvedValue(overviewData);

      const { container } = render(() => <Overview />);

      await vi.waitFor(() => {
        expect(mockGetOverview).toHaveBeenCalledWith('7d', 'test-agent', true);
      });
      await vi.waitFor(() => {
        expect(localStorage.getItem('manifest_chart_range')).toBe('7d');
      });

      const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
      const lockedOptions = Array.from(select.options).filter((option) =>
        ['30d', '90d', '365d'].includes(option.value),
      );
      expect(lockedOptions.map((option) => option.disabled)).toEqual([true, true, true]);
      expect(select.textContent).toContain('Last 30 days - PRO');

      fireEvent.change(select, { target: { value: '90d' } });
      expect(localStorage.getItem('manifest_chart_range')).toBe('7d');
    });
  });

  describe('smart default range', () => {
    it('cascades to smaller range when data arrays are all empty', async () => {
      const emptyUsageData = {
        ...overviewData,
        has_data: true,
        token_usage: [],
        cost_usage: [],
        message_usage: [],
      };
      mockGetOverview.mockResolvedValue(emptyUsageData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        // Cascades from 30d → 7d → 24h (all empty, lands at final range)
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('24h');
      });
    });

    it('does not cascade when user has manually selected a range', async () => {
      localStorage.setItem('manifest_chart_range', '30d');
      const emptyUsageData = {
        ...overviewData,
        has_data: true,
        token_usage: [],
        cost_usage: [],
        message_usage: [],
      };
      mockGetOverview.mockResolvedValue(emptyUsageData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('30d');
      });
    });

    it('stays on current range when there is data', async () => {
      mockGetOverview.mockResolvedValue(overviewData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('30d');
      });
    });

    it('cascades when localStorage contains an invalid range (not treated as user selection)', async () => {
      // An invalid stored range must NOT lock userSelectedRange=true;
      // the smart-range cascade must still kick in.
      localStorage.setItem('manifest_chart_range', 'invalid');
      const emptyUsageData = {
        ...overviewData,
        has_data: true,
        token_usage: [],
        cost_usage: [],
        message_usage: [],
      };
      mockGetOverview.mockResolvedValue(emptyUsageData);
      const { container } = render(() => <Overview />);
      await vi.waitFor(() => {
        // Cascade should run: all-empty data + invalid stored range → lands at 24h
        const select = container.querySelector('[data-testid="select"]') as HTMLSelectElement;
        expect(select.value).toBe('24h');
      });
    });
  });

  it('renders provider icon and auth badge in cost_by_model for known providers', async () => {
    const dataWithKnownModel = {
      ...overviewData,
      cost_by_model: [
        {
          model: 'gpt-4o',
          tokens: 30000,
          share_pct: 100,
          estimated_cost: 2.1,
          auth_type: 'api_key',
        },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithKnownModel);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const panels = container.querySelectorAll('.panel');
      const costPanel = Array.from(panels).find((p) => p.textContent?.includes('Model usage'));
      expect(costPanel).toBeDefined();
      // Verify the provider icon SVG is rendered (aria-hidden, not role="img")
      const icon = costPanel!.querySelector('svg[aria-hidden="true"]');
      expect(icon).not.toBeNull();
      // Verify auth badge is rendered
      const keyBadge = costPanel!.querySelector('.provider-auth-badge--key');
      expect(keyBadge).not.toBeNull();
    });
  });

  it('shows $0.00 cost for flat-fee subscription messages (cost null) in recent activity', async () => {
    const dataWithSub = {
      ...overviewData,
      recent_activity: [
        { ...overviewData.recent_activity[0], auth_type: 'subscription', cost: null },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithSub);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const subCost = container.querySelector('[title="Included in subscription"]');
      expect(subCost).not.toBeNull();
      expect(subCost!.textContent).toBe('$0.00');
    });
  });

  it('renders the per-request cost for subscriptions (e.g. OpenCode Go)', async () => {
    const dataWithPerRequestSub = {
      ...overviewData,
      recent_activity: [
        { ...overviewData.recent_activity[0], auth_type: 'subscription', cost: 0.013636 },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithPerRequestSub);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      // Per-request subscription rows should show the real cost, not $0.00.
      expect(container.textContent).toContain('$0.01');
      const tooltip = container.querySelector('[title^="Per-request subscription cost:"]');
      expect(tooltip).not.toBeNull();
    });
  });

  it('shows formatCost for non-subscription messages with cost in recent activity', async () => {
    const dataWithCost = {
      ...overviewData,
      recent_activity: [{ ...overviewData.recent_activity[0], auth_type: null, cost: 0.05 }],
    };
    mockGetOverview.mockResolvedValue(dataWithCost);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$0.05');
    });
  });

  it('renders subscription auth badge on provider icon in recent activity', async () => {
    const dataWithSub = {
      ...overviewData,
      recent_activity: [
        { ...overviewData.recent_activity[0], model: 'claude-sonnet-4', auth_type: 'subscription' },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithSub);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.provider-auth-badge--sub');
      expect(badge).not.toBeNull();
    });
  });

  it('renders api_key auth badge when auth_type is api_key', async () => {
    const dataWithApiKey = {
      ...overviewData,
      recent_activity: [
        { ...overviewData.recent_activity[0], model: 'claude-sonnet-4', auth_type: 'api_key' },
      ],
      cost_by_model: overviewData.cost_by_model.map((r) => ({ ...r, auth_type: 'api_key' })),
    };
    mockGetOverview.mockResolvedValue(dataWithApiKey);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.provider-auth-badge--key');
      expect(badge).not.toBeNull();
      const subBadge = container.querySelector('.provider-auth-badge--sub');
      expect(subBadge).toBeNull();
    });
  });

  it('renders fallback badge in recent activity when fallback_from_model is present', async () => {
    const dataWithFallback = {
      ...overviewData,
      recent_activity: [
        { ...overviewData.recent_activity[0], fallback_from_model: 'gpt-4o', fallback_index: 0 },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithFallback);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      // Fallback is now surfaced in the Self-heal column, not a Model-cell badge.
      const badge = container.querySelector('[title="Fallback"]');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('title')).toBe('Fallback');
    });
  });

  it('does not render fallback badge in recent activity when fallback_from_model is absent', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('gpt-4o');
      const badge = container.querySelector('.tier-badge--fallback');
      expect(badge).toBeNull();
    });
  });

  it('renders a non-ok recent-activity row as a binary Failed status', async () => {
    const dataWithFailure = {
      ...overviewData,
      recent_activity: [
        {
          ...overviewData.recent_activity[0],
          status: 'fallback_error',
          model: 'gemini-flash',
          error_origin: 'provider',
          error_message: 'Provider returned HTTP 429, routed to fallback',
        },
      ],
    };
    mockGetOverview.mockResolvedValue(dataWithFailure);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      // Status is now binary: any non-ok row is "Failed" (with an origin
      // descriptor); fallback_error is no longer its own pill.
      expect(container.querySelector('.status-badge--fallback_error')).toBeNull();
      const badge = container.querySelector('.status-badge--error');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('Failed');
    });
  });

  it('recent request rows navigate to the Requests page with the request selected', async () => {
    mockGetOverview.mockResolvedValue(overviewData);
    const { container } = render(() => <Overview />);
    await vi.waitFor(() => {
      expect(container.querySelector('.msg-row--clickable')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('.msg-row--clickable')!);
    // No inline accordion: the click deep-links into the Requests page drawer.
    expect(container.querySelector('.msg-row--expanded')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/harnesses\/test-agent\/messages\?request=/),
    );
  });
});
