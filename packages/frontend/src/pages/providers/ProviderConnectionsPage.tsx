import { Title } from '@solidjs/meta';
import { useNavigate, useSearchParams } from '@solidjs/router';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from 'solid-js';
import {
  getAgents,
  getCustomProviders,
  getProviders as getAgentProviders,
} from '../../services/api.js';
import {
  getProviders as getGlobalProviders,
  getProviderUsage,
  mergeUsage,
  connectionUsage,
  type TenantProviderSummary,
  type TenantProviderConnection,
} from '../../services/api/providers.js';
import { analyticsPing, routingPing } from '../../services/sse.js';
import { toggleScrollFade } from '../../services/scroll-fade.js';
import { renameProviderKey } from '../../services/api/routing.js';
import type { AuthType, CustomProviderData, RoutingProvider } from '../../services/api.js';
import type { CustomProviderPrefill, ProviderDeepLink } from '../../services/routing-params.js';
import { PROVIDERS, type ProviderDef } from '../../services/providers.js';
import {
  customProviderColor,
  formatCost,
  formatNumber,
  formatTimeAgo,
} from '../../services/formatters.js';
import InfoTooltip from '../../components/InfoTooltip.jsx';
import { providerIcon } from '../../components/ProviderIcon.jsx';
import { toast } from '../../services/toast-store.js';
import ProviderSelectModal from '../../components/ProviderSelectModal.jsx';
import CustomProviderForm from '../../components/CustomProviderForm.jsx';
import Sparkline from '../../components/Sparkline.jsx';
import {
  attemptSuccessRate,
  totalAttemptsTooltip,
  CONNECTION_SUCCESS_RATE_TOOLTIP_30D,
} from '../../services/api/analytics.js';
import '../../styles/routing.css';
import '../../styles/analytics-overview.css';

type ProviderPageKind = 'subscriptions' | 'byok' | 'local';
type ViewMode = 'list' | 'grid';

interface ProviderConnectionsPageProps {
  kind: ProviderPageKind;
}

interface AgentRow {
  agent_name: string;
}

const PAGE_COPY: Record<
  ProviderPageKind,
  {
    title: string;
    heading: string;
    subtitle: string;
    addLabel: string;
    customAddLabel?: string;
    connectedHeading: string;
    supportedHeading: string;
    authType: AuthType;
    /** Cost metric (stat card + per-row column) — BYOK only. Subscriptions and
     *  local providers have no real cost figure to show. */
    metricLabel?: string;
    metricTooltip?: string;
    rowMetricHeading?: string;
    activeSingular: string;
    activePlural: string;
  }
> = {
  subscriptions: {
    title: 'Subscriptions | Manifest',
    heading: 'Subscriptions',
    subtitle: 'Use your current plans with any supported provider.',
    addLabel: 'Connect',
    connectedHeading: 'My subscription connections',
    supportedHeading: 'Supported subscription providers',
    authType: 'subscription',
    activeSingular: 'connection',
    activePlural: 'connections',
  },
  byok: {
    title: 'Usage-based | Manifest',
    heading: 'Usage-based',
    subtitle: 'Connect providers you pay per token or per usage with your own API keys.',
    addLabel: 'Connect',
    customAddLabel: 'Add custom provider',
    connectedHeading: 'My usage-based connections',
    supportedHeading: 'Supported usage-based providers',
    authType: 'api_key',
    metricLabel: 'Total API cost (30d)',
    metricTooltip: 'Sum of all API key usage costs across your connected providers.',
    rowMetricHeading: 'Cost (30d)',
    activeSingular: 'key',
    activePlural: 'keys',
  },
  local: {
    title: 'Local | Manifest',
    heading: 'Local',
    subtitle: 'Connect to LLM servers running on your machine.',
    addLabel: 'Connect',
    connectedHeading: 'My local connections',
    supportedHeading: 'Supported local providers',
    authType: 'local',
    activeSingular: 'connection',
    activePlural: 'connections',
  },
};

const CONNECTIONS_COLLAPSE_THRESHOLD = 6;

const providerListForKind = (kind: ProviderPageKind): ProviderDef[] => {
  if (kind === 'subscriptions')
    return PROVIDERS.filter((provider) => provider.supportsSubscription);
  if (kind === 'local') return PROVIDERS.filter((provider) => provider.localOnly);
  return PROVIDERS.filter((provider) => !provider.subscriptionOnly && !provider.localOnly);
};

const standardProviderName = (providerId: string): string | null =>
  PROVIDERS.find((provider) => provider.id === providerId)?.name ?? null;

const customProviderName = (
  providerId: string,
  customProviders: readonly CustomProviderData[],
): string | null => {
  if (!providerId.startsWith('custom:')) return null;
  const id = providerId.slice('custom:'.length);
  return customProviders.find((provider) => provider.id === id)?.name ?? null;
};

const providerDisplayName = (
  providerId: string,
  customProviders: readonly CustomProviderData[],
): string =>
  customProviderName(providerId, customProviders) ?? standardProviderName(providerId) ?? providerId;

/** Shimmer placeholder shown in usage cells while the usage fetch is in flight. */
const UsageShimmer: Component<{ width?: number }> = (props) => (
  <span
    aria-hidden="true"
    style={{
      display: 'inline-block',
      width: `${props.width ?? 56}px`,
      height: '12px',
      'border-radius': 'var(--radius-sm)',
      background: 'hsl(var(--muted) / 0.6)',
      animation: 'skeleton-pulse 1.2s ease-in-out infinite',
      'vertical-align': 'middle',
    }}
  />
);

const StatusBadge: Component<{ active: boolean }> = (props) => (
  <Show
    when={props.active}
    fallback={
      <span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); background: hsl(var(--muted)); color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs); font-weight: 500;">
        Inactive
      </span>
    }
  >
    <span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); background: hsl(var(--success)); color: white; font-size: var(--font-size-xs); font-weight: 600;">
      Active
    </span>
  </Show>
);

/**
 * An upstream 401 means this connection's token/API key was rejected. Routing
 * skips it until it is reconnected, so make that state visible instead of
 * leaving the connection looking "Active".
 */
const ReauthBadge: Component<{ failure?: TenantProviderConnection['last_auth_failure'] }> = (
  props,
) => (
  <span
    title={
      props.failure
        ? `Upstream rejected this credential (HTTP ${props.failure.statusCode}). Reconnect it to resume routing.`
        : 'Upstream rejected this credential. Reconnect it to resume routing.'
    }
    style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); background: hsl(var(--warning)); color: white; font-size: var(--font-size-xs); font-weight: 600;"
  >
    Needs re-auth
  </span>
);

const ProviderMark: Component<{ providerId: string; name: string; size?: number }> = (props) => {
  const size = () => props.size ?? 20;
  return (
    <Show
      when={providerIcon(props.providerId, size())}
      fallback={
        <span
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            'justify-content': 'center',
            width: `${size()}px`,
            height: `${size()}px`,
            'border-radius': '4px',
            'font-size': size() > 20 ? '12px' : '11px',
            'font-weight': '600',
            color: 'white',
            background: customProviderColor(props.name || props.providerId),
          }}
        >
          {(props.name || props.providerId).charAt(0).toUpperCase()}
        </span>
      }
    >
      <span style={`display: flex; align-items: center; width: ${size()}px; height: ${size()}px;`}>
        {providerIcon(props.providerId, size())}
      </span>
    </Show>
  );
};

const ListIcon: Component = () => (
  <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z" />
  </svg>
);

const GridIcon: Component = () => (
  <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  </svg>
);

const ProviderConnectionsPage: Component<ProviderConnectionsPageProps> = (props) => {
  const copy = () => PAGE_COPY[props.kind];
  const navigate = useNavigate();
  const [showModal, setShowModal] = createSignal(false);
  const [showCustomModal, setShowCustomModal] = createSignal(false);
  const [deepLink, setDeepLink] = createSignal<ProviderDeepLink | null>(null);
  const [customProviderPrefill, setCustomProviderPrefill] =
    createSignal<CustomProviderPrefill | null>(null);
  const [viewMode, setViewMode] = createSignal<ViewMode>('grid');
  // Past this many connections the list is capped inside its own card, so the
  // supported-provider catalog below stays reachable without a long scroll.
  const [connectionsExpanded, setConnectionsExpanded] = createSignal(false);
  const connectionsCollapsible = () => connectedRows().length > CONNECTIONS_COLLAPSE_THRESHOLD;
  const connectionsCollapsed = () => connectionsCollapsible() && !connectionsExpanded();
  let connectionsScroller: HTMLDivElement | undefined;
  const toggleConnections = () => {
    setConnectionsExpanded((open) => !open);
    // Expanding takes the cap off, which drops the scroll position. The
    // at-bottom flag from before it would otherwise survive into the next
    // collapse and keep the fade hidden at the top of the list.
    if (connectionsScroller) {
      connectionsScroller.scrollTop = 0;
      connectionsScroller.parentElement?.classList.remove('scroll-panel--at-bottom');
    }
  };
  const [searchParams, setSearchParams] = useSearchParams();

  // Inline rename state
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [renameError, setRenameError] = createSignal('');
  const [renameBusy, setRenameBusy] = createSignal(false);

  const startRename = (connectionId: string, currentLabel: string, e: Event) => {
    e.stopPropagation();
    setRenamingId(connectionId);
    setRenameValue(currentLabel);
    setRenameError('');
  };

  const cancelRename = (e?: Event) => {
    e?.stopPropagation();
    setRenamingId(null);
    setRenameError('');
  };

  const submitRename = async (
    provider: string,
    currentLabel: string,
    authType: string,
    e?: Event,
  ) => {
    e?.stopPropagation();
    const newLabel = renameValue().trim();
    if (!newLabel) {
      setRenameError('Name cannot be empty');
      return;
    }
    if (newLabel === currentLabel) {
      cancelRename();
      return;
    }
    if (!firstAgentName()) return;
    setRenameBusy(true);
    setRenameError('');
    try {
      await renameProviderKey(
        firstAgentName(),
        provider,
        currentLabel,
        newLabel,
        authType as AuthType,
      );
      toast.success('Connection renamed');
      setRenamingId(null);
      refetchGlobalProviders();
    } catch (err: any) {
      setRenameError(err?.message ?? 'Failed to rename');
    } finally {
      setRenameBusy(false);
    }
  };

  // CONFIG resource — paints the page immediately (cheap endpoint, no
  // agent_messages scan).
  const [config, { refetch: refetchConfig }] = createResource(async () => {
    try {
      return await getGlobalProviders();
    } catch {
      return { providers: [], model_counts: {} };
    }
  });

  // USAGE resource — the expensive 30d aggregation, fetched independently. Its
  // source includes the SSE ping signals so coalesced message activity
  // (analyticsPing) or a provider connect/disconnect/rename (routingPing)
  // re-runs the usage fetch.
  const [usage, { refetch: refetchUsage }] = createResource(
    () => ({ m: analyticsPing(), r: routingPing() }),
    async () => {
      try {
        return (await getProviderUsage()).providers;
      } catch {
        return [];
      }
    },
  );

  // Distinguish "loading" (shimmer the usage cells) from "loaded-zero" (a real
  // 0). Only the FIRST load shimmers; SSE-driven refetches keep the prior
  // numbers on screen (usage() stays defined) so the table doesn't flicker.
  const usageLoading = () => usage.loading && usage() === undefined;

  // Coordinate a usage refetch alongside config on connect/disconnect/rename.
  const refetchGlobalProviders = () => {
    void refetchConfig();
    void refetchUsage();
  };

  // Merge config + usage by (provider, auth_type). While usage is still loading
  // every row carries zeroed usage; `usageLoading()` tells the view to shimmer
  // instead of rendering those zeros.
  const data = () => ({
    providers: mergeUsage(config()?.providers ?? [], usage()),
    model_counts: config()?.model_counts ?? {},
  });

  const [agents] = createResource(async () => {
    try {
      const result = (await getAgents()) as { agents?: AgentRow[] } | AgentRow[];
      return Array.isArray(result) ? result : (result.agents ?? []);
    } catch {
      return [];
    }
  });

  const firstAgentName = () => agents()?.[0]?.agent_name ?? '';

  const [modalProviders, { refetch: refetchModalProviders }] = createResource(
    () => firstAgentName(),
    async (agentName): Promise<RoutingProvider[]> => {
      if (!agentName) return [];
      try {
        return await getAgentProviders(agentName);
      } catch {
        return [];
      }
    },
  );

  const [customProviders, { refetch: refetchCustomProviders }] = createResource(
    () => firstAgentName(),
    async (agentName): Promise<CustomProviderData[]> => {
      if (!agentName) return [];
      try {
        return await getCustomProviders(agentName);
      } catch {
        return [];
      }
    },
  );

  const connectedSummaries = () =>
    (data()?.providers ?? []).filter((provider) => provider.auth_type === copy().authType);

  const hasUsage = (summary: TenantProviderSummary) =>
    summary.consumption_tokens > 0 || summary.consumption_messages > 0;

  const connectedRows = () => {
    const rows: Array<{
      summary: TenantProviderSummary;
      connection: TenantProviderSummary['connections'][number];
      name: string;
    }> = [];
    for (const summary of connectedSummaries()) {
      for (const connection of summary.connections) {
        if (!connection.is_active && props.kind !== 'subscriptions' && !hasUsage(summary)) continue;
        rows.push({
          summary,
          connection,
          name: providerDisplayName(summary.provider, customProviders() ?? []),
        });
      }
    }
    return rows;
  };

  const connectedByProvider = () => {
    const map = new Map<string, TenantProviderSummary>();
    for (const summary of connectedSummaries()) map.set(summary.provider, summary);
    return map;
  };

  const activeConnectionCount = (providerId: string) =>
    connectedByProvider()
      .get(providerId)
      ?.connections.filter((connection) => connection.is_active).length ?? 0;

  const totalApiCost = createMemo(() =>
    connectedSummaries().reduce((sum, summary) => sum + summary.consumption_cost, 0),
  );

  // Attempt-world totals for the header cards: summed over THIS page's rows
  // (provider + auth_type grain), so the Subscriptions page never blends an
  // api_key connection's failures into its numbers, and vice versa.
  const totalAttempts = createMemo(() =>
    connectedSummaries().reduce((sum, s) => sum + s.attempts_30d, 0),
  );
  const totalAttemptsSucceeded = createMemo(() =>
    connectedSummaries().reduce((sum, s) => sum + s.succeeded_30d, 0),
  );

  const connectionDenominator = (summary: TenantProviderSummary) =>
    Math.max(
      summary.connections.filter((connection) => connection.is_active || hasUsage(summary)).length,
      summary.connection_count,
      1,
    );

  // Per-connection usage at the (provider, auth_type, label) grain: two
  // connections of the same provider and type never share numbers. Falls back
  // to the group's even split only while the label rows are missing.
  const usageForConnection = (
    summary: TenantProviderSummary,
    connection: { label?: string | null },
  ) => connectionUsage(usage(), summary.provider, summary.auth_type, connection.label);

  const perConnectionTokens = (
    summary: TenantProviderSummary,
    connection: { label?: string | null },
  ) =>
    usageForConnection(summary, connection)?.consumption_tokens ??
    Math.round(summary.consumption_tokens / connectionDenominator(summary));

  const perConnectionCost = (
    summary: TenantProviderSummary,
    connection: { label?: string | null },
  ) =>
    usageForConnection(summary, connection)?.consumption_cost ??
    summary.consumption_cost / connectionDenominator(summary);

  const connectionLastUsedAt = (
    summary: TenantProviderSummary,
    connection: { label?: string | null },
  ) =>
    usageForConnection(summary, connection)?.last_used_at ??
    (summary.connections.length === 1 ? summary.last_used_at : null);

  const showMetricCard = () =>
    !!copy().metricLabel && (connectedRows().length > 0 || totalApiCost() > 0);

  const activeLabel = (count: number) => {
    if (props.kind === 'local') return 'Connected';
    return `${count} active ${count === 1 ? copy().activeSingular : copy().activePlural}`;
  };

  const openModal = (providerId?: string) => {
    setCustomProviderPrefill(null);
    // Deep-link with the page's auth type so the connection form opens in the
    // matching mode (e.g. the Subscriptions page opens the OAuth/subscription
    // flow rather than the API-key form for providers that support both).
    setDeepLink(providerId ? { providerId, authType: copy().authType } : null);
    void refetchModalProviders();
    setShowModal(true);
  };

  // Deep-link support: visiting a provider page with ?add=true auto-opens the
  // connect modal so onboarding surfaces can route a user straight into adding
  // a provider. React on every navigation (not just initial mount) and clear the
  // param (replace) so a refresh or back-nav doesn't re-trigger it. Runs in an
  // effect — never the render body — so the param write/modal open stay reactive
  // side effects rather than firing during render.
  createEffect(() => {
    if (searchParams.add === 'true') {
      setSearchParams({ add: undefined }, { replace: true });
      openModal();
    }
  });

  const openCustomProvider = () => {
    setShowCustomModal(true);
  };

  const handleCustomModalClose = () => {
    setShowCustomModal(false);
    void refetchGlobalProviders();
    void refetchCustomProviders();
  };

  const handleModalClose = () => {
    setShowModal(false);
    setDeepLink(null);
    setCustomProviderPrefill(null);
    void refetchGlobalProviders();
  };

  const handleModalUpdate = async () => {
    await Promise.all([
      refetchModalProviders(),
      refetchGlobalProviders(),
      refetchCustomProviders(),
    ]);
  };

  return (
    <div class="container--lg">
      <Title>{copy().title}</Title>
      <div class="page-header" style="border-bottom: none; padding-bottom: 0;">
        <div>
          <h1 class="page-header__title">{copy().heading}</h1>
          <p class="page-header__subtitle">{copy().subtitle}</p>
        </div>
        <Show when={copy().customAddLabel}>
          <button
            class="btn btn--outline btn--sm"
            onClick={() => openCustomProvider()}
            style="display: inline-flex; align-items: center; gap: 6px;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M7 11h10c.37 0 .72-.21.89-.54s.14-.73-.08-1.04l-5-7c-.38-.53-1.25-.53-1.63 0l-5 7A.997.997 0 0 0 6.99 11Zm5-6.28L15.06 9H8.95l3.06-4.28ZM17.5 13c-2.48 0-4.5 2.02-4.5 4.5s2.02 4.5 4.5 4.5 4.5-2.02 4.5-4.5-2.02-4.5-4.5-4.5m0 7a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5M3 22h7c.55 0 1-.45 1-1v-7c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v7c0 .55.45 1 1 1m1-7h5v5H4z" />
            </svg>
            {copy().customAddLabel}
          </button>
        </Show>
      </div>

      <Show when={connectedRows().length > 0}>
        <div
          class="overview-stats"
          classList={{ 'overview-stats--3': !showMetricCard() }}
          style="margin-bottom: 24px;"
        >
          <Show when={showMetricCard()}>
            <div class="overview-stat-card">
              <span class="overview-stat-card__label">Total API cost (30d)</span>
              <div class="overview-stat-card__value-row">
                <Show when={!usageLoading()} fallback={<UsageShimmer width={72} />}>
                  <span class="overview-stat-card__value">
                    {formatCost(totalApiCost()) ?? '$0.00'}
                  </span>
                </Show>
              </div>
            </div>
          </Show>
          <div class="overview-stat-card">
            <span class="overview-stat-card__label">
              Total attempts (30d)
              <InfoTooltip text={totalAttemptsTooltip(true)} />
            </span>
            <div class="overview-stat-card__value-row">
              <span class="overview-stat-card__value">{formatNumber(totalAttempts())}</span>
            </div>
          </div>
          <div class="overview-stat-card">
            <span class="overview-stat-card__label">
              Success rate (30d)
              <InfoTooltip text={CONNECTION_SUCCESS_RATE_TOOLTIP_30D} />
            </span>
            <div class="overview-stat-card__value-row">
              <span class="overview-stat-card__value">
                {(() => {
                  const rate = attemptSuccessRate({
                    attempts: totalAttempts(),
                    succeeded: totalAttemptsSucceeded(),
                  });
                  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
                })()}
              </span>
            </div>
          </div>
        </div>
      </Show>

      <Show when={connectedRows().length > 0}>
        <h3 style="font-size: var(--font-size-base); font-weight: 600; color: hsl(var(--foreground)); margin-bottom: 12px;">
          {copy().connectedHeading}
        </h3>
        <div
          class="panel connections-panel"
          classList={{ 'connections-panel--collapsed': connectionsCollapsed() }}
          style="padding: 0; margin-bottom: 24px;"
        >
          <div class="connections-panel__viewport">
            <div
              class="connections-panel__body"
              id="connected-connections"
              ref={connectionsScroller}
              onScroll={toggleScrollFade}
            >
              <table class="data-table" style="width: 100%;">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Connection</th>
                    <th>Status</th>
                    <th>Usage (30d)</th>
                    <Show when={copy().rowMetricHeading}>
                      <th>{copy().rowMetricHeading}</th>
                    </Show>
                    <th class="rel-col">
                      Total attempts (30d)
                      <InfoTooltip text={totalAttemptsTooltip(true)} />
                    </th>
                    <th class="rel-col">
                      Success rate (30d)
                      <InfoTooltip text={CONNECTION_SUCCESS_RATE_TOOLTIP_30D} />
                    </th>
                    <th>Last used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={connectedRows()}>
                    {(row) => (
                      <tr
                        style="cursor: pointer;"
                        onClick={() => navigate(`/providers/connections/${row.connection.id}`)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            navigate(`/providers/connections/${row.connection.id}`);
                          }
                        }}
                        tabindex="0"
                      >
                        <td>
                          <span style="display: flex; align-items: center; gap: 10px;">
                            <ProviderMark providerId={row.summary.provider} name={row.name} />
                            <span style="font-weight: 500;">{row.name}</span>
                            <Show when={row.summary.provider.startsWith('custom:')}>
                              <span style="display: inline-flex; padding: 1px 6px; border-radius: var(--radius-sm); border: 1px solid hsl(var(--border)); font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                                Custom
                              </span>
                            </Show>
                          </span>
                        </td>
                        <td
                          style="color: hsl(var(--muted-foreground));"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Show
                            when={renamingId() === row.connection.id}
                            fallback={
                              <span
                                style="display: inline-flex; align-items: center; gap: 6px; cursor: default;"
                                class="connection-label-cell"
                              >
                                {row.connection.label}
                                <button
                                  type="button"
                                  class="connection-label-cell__edit"
                                  onClick={(e) =>
                                    startRename(row.connection.id, row.connection.label, e)
                                  }
                                  aria-label={`Rename ${row.connection.label}`}
                                  style="background: none; border: none; cursor: pointer; padding: 2px; color: hsl(var(--muted-foreground)); opacity: 0; transition: opacity 0.15s; display: inline-flex; align-items: center; line-height: 1;"
                                >
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                  >
                                    <path d="M5 21h14c1.1 0 2-.9 2-2v-7h-2v7H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2" />
                                    <path d="M7 13v3c0 .55.45 1 1 1h3c.27 0 .52-.11.71-.29l9-9a.996.996 0 0 0 0-1.41l-3-3a.996.996 0 0 0-1.41 0l-9.01 8.99A1 1 0 0 0 7 13m10-7.59L18.59 7 17.5 8.09 15.91 6.5zm-8 8 5.5-5.5 1.59 1.59-5.5 5.5H9z" />
                                  </svg>
                                </button>
                              </span>
                            }
                          >
                            <div style="display: flex; align-items: center; gap: 6px;">
                              <input
                                type="text"
                                class={`provider-detail__input${renameError() ? ' provider-detail__input--error' : ''}`}
                                value={renameValue()}
                                onInput={(e) => {
                                  setRenameValue(e.currentTarget.value);
                                  setRenameError('');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter')
                                    submitRename(
                                      row.summary.provider,
                                      row.connection.label,
                                      row.summary.auth_type ?? copy().authType,
                                      e,
                                    );
                                  if (e.key === 'Escape') cancelRename(e);
                                }}
                                style="width: 120px;"
                                ref={(el) => requestAnimationFrame(() => el.focus())}
                              />
                              <button
                                class="btn btn--primary btn--sm"
                                style="font-size: var(--font-size-xs); padding: 4px 10px;"
                                disabled={renameBusy()}
                                onClick={(e) =>
                                  submitRename(
                                    row.summary.provider,
                                    row.connection.label,
                                    row.summary.auth_type ?? copy().authType,
                                    e,
                                  )
                                }
                              >
                                Save
                              </button>
                              <button
                                class="btn btn--outline btn--sm"
                                style="font-size: var(--font-size-xs); padding: 4px 10px;"
                                onClick={cancelRename}
                              >
                                Cancel
                              </button>
                            </div>
                            <Show when={renameError()}>
                              <div style="color: hsl(var(--destructive)); font-size: var(--font-size-xs); margin-top: 2px;">
                                {renameError()}
                              </div>
                            </Show>
                          </Show>
                        </td>
                        <td>
                          <span style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <StatusBadge active={row.connection.is_active} />
                            <Show when={row.connection.requires_reauth}>
                              <ReauthBadge failure={row.connection.last_auth_failure} />
                            </Show>
                          </span>
                        </td>
                        <td>
                          <Show when={!usageLoading()} fallback={<UsageShimmer width={96} />}>
                            <div style="display: flex; align-items: center; gap: 8px;">
                              {(() => {
                                const u = usageForConnection(row.summary, row.connection);
                                const spark = u?.sparkline_7d ?? row.summary.sparkline_7d;
                                return (
                                  <>
                                    <Show when={spark?.length}>
                                      <span style="flex-shrink: 0;">
                                        <Sparkline data={spark} width={60} height={20} />
                                      </span>
                                    </Show>
                                    <span>
                                      {formatNumber(
                                        perConnectionTokens(row.summary, row.connection),
                                      )}{' '}
                                      tokens
                                    </span>
                                  </>
                                );
                              })()}
                            </div>
                          </Show>
                        </td>
                        <Show when={copy().rowMetricHeading}>
                          <td>
                            <Show when={!usageLoading()} fallback={<UsageShimmer />}>
                              {formatCost(perConnectionCost(row.summary, row.connection)) ??
                                '$0.00'}
                            </Show>
                          </td>
                        </Show>
                        {/* Attempt reliability at the row's own grain (provider +
                        auth_type): a subscription row never shows a rate
                        blended with the provider's api_key traffic. */}
                        <td class="rel-col">
                          <Show when={!usageLoading()} fallback={<UsageShimmer width={48} />}>
                            {formatNumber(
                              usageForConnection(row.summary, row.connection)?.attempts_30d ??
                                row.summary.attempts_30d,
                            )}
                          </Show>
                        </td>
                        <td class="rel-col">
                          <Show when={!usageLoading()} fallback={<UsageShimmer width={48} />}>
                            {(() => {
                              const u = usageForConnection(row.summary, row.connection);
                              const rate = attemptSuccessRate({
                                attempts: u?.attempts_30d ?? row.summary.attempts_30d,
                                succeeded: u?.succeeded_30d ?? row.summary.succeeded_30d,
                              });
                              return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
                            })()}
                          </Show>
                        </td>
                        <td style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-xs);">
                          <Show when={!usageLoading()} fallback={<UsageShimmer width={48} />}>
                            {connectionLastUsedAt(row.summary, row.connection)
                              ? formatTimeAgo(connectionLastUsedAt(row.summary, row.connection)!)
                              : '-'}
                          </Show>
                        </td>
                        <td style="text-align: right;">
                          <button
                            class="btn btn--outline btn--sm"
                            style="font-size: var(--font-size-xs); white-space: nowrap;"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(`/providers/connections/${row.connection.id}`);
                            }}
                          >
                            View details
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
          <Show when={connectionsCollapsible()}>
            <button
              type="button"
              class="connections-panel__toggle"
              aria-expanded={connectionsExpanded()}
              aria-controls="connected-connections"
              onClick={toggleConnections}
            >
              <Show
                when={connectionsExpanded()}
                fallback={`Show all ${connectedRows().length} connections`}
              >
                Show less
              </Show>
              <svg
                class="connections-panel__chevron"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>

      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px;">
        <h3 style="font-size: var(--font-size-base); font-weight: 600; color: hsl(var(--foreground)); margin: 0;">
          {copy().supportedHeading}
        </h3>
        <div class="panel__tabs" role="tablist" style="height: 30px;">
          <button
            role="tab"
            aria-selected={viewMode() === 'grid'}
            class="panel__tab"
            classList={{ 'panel__tab--active': viewMode() === 'grid' }}
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            style="padding: 0 8px;"
          >
            <GridIcon />
          </button>
          <button
            role="tab"
            aria-selected={viewMode() === 'list'}
            class="panel__tab"
            classList={{ 'panel__tab--active': viewMode() === 'list' }}
            onClick={() => setViewMode('list')}
            aria-label="List view"
            style="padding: 0 8px;"
          >
            <ListIcon />
          </button>
        </div>
      </div>

      <Show when={viewMode() === 'list'}>
        <div class="panel" style="padding: 0; overflow-x: auto;">
          <table class="data-table" style="width: 100%;">
            <thead>
              <tr>
                <th>Provider</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={providerListForKind(props.kind)}>
                {(provider) => {
                  const activeCount = () => activeConnectionCount(provider.id);
                  return (
                    <tr>
                      <td>
                        <span style="display: flex; align-items: center; gap: 10px;">
                          <ProviderMark providerId={provider.id} name={provider.name} />
                          <span style="font-weight: 500;">{provider.name}</span>
                        </span>
                      </td>
                      <td style="text-align: right;">
                        <span style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px;">
                          <Show when={activeCount() > 0}>
                            <span style="color: hsl(var(--success)); font-size: var(--font-size-xs); font-weight: 500; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;">
                              <svg
                                width="8"
                                height="8"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14" />
                              </svg>
                              {activeLabel(activeCount())}
                            </span>
                          </Show>
                          <button
                            class="btn btn--outline btn--sm"
                            disabled={!firstAgentName()}
                            style="white-space: nowrap;"
                            onClick={() => openModal(provider.id)}
                          >
                            {copy().addLabel}
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={viewMode() === 'grid'}>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;">
          <For each={providerListForKind(props.kind)}>
            {(provider) => {
              const activeCount = () => activeConnectionCount(provider.id);
              return (
                <div
                  class="panel"
                  style="padding: 16px; display: flex; flex-direction: column; gap: 12px; margin-bottom: 0;"
                >
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                      <ProviderMark providerId={provider.id} name={provider.name} size={24} />
                      <span style="font-weight: 600; font-size: var(--font-size-sm); color: hsl(var(--foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {provider.name}
                      </span>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                    <Show when={activeCount() > 0} fallback={<span />}>
                      <span style="color: hsl(var(--success)); font-size: var(--font-size-xs); font-weight: 500; display: inline-flex; align-items: center; gap: 4px;">
                        <svg
                          width="8"
                          height="8"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14" />
                        </svg>
                        {activeLabel(activeCount())}
                      </span>
                    </Show>
                    <button
                      class="btn btn--outline btn--sm"
                      disabled={!firstAgentName()}
                      style="font-size: var(--font-size-xs); white-space: nowrap;"
                      onClick={() => openModal(provider.id)}
                    >
                      {copy().addLabel}
                    </button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={showModal() && firstAgentName()}>
        <ProviderSelectModal
          agentName={firstAgentName()}
          providers={modalProviders() ?? []}
          customProviders={customProviders() ?? []}
          customProviderPrefill={customProviderPrefill()}
          providerDeepLink={deepLink()}
          initialTab={copy().authType}
          onUpdate={handleModalUpdate}
          onClose={handleModalClose}
        />
      </Show>

      <Show when={showCustomModal() && firstAgentName()}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCustomModalClose();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleCustomModalClose();
          }}
        >
          <div
            class="modal-card routing-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add custom provider"
            style="max-width: 600px; max-height: 85vh; overflow-y: auto;"
          >
            <CustomProviderForm
              agentName={firstAgentName()}
              onCreated={handleCustomModalClose}
              onBack={() => handleCustomModalClose()}
            />
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ProviderConnectionsPage;
