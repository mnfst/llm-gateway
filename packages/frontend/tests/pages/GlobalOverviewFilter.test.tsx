import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';

/**
 * Targeted coverage for GlobalOverview's harness/provider multi-select
 * `onUnselectAll` callback. The real `FilterSelect` only renders a "Select all"
 * button, so `onUnselectAll` is unreachable through its DOM — we stub
 * FilterSelect to expose the callback as a button and assert the page clears the
 * selection and persists an empty set to sessionStorage.
 */

const apiMocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getGlobalProviders: vi.fn(),
  getGlobalProviderUsage: vi.fn(),
  getOverview: vi.fn(),
  getOverviewDetails: vi.fn(),
  getOverviewAgentUsage: vi.fn(),
  getOverviewProviderUsage: vi.fn(),
  getBillingStatus: vi.fn(),
  navigate: vi.fn(),
}));

const sseMocks = vi.hoisted(() => ({
  bumpAgent: undefined as undefined | (() => void),
  bumpAnalytics: undefined as undefined | (() => void),
  bumpRouting: undefined as undefined | (() => void),
  reset: undefined as undefined | (() => void),
}));

let filterSelectProps: {
  onUnselectAll: () => void;
  onSelectAll: () => void;
  items: string[];
} | null = null;
let providerChartProps: Record<string, unknown> | null = null;
let mockSearchParams: Record<string, string | undefined> = {};

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <title>{props.children}</title>,
}));

vi.mock('@solidjs/router', () => ({
  A: (props: { href: string; children: unknown; class?: string }) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useNavigate: () => apiMocks.navigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('../../src/services/api.js', async () => {
  const providers = await vi.importActual<typeof import('../../src/services/api/providers')>(
    '../../src/services/api/providers',
  );
  return {
    getAgents: (...args: unknown[]) => apiMocks.getAgents(...args),
    getGlobalProviders: (...args: unknown[]) => apiMocks.getGlobalProviders(...args),
    getGlobalProviderUsage: (...args: unknown[]) => apiMocks.getGlobalProviderUsage(...args),
    mergeUsage: providers.mergeUsage,
  };
});

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
  selfHealedCount: (row: { autofixed: number; fallback_saves?: number }) =>
    row.autofixed + (row.fallback_saves ?? 0),
  successRate: (row: { requests: number; succeeded?: number }) =>
    !row.requests || row.succeeded == null ? null : row.succeeded / row.requests,
  getPerAgentReliability: () =>
    Promise.resolve([
      {
        agent_name: 'demo-agent',
        requests: 18,
        failed: 1,
        autofixed: 1,
        fallback_saves: 1,
        succeeded: 17,
      },
    ]),
  getOverview: (...args: unknown[]) => apiMocks.getOverview(...args),
  getOverviewDetails: (...args: unknown[]) => apiMocks.getOverviewDetails(...args),
  getOverviewAgentUsage: (...args: unknown[]) => apiMocks.getOverviewAgentUsage(...args),
  getOverviewProviderUsage: (...args: unknown[]) => apiMocks.getOverviewProviderUsage(...args),
  getAttemptStats: () =>
    Promise.resolve({
      total_attempts: { value: 20, previous: 10 },
      fallbacked_attempts: { value: 2, previous: 1 },
    }),
  getAttemptTimeseries: () => Promise.resolve({ range: '7d', by: 'metric', keys: [], buckets: [] }),
  getWorkspaceAutofixStatus: () =>
    Promise.resolve({ any_enabled: false, enabled_agents: [], consented: true }),
  getAutofixStats: () => Promise.resolve(null),
  getAutofixTimeseries: () =>
    Promise.resolve({ range: '7d', by: 'disposition', keys: [], buckets: [] }),
  getPerProviderReliability: () =>
    Promise.resolve([
      {
        provider: 'openai',
        auth_type: 'api_key',
        key_label: 'Default',
        attempts: 10,
        succeeded: 7,
      },
    ]),
  getPerModelReliability: () => Promise.resolve([]),
  getErrorBreakdown: () => Promise.resolve({ by_class: {}, by_origin: {}, auto_fixed: 0 }),
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => apiMocks.getBillingStatus(...args),
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1', name: 'Test User', email: 'test@test.com' } },
      isPending: false,
    }),
  },
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
  ],
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: (provider: string) =>
    provider.startsWith('custom:') ? null : <span data-provider-icon={provider} />,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/MultiAgentTokenChart.jsx', () => ({
  AGENT_COLORS: ['#111111', '#222222', '#333333'],
  default: () => <div data-testid="multi-agent-token-chart" />,
}));

vi.mock('../../src/components/ProviderChartCard.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    providerChartProps = props;
    return <div data-testid="provider-chart-card" />;
  },
}));

vi.mock('../../src/components/Sparkline.jsx', () => ({
  default: (props: { data: number[] }) => <span data-testid="sparkline">{props.data.length}</span>,
}));

vi.mock('../../src/components/Select.jsx', () => ({
  default: (props: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string; disabled?: boolean; description?: string }>;
  }) => (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      {props.options.map((option) => (
        <option value={option.value} disabled={option.disabled}>
          {option.description ? `${option.label} · ${option.description}` : option.label}
        </option>
      ))}
    </select>
  ),
}));

// Stub FilterSelect to surface the otherwise-unreachable onUnselectAll handler.
vi.mock('../../src/components/FilterSelect.jsx', () => ({
  default: (props: {
    items: string[];
    onUnselectAll: () => void;
    onSelectAll: () => void;
    onToggle: (item: string) => void;
  }) => {
    filterSelectProps = props;
    return (
      <div data-testid="filter-select">
        <span data-testid="filter-item-count">{props.items.length}</span>
        <button data-testid="filter-unselect-all" onClick={() => props.onUnselectAll()}>
          Unselect all
        </button>
        <button data-testid="filter-select-all" onClick={() => props.onSelectAll()}>
          Select all
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/AddAgentModal.jsx', () => ({
  default: () => null,
}));

vi.mock('../../src/components/AuthBadge.jsx', () => ({
  authLabel: (authType: string) => `auth:${authType}`,
  authBadgeFor: (authType: string | null) => <span data-auth-badge={authType ?? ''} />,
}));

vi.mock('../../src/components/GlobalOverviewSkeleton.jsx', () => ({
  default: () => <div data-testid="global-overview-skeleton" />,
}));

vi.mock('../../src/services/sse.js', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [agentPing, setAgentPing] = createSignal(0);
  const [analyticsPing, setAnalyticsPing] = createSignal(0);
  const [routingPing, setRoutingPing] = createSignal(0);
  sseMocks.bumpAgent = () => setAgentPing((n) => n + 1);
  sseMocks.bumpAnalytics = () => setAnalyticsPing((n) => n + 1);
  sseMocks.bumpRouting = () => setRoutingPing((n) => n + 1);
  sseMocks.reset = () => {
    setAgentPing(0);
    setAnalyticsPing(0);
    setRoutingPing(0);
  };
  return { agentPing, analyticsPing, routingPing };
});

vi.mock('../../src/services/scroll-fade.js', () => ({
  toggleScrollFade: vi.fn(),
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
  preloadModelDisplayNames: () => {},
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatNumber: (v: number) => String(v),
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatTimeAgo: (t: string) => t,
  customProviderColor: () => '#6366f1',
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ''),
}));

vi.mock('manifest-shared', () => ({
  platformIcon: () => 'robot',
}));

let mockIsSelfHosted = false;
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => Promise.resolve(mockIsSelfHosted),
}));

import GlobalOverview from '../../src/pages/GlobalOverview';

const overviewResponse = {
  summary: {
    tokens_today: { value: 1200, trend_pct: 12 },
    cost_today: { value: 3.21, trend_pct: -4 },
    messages: { value: 18, trend_pct: 5 },
  },
  token_usage: [{ hour: '2026-06-04 10:00:00', input_tokens: 700, output_tokens: 500 }],
  message_usage: [{ hour: '2026-06-04 10:00:00', count: 18 }],
  cost_by_model: [],
  recent_activity: [],
  has_data: true,
  has_providers: true,
  request_reliability: {
    total: 18,
    successful: 17,
    success_rate: 94.4,
    attempt_success_rate: 88.9,
    manifest_lift_pct: 5.5,
    recovered: 1,
    previous_total: 16,
  },
};

const providersResponse = {
  providers: [
    {
      provider: 'openai',
      auth_type: 'api_key',
      connection_count: 1,
      connections: [{ id: 'conn-openai', label: 'Default', is_active: true }],
      total_models: 10,
      consumption_tokens: 1200,
      consumption_messages: 18,
      consumption_cost: 3.21,
      sparkline_7d: [1, 2, 3],
      last_used_at: '2026-06-04T10:00:00Z',
    },
  ],
};

const agentsResponse = {
  agents: [
    {
      agent_name: 'demo-agent',
      display_name: 'Demo Agent',
      agent_category: 'personal',
      agent_platform: 'codex',
      message_count: 18,
      total_tokens: 1200,
      sparkline: [1, 2, 3],
    },
  ],
};

// Two series → allAgents().length > 1 → the FilterSelect renders.
const providerTimeseries = {
  agents: ['openai', 'anthropic'],
  timeseries: [{ hour: '2026-06-04 10:00:00', openai: 1200, anthropic: 900 }],
};
const providerUsageTimeseries = {
  tokenUsage: providerTimeseries,
  messageUsage: providerTimeseries,
  costUsage: providerTimeseries,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('manifest_global_group', 'provider');
  mockIsSelfHosted = false;
  filterSelectProps = null;
  providerChartProps = null;
  mockSearchParams = {};
  sseMocks.reset?.();

  apiMocks.getAgents.mockResolvedValue(agentsResponse);
  apiMocks.getGlobalProviders.mockResolvedValue(providersResponse);
  apiMocks.getGlobalProviderUsage.mockResolvedValue({ providers: [] });
  apiMocks.getOverview.mockResolvedValue(overviewResponse);
  apiMocks.getOverviewDetails.mockResolvedValue({});
  apiMocks.getOverviewAgentUsage.mockResolvedValue(providerUsageTimeseries);
  apiMocks.getOverviewProviderUsage.mockResolvedValue(providerUsageTimeseries);
  apiMocks.getBillingStatus.mockResolvedValue({
    enabled: false,
    plan: 'free',
    priceMonthly: { amount: null, currency: null, interval: null },
    requests: { used: null, limit: null, periodEnd: null },
    cancelAtPeriodEnd: false,
    subscriptionPeriodEnd: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('GlobalOverview filter onUnselectAll', () => {
  it('refetches global usage data when an analytics SSE ping lands', async () => {
    render(() => <GlobalOverview />);

    await waitFor(() => expect(apiMocks.getOverview).toHaveBeenCalledTimes(1));
    expect(apiMocks.getAgents).toHaveBeenCalledTimes(1);
    expect(apiMocks.getGlobalProviders).toHaveBeenCalledTimes(1);
    expect(apiMocks.getGlobalProviderUsage).toHaveBeenCalledTimes(1);
    expect(apiMocks.getOverviewProviderUsage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiMocks.getOverviewDetails).toHaveBeenCalledTimes(1));

    sseMocks.bumpAnalytics?.();

    await waitFor(() => expect(apiMocks.getOverview).toHaveBeenCalledTimes(2));
    expect(apiMocks.getAgents).toHaveBeenCalledTimes(2);
    expect(apiMocks.getGlobalProviders).toHaveBeenCalledTimes(1);
    expect(apiMocks.getGlobalProviderUsage).toHaveBeenCalledTimes(2);
    expect(apiMocks.getOverviewProviderUsage).toHaveBeenCalledTimes(2);
    expect(apiMocks.getOverviewDetails).toHaveBeenCalledTimes(1);
  });

  it('shows the skeleton on a range change but not on a background ping refetch', async () => {
    const { container, queryByTestId } = render(() => <GlobalOverview />);

    // Wait for the initial load to paint the dashboard (skeleton gone).
    await waitFor(() => expect(container.querySelector('.chart-card')).not.toBeNull());
    expect(queryByTestId('global-overview-skeleton')).toBeNull();

    // A background SSE ping refetch keeps the dashboard in place (no skeleton).
    apiMocks.getOverview.mockReturnValue(new Promise(() => {}));
    sseMocks.bumpAnalytics?.();
    await Promise.resolve();
    expect(queryByTestId('global-overview-skeleton')).toBeNull();
    expect(container.querySelector('.chart-card')).not.toBeNull();

    // A range change swaps in the skeleton while the new range loads.
    const rangeSelect = [...container.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === '365d'),
    ) as HTMLSelectElement;
    rangeSelect.value = '24h';
    fireEvent.change(rangeSelect);
    await waitFor(() => expect(queryByTestId('global-overview-skeleton')).not.toBeNull());
  });

  it('links the harness total-requests count to the agent-scoped Requests log', async () => {
    const { container } = render(() => <GlobalOverview />);
    await waitFor(() => {
      const link = [...container.querySelectorAll('a')].find(
        (a) => a.getAttribute('href') === '/messages?agent=demo-agent&range=7d',
      );
      expect(link).toBeDefined();
    });
  });

  it('links the recovered-requests count to the scoped Requests log', async () => {
    const { container } = render(() => <GlobalOverview />);
    const href = '/messages?agent=demo-agent&range=7d&status=ok&trigger=autofix,fallback';
    const link = await waitFor(() => {
      const found = [...container.querySelectorAll('a')].find(
        (candidate) => candidate.getAttribute('href') === href,
      );
      expect(found).toBeDefined();
      return found!;
    });

    expect(link.textContent).toContain('2');
    fireEvent.click(link);
    expect(apiMocks.navigate).toHaveBeenCalledWith(href);
  });

  it('links the connection failed-attempts count to the scoped Requests log', async () => {
    const { container } = render(() => <GlobalOverview />);
    await waitFor(() => {
      const link = [...container.querySelectorAll('a')].find((a) =>
        a.getAttribute('href')?.includes('attempts=has_failed'),
      );
      expect(link).toBeDefined();
      // failed = attempts - succeeded = 3, scoped to the connection + window.
      expect(link!.textContent).toContain('3');
      expect(link!.getAttribute('href')).toBe(
        '/messages?connections=conn-openai&range=7d&attempts=has_failed',
      );
    });
  });

  it('opens the Pro success modal when upgraded=1 is present', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    mockSearchParams = { upgraded: '1' };

    try {
      render(() => <GlobalOverview />);

      await waitFor(() => expect(localStorage.getItem('manifest_plan_chosen_u1')).toBe('1'));
      await waitFor(() =>
        expect(document.body.textContent).toContain("You're now on the Pro plan"),
      );

      await waitFor(() => expect(document.querySelector('.modal-backdrop')).not.toBeNull());
      fireEvent.click(document.querySelector('.modal-backdrop')!);

      expect(replaceState).toHaveBeenCalledWith(null, '', '/overview');
    } finally {
      replaceState.mockRestore();
    }
  });
});
