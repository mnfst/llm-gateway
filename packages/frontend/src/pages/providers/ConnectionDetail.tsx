import { Title } from '@solidjs/meta';
import { toggleScrollFade } from '../../services/scroll-fade.js';
import { A, useNavigate, useParams } from '@solidjs/router';
import { getBillingStatus } from '../../services/api/billing.js';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from 'solid-js';
import {
  getConnectionDetail,
  getProviderAnalytics,
  getPerAgentTimeseries,
  getPerAgentMessageTimeseries,
  getPerAgentCostTimeseries,
  getConnectionAttemptStatusTimeseries,
  getConnectionAttemptsByAgentTimeseries,
  getConnectionAttemptHttpStatusTimeseries,
  getConnectionAttemptBreakdown,
  attemptSuccessRate,
  totalAttemptsTooltip,
  CONNECTION_SUCCESS_RATE_TOOLTIP,
  CONNECTION_HARNESS_SUCCESS_RATE_TOOLTIP,
} from '../../services/api/analytics.js';
import { platformIcon } from 'manifest-shared';
import { PROVIDERS } from '../../services/providers.js';
import { providerIcon } from '../../components/ProviderIcon.jsx';
import FilterSelect from '../../components/FilterSelect.jsx';
import {
  formatNumber,
  formatCost,
  formatTimeAgo,
  customProviderColor,
} from '../../services/formatters.js';
import { getAgents, getCustomProviders as fetchCustomProviders } from '../../services/api.js';
import {
  renameConnection,
  disconnectConnection,
  refreshConnectionModels,
} from '../../services/api/routing.js';
import UnifiedChartCard, { type ChartTab } from '../../components/UnifiedChartCard.jsx';
import InfoTooltip from '../../components/InfoTooltip.jsx';
import { AGENT_COLORS } from '../../components/MultiAgentTokenChart.jsx';
import Select from '../../components/Select.jsx';
import { setConnectionBreadcrumb } from '../../services/connection-breadcrumb-store.js';
import { toast } from '../../services/toast-store.js';
import '../../styles/charts.css';
import '../../styles/analytics-overview.css';
import '../../styles/connection-detail.css';
import { getModelDisplayName } from '../../services/model-display.js';
import CustomProviderForm from '../../components/CustomProviderForm.jsx';
import '../../styles/routing.css';

const AUTH_TYPE_LABELS: Record<string, string> = {
  subscription: 'Subscriptions',
  api_key: 'Usage-based',
  local: 'Local',
};

const BACK_LINKS: Record<string, string> = {
  subscription: '/providers/subscriptions',
  api_key: '/providers/usage-based',
  local: '/providers/local',
};

interface AgentRow {
  agent_name: string;
  agent_platform: string | null;
  tokens_30d: number;
  cost_30d: number;
  messages_30d: number;
  attempts_30d?: number;
  succeeded_30d?: number;
  pct_of_total: number;
  last_used: string | null;
}

interface ModelRow {
  model: string;
  tokens: number;
  cost: number;
  messages: number;
  pct_of_total: number;
}

interface ConnectionInfo {
  id: string;
  provider: string;
  auth_type: string;
  label: string;
  cached_model_count: number;
  key_prefix: string | null;
  connected_at: string;
  is_active: boolean;
  last_used_at: string | null;
}

interface DetailResponse {
  connection: ConnectionInfo | null;
  agents: AgentRow[];
  model_usage: ModelRow[];
  recent_messages: any[];
}

interface AnalyticsResponse {
  summary: {
    messages: { value: number; trend_pct: number };
    tokens: { value: number; trend_pct: number };
  };
  token_usage: Array<{ hour?: string; date?: string; input_tokens: number; output_tokens: number }>;
  message_usage: Array<{ hour?: string; date?: string; count: number }>;
  attempts: { total: number; successful: number; success_rate: number };
}

const PRO_RANGES_CD = new Set(['30d', '90d', '365d']);
const CD_RANGE_OPTIONS = [
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
  { label: 'Last 365 days', value: '365d' },
];

const ConnectionDetail: Component = () => {
  const params = useParams<{ connectionId: string }>();
  const navigate = useNavigate();
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });
  const isFreePlan = () => billing()?.enabled && billing()?.plan === 'free';
  const proBadge = () => (
    <span class="pro-range-badge" aria-label="Pro plan required">
      PRO
    </span>
  );
  const cdRangeOptions = () =>
    CD_RANGE_OPTIONS.map((opt) =>
      isFreePlan() && PRO_RANGES_CD.has(opt.value)
        ? { ...opt, disabled: true, badge: proBadge() }
        : opt,
    );

  const [detail, { refetch: refetchDetail }] = createResource(
    () => params.connectionId,
    (id) => getConnectionDetail(id) as Promise<DetailResponse>,
  );

  const conn = () => (detail.error ? null : (detail()?.connection ?? null));
  const provDef = () => PROVIDERS.find((p) => p.id === conn()?.provider);
  const isCustomProvider = () => conn()?.provider?.startsWith('custom:') ?? false;

  // Fetch custom provider name for custom: providers
  const [customProviderData] = createResource(
    () => {
      const c = conn();
      if (!c || !c.provider.startsWith('custom:')) return null;
      const agentName = (agents() ?? [])[0]?.agent_name;
      return agentName ? { agentName, providerId: c.provider.replace('custom:', '') } : null;
    },
    async (p) => {
      if (!p) return null;
      try {
        const list = await fetchCustomProviders(p.agentName);
        return (list as any[])?.find((cp: any) => cp.id === p.providerId) ?? null;
      } catch {
        return null;
      }
    },
  );

  const providerDisplayName = () => {
    if (provDef()) return provDef()!.name;
    const cp = customProviderData();
    if (cp) return cp.name;
    return conn()?.provider ?? '';
  };

  // Deep links into the Requests log, scoped to THIS connection and the
  // card's current window, so the list matches what the card counted.
  const requestsLink = (extra: string) =>
    `/messages?connections=${encodeURIComponent(params.connectionId)}&range=${chartRange()}${extra}`;
  const viewMore = () => <span class="view-more-link">View more</span>;

  const backLink = () =>
    BACK_LINKS[conn()?.auth_type ?? 'subscription'] ?? '/providers/subscriptions';
  const backLabel = () => AUTH_TYPE_LABELS[conn()?.auth_type ?? 'subscription'] ?? 'Providers';

  // Set breadcrumb for Header
  createEffect(() => {
    const c = conn();
    if (c) {
      setConnectionBreadcrumb(providerDisplayName(), backLink(), backLabel(), c.provider, c.label);
    }
  });
  onCleanup(() => setConnectionBreadcrumb(null));

  // Chart state (persisted in sessionStorage)
  const rangeKey = () => `chart-range:${params.connectionId}`;
  const viewKey = () => `chart-view:${params.connectionId}`;
  const savedRange = () => {
    try {
      const v = sessionStorage.getItem(rangeKey());
      // Restore any persisted range, including longer windows, so saved
      // selections survive reload instead of silently resetting to the 7d default.
      if (v === '24h' || v === '7d' || v === '30d' || v === '90d' || v === '365d') return v;
    } catch {
      /* ignore */
    }
    return '7d';
  };
  const savedView = () => {
    try {
      const v = sessionStorage.getItem(viewKey());
      if (v === 'tokens' || v === 'cost' || v === 'requests') return v;
    } catch {
      /* ignore */
    }
    return 'tokens' as const;
  };
  const [chartRange, setChartRangeRaw] = createSignal(savedRange());
  const setChartRange = (v: string) => {
    setChartRangeRaw(v);
    try {
      sessionStorage.setItem(rangeKey(), v);
    } catch {
      /* ignore */
    }
  };
  const [chartView, setChartViewRaw] = createSignal<ChartTab>(savedView());
  const setChartView = (v: ChartTab) => {
    setChartViewRaw(v);
    try {
      sessionStorage.setItem(viewKey(), v);
    } catch {
      /* ignore */
    }
  };
  const [chartAgent] = createSignal('');

  // Attempts tab view: By attempt status (default) or By harness. Persisted
  // per connection like the range and the active tab.
  const groupKey = () => `chart-group:${params.connectionId}`;
  const savedGroup = (): 'status' | 'http' | 'harness' => {
    try {
      const v = sessionStorage.getItem(groupKey());
      return v === 'harness' || v === 'status' ? v : 'http';
    } catch {
      return 'http';
    }
  };
  const [groupBy, setGroupByRaw] = createSignal<'status' | 'http' | 'harness'>(savedGroup());
  const setGroupBy = (v: 'status' | 'http' | 'harness') => {
    setGroupByRaw(v);
    try {
      sessionStorage.setItem(groupKey(), v);
    } catch {
      /* ignore */
    }
  };

  const [analytics] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return {
        range: chartRange(),
        agent: chartAgent(),
        authType: c.auth_type,
        provider: c.provider,
        // Scope every chart/summary query to this exact connection
        // (provider+auth_type+label). Without the label, two connections that
        // share provider+auth_type but differ by label show each other's usage.
        label: c.label,
      };
    },
    (p) => {
      if (!p) return null;
      return getProviderAnalytics(
        p.authType,
        p.range,
        p.agent || undefined,
        p.provider,
        p.label,
        // Scope the cards + chart to this exact connection (tenant_providers id),
        // so a freshly added key shows its own usage, not a sibling key's.
        params.connectionId,
      ) as Promise<AnalyticsResponse>;
    },
  );

  const [agentTimeseries] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getPerAgentTimeseries(p.authType, p.provider, p.range, p.label, params.connectionId);
    },
  );

  const [agentMessageTimeseries] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getPerAgentMessageTimeseries(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );

  // Attempt world: every provider call on this connection, by its own
  // outcome. Default view of the Attempts chart; the harness view shares the
  // same universe so both stack to the same totals.
  const [attemptStatusTs] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getConnectionAttemptStatusTimeseries(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );
  const [attemptsByAgentTs] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getConnectionAttemptsByAgentTimeseries(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );
  const [httpStatusTs] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getConnectionAttemptHttpStatusTimeseries(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );
  const [breakdown] = createResource(
    () => {
      const c = conn();
      if (!c) return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getConnectionAttemptBreakdown(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );

  const attemptTotals = () => {
    const ts = attemptStatusTs();
    if (!ts) return { attempts: 0, succeeded: 0 };
    const successIdx = ts.keys.indexOf('success');
    let attempts = 0;
    let succeeded = 0;
    for (const b of ts.buckets) {
      for (let i = 0; i < b.counts.length; i++) {
        attempts += b.counts[i] ?? 0;
        if (i === successIdx) succeeded += b.counts[i] ?? 0;
      }
    }
    return { attempts, succeeded };
  };

  const isByok = () => conn()?.auth_type === 'api_key';

  const [agentCostTimeseries] = createResource(
    () => {
      const c = conn();
      if (!c || c.auth_type !== 'api_key') return null;
      return { range: chartRange(), authType: c.auth_type, provider: c.provider, label: c.label };
    },
    (p) => {
      if (!p) return null;
      return getPerAgentCostTimeseries(
        p.authType,
        p.provider,
        p.range,
        p.label,
        params.connectionId,
      );
    },
  );

  // Harness tag selection for chart filtering (persisted in sessionStorage).
  // `null` means "no persisted preference" (→ default to all selected); a Set
  // — even an empty one — means an explicit user choice, so a genuine
  // "Unselect all" survives and isn't coerced back to "all selected".
  const storageKey = () => `agent-filter:${params.connectionId}`;
  const loadSavedAgents = (): Set<string> | null => {
    try {
      const saved = sessionStorage.getItem(storageKey());
      if (saved !== null) return new Set(JSON.parse(saved) as string[]);
    } catch {
      /* ignore */
    }
    return null;
  };
  const [selectedAgents, setSelectedAgents] = createSignal<Set<string> | null>(loadSavedAgents());
  const persistSelection = (next: Set<string>) => {
    setSelectedAgents(next);
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };
  // Merge agent lists from both token and message timeseries
  const allAgents = createMemo(() => {
    const tokenAgents = agentTimeseries()?.agents ?? [];
    const msgAgents = agentMessageTimeseries()?.agents ?? [];
    const costAgents = agentCostTimeseries()?.agents ?? [];
    const attemptAgents = attemptsByAgentTs()?.agents ?? [];
    const set = new Set([...tokenAgents, ...msgAgents, ...costAgents, ...attemptAgents]);
    return [...set].sort();
  });

  const agentColorMap = createMemo(() => {
    const map: Record<string, string> = {};
    const agents = allAgents();
    for (let i = 0; i < agents.length; i++) {
      map[agents[i]!] = AGENT_COLORS[i % AGENT_COLORS.length]!;
    }
    return map;
  });

  const effectiveSelected = () => {
    const sel = selectedAgents();
    // No persisted preference (null) → default to all selected. An explicit
    // (possibly empty) Set is honored as-is so "Unselect all" sticks.
    if (sel === null) return new Set(allAgents());
    return sel;
  };

  const toggleAgent = (agent: string) => {
    const next = new Set(effectiveSelected());
    if (next.has(agent)) {
      next.delete(agent);
    } else {
      next.add(agent);
    }
    persistSelection(next);
  };

  // Filter a series bundle down to the selected agents. An explicit empty
  // selection (genuine "Unselect all") yields empty agents/series, so the chart
  // renders its empty state instead of silently showing everything.
  type Series = { agents: string[]; timeseries: Array<Record<string, number | string>> };
  const filterSeries = (raw: Series | null | undefined): Series | undefined => {
    if (!raw) return undefined;
    const sel = effectiveSelected();
    const agents = raw.agents.filter((a) => sel.has(a));
    const timeseries = raw.timeseries.map((row) => {
      const filtered: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'hour' || k === 'date' || sel.has(k)) filtered[k] = v;
      }
      return filtered;
    });
    return { agents, timeseries };
  };

  const filteredAgentTimeseries = createMemo(() => filterSeries(agentTimeseries()));
  const filteredAgentMessageTimeseries = createMemo(() => filterSeries(agentMessageTimeseries()));
  const filteredAgentCostTimeseries = createMemo(() => filterSeries(agentCostTimeseries()));
  const filteredAttemptsByAgentTimeseries = createMemo(() => filterSeries(attemptsByAgentTs()));

  // Manage modal state
  const [showManageModal, setShowManageModal] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal('');
  const [renaming, setRenaming] = createSignal(false);
  const [renameError, setRenameError] = createSignal('');
  const [refreshingModels, setRefreshingModels] = createSignal(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [deleteConfirmName, setDeleteConfirmName] = createSignal('');
  const [deletingConnection, setDeletingConnection] = createSignal(false);

  // Only the custom-provider edit form still goes through agent-scoped routes.
  const [agents] = createResource(async () => {
    try {
      const res = await getAgents();
      return (res as any)?.agents ?? res ?? [];
    } catch {
      return [];
    }
  });
  const firstAgentName = () => (agents() ?? [])[0]?.agent_name ?? '';

  const openManageModal = () => {
    const c = conn();
    if (c) setRenameValue(c.label);
    setRenameError('');
    setShowDeleteConfirm(false);
    setDeleteConfirmName('');
    setShowManageModal(true);
  };

  const closeManageModal = () => {
    setShowManageModal(false);
    setShowDeleteConfirm(false);
    setDeleteConfirmName('');
  };

  const openDeleteConfirm = () => {
    setDeleteConfirmName('');
    setShowDeleteConfirm(true);
  };

  const closeDeleteConfirm = () => {
    setShowDeleteConfirm(false);
    setDeleteConfirmName('');
  };

  const deleteConfirmMatches = () => {
    const c = conn();
    return !!c && deleteConfirmName() === c.label;
  };

  const handleRename = async () => {
    const c = conn();
    if (!c) return;
    const newLabel = renameValue().trim();
    if (!newLabel) {
      setRenameError('Name cannot be empty');
      return;
    }
    if (newLabel === c.label) {
      closeManageModal();
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      await renameConnection(c.provider, c.label, newLabel, c.auth_type as any);
      toast.success('Connection renamed');
      closeManageModal();
      refetchDetail();
    } catch (e: any) {
      setRenameError(e?.message ?? 'Failed to rename');
    } finally {
      setRenaming(false);
    }
  };

  const handleDisconnect = async () => {
    const c = conn();
    if (!c) return;
    if (!c.is_active && !deleteConfirmMatches()) return;
    setDeletingConnection(true);
    try {
      await disconnectConnection(c.provider, c.auth_type as any, c.label);
      toast.success('Connection removed');
      navigate(backLink());
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to disconnect');
    } finally {
      setDeletingConnection(false);
    }
  };

  const handleRefreshModels = async () => {
    setRefreshingModels(true);
    try {
      await refreshConnectionModels();
      toast.success('Models refreshed');
      refetchDetail();
    } catch {
      toast.error('Failed to refresh models');
    } finally {
      setRefreshingModels(false);
    }
  };

  // A resolved-but-null connection means the id is unknown / the connection
  // was deleted. Branch on the resource so this renders a not-found state
  // instead of the loading fallback spinning forever.
  // A rejected fetch leaves the resource errored; surface a retryable error state
  // instead of spinning the loading skeleton forever. Reading detail.error never
  // throws, unlike calling detail(), so guard the other branches on it too.
  const hasError = () => !detail.loading && !!detail.error;
  const notFound = () =>
    !hasError() && !detail.loading && detail() !== undefined && conn() === null;

  return (
    <div class="container--lg">
      <Show when={hasError()}>
        <Title>Couldn't load connection | Manifest</Title>
        <div style="padding: 48px 0; text-align: center;">
          <div style="font-size: var(--font-size-base); font-weight: 600; color: hsl(var(--foreground)); margin-bottom: 8px;">
            Couldn't load this connection
          </div>
          <div style="font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); margin-bottom: 16px;">
            Something went wrong loading this connection. Please try again.
          </div>
          <button type="button" class="btn btn--outline btn--sm" onClick={() => refetchDetail()}>
            Retry
          </button>
        </div>
      </Show>
      <Show when={notFound()}>
        <Title>Connection not found | Manifest</Title>
        <div style="padding: 48px 0; text-align: center;">
          <div style="font-size: var(--font-size-base); font-weight: 600; color: hsl(var(--foreground)); margin-bottom: 8px;">
            Connection not found
          </div>
          <div style="font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); margin-bottom: 16px;">
            This connection no longer exists or you don't have access to it.
          </div>
          <A href="/" class="btn btn--outline btn--sm" style="text-decoration: none;">
            Back to overview
          </A>
        </div>
      </Show>
      <Show
        when={!notFound() && !hasError() && detail() && conn()}
        fallback={
          <Show when={!notFound() && !hasError()}>
            <div style="width: 100%; height: 300px; border-radius: var(--radius); background: hsl(var(--muted) / 0.45); animation: skeleton-pulse 1.2s ease-in-out infinite;" />
          </Show>
        }
      >
        {(() => {
          const c = conn()!;
          return (
            <>
              <Title>
                {providerDisplayName()} / {c.label} | Manifest
              </Title>

              {/* Back link */}
              <div style="margin-bottom: 24px;">
                <A
                  href={backLink()}
                  style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); text-decoration: none;"
                >
                  ← {backLabel()}
                </A>
              </div>

              {/* Header */}
              <div class="connection-detail__header">
                <div class="connection-detail__identity">
                  <div class="connection-detail__title-row">
                    <div class="connection-detail__title">
                      <span style="display: flex; align-items: center; flex-shrink: 0; width: 32px; height: 32px;">
                        <Show
                          when={providerIcon(c.provider, 32)}
                          fallback={
                            <span
                              style={{
                                display: 'inline-flex',
                                'align-items': 'center',
                                'justify-content': 'center',
                                width: '32px',
                                height: '32px',
                                'border-radius': '8px',
                                'font-size': '16px',
                                'font-weight': '700',
                                color: 'white',
                                background: customProviderColor(providerDisplayName()),
                              }}
                            >
                              {providerDisplayName().charAt(0).toUpperCase()}
                            </span>
                          }
                        >
                          {providerIcon(c.provider, 32)}
                        </Show>
                      </span>
                      <h1 class="page-header__title">
                        {providerDisplayName()}
                        <span style="font-size: var(--font-size-sm); font-weight: 400; color: hsl(var(--muted-foreground));">
                          {c.label}
                        </span>
                      </h1>
                    </div>
                    <div class="connection-detail__badges">
                      <Show when={isCustomProvider()}>
                        <span
                          class="connection-detail__badge"
                          style="padding: 2px 8px; border: 1px solid hsl(var(--border)); color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs); font-weight: 500;"
                        >
                          Custom
                        </span>
                      </Show>
                      <Show
                        when={c.is_active}
                        fallback={
                          <span
                            class="connection-detail__badge"
                            style="padding: 4px 12px; background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); font-weight: 500;"
                          >
                            Inactive
                          </span>
                        }
                      >
                        <span
                          class="connection-detail__badge"
                          style="padding: 4px 12px; background: hsl(var(--success)); color: white; font-size: var(--font-size-sm); font-weight: 600;"
                        >
                          Active
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div class="connection-detail__meta">
                    <span>
                      <span style="font-weight: 600; color: hsl(var(--foreground));">
                        Connection name:
                      </span>{' '}
                      <span style="color: hsl(var(--muted-foreground));">{c.label}</span>
                    </span>
                    <span>
                      <span style="font-weight: 600; color: hsl(var(--foreground));">Models:</span>{' '}
                      <span style="color: hsl(var(--muted-foreground));">
                        {c.cached_model_count}
                      </span>
                    </span>
                    <span>
                      <span style="font-weight: 600; color: hsl(var(--foreground));">
                        First connection:
                      </span>{' '}
                      <span style="color: hsl(var(--muted-foreground));">
                        {c.connected_at ? formatTimeAgo(c.connected_at) : '—'}
                      </span>
                    </span>
                    <span>
                      <span style="font-weight: 600; color: hsl(var(--foreground));">
                        Last used:
                      </span>{' '}
                      <span style="color: hsl(var(--muted-foreground));">
                        {c.last_used_at ? formatTimeAgo(c.last_used_at) : '—'}
                      </span>
                    </span>
                  </div>
                </div>
                <div class="connection-detail__controls">
                  <Show when={allAgents().length > 1}>
                    <FilterSelect
                      noun="harnesses"
                      items={allAgents()}
                      selected={effectiveSelected()}
                      colorMap={agentColorMap()}
                      onToggle={toggleAgent}
                      onSelectAll={() => persistSelection(new Set(allAgents()))}
                      onUnselectAll={() => persistSelection(new Set<string>())}
                    />
                  </Show>
                  <Select
                    value={chartRange()}
                    onChange={(v) => {
                      if (isFreePlan() && PRO_RANGES_CD.has(v)) return;
                      setChartRange(v);
                    }}
                    options={cdRangeOptions()}
                  />
                  <button class="btn btn--outline btn--sm" onClick={openManageModal}>
                    Manage
                  </button>
                </div>
              </div>

              {/* Attempt world cards: the connection's own numbers on the
                  filtered period. Fallback retries exist for everyone;
                  autofixed attempts only exist with the Doctor version. */}
              <div class="overview-stats overview-stats--5" style="margin-bottom: 16px;">
                <div class="overview-stat-card">
                  <span class="overview-stat-card__label">
                    Success rate
                    <InfoTooltip text={CONNECTION_SUCCESS_RATE_TOOLTIP} />
                  </span>
                  <div class="overview-stat-card__value-row">
                    <span class="overview-stat-card__value">
                      {(() => {
                        const b = breakdown();
                        const rate = b
                          ? attemptSuccessRate({ attempts: b.attempts, succeeded: b.succeeded })
                          : null;
                        return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
                      })()}
                    </span>
                  </div>
                </div>
                <div
                  class="overview-stat-card"
                  style="cursor: pointer;"
                  title="View the requests holding these succeeded attempts"
                  onClick={() => navigate(requestsLink('&attempts=has_succeeded'))}
                >
                  <span class="overview-stat-card__label">Succeeded attempts</span>
                  <div class="overview-stat-card__value-row">
                    <span class="overview-stat-card__value">
                      {formatNumber(breakdown()?.succeeded ?? 0)}
                    </span>
                    {viewMore()}
                  </div>
                </div>
                <div
                  class="overview-stat-card"
                  style="cursor: pointer;"
                  title="View the requests holding these failed attempts"
                  onClick={() => navigate(requestsLink('&attempts=has_failed'))}
                >
                  <span class="overview-stat-card__label">Failed attempts</span>
                  <div class="overview-stat-card__value-row">
                    <span class="overview-stat-card__value">
                      {formatNumber(breakdown()?.failed ?? 0)}
                    </span>
                    {viewMore()}
                  </div>
                </div>
                <div
                  class="overview-stat-card"
                  style="cursor: pointer;"
                  title="View the requests where this connection ran a fallback retry"
                  onClick={() => navigate(requestsLink('&trigger=fallback'))}
                >
                  <span class="overview-stat-card__label">Fallback retries</span>
                  <div class="overview-stat-card__value-row">
                    <span class="overview-stat-card__value">
                      {formatNumber(breakdown()?.fallback_retries ?? 0)}
                    </span>
                    <Show when={(breakdown()?.fallback_retries ?? 0) > 0}>
                      <span style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs);">
                        {formatNumber(breakdown()?.fallback_retries_succeeded ?? 0)} succeeded
                      </span>
                    </Show>
                    {viewMore()}
                  </div>
                </div>
                <div
                  class="overview-stat-card"
                  style="cursor: pointer;"
                  title="View the requests where this connection ran an autofixed attempt"
                  onClick={() => navigate(requestsLink('&trigger=autofix'))}
                >
                  <span class="overview-stat-card__label">Autofixed attempts</span>
                  <div class="overview-stat-card__value-row">
                    <span class="overview-stat-card__value">
                      {formatNumber(breakdown()?.autofix_attempts ?? 0)}
                    </span>
                    <Show when={(breakdown()?.autofix_attempts ?? 0) > 0}>
                      <span style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs);">
                        {formatNumber(breakdown()?.autofix_attempts_succeeded ?? 0)} succeeded
                      </span>
                    </Show>
                    {viewMore()}
                  </div>
                </div>
              </div>

              {/* Chart */}
              <Show when={analytics()}>
                {(() => {
                  const totalCost = createMemo(() => {
                    const ts = agentCostTimeseries();
                    if (!ts) return undefined;
                    let sum = 0;
                    for (const row of ts.timeseries) {
                      for (const a of ts.agents) sum += Number(row[a] ?? 0);
                    }
                    return sum;
                  });
                  return (
                    <UnifiedChartCard
                      activeTab={chartView()}
                      onTabChange={setChartView}
                      requestsLabel="Attempts"
                      requestsInfoTooltip={totalAttemptsTooltip(true)}
                      requestsValue={attemptTotals().attempts}
                      requestsTrendPct={0}
                      tokensValue={analytics()!.summary.tokens.value}
                      tokensTrendPct={analytics()!.summary.tokens.trend_pct}
                      costValue={isByok() ? (totalCost() ?? 0) : undefined}
                      range={chartRange()}
                      agentTimeseries={filteredAgentTimeseries() ?? undefined}
                      agentRequestTimeseries={
                        groupBy() === 'harness' ? filteredAttemptsByAgentTimeseries() : undefined
                      }
                      requestStatusTimeseries={
                        groupBy() === 'status'
                          ? (attemptStatusTs() ?? undefined)
                          : groupBy() === 'http'
                            ? (httpStatusTs() ?? undefined)
                            : undefined
                      }
                      requestStatusSeriesMode={groupBy() === 'http' ? 'http_status' : 'disposition'}
                      agentCostTimeseries={
                        isByok() ? (filteredAgentCostTimeseries() ?? undefined) : undefined
                      }
                      colorMap={agentColorMap()}
                      seriesFilters={
                        <>
                          {/* Status/harness grouping only applies to the
                              Requests tab; Tokens and Cost stay per-harness. */}
                          <Show when={chartView() === 'requests'}>
                            <button
                              class="chart-card__filter-btn"
                              classList={{
                                'chart-card__filter-btn--active': groupBy() === 'http',
                              }}
                              onClick={() => setGroupBy('http')}
                            >
                              By HTTP status
                            </button>
                            <button
                              class="chart-card__filter-btn"
                              classList={{
                                'chart-card__filter-btn--active': groupBy() === 'status',
                              }}
                              onClick={() => setGroupBy('status')}
                            >
                              By attempt status
                            </button>
                            <button
                              class="chart-card__filter-btn"
                              classList={{
                                'chart-card__filter-btn--active': groupBy() === 'harness',
                              }}
                              onClick={() => setGroupBy('harness')}
                            >
                              By harness
                            </button>
                          </Show>
                          <Show
                            when={
                              (chartView() !== 'requests' || groupBy() === 'harness') &&
                              allAgents().length > 1
                            }
                          >
                            <FilterSelect
                              noun="harnesses"
                              items={allAgents()}
                              selected={effectiveSelected()}
                              colorMap={agentColorMap()}
                              onToggle={toggleAgent}
                              onSelectAll={() => persistSelection(new Set(allAgents()))}
                              onUnselectAll={() => persistSelection(new Set<string>())}
                            />
                          </Show>
                        </>
                      }
                    />
                  );
                })()}
              </Show>

              {/* Recent Requests (full width) */}
              <div class="panel scroll-panel" style="margin-bottom: 24px;">
                <div
                  class="panel__title"
                  style="display: flex; justify-content: space-between; align-items: center;"
                >
                  Recent Requests
                </div>
                <Show
                  when={detail()!.recent_messages.length > 0}
                  fallback={
                    <div style="padding: 24px 16px; color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); text-align: center;">
                      No requests yet.
                    </div>
                  }
                >
                  <div class="scroll-panel__body" onScroll={toggleScrollFade}>
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Request ID</th>
                          <th>Model</th>
                          <th>Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={detail()!.recent_messages}>
                          {(msg: any) => (
                            <tr>
                              <td style="white-space: nowrap;">
                                {msg.timestamp ? formatTimeAgo(msg.timestamp) : '—'}
                              </td>
                              <td style="font-family: var(--font-mono, monospace); font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                                {msg.id ? msg.id.slice(0, 8) : '—'}
                              </td>
                              <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                <span style="display: inline-flex; align-items: center; gap: 4px;">
                                  {msg.model ? (
                                    <>
                                      <span style="display: inline-flex; flex-shrink: 0; position: relative; width: 14px; height: 14px;">
                                        {providerIcon(msg.provider ?? c.provider, 14)}
                                      </span>
                                      {getModelDisplayName(msg.model)}
                                    </>
                                  ) : (
                                    '—'
                                  )}
                                </span>
                              </td>
                              <td>
                                {formatNumber((msg.input_tokens ?? 0) + (msg.output_tokens ?? 0))}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              {/* Models (full width) */}
              <div class="panel scroll-panel" style="margin-bottom: 24px;">
                <div class="panel__title">Models</div>
                <Show
                  when={detail()!.model_usage.length > 0}
                  fallback={
                    <div style="padding: 24px 16px; color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); text-align: center;">
                      No model usage data yet.
                    </div>
                  }
                >
                  <div class="scroll-panel__body" onScroll={toggleScrollFade}>
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Tokens</th>
                          <th>% of total</th>
                          <Show when={isByok()}>
                            <th>Cost</th>
                          </Show>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={detail()!.model_usage}>
                          {(m) => (
                            <tr>
                              <td style="font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                {m.model}
                              </td>
                              <td>{formatNumber(m.tokens)}</td>
                              <td>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                  <div style="width: 60px; height: 6px; background: hsl(var(--muted)); border-radius: 3px; overflow: hidden;">
                                    <div
                                      style={{
                                        width: `${m.pct_of_total}%`,
                                        height: '100%',
                                        background: 'hsl(var(--success))',
                                        'border-radius': '3px',
                                      }}
                                    />
                                  </div>
                                  <span style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs);">
                                    {m.pct_of_total}%
                                  </span>
                                </div>
                              </td>
                              <Show when={isByok()}>
                                <td style="font-weight: 600; color: hsl(var(--foreground));">
                                  {formatCost(m.cost) ?? '$0.00'}
                                </td>
                              </Show>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              {/* Harnesses (full width) */}
              <div class="panel scroll-panel" style="margin-bottom: 0;">
                <div class="panel__title">Harnesses</div>
                <Show
                  when={detail()!.agents.length > 0}
                  fallback={
                    <div style="padding: 24px 16px; color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); text-align: center;">
                      No harnesses have used this provider yet.
                    </div>
                  }
                >
                  <div class="scroll-panel__body" onScroll={toggleScrollFade}>
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Harness</th>
                          <th>Tokens (30d)</th>
                          <th>% of total</th>
                          <Show when={isByok()}>
                            <th>Cost (30d)</th>
                          </Show>
                          <th class="rel-col">
                            Total attempts
                            <InfoTooltip text={totalAttemptsTooltip(true)} />
                          </th>
                          <th class="rel-col">
                            Success rate
                            <InfoTooltip text={CONNECTION_HARNESS_SUCCESS_RATE_TOOLTIP} />
                          </th>
                          <th>Last used</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={detail()!.agents}>
                          {(agent) => (
                            <tr>
                              <td>
                                <A
                                  href={`/harnesses/${encodeURIComponent(agent.agent_name)}`}
                                  style="text-decoration: none; color: hsl(var(--foreground)); font-weight: 500; display: flex; align-items: center; gap: 8px;"
                                >
                                  <Show when={platformIcon(agent.agent_platform, null)}>
                                    <img
                                      src={platformIcon(agent.agent_platform, null)!}
                                      alt=""
                                      width="16"
                                      height="16"
                                      class="platform-icon"
                                      style="border-radius: 3px;"
                                    />
                                  </Show>
                                  {agent.agent_name}
                                </A>
                              </td>
                              <td>{formatNumber(agent.tokens_30d)}</td>
                              <td>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                  <div style="width: 60px; height: 6px; background: hsl(var(--muted)); border-radius: 3px; overflow: hidden;">
                                    <div
                                      style={{
                                        width: `${agent.pct_of_total}%`,
                                        height: '100%',
                                        background: 'hsl(var(--success))',
                                        'border-radius': '3px',
                                      }}
                                    />
                                  </div>
                                  <span style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs);">
                                    {agent.pct_of_total}%
                                  </span>
                                </div>
                              </td>
                              <Show when={isByok()}>
                                <td>{formatCost(agent.cost_30d) ?? '$0.00'}</td>
                              </Show>
                              <td class="rel-col">{formatNumber(agent.attempts_30d ?? 0)}</td>
                              <td class="rel-col">
                                {(() => {
                                  const rate = attemptSuccessRate({
                                    attempts: agent.attempts_30d ?? 0,
                                    succeeded: agent.succeeded_30d,
                                  });
                                  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
                                })()}
                              </td>
                              <td style="color: hsl(var(--muted-foreground));">
                                {agent.last_used ? formatTimeAgo(agent.last_used) : '—'}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
              {/* Manage connection modal */}
              <Show when={showManageModal()}>
                <Show
                  when={isCustomProvider() && customProviderData()}
                  fallback={
                    <div
                      class="modal-overlay"
                      onClick={(e) => {
                        if (e.target === e.currentTarget) closeManageModal();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') closeManageModal();
                      }}
                    >
                      <div
                        class="modal-card"
                        style="max-width: 420px; padding: 24px;"
                        role="dialog"
                        aria-modal="true"
                      >
                        {/* Header with provider name and close button */}
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                          <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="display: flex; align-items: center; width: 28px; height: 28px;">
                              <Show
                                when={provDef()}
                                fallback={
                                  <span style="width: 28px; height: 28px; border-radius: 50%; background: hsl(var(--muted)); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; color: hsl(var(--muted-foreground));">
                                    {providerDisplayName().charAt(0)}
                                  </span>
                                }
                              >
                                {providerIcon(provDef()!.id, 28)}
                              </Show>
                            </span>
                            <span style="font-size: var(--font-size-lg); font-weight: 600; color: hsl(var(--foreground));">
                              {providerDisplayName()}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={closeManageModal}
                            style="background: none; border: none; cursor: pointer; padding: 4px; color: hsl(var(--muted-foreground)); font-size: 18px; line-height: 1;"
                            aria-label="Close"
                          >
                            ✕
                          </button>
                        </div>

                        {/* Connection name */}
                        <div style="margin-bottom: 16px;">
                          <label style="display: block; font-size: var(--font-size-sm); font-weight: 500; color: hsl(var(--foreground)); margin-bottom: 6px;">
                            Connection name
                          </label>
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <input
                              type="text"
                              class={`provider-detail__input${renameError() ? ' provider-detail__input--error' : ''}`}
                              value={renameValue()}
                              onInput={(e) => {
                                setRenameValue(e.currentTarget.value);
                                setRenameError('');
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRename();
                              }}
                              style="flex: 1;"
                            />
                            <button
                              class="btn btn--primary btn--sm"
                              disabled={renaming() || renameValue().trim() === conn()?.label}
                              onClick={handleRename}
                            >
                              {renaming() ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                          <Show when={renameError()}>
                            <div style="color: hsl(var(--destructive)); font-size: var(--font-size-sm); margin-top: 4px;">
                              {renameError()}
                            </div>
                          </Show>
                        </div>

                        <Show when={c.is_active}>
                          {/* Models */}
                          <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-top: 1px solid hsl(var(--border));">
                            <span style="font-size: var(--font-size-sm); color: hsl(var(--muted-foreground));">
                              {c.cached_model_count ?? 0} models
                            </span>
                            {/* Custom provider models are entered by hand; discovery skips them. */}
                            <Show when={!isCustomProvider()}>
                              <button
                                class="btn btn--outline btn--sm"
                                disabled={refreshingModels()}
                                onClick={handleRefreshModels}
                                style="display: inline-flex; align-items: center; gap: 6px;"
                              >
                                {refreshingModels() ? 'Refreshing...' : 'Refresh models'}
                              </button>
                            </Show>
                          </div>

                          {/* Connection info */}
                          <div style="padding: 12px 0; border-top: 1px solid hsl(var(--border)); font-size: var(--font-size-sm); color: hsl(var(--muted-foreground));">
                            Connected via{' '}
                            {c.auth_type === 'subscription'
                              ? c.auth_type
                              : c.auth_type === 'api_key'
                                ? 'API key'
                                : 'local server'}
                          </div>

                          {/* Actions */}
                          <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 16px; border-top: 1px solid hsl(var(--border));">
                            <button class="btn btn--danger btn--sm" onClick={handleDisconnect}>
                              Disconnect
                            </button>
                            <button class="btn btn--outline btn--sm" onClick={closeManageModal}>
                              Done
                            </button>
                          </div>
                        </Show>

                        <Show when={!c.is_active}>
                          <Show
                            when={showDeleteConfirm()}
                            fallback={
                              <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 1px solid hsl(var(--border));">
                                <button class="btn btn--danger btn--sm" onClick={openDeleteConfirm}>
                                  Delete
                                </button>
                                <button class="btn btn--outline btn--sm" onClick={closeManageModal}>
                                  Close
                                </button>
                              </div>
                            }
                          >
                            <div
                              class="connection-delete-confirmation"
                              role="alertdialog"
                              aria-labelledby="delete-connection-confirm-title"
                              aria-describedby="delete-connection-confirm-copy"
                            >
                              <div class="connection-delete-confirmation__warning">
                                <h3
                                  id="delete-connection-confirm-title"
                                  class="connection-delete-confirmation__title"
                                >
                                  Delete usage history?
                                </h3>
                                <p
                                  id="delete-connection-confirm-copy"
                                  class="connection-delete-confirmation__copy"
                                >
                                  This will permanently delete this inactive connection and its
                                  usage history. This action cannot be undone.
                                </p>
                              </div>
                              <label
                                for="delete-connection-confirm-input"
                                class="connection-delete-confirmation__label"
                              >
                                Type the connection name to confirm
                              </label>
                              <input
                                id="delete-connection-confirm-input"
                                class="provider-detail__input"
                                type="text"
                                value={deleteConfirmName()}
                                onInput={(e) => setDeleteConfirmName(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && deleteConfirmMatches()) {
                                    handleDisconnect();
                                  }
                                }}
                                placeholder={c.label}
                              />
                              <div class="connection-delete-confirmation__footer">
                                <button
                                  class="btn btn--outline btn--sm"
                                  onClick={closeDeleteConfirm}
                                  disabled={deletingConnection()}
                                >
                                  Cancel
                                </button>
                                <button
                                  class="btn btn--danger btn--sm"
                                  onClick={handleDisconnect}
                                  disabled={!deleteConfirmMatches() || deletingConnection()}
                                >
                                  {deletingConnection() ? 'Deleting...' : 'Delete connection'}
                                </button>
                              </div>
                            </div>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  }
                >
                  {/* Custom provider edit modal */}
                  <div
                    class="modal-overlay"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) closeManageModal();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') closeManageModal();
                    }}
                  >
                    <div
                      class="modal-card routing-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-label="Edit custom provider"
                      style="max-width: 600px; max-height: 85vh; overflow-y: auto;"
                    >
                      <CustomProviderForm
                        agentName={firstAgentName()}
                        initialData={customProviderData()!}
                        onCreated={() => {
                          closeManageModal();
                          refetchDetail();
                        }}
                        onBack={closeManageModal}
                        onDeleted={() => {
                          closeManageModal();
                          navigate(backLink());
                        }}
                      />
                    </div>
                  </div>
                </Show>
              </Show>
            </>
          );
        })()}
      </Show>
    </div>
  );
};

export default ConnectionDetail;
