import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Show } from 'solid-js';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { connectionId: 'conn-openai' } as Record<string, string>,
}));

const apiMocks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  getCustomProviders: vi.fn(),
  getGlobalProviders: vi.fn(),
  getGlobalProviderUsage: vi.fn(),
  disconnectConnection: vi.fn(),
  renameConnection: vi.fn(),
  refreshConnectionModels: vi.fn(),
  fetchMutate: vi.fn(),
  getOverview: vi.fn(),
  getOverviewDetails: vi.fn(),
  getOverviewAgentUsage: vi.fn(),
  getOverviewProviderUsage: vi.fn(),
  getBillingStatus: vi.fn(),
  getConnectionDetail: vi.fn(),
  getProviderAnalytics: vi.fn(),
  getPerAgentTimeseries: vi.fn(),
  getPerAgentMessageTimeseries: vi.fn(),
  getConnectionAttemptStatusTimeseries: vi.fn(),
  getConnectionAttemptHttpStatusTimeseries: vi.fn(),
  getConnectionAttemptBreakdown: vi.fn(),
  getConnectionAttemptsByAgentTimeseries: vi.fn(),
  getPerAgentCostTimeseries: vi.fn(),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <title>{props.children}</title>,
}));

vi.mock('@solidjs/router', () => ({
  A: (props: { href: string; children: unknown; class?: string }) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useNavigate: () => routerState.navigate,
  useParams: () => routerState.params,
  useSearchParams: () => [{}],
}));

vi.mock('../../src/services/api/core.js', () => ({
  fetchJson: () => Promise.resolve({ by_class: {}, by_origin: {} }),
  fetchMutate: (...args: unknown[]) => apiMocks.fetchMutate(...args),
  routingPath: (agent: string, path: string) => `/api/v1/routing/${agent}/${path}`,
}));

vi.mock('../../src/services/api.js', async () => {
  const providers = await vi.importActual<typeof import('../../src/services/api/providers')>(
    '../../src/services/api/providers',
  );
  return {
    getAgents: (...args: unknown[]) => apiMocks.getAgents(...args),
    getCustomProviders: (...args: unknown[]) => apiMocks.getCustomProviders(...args),
    getGlobalProviders: (...args: unknown[]) => apiMocks.getGlobalProviders(...args),
    getGlobalProviderUsage: (...args: unknown[]) => apiMocks.getGlobalProviderUsage(...args),
    // Real merge so the page's config+usage join stays under test.
    mergeUsage: providers.mergeUsage,
  };
});

vi.mock('../../src/services/api/routing.js', () => ({
  disconnectConnection: (...args: unknown[]) => apiMocks.disconnectConnection(...args),
  renameConnection: (...args: unknown[]) => apiMocks.renameConnection(...args),
  refreshConnectionModels: (...args: unknown[]) => apiMocks.refreshConnectionModels(...args),
}));

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
  getOverview: (...args: unknown[]) => apiMocks.getOverview(...args),
  getOverviewDetails: (...args: unknown[]) => apiMocks.getOverviewDetails(...args),
  getOverviewAgentUsage: (...args: unknown[]) => apiMocks.getOverviewAgentUsage(...args),
  getOverviewProviderUsage: (...args: unknown[]) => apiMocks.getOverviewProviderUsage(...args),
  getConnectionDetail: (...args: unknown[]) => apiMocks.getConnectionDetail(...args),
  getProviderAnalytics: (...args: unknown[]) => apiMocks.getProviderAnalytics(...args),
  getPerAgentTimeseries: (...args: unknown[]) => apiMocks.getPerAgentTimeseries(...args),
  getPerAgentMessageTimeseries: (...args: unknown[]) =>
    apiMocks.getPerAgentMessageTimeseries(...args),
  getConnectionAttemptStatusTimeseries: (...args: unknown[]) =>
    apiMocks.getConnectionAttemptStatusTimeseries(...args),
  getConnectionAttemptHttpStatusTimeseries: (...args: unknown[]) =>
    apiMocks.getConnectionAttemptHttpStatusTimeseries(...args),
  getConnectionAttemptBreakdown: (...args: unknown[]) =>
    apiMocks.getConnectionAttemptBreakdown(...args),
  getConnectionAttemptsByAgentTimeseries: (...args: unknown[]) =>
    apiMocks.getConnectionAttemptsByAgentTimeseries(...args),
  getPerAgentCostTimeseries: (...args: unknown[]) => apiMocks.getPerAgentCostTimeseries(...args),
  getWorkspaceAutofixStatus: () =>
    Promise.resolve({ any_enabled: false, enabled_agents: [], consented: true }),
  getAutofixStats: () => Promise.resolve(null),
  getAutofixTimeseries: () =>
    Promise.resolve({ range: '7d', by: 'disposition', keys: [], buckets: [] }),
  getPerProviderReliability: () => Promise.resolve([]),
  getPerModelReliability: () => Promise.resolve([]),
  getPerAgentReliability: () => Promise.resolve([]),
  getErrorBreakdown: () => Promise.resolve({ by_class: {}, by_origin: {}, auto_fixed: 0 }),
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => apiMocks.getBillingStatus(...args),
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic', supportsSubscription: true },
    { id: 'ollama', name: 'Ollama', localOnly: true },
  ],
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  // Return null for custom: ids and for the special 'mystery' provider so both
  // the custom and non-custom icon-fallback branches are exercised.
  providerIcon: (provider: string) =>
    provider.startsWith('custom:') || provider === 'mystery' ? null : (
      <span data-provider-icon={provider} />
    ),
  // Return null so the colored-initial fallback path is exercised.
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/MultiAgentTokenChart.jsx', () => ({
  AGENT_COLORS: ['#111111', '#222222', '#333333'],
  default: () => <div data-testid="multi-agent-token-chart" />,
}));

vi.mock('../../src/components/ProviderChartCard.jsx', () => ({
  default: (props: {
    activeView: string;
    onViewChange: (view: 'messages' | 'tokens' | 'cost') => void;
    tokensValue: number;
    tokensTrendPct?: number;
    requestsValue: number;
    requestsTrendPct?: number;
    costValue?: number;
    costTrendPct?: number;
    costInfoTooltip?: string;
    range?: string;
    agentTimeseries?: { agents: string[]; timeseries: unknown[] };
    agentRequestTimeseries?: { agents: string[]; timeseries: unknown[] };
    agentCostTimeseries?: { agents: string[]; timeseries: unknown[] };
    requestStatusTimeseries?: { keys: string[] };
    selfHealedTimeseries?: { keys: string[] };
    selfHealedValue?: number;
    seriesFilters?: unknown;
    colorMap?: Record<string, string>;
  }) => (
    <div data-active-view={props.activeView} data-testid="provider-chart-card">
      <button onClick={() => props.onViewChange('messages')}>Requests chart</button>
      <button onClick={() => props.onViewChange('tokens')}>Tokens chart</button>
      <button onClick={() => props.onViewChange('cost')}>Cost chart</button>
      <span>{props.tokensValue}</span>
      <span>{props.tokensTrendPct ?? 0}</span>
      <span>{props.requestsValue}</span>
      <span>{props.requestsTrendPct ?? 0}</span>
      <span>{props.costValue ?? 0}</span>
      <span>{props.costTrendPct ?? 0}</span>
      <span>{props.costInfoTooltip ?? ''}</span>
      <span>{props.range}</span>
      <span data-testid="ts-agents">{props.agentTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="msg-agents">{props.agentRequestTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="cost-agents">{props.agentCostTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="color-keys">{Object.keys(props.colorMap ?? {}).join(',')}</span>
      <span data-testid="status-keys">{props.requestStatusTimeseries?.keys.join(',') ?? ''}</span>
      <span data-testid="healed-keys">{props.selfHealedTimeseries?.keys.join(',') ?? ''}</span>
      <span data-testid="healed-value">{props.selfHealedValue ?? ''}</span>
      <div data-testid="series-filters">{props.seriesFilters as any}</div>
    </div>
  ),
}));

vi.mock('../../src/components/UnifiedChartCard.jsx', () => ({
  default: (props: {
    activeTab: string;
    onTabChange: (tab: 'requests' | 'failed' | 'tokens' | 'cost') => void;
    tokensValue: number;
    tokensTrendPct?: number;
    requestsValue: number;
    requestsInfoTooltip?: string;
    requestsTrendPct?: number;
    failedValue?: number;
    failedTrendPct?: number;
    failedTimeseries?: unknown;
    failedFilter?: string;
    onFailedFilterChange?: (f: string) => void;
    costValue?: number;
    costTrendPct?: number;
    costInfoTooltip?: string;
    range?: string;
    agentTimeseries?: { agents: string[]; timeseries: unknown[] };
    agentRequestTimeseries?: { agents: string[]; timeseries: unknown[] };
    agentCostTimeseries?: { agents: string[]; timeseries: unknown[] };
    requestStatusTimeseries?: { keys: string[] };
    selfHealedTimeseries?: { keys: string[] };
    selfHealedValue?: number;
    seriesFilters?: unknown;
    colorMap?: Record<string, string>;
  }) => (
    <div data-active-view={props.activeTab} data-testid="provider-chart-card">
      <button onClick={() => props.onTabChange('requests')}>Requests chart</button>
      <button onClick={() => props.onTabChange('failed')}>Failed chart</button>
      <button onClick={() => props.onTabChange('tokens')}>Tokens chart</button>
      <button onClick={() => props.onTabChange('cost')}>Cost chart</button>
      <span>{props.tokensValue}</span>
      <span>{props.tokensTrendPct ?? 0}</span>
      <span>{props.requestsValue}</span>
      <span>{props.requestsTrendPct ?? 0}</span>
      <span>{props.failedValue ?? 0}</span>
      <span>{props.failedTrendPct ?? 0}</span>
      <span>{props.costValue ?? 0}</span>
      <span>{props.costTrendPct ?? 0}</span>
      <span>{props.costInfoTooltip ?? ''}</span>
      <span>{props.range}</span>
      <span data-testid="requests-info-tooltip">{props.requestsInfoTooltip ?? ''}</span>
      <span data-testid="ts-agents">{props.agentTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="msg-agents">{props.agentRequestTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="cost-agents">{props.agentCostTimeseries?.agents.join(',') ?? ''}</span>
      <span data-testid="color-keys">{Object.keys(props.colorMap ?? {}).join(',')}</span>
      <span data-testid="status-keys">{props.requestStatusTimeseries?.keys.join(',') ?? ''}</span>
      <span data-testid="healed-keys">{props.selfHealedTimeseries?.keys.join(',') ?? ''}</span>
      <span data-testid="healed-value">{props.selfHealedValue ?? ''}</span>
      <div data-testid="series-filters">{props.seriesFilters as any}</div>
    </div>
  ),
}));

vi.mock('../../src/components/Sparkline.jsx', () => ({
  default: (props: { data: number[] }) => <span data-testid="sparkline">{props.data.length}</span>,
}));

vi.mock('../../src/components/Select.jsx', () => ({
  default: (props: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{
      label: string;
      value: string;
      disabled?: boolean;
      description?: string;
      badge?: unknown;
    }>;
  }) => (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
      {props.options.map((option) => (
        <option value={option.value} disabled={option.disabled}>
          {option.description
            ? `${option.label} · ${option.description}`
            : option.badge
              ? `${option.label} · PRO`
              : option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('../../src/components/AddAgentModal.jsx', () => ({
  default: (props: { open: boolean; onClose: () => void }) => (
    <Show when={props.open}>
      <div data-testid="add-agent-modal">
        <button onClick={props.onClose}>Dismiss add agent</button>
      </div>
    </Show>
  ),
}));

const mockCustomProviderForm = vi.fn();
vi.mock('../../src/components/CustomProviderForm.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    mockCustomProviderForm(props);
    return (
      <div data-testid="custom-provider-form">
        Edit custom provider
        <button onClick={() => (props.onCreated as () => void)()}>form-created</button>
        <button onClick={() => (props.onBack as () => void)()}>form-back</button>
        <button
          onClick={() => {
            if (props.onDeleted) (props.onDeleted as () => void)();
          }}
        >
          form-deleted
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/ProviderSelectModal.jsx', () => ({
  default: (props: {
    agentName?: string;
    providers?: unknown[];
    customProviders?: unknown[];
    providerDeepLink?: { providerId: string } | null;
    onClose: () => void;
    onUpdate: () => void;
  }) => (
    <div data-provider={props.providerDeepLink?.providerId ?? ''}>
      Provider modal
      <span>{props.agentName ?? ''}</span>
      <span>{props.providers?.length ?? 0}</span>
      <span data-testid="modal-custom">{props.customProviders?.length ?? 0}</span>
      <button onClick={props.onUpdate}>Modal update</button>
      <button onClick={props.onClose}>Modal close</button>
    </div>
  ),
}));

vi.mock('../../src/components/AuthBadge.jsx', () => ({
  authLabel: (authType: string) => `auth:${authType}`,
  authBadgeFor: (authType: string | null) => <span data-auth-badge={authType ?? ''} />,
}));

vi.mock('../../src/services/sse.js', () => ({
  agentPing: () => 0,
  messagePing: () => 0,
  analyticsPing: () => 0,
  routingPing: () => 0,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    success: (...args: unknown[]) => toastMock.success(...args),
    error: (...args: unknown[]) => toastMock.error(...args),
    warning: (...args: unknown[]) => toastMock.warning(...args),
  },
}));

vi.mock('../../src/services/connection-breadcrumb-store.js', () => ({
  setConnectionBreadcrumb: vi.fn(),
}));

const { MOCK_FREE_PLAN_REQUESTS_PER_MONTH } = vi.hoisted(() => ({
  MOCK_FREE_PLAN_REQUESTS_PER_MONTH: 10_000,
}));

vi.mock('manifest-shared', () => ({
  FREE_PLAN_REQUESTS_PER_MONTH: MOCK_FREE_PLAN_REQUESTS_PER_MONTH,
  PLAN_LIMITS: {
    free: { requestsPerMonth: MOCK_FREE_PLAN_REQUESTS_PER_MONTH },
    pro: { requestsPerMonth: null },
  },
  platformIcon: () => 'robot',
  PLATFORM_LABELS: { codex: 'Codex' },
  // routing-utils (imported by GlobalOverview for stripCustomPrefix) reads
  // these at module scope.
  SHARED_PROVIDERS: [],
  underlyingGatewayModel: (m: string) =>
    m.startsWith('opencode-go/') ? m.slice('opencode-go/'.length) : null,
  inferProviderFromModel: (m: string) => (m.startsWith('custom:') ? 'custom' : null),
  isSuccessStatus: (s: string | null | undefined) => s == null || s === 'ok' || s === 'success',
}));

// Local providers only exist on self-hosted installs.
let mockIsSelfHosted = true;
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => Promise.resolve(mockIsSelfHosted),
}));

import GlobalOverview from '../../src/pages/GlobalOverview';
import ConnectionDetail from '../../src/pages/providers/ConnectionDetail';
import { resetPlanStore } from '../../src/services/plan-store';

const overviewResponse = {
  summary: {
    tokens_today: { value: 1200, trend_pct: 12 },
    cost_today: { value: 3.21, trend_pct: -4 },
    messages: { value: 18, trend_pct: 5 },
  },
  token_usage: [{ hour: '2026-06-04 10:00:00', input_tokens: 700, output_tokens: 500 }],
  message_usage: [{ hour: '2026-06-04 10:00:00', count: 18 }],
  cost_by_model: [
    {
      model: 'gpt-5',
      display_name: 'GPT-5',
      tokens: 1200,
      share_pct: 75,
      estimated_cost: 1.23,
      auth_type: 'api_key',
      provider: 'openai',
    },
    {
      // Custom provider row with a backend-resolved name → letter avatar +
      // stripped model text (the literal `custom:` prefix must never render).
      model: 'custom:cp-1/llama-local',
      display_name: 'custom:cp-1/llama-local',
      tokens: 300,
      share_pct: 19,
      estimated_cost: 0.44,
      auth_type: 'api_key',
      provider: 'custom:cp-1',
      custom_provider_name: 'Custom Provider',
    },
    {
      // Deleted custom provider (NULL name) → letter falls back to the model.
      model: 'custom:cp-gone/zeta-model',
      display_name: 'custom:cp-gone/zeta-model',
      tokens: 100,
      share_pct: 6,
      estimated_cost: 0.1,
      auth_type: 'api_key',
      provider: 'custom:cp-gone',
      custom_provider_name: null,
    },
    {
      // Legacy row with no stored provider → no icon, plain display name.
      model: 'orphan-model',
      display_name: 'Orphan Model',
      tokens: 10,
      share_pct: 1,
      estimated_cost: 0.01,
      auth_type: null,
      provider: null,
    },
  ],
  recent_activity: [
    {
      id: 'msg-recent-1',
      timestamp: '2026-06-04T10:00:00Z',
      agent_name: 'demo-agent',
      model: 'gpt-5',
      input_tokens: 800,
      output_tokens: 400,
      total_tokens: 1200,
      provider: 'openai',
      auth_type: 'api_key',
      status: 'ok',
      cost: 1.23,
    },
    {
      id: 'msg-recent-2',
      timestamp: '2026-06-04T09:00:00Z',
      agent_name: 'demo-agent',
      model: 'gpt-5',
      input_tokens: 30,
      output_tokens: 20,
      total_tokens: 50,
      provider: 'openai',
      auth_type: 'api_key',
      status: 'retry',
      cost: 0.01,
    },
    {
      id: 'msg-recent-3',
      timestamp: '2026-06-04T08:00:00Z',
      agent_name: 'worker-agent',
      model: '',
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      status: 'error',
      cost: 0,
    },
  ],
  has_data: true,
  has_providers: true,
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
    {
      provider: 'anthropic',
      auth_type: 'subscription',
      connection_count: 1,
      connections: [{ id: 'conn-anthropic', label: 'Claude', is_active: true }],
      total_models: 8,
      consumption_tokens: 900,
      consumption_messages: 12,
      consumption_cost: 0,
      sparkline_7d: [],
      last_used_at: '2026-06-04T10:00:00Z',
    },
    {
      provider: 'ollama',
      auth_type: 'local',
      connection_count: 1,
      connections: [{ id: 'conn-ollama', label: 'Local', is_active: false }],
      total_models: 3,
      consumption_tokens: 600,
      consumption_messages: 8,
      consumption_cost: 0,
      sparkline_7d: [1, 1, 2],
      last_used_at: '2026-06-04T10:00:00Z',
    },
    {
      provider: 'custom:cp-1',
      auth_type: 'api_key',
      // Backend-resolved custom provider name (LEFT JOIN on custom_providers).
      display_name: 'Custom Provider',
      connection_count: 1,
      connections: [{ id: 'conn-custom', label: 'My custom key', is_active: true }],
      total_models: 2,
      consumption_tokens: 300,
      consumption_messages: 4,
      consumption_cost: 0.44,
      sparkline_7d: [0, 1, 1],
      last_used_at: '2026-06-04T10:00:00Z',
    },
    {
      provider: 'custom:cp-2',
      auth_type: 'subscription',
      display_name: 'Sub Custom',
      connection_count: 1,
      connections: [{ id: 'conn-custom-sub', label: 'Default', is_active: true }],
      total_models: 1,
      consumption_tokens: 100,
      consumption_messages: 2,
      consumption_cost: 0,
      sparkline_7d: [],
      last_used_at: '2026-06-04T10:00:00Z',
    },
    {
      provider: 'custom:cp-3',
      auth_type: 'local',
      connection_count: 1,
      connections: [{ id: 'conn-custom-local', label: 'Default', is_active: true }],
      total_models: 1,
      consumption_tokens: 50,
      consumption_messages: 1,
      consumption_cost: 0,
      sparkline_7d: [],
      last_used_at: '2026-06-04T10:00:00Z',
    },
    {
      // Non-custom provider with no icon → exercises the non-custom
      // icon-fallback branch in the provider connections table.
      provider: 'mystery',
      auth_type: 'api_key',
      connection_count: 1,
      connections: [{ id: 'conn-mystery', label: 'Default', is_active: true }],
      total_models: 0,
      consumption_tokens: 10,
      consumption_messages: 1,
      consumption_cost: 0,
      sparkline_7d: [],
      last_used_at: '2026-06-04T10:00:00Z',
    },
  ],
  model_counts: { openai: 10, anthropic: 8, ollama: 3 },
};

// Derive the usage-endpoint payload from the config fixture so GlobalOverview's
// merged provider table shows the same numbers as before the config/usage split.
const usageFrom = (resp: { providers: Array<Record<string, unknown>> }) => ({
  providers: resp.providers.map((p) => ({
    provider: p.provider,
    auth_type: p.auth_type,
    consumption_tokens: p.consumption_tokens ?? 0,
    consumption_messages: p.consumption_messages ?? 0,
    consumption_cost: p.consumption_cost ?? 0,
    last_used_at: p.last_used_at ?? null,
    sparkline_7d: p.sparkline_7d ?? [],
  })),
});

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
    {
      agent_name: 'worker-agent',
      display_name: 'Worker Agent',
      agent_category: 'personal',
      agent_platform: null,
      message_count: 8,
      total_tokens: 600,
      sparkline: [],
    },
  ],
};

const agentTimeseries = {
  agents: ['demo-agent', 'worker-agent'],
  timeseries: [{ hour: '2026-06-04 10:00:00', 'demo-agent': 1200, 'worker-agent': 600 }],
};

const providerTimeseries = {
  agents: ['openai', 'anthropic'],
  timeseries: [{ hour: '2026-06-04 10:00:00', openai: 1200, anthropic: 900 }],
};

const agentUsageTimeseries = {
  tokenUsage: agentTimeseries,
  messageUsage: agentTimeseries,
  costUsage: agentTimeseries,
};

const providerUsageTimeseries = {
  tokenUsage: providerTimeseries,
  messageUsage: providerTimeseries,
  costUsage: providerTimeseries,
};

const connectionDetail = {
  connection: {
    id: 'conn-openai',
    provider: 'openai',
    auth_type: 'api_key',
    label: 'Default',
    cached_model_count: 10,
    key_prefix: 'sk',
    connected_at: '2026-06-04T09:00:00Z',
    is_active: true,
    last_used_at: '2026-06-04T10:00:00Z',
  },
  agents: [
    {
      agent_name: 'demo-agent',
      agent_platform: 'codex',
      tokens_30d: 1200,
      cost_30d: 1.23,
      messages_30d: 18,
      pct_of_total: 100,
      last_used: '2026-06-04T10:00:00Z',
    },
  ],
  model_usage: [{ model: 'gpt-5', tokens: 1200, cost: 1.23, messages: 18, pct_of_total: 100 }],
  recent_messages: [
    {
      timestamp: '2026-06-04T10:00:00Z',
      model: 'gpt-5',
      description: 'Hi there',
      input_tokens: 700,
      output_tokens: 500,
    },
  ],
};

const connectionAnalytics = {
  summary: {
    messages: { value: 18, trend_pct: 5 },
    tokens: { value: 1200, trend_pct: 12 },
  },
  token_usage: overviewResponse.token_usage,
  message_usage: overviewResponse.message_usage,
};

function makeMemoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

function ensureStorageLike(kind: 'localStorage' | 'sessionStorage') {
  const current = globalThis[kind] as Partial<Storage> | undefined;
  const ready =
    current &&
    typeof current.getItem === 'function' &&
    typeof current.setItem === 'function' &&
    typeof current.removeItem === 'function' &&
    typeof current.clear === 'function';
  if (ready) return current;
  const replacement = makeMemoryStorage();
  Object.defineProperty(globalThis, kind, { configurable: true, value: replacement });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, kind, { configurable: true, value: replacement });
  }
  return replacement;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPlanStore();
  ensureStorageLike('localStorage').clear();
  ensureStorageLike('sessionStorage').clear();
  localStorage.setItem('manifest_global_group', 'provider');
  routerState.navigate.mockReset();
  routerState.params = { connectionId: 'conn-openai' };
  mockIsSelfHosted = true;

  apiMocks.getAgents.mockResolvedValue(agentsResponse);
  apiMocks.getCustomProviders.mockResolvedValue([
    { id: 'cp-1', name: 'Custom Provider' },
    { id: 'cp-2', name: 'Custom Sub' },
    { id: 'cp-3', name: 'Custom Local' },
  ]);
  apiMocks.getGlobalProviders.mockResolvedValue(providersResponse);
  apiMocks.getGlobalProviderUsage.mockResolvedValue(usageFrom(providersResponse));
  apiMocks.disconnectConnection.mockResolvedValue({ ok: true, notifications: [] });
  apiMocks.renameConnection.mockResolvedValue(undefined);
  apiMocks.refreshConnectionModels.mockResolvedValue({ ok: true });
  apiMocks.fetchMutate.mockResolvedValue({});
  apiMocks.getOverview.mockResolvedValue(overviewResponse);
  apiMocks.getOverviewDetails.mockResolvedValue({});
  apiMocks.getOverviewAgentUsage.mockResolvedValue(agentUsageTimeseries);
  apiMocks.getOverviewProviderUsage.mockResolvedValue(providerUsageTimeseries);
  apiMocks.getBillingStatus.mockResolvedValue({
    enabled: false,
    plan: 'free',
    priceMonthly: { amount: null, currency: null, interval: null },
    requests: { used: null, limit: null, periodEnd: null },
    cancelAtPeriodEnd: false,
    subscriptionPeriodEnd: null,
  });
  apiMocks.getConnectionDetail.mockResolvedValue(connectionDetail);
  apiMocks.getProviderAnalytics.mockResolvedValue(connectionAnalytics);
  apiMocks.getPerAgentTimeseries.mockResolvedValue(agentTimeseries);
  apiMocks.getPerAgentMessageTimeseries.mockResolvedValue(agentTimeseries);
  apiMocks.getPerAgentCostTimeseries.mockResolvedValue(agentTimeseries);
  apiMocks.getConnectionAttemptStatusTimeseries.mockResolvedValue({
    range: '7d',
    by: 'metric',
    keys: ['success', 'error'],
    buckets: [{ bucket: '2026-06-04', counts: [9, 3] }],
  });
  apiMocks.getConnectionAttemptsByAgentTimeseries.mockResolvedValue({
    agents: ['demo-agent'],
    timeseries: [{ date: '2026-06-04', 'demo-agent': 12 }],
  });
  apiMocks.getConnectionAttemptHttpStatusTimeseries.mockResolvedValue({
    range: '7d',
    by: 'metric',
    keys: ['200', '429'],
    buckets: [{ bucket: '2026-06-04', counts: [9, 3] }],
  });
  apiMocks.getConnectionAttemptBreakdown.mockResolvedValue({
    attempts: 12,
    succeeded: 9,
    failed: 3,
    fallback_retries: 10,
    fallback_retries_succeeded: 8,
    autofix_attempts: 5,
    autofix_attempts_succeeded: 4,
  });
});

afterEach(() => {
  cleanup();
});

describe('GlobalOverview (analytics)', () => {
  it('renders the dashboard with harness and provider data', async () => {
    const { container } = render(() => <GlobalOverview />);

    await waitFor(() => expect(screen.getByTestId('provider-chart-card')).toBeDefined());
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('All your harnesses and providers')).toBeDefined();
    expect(screen.getAllByText('Demo Agent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);
    // The shared MessageTable renders a binary status: the ok row is "Success"
    // and the non-ok rows (retry + error) both render "Failed".
    expect(screen.getByText('Success')).toBeDefined();
    expect(screen.getAllByText('Failed').length).toBe(2);
    // custom provider name resolves asynchronously
    await waitFor(() => expect(screen.getAllByText('Custom Provider').length).toBeGreaterThan(0));
    // model usage + provider connection rows render
    expect(screen.getByText('GPT-5')).toBeDefined();
    // custom cost-by-model rows show the stripped model text (no `custom:`),
    // with a letter avatar from the provider name — or from the model when
    // the provider was deleted (NULL custom_provider_name).
    expect(screen.getByText('llama-local')).toBeDefined();
    expect(screen.getByText('zeta-model')).toBeDefined();
    expect(container.textContent).not.toContain('custom:cp-1/');
    expect(container.textContent).not.toContain('custom:cp-gone/');

    fireEvent.click(screen.getByText('Requests chart'));
    expect(screen.getByTestId('provider-chart-card').getAttribute('data-active-view')).toBe(
      'requests',
    );

    for (const scroller of container.querySelectorAll('.scroll-panel__body')) {
      Object.defineProperties(scroller, {
        scrollHeight: { value: 100, configurable: true },
        scrollTop: { value: 92, configurable: true },
        clientHeight: { value: 10, configurable: true },
      });
      fireEvent.scroll(scroller);
    }
  });

  it('navigates to harness and connection detail on row click', async () => {
    render(() => <GlobalOverview />);
    await waitFor(() => expect(screen.getByTestId('provider-chart-card')).toBeDefined());

    // provider connection row → connection detail
    const providerCell = screen
      .getAllByText('OpenAI')
      .map((el) => el.closest('tr'))
      .find((tr) => tr?.querySelector('td'));
    fireEvent.click(providerCell!);
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/connections/conn-openai');

    // harness row → harness detail
    const harnessRow = screen
      .getAllByText('Worker Agent')
      .map((el) => el.closest('tr'))
      .find((tr) => tr);
    fireEvent.click(harnessRow!);
    expect(routerState.navigate).toHaveBeenCalledWith('/harnesses/worker-agent');
  });

  it('limits Free users to 7-day dashboard ranges and labels longer ranges as Pro-only', async () => {
    localStorage.setItem('manifest_global_range', '365d');
    resetPlanStore({ enabled: true, plan: 'free' });

    render(() => <GlobalOverview />);

    await waitFor(() => expect(screen.getByTestId('provider-chart-card')).toBeDefined());
    await waitFor(() => expect(localStorage.getItem('manifest_global_range')).toBe('7d'));
    expect(apiMocks.getOverview).toHaveBeenCalledWith('7d', undefined, true);

    const rangeSelect = screen.getByRole('combobox') as HTMLSelectElement;
    const lockedOptions = Array.from(rangeSelect.options).filter((option) =>
      ['30d', '90d', '365d'].includes(option.value),
    );
    expect(lockedOptions.map((option) => option.disabled)).toEqual([true, true, true]);
    expect(screen.getByText('Last 30 days · PRO')).toBeDefined();

    fireEvent.change(rangeSelect, { target: { value: '90d' } });
    expect(localStorage.getItem('manifest_global_range')).toBe('7d');
  });

  it('shows custom provider names instead of custom:<uuid> in provider series', async () => {
    localStorage.setItem('manifest_global_group', 'provider');
    const customSeries = {
      agents: ['openai', 'custom:cp-1'],
      timeseries: [{ hour: '2026-06-04 10:00:00', openai: 1200, 'custom:cp-1': 300 }],
    };
    apiMocks.getOverviewProviderUsage.mockResolvedValue({
      tokenUsage: customSeries,
      messageUsage: customSeries,
      costUsage: customSeries,
    });
    // A custom model with no display_name must render its stripped name, not
    // the raw custom:<uuid>/ slug.
    apiMocks.getOverview.mockResolvedValue({
      ...overviewResponse,
      cost_by_model: [
        {
          model: 'custom:cp-1/qwen-2.5',
          display_name: null,
          tokens: 300,
          share_pct: 25,
          estimated_cost: 0.1,
          auth_type: 'api_key',
          provider: 'custom:cp-1',
        },
      ],
    });

    render(() => <GlobalOverview />);
    await waitFor(() => expect(screen.getByTestId('provider-chart-card')).toBeDefined());

    // Chart series lists the resolved name once customProviderData loads.
    await waitFor(() =>
      expect(screen.getByTestId('ts-agents').textContent).toContain('Custom Provider'),
    );
    expect(screen.getByTestId('ts-agents').textContent).not.toContain('custom:cp-1');

    // Model usage renders the stripped model name.
    expect(screen.getByText('qwen-2.5')).toBeDefined();
  });

  it('shows the empty state when there are no harnesses and no providers', async () => {
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    apiMocks.getGlobalProviders.mockResolvedValue({ providers: [] });

    render(() => <GlobalOverview />);
    await waitFor(() => expect(screen.getByText('No activity yet')).toBeDefined());
    expect(screen.getByText('Set up harness')).toBeDefined();

    // The Add Harness modal opens from the empty-state CTA.
    fireEvent.click(screen.getByText('Set up harness'));
    await waitFor(() => expect(screen.getByTestId('add-agent-modal')).toBeDefined());
    fireEvent.click(screen.getByText('Dismiss add agent'));
    await waitFor(() => expect(screen.queryByTestId('add-agent-modal')).toBeNull());
  });

  it('swallows storage errors when dismissing the onboarding modal', async () => {
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    apiMocks.getGlobalProviders.mockResolvedValue({ providers: [] });

    render(() => <GlobalOverview />);
    await waitFor(() => expect(screen.getByText('No activity yet')).toBeDefined());
    fireEvent.click(screen.getByText('Set up harness'));
    await waitFor(() => expect(screen.getByTestId('add-agent-modal')).toBeDefined());

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    fireEvent.click(screen.getByText('Dismiss add agent'));
    await waitFor(() => expect(screen.queryByTestId('add-agent-modal')).toBeNull());
    setItem.mockRestore();
  });

  it('shows the no-providers state when harnesses exist without providers', async () => {
    apiMocks.getGlobalProviders.mockResolvedValue({ providers: [] });

    render(() => <GlobalOverview />);
    await waitFor(() => expect(screen.getByText('No providers connected')).toBeDefined());
    expect(screen.getByText('Connect provider')).toBeDefined();
  });

  it('falls back to empty arrays when the providers and agents calls reject', async () => {
    apiMocks.getAgents.mockRejectedValue(new Error('agents down'));
    apiMocks.getGlobalProviders.mockRejectedValue(new Error('providers down'));

    render(() => <GlobalOverview />);
    // Both empty → onboarding empty state
    await waitFor(() => expect(screen.getByText('No activity yet')).toBeDefined());
  });

  it('renders config-only when the usage endpoint rejects (usage zeroed)', async () => {
    // Config resolves so the provider table paints; usage rejects → the page's
    // usage resource catch returns [] and the merged rows show 0 tokens.
    apiMocks.getGlobalProviderUsage.mockRejectedValue(new Error('usage down'));

    render(() => <GlobalOverview />);

    await waitFor(() => expect(screen.getAllByText(/0 tokens/).length).toBeGreaterThan(0));
  });
});

describe('ConnectionDetail (analytics)', () => {
  it('renders connection analytics, models, and harness breakdown', async () => {
    const { container } = render(() => <ConnectionDetail />);

    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Harnesses').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-5').length).toBeGreaterThan(0);
    expect(screen.getByTestId('requests-info-tooltip').textContent).toContain('autofixed attempts');
    // Recent messages table renders model and token data (description is no longer displayed).
    expect(screen.getByText('Recent Requests')).toBeDefined();
    // BYOK connection → cost columns present
    expect(screen.getByText('Active')).toBeDefined();

    // Manage opens an inline modal (not the ProviderSelectModal).
    fireEvent.click(screen.getByText('Manage'));
    expect(screen.getByText('Connection name')).toBeDefined();
    // Close the inline manage modal via the Done button.
    fireEvent.click(screen.getByText('Done'));

    for (const scroller of container.querySelectorAll('.scroll-panel__body')) {
      Object.defineProperties(scroller, {
        scrollHeight: { value: 100, configurable: true },
        scrollTop: { value: 92, configurable: true },
        clientHeight: { value: 10, configurable: true },
      });
      fireEvent.scroll(scroller);
    }
  });

  it('persists chart range and view selection', async () => {
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));

    const rangeSelect = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(rangeSelect, { target: { value: '365d' } });
    expect(sessionStorage.getItem('chart-range:conn-openai')).toBe('365d');

    fireEvent.click(screen.getByText('Requests chart'));
    expect(sessionStorage.getItem('chart-view:conn-openai')).toBe('requests');
  });

  it('shows the Attempts tab, By HTTP status default, and no Healed tab', async () => {
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Requests chart'));

    // Grouping buttons, in order: HTTP status (default), attempt status,
    // harness. No provider grouping and no request notion here.
    await waitFor(() => expect(screen.getByText('By HTTP status')).toBeDefined());
    expect(screen.getByText('By HTTP status').className).toContain('--active');
    const buttons = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => t?.startsWith('By '));
    expect(buttons).toEqual(['By HTTP status', 'By attempt status', 'By harness']);

    // Default view feeds the HTTP-status series.
    await waitFor(() => expect(screen.getByTestId('status-keys').textContent).toBe('200,429'));

    // Switching to attempt status feeds the success/error series.
    fireEvent.click(screen.getByText('By attempt status'));
    await waitFor(() =>
      expect(screen.getByTestId('status-keys').textContent).toBe('success,error'),
    );
    // The healed tab is gone: healing belongs to requests, not connections.
    expect(screen.getByTestId('healed-keys').textContent).toBe('');

    // Scoped fetch to this exact connection.
    expect(apiMocks.getConnectionAttemptStatusTimeseries).toHaveBeenCalledWith(
      'api_key',
      'openai',
      expect.any(String),
      'Default',
      'conn-openai',
    );

    // Switching to By harness hands the chart the attempts-per-agent series.
    fireEvent.click(screen.getByText('By harness'));
    await waitFor(() => expect(screen.getByTestId('status-keys').textContent).toBe(''));
    expect(screen.getByTestId('msg-agents').textContent).toBe('demo-agent');
  });

  it('applies the harness selection to the attempts-by-harness series', async () => {
    const emptySeries = { agents: [], timeseries: [] };
    apiMocks.getPerAgentTimeseries.mockResolvedValue(emptySeries);
    apiMocks.getPerAgentMessageTimeseries.mockResolvedValue(emptySeries);
    apiMocks.getPerAgentCostTimeseries.mockResolvedValue(emptySeries);
    apiMocks.getConnectionAttemptsByAgentTimeseries.mockResolvedValue({
      agents: ['alpha', 'beta'],
      timeseries: [{ date: '2026-06-04', alpha: 7, beta: 5 }],
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Requests chart'));
    fireEvent.click(screen.getByText('By harness'));
    await waitFor(() => expect(screen.getByTestId('msg-agents').textContent).toBe('alpha,beta'));

    fireEvent.click(screen.getAllByText('All harnesses (2)').at(-1)!);
    fireEvent.click(screen.getByText('beta'));
    await waitFor(() => expect(screen.getByTestId('msg-agents').textContent).toBe('alpha'));
  });

  it('lays out the header, meta row, controls and stat grid with responsive classes', async () => {
    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    // The mobile layout lives in connection-detail.css: every block that used
    // to be a fixed inline flex row / 5-column grid now carries a class the
    // 768px breakpoint can reflow.
    expect(container.querySelector('.connection-detail__header')).not.toBeNull();
    expect(container.querySelector('.connection-detail__meta')).not.toBeNull();
    expect(container.querySelector('.connection-detail__controls')).not.toBeNull();
    // The status pill (and the Custom tag on custom connections) share one
    // badge class so the phone breakpoint can size them as a matched pair.
    expect(container.querySelector('.connection-detail__badge')?.textContent).toBe('Active');
    const stats = container.querySelector('.overview-stats');
    expect(stats?.classList.contains('overview-stats--5')).toBe(true);
    expect((stats as HTMLElement).style.gridTemplateColumns).toBe('');
  });

  it('shows the attempt cards row: rate, counts and both retry families', async () => {
    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    await waitFor(() => {
      const cards = [...container.querySelectorAll('.overview-stat-card')].map((c) =>
        c.textContent?.trim(),
      );
      // 9 ok / 12 attempts = 75.0%.
      expect(cards.join(' | ')).toContain('75.0%');
      expect(cards.find((c) => c?.includes('Succeeded attempts'))).toContain('9');
      expect(cards.find((c) => c?.includes('Failed attempts'))).toContain('3');
      // A fallback is a retry: 10 sent, 8 of them succeeded.
      const fb = cards.find((c) => c?.includes('Fallback retries'));
      expect(fb).toContain('10');
      expect(fb).toContain('8 succeeded');
    });
    await waitFor(() => {
      const card = [...container.querySelectorAll('.overview-stat-card')].find((c) =>
        c.textContent?.includes('Autofixed attempts'),
      );
      expect(card?.textContent).toContain('5');
      expect(card?.textContent).toContain('4 succeeded');
    });
  });

  it.each([
    ['Failed attempts', '&attempts=has_failed'],
    ['Succeeded attempts', '&attempts=has_succeeded'],
    ['Fallback retries', '&trigger=fallback'],
  ])('links the %s card to the connection-scoped Requests log', async (label, extra) => {
    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    const card = await waitFor(() => {
      const found = [...container.querySelectorAll('.overview-stat-card')].find((c) =>
        c.textContent?.includes(label),
      );
      expect(found).toBeDefined();
      return found!;
    });
    fireEvent.click(card);
    // Scoped to THIS connection and the card's window, never the whole provider.
    expect(routerState.navigate).toHaveBeenCalledWith(
      `/messages?connections=conn-openai&range=7d${extra}`,
    );
  });

  it('links the Autofixed attempts card', async () => {
    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    const card = await waitFor(() => {
      const found = [...container.querySelectorAll('.overview-stat-card')].find((c) =>
        c.textContent?.includes('Autofixed attempts'),
      );
      expect(found).toBeDefined();
      return found!;
    });
    fireEvent.click(card);
    expect(routerState.navigate).toHaveBeenCalledWith(
      '/messages?connections=conn-openai&range=7d&trigger=autofix',
    );
  });

  it('opens the inline manage modal from the connection detail', async () => {
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Manage'));
    // The inline manage modal shows connection name, models, and disconnect.
    expect(screen.getByText('Connection name')).toBeDefined();
    fireEvent.click(screen.getByText('Done'));
  });

  it('renders inactive custom connection with reactivation copy', async () => {
    routerState.params = { connectionId: 'conn-custom' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      connection: {
        id: 'conn-custom',
        provider: 'custom:cp-1',
        auth_type: 'subscription',
        label: 'Custom',
        cached_model_count: 0,
        key_prefix: null,
        connected_at: '2026-06-04T09:00:00Z',
        is_active: false,
        last_used_at: null,
      },
      agents: [],
      model_usage: [],
      recent_messages: [],
    });
    apiMocks.getProviderAnalytics.mockResolvedValue({
      summary: {
        messages: { value: 0, trend_pct: 0 },
        tokens: { value: 0, trend_pct: 0 },
      },
      token_usage: [],
      message_usage: [],
    });
    apiMocks.getPerAgentTimeseries.mockResolvedValue({ agents: [], timeseries: [] });
    apiMocks.getPerAgentMessageTimeseries.mockResolvedValue({ agents: [], timeseries: [] });
    apiMocks.getPerAgentCostTimeseries.mockResolvedValue({ agents: [], timeseries: [] });

    render(() => <ConnectionDetail />);

    await waitFor(() => expect(screen.getByText('Custom Provider')).toBeDefined());
    // "Custom" appears both as the badge and as the connection label.
    expect(screen.getAllByText('Custom').length).toBeGreaterThan(0);
    expect(screen.getByText('Inactive')).toBeDefined();
    expect(screen.getByText('No requests yet.')).toBeDefined();
    expect(screen.getByText('No model usage data yet.')).toBeDefined();
    expect(screen.getByText('No harnesses have used this provider yet.')).toBeDefined();
    // Manage button is present even for inactive connections.
    expect(screen.getByText('Manage')).toBeDefined();
    // back link points to subscriptions for subscription auth type
    expect(screen.getByText(/Subscriptions/)).toBeDefined();
  });

  it('requires typing an inactive connection name before deleting usage history', async () => {
    routerState.params = { connectionId: 'conn-anthropic' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-anthropic',
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Default',
        key_prefix: null,
        cached_model_count: 0,
        is_active: false,
      },
    });

    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Inactive')).toBeDefined());

    fireEvent.click(screen.getByText('Manage'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Delete usage history?' });
    expect(dialog).toBeDefined();
    expect(dialog.textContent).not.toContain('Connection');
    expect(dialog.textContent).not.toContain('Default');
    expect(dialog.textContent).not.toContain('Enter Default exactly.');
    expect(container.querySelector('.connection-delete-confirmation__target')).toBeNull();
    expect(container.querySelector('.connection-delete-confirmation__hint')).toBeNull();
    const deleteButton = screen.getByRole('button', {
      name: 'Delete connection',
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    const confirmInput = screen.getByLabelText(
      'Type the connection name to confirm',
    ) as HTMLInputElement;
    fireEvent.input(confirmInput, { target: { value: 'Wrong' } });
    expect(deleteButton.disabled).toBe(true);
    expect(apiMocks.disconnectConnection).not.toHaveBeenCalled();

    fireEvent.input(confirmInput, { target: { value: 'Default' } });
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(apiMocks.disconnectConnection).toHaveBeenCalledWith(
        'anthropic',
        'subscription',
        'Default',
      ),
    );
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/subscriptions');
  });

  it('shows a loading state until the connection detail resolves', async () => {
    let resolveDetail!: (value: unknown) => void;
    apiMocks.getConnectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    const { container } = render(() => <ConnectionDetail />);
    // Loading state renders a skeleton placeholder (no "Loading..." text).
    expect(container.querySelector('[style*="skeleton-pulse"]')).not.toBeNull();

    resolveDetail(connectionDetail);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
  });

  it('shows a not-found state for a missing/deleted connection (P3)', async () => {
    // A resolved-but-null connection must render not-found, never spin on the
    // loading fallback forever.
    apiMocks.getConnectionDetail.mockResolvedValue({
      connection: null,
      agents: [],
      model_usage: [],
      recent_messages: [],
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Connection not found')).toBeDefined());
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getByText('Back to overview')).toBeDefined();
  });

  it('shows a retryable error state when the connection detail fetch fails', async () => {
    // A rejected fetch must render a retryable error state, not spin the loading
    // skeleton forever (calling detail() re-throws on error in Solid).
    apiMocks.getConnectionDetail.mockRejectedValueOnce(new Error('network down'));

    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText("Couldn't load this connection")).toBeDefined());
    expect(container.querySelector('[style*="skeleton-pulse"]')).toBeNull();

    // Retry re-fetches; on success the connection renders.
    apiMocks.getConnectionDetail.mockResolvedValueOnce(connectionDetail);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
  });

  it('scopes every chart query to the connection label (P2)', async () => {
    // The detail page must pass the connection's label to all chart/summary
    // queries so two connections sharing provider+auth_type but differing by
    // label don't show each other's usage.
    routerState.params = { connectionId: 'conn-work' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: { ...connectionDetail.connection, id: 'conn-work', label: 'Work' },
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Work').length).toBeGreaterThan(0));

    // analytics summary/timeseries: getProviderAnalytics(authType, range, agent, provider, label)
    const analyticsCall = apiMocks.getProviderAnalytics.mock.calls.at(-1)!;
    expect(analyticsCall[4]).toBe('Work');
    // per-agent token/message/cost fetchers: (...args, range, label)
    expect(apiMocks.getPerAgentTimeseries.mock.calls.at(-1)![3]).toBe('Work');
    expect(apiMocks.getPerAgentMessageTimeseries.mock.calls.at(-1)![3]).toBe('Work');
    expect(apiMocks.getPerAgentCostTimeseries.mock.calls.at(-1)![3]).toBe('Work');
  });

  it('opens the inline manage modal for a custom provider connection', async () => {
    routerState.params = { connectionId: 'conn-custom' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-custom',
        provider: 'custom:cp-1',
        label: 'Custom key',
      },
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Custom Provider')).toBeDefined());

    fireEvent.click(screen.getByText('Manage'));
    // Custom providers open the CustomProviderForm in edit mode
    await waitFor(() => expect(screen.getByText('Edit custom provider')).toBeDefined());
  });

  const setupCustomConnectionDetail = () => {
    routerState.params = { connectionId: 'conn-custom' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-custom',
        provider: 'custom:cp-1',
        label: 'Custom key',
      },
    });
  };

  it('closes the custom provider edit modal and refetches on onCreated', async () => {
    setupCustomConnectionDetail();
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Custom Provider')).toBeDefined());

    fireEvent.click(screen.getByText('Manage'));
    await waitFor(() => expect(screen.getByTestId('custom-provider-form')).toBeDefined());

    fireEvent.click(screen.getByText('form-created'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit custom provider' })).toBeNull(),
    );
    // Detail is refetched after onCreated.
    expect(apiMocks.getConnectionDetail.mock.calls.length).toBeGreaterThan(1);
  });

  it('closes the custom provider edit modal on onBack', async () => {
    setupCustomConnectionDetail();
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Custom Provider')).toBeDefined());

    fireEvent.click(screen.getByText('Manage'));
    await waitFor(() => expect(screen.getByTestId('custom-provider-form')).toBeDefined());

    fireEvent.click(screen.getByText('form-back'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit custom provider' })).toBeNull(),
    );
  });

  it('closes the custom provider edit modal and navigates back on onDeleted', async () => {
    setupCustomConnectionDetail();
    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getByText('Custom Provider')).toBeDefined());

    fireEvent.click(screen.getByText('Manage'));
    await waitFor(() => expect(screen.getByTestId('custom-provider-form')).toBeDefined());

    fireEvent.click(screen.getByText('form-deleted'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit custom provider' })).toBeNull(),
    );
    // onDeleted navigates to backLink() (usage-based for api_key auth type).
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/usage-based');
  });

  it('falls back to empty data when the custom provider lookup rejects', async () => {
    routerState.params = { connectionId: 'conn-custom' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-custom',
        provider: 'custom:cp-1',
        label: 'Custom key',
      },
    });
    // Custom provider name lookup rejects → resolver returns null → provider id
    // is shown as the display name.
    apiMocks.getCustomProviders.mockRejectedValue(new Error('custom lookup failed'));

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Custom key').length).toBeGreaterThan(0));
  });

  it('falls back to no providers when the harness list cannot load', async () => {
    apiMocks.getAgents.mockRejectedValue(new Error('agents down'));

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));

    // Manage still opens the inline modal even when harness list fails.
    fireEvent.click(screen.getByText('Manage'));
    expect(screen.getByText('Connection name')).toBeDefined();
    fireEvent.click(screen.getByText('Done'));
  });

  it('swallows storage failures across chart and filter persistence', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));

    // range + view persistence both throw and are swallowed
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30d' } });
    fireEvent.click(screen.getByText('Requests chart'));

    // filter persistence (toggle / select all) all throw + swallow
    fireEvent.click(screen.getByText('All harnesses (2)'));
    const toggle = screen
      .getAllByText('demo-agent')
      .find((el) => el.closest('.agent-filter-select'));
    fireEvent.click(toggle!);
    fireEvent.click(screen.getByText('Select all'));

    getItem.mockRestore();
    setItem.mockRestore();
  });

  // Helper: open the manage modal and return the rename input.
  const openManageModal = async () => {
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('Manage'));
    return screen.getByDisplayValue('Default') as HTMLInputElement;
  };

  it('renames a connection and refetches on success', async () => {
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    fireEvent.input(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(apiMocks.renameConnection).toHaveBeenCalledWith(
        'openai',
        'Default',
        'Renamed',
        'api_key',
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith('Connection renamed');
    // Modal closes on success.
    await waitFor(() => expect(screen.queryByText('Connection name')).toBeNull());
    // Detail is refetched (initial load + refetch).
    expect(apiMocks.getConnectionDetail.mock.calls.length).toBeGreaterThan(1);
  });

  it('shows an inline error when renaming a connection fails', async () => {
    apiMocks.renameConnection.mockRejectedValueOnce(new Error('rename boom'));
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    fireEvent.input(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    // The thrown message surfaces inline (line 938 renders renameError()).
    await waitFor(() => expect(screen.getByText('rename boom')).toBeDefined());
    expect(toastMock.success).not.toHaveBeenCalled();
    // Modal stays open so the user can retry.
    expect(screen.getByText('Connection name')).toBeDefined();
  });

  it('falls back to a generic message when the rename error has no message', async () => {
    apiMocks.renameConnection.mockRejectedValueOnce({});
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    fireEvent.input(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Failed to rename')).toBeDefined());
  });

  it('rejects an empty rename with a validation message', async () => {
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    // Whitespace-only trims to empty → validation error, no API call.
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Name cannot be empty')).toBeDefined());
    expect(apiMocks.renameConnection).not.toHaveBeenCalled();
  });

  it('closes the modal without an API call when the name is unchanged', async () => {
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    // The Save button is disabled when the value equals the label, so submit via
    // Enter (line 924) to exercise the unchanged-name early return (lines 397-399).
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByText('Connection name')).toBeNull());
    expect(apiMocks.renameConnection).not.toHaveBeenCalled();
  });

  it('renames a connection when the workspace has no harness', async () => {
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    render(() => <ConnectionDetail />);
    const input = await openManageModal();

    fireEvent.input(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(apiMocks.renameConnection).toHaveBeenCalledWith(
        'openai',
        'Default',
        'Renamed',
        'api_key',
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith('Connection renamed');
  });

  it('disconnects a connection and navigates back on success', async () => {
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() =>
      expect(apiMocks.disconnectConnection).toHaveBeenCalledWith('openai', 'api_key', 'Default'),
    );
    expect(toastMock.success).toHaveBeenCalledWith('Connection removed');
    // BYOK connection → back link is the usage-based providers page.
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/usage-based');
  });

  it('shows an error toast when disconnecting fails', async () => {
    apiMocks.disconnectConnection.mockRejectedValueOnce(new Error('disconnect boom'));
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('disconnect boom'));
    expect(routerState.navigate).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the disconnect error has no message', async () => {
    apiMocks.disconnectConnection.mockRejectedValueOnce({});
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Failed to disconnect'));
  });

  it('disconnects a connection when the workspace has no harness', async () => {
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() =>
      expect(apiMocks.disconnectConnection).toHaveBeenCalledWith('openai', 'api_key', 'Default'),
    );
    expect(toastMock.success).toHaveBeenCalledWith('Connection removed');
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/usage-based');
  });

  it('refreshes models and refetches on success', async () => {
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Refresh models'));

    await waitFor(() => expect(apiMocks.refreshConnectionModels).toHaveBeenCalledWith());
    expect(toastMock.success).toHaveBeenCalledWith('Models refreshed');
    expect(apiMocks.getConnectionDetail.mock.calls.length).toBeGreaterThan(1);
  });

  it('shows an error toast when refreshing models fails', async () => {
    apiMocks.refreshConnectionModels.mockRejectedValueOnce(new Error('refresh boom'));
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Refresh models'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Failed to refresh models'));
  });

  it('refreshes models when the workspace has no harness', async () => {
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    render(() => <ConnectionDetail />);
    await openManageModal();

    fireEvent.click(screen.getByText('Refresh models'));

    await waitFor(() => expect(apiMocks.refreshConnectionModels).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Models refreshed');
  });

  it('hides model refresh for a custom provider in the fallback modal', async () => {
    // No harness → the custom-provider form can't load, so the generic modal
    // shows. Discovery skips custom providers, so offering refresh would lie.
    apiMocks.getAgents.mockResolvedValue({ agents: [] });
    routerState.params = { connectionId: 'conn-custom' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: { ...connectionDetail.connection, id: 'conn-custom', provider: 'custom:cp-1' },
    });
    render(() => <ConnectionDetail />);
    await openManageModal();

    expect(screen.getByText('Connection name')).toBeDefined();
    expect(screen.queryByText('Refresh models')).toBeNull();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  it('closes the manage modal when Escape is pressed on the overlay', async () => {
    render(() => <ConnectionDetail />);
    await openManageModal();
    expect(screen.getByText('Connection name')).toBeDefined();

    const overlay = document.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.keyDown(overlay, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('Connection name')).toBeNull());
  });

  it('renders the subscription connection-info copy for an active subscription', async () => {
    routerState.params = { connectionId: 'conn-anthropic' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-anthropic',
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Claude',
        is_active: true,
      },
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Claude').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Manage'));
    // Active subscription → "Connected via subscription" (line 963 truthy branch).
    await waitFor(() => expect(screen.getByText(/Connected via\s+subscription/)).toBeDefined());
  });

  it('renders a dash for a recent message with no model', async () => {
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      recent_messages: [
        { timestamp: '2026-06-04T10:00:00Z', model: null, input_tokens: 0, output_tokens: 0 },
      ],
    });

    const { container } = render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
    // The model cell falls back to an em dash when msg.model is falsy (line 708).
    const dashCell = Array.from(container.querySelectorAll('td')).find(
      (td) => td.textContent?.trim() === '—',
    );
    expect(dashCell).toBeDefined();
  });

  it('requires confirmation before deleting an inactive connection', async () => {
    routerState.params = { connectionId: 'conn-inactive' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-inactive',
        is_active: false,
        label: 'Stale',
      },
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Stale').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Manage'));
    expect(screen.getByText('Connection name')).toBeDefined();
    expect(screen.queryByText('Disconnect')).toBeNull();
    expect(screen.getByText('Delete')).toBeDefined();
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.getByRole('alertdialog', { name: 'Delete usage history?' })).toBeDefined();
    expect(screen.getByLabelText('Type the connection name to confirm')).toBeDefined();
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('alertdialog', { name: 'Delete usage history?' })).toBeNull();
    expect(screen.getByText('Delete')).toBeDefined();
    fireEvent.click(screen.getByText('Close'));

    await waitFor(() => expect(screen.queryByText('Connection name')).toBeNull());
    expect(apiMocks.disconnectConnection).not.toHaveBeenCalled();
  });

  it('deletes an inactive subscription connection and navigates back on success', async () => {
    routerState.params = { connectionId: 'conn-inactive-subscription' };
    apiMocks.getConnectionDetail.mockResolvedValue({
      ...connectionDetail,
      connection: {
        ...connectionDetail.connection,
        id: 'conn-inactive-subscription',
        provider: 'anthropic',
        auth_type: 'subscription',
        is_active: false,
        label: 'Old Claude',
      },
    });

    render(() => <ConnectionDetail />);
    await waitFor(() => expect(screen.getAllByText('Old Claude').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Manage'));
    fireEvent.click(screen.getByText('Delete'));
    const deleteButton = screen.getByRole('button', {
      name: 'Delete connection',
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Type the connection name to confirm'), {
      target: { value: 'Old Claude' },
    });
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(apiMocks.disconnectConnection).toHaveBeenCalledWith(
        'anthropic',
        'subscription',
        'Old Claude',
      ),
    );
    expect(routerState.navigate).toHaveBeenCalledWith('/providers/subscriptions');
  });
});
