import { Meta, Title } from '@solidjs/meta';
import { A, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Component,
} from 'solid-js';
import ErrorState from '../components/ErrorState.jsx';
import MessageTable from '../components/MessageTable.jsx';
import RequestDrawer from '../components/RequestDrawer.jsx';
import Pagination from '../components/Pagination.jsx';
import Select from '../components/Select.jsx';
import MultiSelect, { type MultiSelectOption } from '../components/MultiSelect.jsx';
import { getProviders as getProviderConnections } from '../services/api/providers.js';
import SetupModal from '../components/SetupModal.jsx';
import { DETAILED_COLUMNS, type MessageRow } from '../components/message-table-types.js';
import { AutofixIcon, FallbackIcon } from '../components/message-table-cells.jsx';
import { agentDisplayName } from '../services/agent-display-name.js';
import { agentPlatform, agentCategory } from '../services/agent-platform-store.js';
import {
  getAgents,
  getSpecificityAssignments,
  getMessageCount,
  getMessages,
  getMessageFilterOptions,
  getRoutingStatus,
} from '../services/api.js';
import { createCursorPagination } from '../services/cursor-pagination.js';
import { usePlanRangeLock } from '../services/plan-range-lock.js';
import { getModelDisplayName, preloadModelDisplayNames } from '../services/model-display.js';
import { PROVIDERS, SPECIFICITY_STAGES } from '../services/providers.js';
import { providerIcon } from '../components/ProviderIcon.jsx';
import { platformIcon } from 'manifest-shared';
import { ALL_TIERS, TIER_LABELS_ALL } from 'manifest-shared';
import { analyticsPing, messagePing } from '../services/sse.js';
import '../styles/overview.css';
import '../styles/routing.css';
// The filtered-empty state here reuses .model-filter__empty classes, so this
// route imports model-filter.css directly (also imported by ModelPrices).
import '../styles/model-filter.css';

interface MessagesData {
  items: MessageRow[];
  next_cursor: string | null;
  total_count: number;
  total_count_exact?: boolean;
  providers: string[];
  provider_labels?: Record<string, string>;
}

interface HeaderTierFilterOption {
  name: string;
  /** Every custom-tier id this option covers — same name on several harnesses. */
  ids: string[];
}

interface MessageFilterOptionsData {
  providers: string[];
  provider_labels?: Record<string, string>;
  header_tiers?: HeaderTierFilterOption[];
  /** Every model this tenant has used in range — the Model filter's options. */
  models?: string[];
}

interface AgentFilterOption {
  agent_name: string;
  agent_platform?: string | null;
  agent_category?: string | null;
}

const SPECIFICITY_FILTER_PREFIX = 'specificity:';
const HEADER_TIER_FILTER_PREFIX = 'header:';
const MESSAGE_STATUS_FILTERS = ['ok', 'failed', 'cancelled'] as const;
type MessageStatusFilter = (typeof MESSAGE_STATUS_FILTERS)[number];
type MessageStatusFilterValue = '' | MessageStatusFilter;
const MESSAGE_TRIGGER_FILTERS = ['none', 'fallback', 'autofix'] as const;
type MessageTriggerFilter = (typeof MESSAGE_TRIGGER_FILTERS)[number];

const isMessageStatusFilter = (value: unknown): value is MessageStatusFilter =>
  typeof value === 'string' && (MESSAGE_STATUS_FILTERS as readonly string[]).includes(value);

const normalizeStatusFilter = (value: unknown): MessageStatusFilterValue =>
  isMessageStatusFilter(value) ? value : '';

const MESSAGE_RANGE_FILTERS = ['24h', '7d', '30d', '90d', '365d'] as const;
type MessageRangeFilter = (typeof MESSAGE_RANGE_FILTERS)[number];
type MessageRangeFilterValue = '' | MessageRangeFilter;
// Same Pro gating as the Overview range selector: long windows are paid.
const PRO_RANGES = new Set(['30d', '90d', '365d']);

const isMessageRangeFilter = (value: unknown): value is MessageRangeFilter =>
  typeof value === 'string' && (MESSAGE_RANGE_FILTERS as readonly string[]).includes(value);

const normalizeRangeFilter = (value: unknown): MessageRangeFilterValue =>
  isMessageRangeFilter(value) ? value : '';

const isMessageTriggerFilter = (value: unknown): value is MessageTriggerFilter =>
  typeof value === 'string' && (MESSAGE_TRIGGER_FILTERS as readonly string[]).includes(value);

const normalizeTriggerFilters = (value: unknown): MessageTriggerFilter[] =>
  typeof value === 'string' ? value.split(',').filter(isMessageTriggerFilter) : [];

/** The recovery select's states: default, any kind, one kind, or none at all. */
const TRIGGER_CHOICES = ['any', 'autofix', 'fallback', 'none'] as const;
type TriggerChoice = '' | (typeof TRIGGER_CHOICES)[number];

const isTriggerChoice = (value: unknown): value is TriggerChoice =>
  value === '' ||
  (typeof value === 'string' && (TRIGGER_CHOICES as readonly string[]).includes(value));

const ATTEMPT_STATUS_FILTERS = ['has_failed', 'has_succeeded'] as const;
type AttemptStatusFilter = (typeof ATTEMPT_STATUS_FILTERS)[number];

const isAttemptStatusFilter = (value: unknown): value is AttemptStatusFilter =>
  typeof value === 'string' && (ATTEMPT_STATUS_FILTERS as readonly string[]).includes(value);

const normalizeAttemptStatusFilters = (value: unknown): AttemptStatusFilter[] =>
  typeof value === 'string' ? value.split(',').filter(isAttemptStatusFilter) : [];

const MessageLog: Component = () => {
  const params = useParams<{ agentName: string }>();
  const [searchParams, setSearchParams] = useSearchParams<{
    agent?: string;
    status?: string;
    request?: string;
    provider?: string;
    connections?: string;
    trigger?: string;
    attempts?: string;
    model?: string;
    range?: string;
  }>();
  const navigate = useNavigate();

  preloadModelDisplayNames();
  const columns = () => {
    const base = DETAILED_COLUMNS;
    if (params.agentName) return base;
    // Global Messages spans every harness, so show which harness each row belongs to.
    const at = base.indexOf('model');
    return [...base.slice(0, at), 'agent' as const, ...base.slice(at)];
  };
  // Seed from ?agent= (set by AgentMessagesRedirect) so "View more" on a
  // harness overview lands pre-filtered; only meaningful in global mode —
  // when the route itself carries an agent, that param scopes the query.
  const [agentFilter, setAgentFilter] = createSignal(
    !params.agentName && typeof searchParams.agent === 'string' ? searchParams.agent : '',
  );
  createEffect(
    on(
      () => searchParams.agent,
      (agent) => setAgentFilter(typeof agent === 'string' ? agent : ''),
      { defer: true },
    ),
  );
  const [agentListRaw] = createResource(
    () => !params.agentName,
    async (isGlobal) => {
      if (!isGlobal) return [] as AgentFilterOption[];
      // includePlayground=true so the reserved Playground agent appears in the
      // filter and the log can be narrowed to Playground runs.
      const data = (await getAgents(true)) as
        { agents?: AgentFilterOption[] } | AgentFilterOption[];
      return (Array.isArray(data) ? data : (data?.agents ?? [])) as AgentFilterOption[];
    },
  );
  const agentList = createMemo(() => (agentListRaw() ?? []).map((a) => a.agent_name).sort());
  const agentPlatformMap = createMemo(() => {
    const map = new Map<string, { platform: string | null; category: string | null }>();
    for (const a of agentListRaw() ?? []) {
      map.set(a.agent_name, {
        platform: a.agent_platform ?? null,
        category: a.agent_category ?? null,
      });
    }
    return map;
  });
  const agentFilterOptions = createMemo(() => [
    { label: 'All harnesses', value: '' },
    ...(agentList() ?? []).map((a) => {
      const info = agentPlatformMap().get(a);
      const iconPath = info?.platform ? platformIcon(info.platform, info.category) : null;
      return {
        label: a,
        value: a,
        icon: iconPath ? (
          <img
            src={iconPath}
            alt=""
            width="14"
            height="14"
            class="platform-icon"
            style="border-radius: 3px;"
          />
        ) : (
          <span style="display: inline-block; width: 14px; height: 14px;" />
        ),
      };
    }),
  ]);
  // `?connections=` deep-links a pre-filtered log (dashboard connection cards
  // link here); `?provider=` is the legacy form and folds into it below.
  const [connectionsFilter, setConnectionsFilterValue] = createSignal<string[]>(
    typeof searchParams.connections === 'string' && searchParams.connections
      ? searchParams.connections.split(',').filter(Boolean)
      : [],
  );
  const setConnectionsFilter = (values: string[]) => {
    setConnectionsFilterValue(values);
    setSearchParams(
      { connections: values.length ? values.join(',') : undefined },
      { replace: true },
    );
  };
  const [connectionConfig] = createResource(async () => {
    try {
      return await getProviderConnections();
    } catch {
      return null;
    }
  });
  // Legacy `?provider=openai` deep links select every connection of that
  // provider once the connection list is known.
  createEffect(() => {
    const provider = searchParams.provider;
    const groups = connectionConfig()?.providers;
    if (typeof provider !== 'string' || !provider || !groups) return;
    if (connectionsFilter().length === 0) {
      const ids = groups
        .filter((g) => g.provider === provider)
        .flatMap((g) => g.connections.map((c) => c.id));
      if (ids.length > 0) setConnectionsFilterValue(ids);
    }
    setSearchParams(
      {
        provider: undefined,
        connections: connectionsFilter().length ? connectionsFilter().join(',') : undefined,
      },
      { replace: true },
    );
  });
  // A plain select over the useful recovery readings. The wire stays a comma
  // list (?trigger=autofix,fallback), so 'any' folds both kinds and existing
  // deep links keep working.
  const triggerListToChoice = (list: MessageTriggerFilter[]): TriggerChoice => {
    if (list.includes('autofix') && list.includes('fallback')) return 'any';
    if (list.includes('autofix')) return 'autofix';
    if (list.includes('fallback')) return 'fallback';
    if (list.includes('none')) return 'none';
    return '';
  };
  const triggerChoiceToParam = (choice: TriggerChoice): string | undefined => {
    if (choice === 'any') return 'autofix,fallback';
    return choice || undefined;
  };
  const [triggerFilter, setTriggerFilter] = createSignal<TriggerChoice>(
    triggerListToChoice(normalizeTriggerFilters(searchParams.trigger)),
  );
  // Attempt-status facet: a plain select (all / with a failed attempt / with
  // a succeeded attempt). NOT derivable from Status + Recovery — "has a failed
  // attempt" is Status=Failed UNION Recovery!=none, and those two AND together.
  // The connection cards on GlobalOverview and ConnectionDetail deep-link here
  // with ?attempts=, so this is also what keeps those drill-downs honest.
  const [attemptStatusFilter, setAttemptStatusFilterValue] = createSignal<'' | AttemptStatusFilter>(
    normalizeAttemptStatusFilters(searchParams.attempts)[0] ?? '',
  );
  const setAttemptStatusFilter = (value: string) => {
    const next = isAttemptStatusFilter(value) ? value : '';
    setAttemptStatusFilterValue(next);
    setSearchParams({ attempts: next || undefined }, { replace: true });
  };
  // `?model=` narrows the log to requests that touched one of these models.
  const [modelsFilter, setModelsFilterValue] = createSignal<string[]>(
    typeof searchParams.model === 'string' ? searchParams.model.split(',').filter(Boolean) : [],
  );
  // Navigation can change ?model= while this page stays mounted, so the signal
  // follows the URL the way status and range do — otherwise the log would keep
  // querying the selection from before the navigation.
  createEffect(
    on(
      () => searchParams.model,
      (model) =>
        setModelsFilterValue(typeof model === 'string' ? model.split(',').filter(Boolean) : []),
      { defer: true },
    ),
  );
  const setModelsFilter = (values: string[]) => {
    setModelsFilterValue(values);
    setSearchParams({ model: values.length ? values.join(',') : undefined }, { replace: true });
  };
  // `?range=` scopes the log to a rolling window; deep links from dashboard
  // cards carry it so the list total can match the card that sent us here.
  const [rangeFilter, setRangeFilterValue] = createSignal<MessageRangeFilterValue>(
    normalizeRangeFilter(searchParams.range),
  );
  const { isFreePlan, isProRangeLocked, effectiveRange } =
    usePlanRangeLock<MessageRangeFilterValue>(rangeFilter, PRO_RANGES, '7d');
  const [tierFilter, setTierFilter] = createSignal('');
  const [originFilter, setOriginFilter] = createSignal('');
  const [statusFilterValue, setStatusFilterValue] = createSignal<MessageStatusFilterValue>(
    normalizeStatusFilter(searchParams.status),
  );
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [setupCompleted] = createSignal(
    !!localStorage.getItem(`setup_completed_${params.agentName}`),
  );

  const [routingStatus] = createResource(
    () => params.agentName,
    (name) => getRoutingStatus(decodeURIComponent(name)),
  );

  const tierMetadataAgentName = createMemo(
    () => agentFilter() || (params.agentName ? decodeURIComponent(params.agentName) : ''),
  );

  const [specificityAssignments] = createResource(
    () => ({ agentName: tierMetadataAgentName() }),
    ({ agentName }) => (agentName ? getSpecificityAssignments(agentName) : Promise.resolve([])),
  );

  const hasProviders = () => routingStatus()?.enabled === true;

  const pager = createCursorPagination(50);

  const setStatusFilter = (value: string) => {
    const next = normalizeStatusFilter(value);
    setStatusFilterValue(next);
    setSearchParams({ status: next || undefined }, { replace: true });
  };
  const setTriggerFilterValue = (value: string) => {
    const next = isTriggerChoice(value) ? value : '';
    setTriggerFilter(next);
    setSearchParams({ trigger: triggerChoiceToParam(next) }, { replace: true });
  };
  const setRangeFilter = (value: string) => {
    if (isProRangeLocked(value)) return;
    const next = normalizeRangeFilter(value);
    setRangeFilterValue(next);
    setSearchParams({ range: next || undefined }, { replace: true });
  };

  createEffect(() => {
    if (isFreePlan() && PRO_RANGES.has(rangeFilter())) setRangeFilter('7d');
  });

  createEffect(
    on(
      () => searchParams.range,
      (range) => setRangeFilterValue(normalizeRangeFilter(range)),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => searchParams.status,
      (status) => setStatusFilterValue(normalizeStatusFilter(status)),
      { defer: true },
    ),
  );

  createEffect(
    on(
      [
        agentFilter,
        connectionsFilter,
        triggerFilter,
        attemptStatusFilter,
        modelsFilter,
        tierFilter,
        originFilter,
        statusFilterValue,
        rangeFilter,
      ],
      () => pager.resetPage(),
      {
        defer: true,
      },
    ),
  );

  const messageFilters = () => {
    const q: Record<string, string> = {};
    const connections = connectionsFilter();
    if (connections.length) q.connections = connections.join(',');
    const triggerParam = triggerChoiceToParam(triggerFilter());
    if (triggerParam) q.trigger = triggerParam;
    const attempts = attemptStatusFilter();
    if (attempts) q.attempts = attempts;
    const models = modelsFilter();
    if (models.length) q.model = models.join(',');
    const tier = tierFilter();
    if (tier) {
      if (tier.startsWith(SPECIFICITY_FILTER_PREFIX)) {
        q.specificity_category = tier.slice(SPECIFICITY_FILTER_PREFIX.length);
      } else if (tier.startsWith(HEADER_TIER_FILTER_PREFIX)) {
        q.header_tier_id = tier.slice(HEADER_TIER_FILTER_PREFIX.length);
      } else {
        q.routing_tier = tier;
      }
    }
    const status = statusFilterValue();
    if (status) q.status = status;
    const range = effectiveRange();
    if (range) q.range = range;
    const origin = originFilter();
    if (origin) q.origin = origin;
    const agentName = agentFilter() || params.agentName;
    if (agentName) q.agent_name = agentName;
    return q;
  };

  const [data, { refetch }] = createResource(
    () => ({
      filters: messageFilters(),
      _ping: messagePing(),
      cursor: pager.currentCursor(),
      limit: pager.pageSize,
    }),
    (p) => {
      const q = { ...p.filters };
      if (p.cursor) q.cursor = p.cursor;
      q.limit = String(p.limit);
      // Live message events refresh only the bounded page. Exact totals have
      // their own slower resource below, so ingest cannot put COUNT(*) back on
      // the 500ms feed path.
      q.include_total = 'false';
      q.include_filter_options = 'false';
      return getMessages(q) as Promise<MessagesData>;
    },
  );

  const countQueryKey = () => JSON.stringify(messageFilters());
  const [messageCount] = createResource(
    () => ({ key: countQueryKey(), _ping: analyticsPing() }),
    async (source) => ({
      key: source.key,
      data: (await getMessageCount(JSON.parse(source.key))) as MessagesData,
    }),
  );

  // The resource retains its previous value during refetches. Show the table
  // skeleton when the requested filters or page change, but keep existing rows
  // visible for the frequent background SSE `_ping` refetches.
  const messageQueryKey = () =>
    JSON.stringify({
      filters: messageFilters(),
      cursor: pager.currentCursor(),
      limit: pager.pageSize,
    });
  const [loadedMessageQueryKey, setLoadedMessageQueryKey] = createSignal(messageQueryKey());
  createEffect(() => {
    if (!data.loading && data() !== undefined) setLoadedMessageQueryKey(messageQueryKey());
  });
  const messageQueryChanging = () => data.loading && loadedMessageQueryKey() !== messageQueryKey();

  const [messageFilterOptions] = createResource(
    () => ({
      agentName: agentFilter() || params.agentName,
      range: effectiveRange(),
      _ping: analyticsPing(),
    }),
    (p) => {
      const q: Record<string, string> = {};
      if (p.agentName) q.agent_name = p.agentName;
      if (p.range) q.range = p.range;
      return getMessageFilterOptions(q) as Promise<MessageFilterOptionsData>;
    },
  );

  // Models the tenant has actually used in range, labelled the way the Model
  // column renders them. A model already picked stays listed even if it drops
  // out of the window, so an active filter never loses its own option.
  const modelOptions = createMemo<MultiSelectOption[]>(() => {
    const available = messageFilterOptions()?.models ?? [];
    const merged = [...new Set([...available, ...modelsFilter()])].sort();
    return merged.map((model) => ({ value: model, label: getModelDisplayName(model) }));
  });

  const displayedItems = createMemo<MessageRow[]>(() => {
    return data()?.items ?? [];
  });

  createEffect(
    on(
      () => data(),
      (d) => {
        if (d) pager.recordResponse(d.next_cursor);
      },
    ),
  );

  const hasActiveFilters = () =>
    agentFilter() !== '' ||
    connectionsFilter().length > 0 ||
    triggerFilter() !== '' ||
    attemptStatusFilter() !== '' ||
    modelsFilter().length > 0 ||
    tierFilter() !== '' ||
    originFilter() !== '' ||
    statusFilterValue() !== '' ||
    rangeFilter() !== '';

  const exactTotal = () => {
    const count = messageCount();
    return count?.key === countQueryKey() ? count.data?.total_count : undefined;
  };

  const hasNoData = () => {
    const d = data();
    return d && (exactTotal() ?? d.total_count) === 0;
  };

  const totalForPager = () => {
    const count = exactTotal();
    if (count !== undefined) return count;
    const d = data();
    if (!d) return 0;
    if (d.total_count_exact !== false) return d.total_count;
    return (pager.currentPage() - 1) * pager.pageSize + d.total_count;
  };

  const showEmptyState = () => hasNoData() && !hasActiveFilters() && !hasProviders();
  const isFilteredEmpty = () => hasNoData() && hasActiveFilters();
  const showMessages = () => !hasNoData() || (hasProviders() && !hasActiveFilters());

  const clearFilters = () => {
    setAgentFilter('');
    setConnectionsFilter([]);
    setTriggerFilterValue('');
    setAttemptStatusFilter('');
    setModelsFilter([]);
    setTierFilter('');
    setOriginFilter('');
    setStatusFilter('');
    setRangeFilter('');
  };

  const activeSpecificityCategories = createMemo(
    () =>
      new Set(
        (specificityAssignments() ?? [])
          .filter((assignment) => assignment.is_active)
          .map((assignment) => assignment.category),
      ),
  );

  const tierOptions = createMemo(() => [
    { label: 'All tiers', value: '' },
    ...ALL_TIERS.map((t) => ({ label: TIER_LABELS_ALL[t], value: t })),
    ...SPECIFICITY_STAGES.filter((stage) => activeSpecificityCategories().has(stage.id)).map(
      (stage) => ({
        label: stage.label,
        value: `${SPECIFICITY_FILTER_PREFIX}${stage.id}`,
      }),
    ),
    ...(messageFilterOptions()?.header_tiers ?? []).map((tier) => ({
      label: tier.name,
      value: `${HEADER_TIER_FILTER_PREFIX}${tier.ids.join(',')}`,
    })),
  ]);

  /** Resolve provider ID to display name */
  const providerDisplayName = (id: string): string => {
    if (id === 'manifest') return 'Manifest';
    const prov = PROVIDERS.find((p) => p.id === id);
    if (prov) return prov.name;
    // Custom providers arrive as `custom:<uuid>` — the backend ships a label
    // map alongside the provider list so the dropdown can show their names.
    return messageFilterOptions()?.provider_labels?.[id] ?? id;
  };

  const AUTH_TYPE_LABELS: Record<string, string> = {
    subscription: 'Subscription',
    api_key: 'Usage-based',
    local: 'Local',
  };
  // Every connection the tenant has, active or not: the log keeps history for
  // connections that were since disabled.
  const connectionOptions = createMemo<MultiSelectOption[]>(() => {
    const groups = connectionConfig()?.providers ?? [];
    return groups.flatMap((group) =>
      group.connections.map((conn) => ({
        value: conn.id,
        label: `${group.display_name ?? providerDisplayName(group.provider)} · ${conn.label}`,
        icon: providerIcon(group.provider, 14) ?? undefined,
        description:
          (AUTH_TYPE_LABELS[group.auth_type] ?? group.auth_type) +
          (conn.is_active ? '' : ' · inactive'),
      })),
    );
  });

  const proBadge = () => (
    <span class="pro-range-badge" aria-label="Pro plan required">
      PRO
    </span>
  );
  const rangeOptions = createMemo(() => [
    { label: 'All time', value: '' },
    ...[
      { label: 'Last 24 hours', value: '24h' },
      { label: 'Last 7 days', value: '7d' },
      { label: 'Last 30 days', value: '30d' },
      { label: 'Last 90 days', value: '90d' },
      { label: 'Last 365 days', value: '365d' },
    ].map((opt) =>
      isProRangeLocked(opt.value) ? { ...opt, disabled: true, badge: proBadge() } : opt,
    ),
  ]);

  const attemptStatusOptions = [
    { label: 'All attempt statuses', value: '' },
    { label: 'With a failed attempt', value: 'has_failed' },
    { label: 'With a succeeded attempt', value: 'has_succeeded' },
  ];

  const statusOptions = [
    { label: 'All statuses', value: '' },
    { label: 'Success', value: 'ok' },
    { label: 'Failed', value: 'failed' },
    // The caller hung up — not a Manifest or provider failure, so it is no
    // longer folded into Failed and needs its own way in.
    { label: 'Cancelled', value: 'cancelled' },
  ];

  const noRecoveryIcon = () => (
    <span class="recovery-opt-icon recovery-opt-icon__none" aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
      </svg>
    </span>
  );
  const triggerOptions = [
    { label: 'All attempts', value: '' },
    {
      label: 'With any recovery attempt',
      value: 'any',
      icon: (
        <span class="recovery-opt-icon" aria-hidden="true">
          <AutofixIcon />
          <span class="recovery-opt-icon__plus">+</span>
          <FallbackIcon />
        </span>
      ),
    },
    {
      label: 'With an autofix attempt',
      value: 'autofix',
      icon: (
        <span class="recovery-opt-icon" aria-hidden="true">
          <AutofixIcon />
        </span>
      ),
    },
    {
      label: 'With a fallback attempt',
      value: 'fallback',
      icon: (
        <span class="recovery-opt-icon" aria-hidden="true">
          <FallbackIcon />
        </span>
      ),
    },
    { label: 'No recovery attempt', value: 'none', icon: noRecoveryIcon() },
  ];

  // Who failed. `manifest` collapses every Manifest-authored origin (setup,
  // limits, bad requests, internal errors) into one choice, since from a user's
  // point of view they share a fix path that has nothing to do with a provider.
  const originOptions = [
    { label: 'All origins', value: '' },
    { label: 'Manifest', value: 'manifest' },
    { label: 'Provider', value: 'provider' },
    { label: 'Transport', value: 'transport' },
  ];

  // Jump to a linked message (the Autofix sibling of an expanded row).
  const scrollToMessage = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 2000);
  };

  // Drawer state. `?request=<id>` deep-links a request into the side panel
  // (the Recent Requests lists navigate here instead of expanding inline).
  const [selectedMessageId, setSelectedMessageId] = createSignal<string | null>(
    typeof searchParams.request === 'string' && searchParams.request ? searchParams.request : null,
  );
  const openDrawer = (id: string) => setSelectedMessageId(id);
  const closeDrawer = () => {
    setSelectedMessageId(null);
    if (searchParams.request) setSearchParams({ request: undefined });
  };
  const handleOpenMessageInDrawer = (id: string) => {
    closeDrawer();
    setTimeout(() => openDrawer(id), 100);
  };

  // Close drawer when clicking outside the table (not on a message row)
  const handlePageClick = (e: MouseEvent) => {
    if (!selectedMessageId()) return;
    const target = e.target as HTMLElement;
    // If clicking inside the drawer itself, ignore
    if (target.closest('.drawer')) return;
    // If clicking on a message row, the row handler will switch content
    if (target.closest('.msg-row--clickable')) return;
    closeDrawer();
  };

  return (
    <div class="container--full" onClick={handlePageClick}>
      <Title>
        {params.agentName
          ? `${agentDisplayName() ?? decodeURIComponent(params.agentName)} Requests - Manifest`
          : 'Requests - Manifest'}
      </Title>
      <Meta
        name="description"
        content={
          params.agentName
            ? `Browse all requests handled for ${agentDisplayName() ?? decodeURIComponent(params.agentName)}. Filter by provider, status, or cost.`
            : 'Browse all requests across all harnesses. Filter by provider, status, or cost.'
        }
      />
      <div class="page-header page-header--wrap">
        <div class="page-header__intro">
          <h1>Requests</h1>
          <span class="breadcrumb">
            Full log of requests from your app. Provider calls appear as attempts.
          </span>
        </div>
        <div class="header-controls">
          <Show when={!showEmptyState()}>
            <Show when={!params.agentName}>
              <Select
                value={agentFilter()}
                onChange={setAgentFilter}
                options={agentFilterOptions()}
              />
            </Show>
            <MultiSelect
              values={connectionsFilter()}
              onChange={setConnectionsFilter}
              options={connectionOptions()}
              placeholder="All connections"
              label="Connection filter"
            />
            <Select
              value={triggerFilter()}
              onChange={setTriggerFilterValue}
              options={triggerOptions}
              label="Recovery filter"
            />
            <Select
              value={attemptStatusFilter()}
              onChange={setAttemptStatusFilter}
              options={attemptStatusOptions}
              label="Attempt status filter"
            />
            <MultiSelect
              values={modelsFilter()}
              onChange={setModelsFilter}
              options={modelOptions()}
              placeholder="All models"
              label="Model filter"
            />
            <Select
              value={statusFilterValue()}
              onChange={setStatusFilter}
              options={statusOptions}
              label="Status filter"
            />
            <Select
              value={originFilter()}
              onChange={setOriginFilter}
              options={originOptions}
              label="Origin filter"
            />
            <Select value={tierFilter()} onChange={setTierFilter} options={tierOptions()} />
            <Select
              value={rangeFilter()}
              onChange={setRangeFilter}
              options={rangeOptions()}
              label="Period filter"
            />
          </Show>
          <Show when={showEmptyState() && !!params.agentName && !setupCompleted()}>
            <button class="btn btn--primary btn--sm" onClick={() => setSetupOpen(true)}>
              Set up harness
            </button>
          </Show>
        </div>
      </div>

      <Show
        when={(data() !== undefined || !data.loading) && !messageQueryChanging()}
        fallback={
          <div class="panel">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--gap-lg);">
              <div class="skeleton skeleton--text" style="width: 80px; height: 16px;" />
              <div class="skeleton skeleton--text" style="width: 60px; height: 14px;" />
            </div>
            <div class="data-table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Request</th>
                    <th>Cost</th>
                    <th>Total Tokens</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Model</th>
                    <th>Cache</th>
                    <th>Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}>
                    {() => (
                      <tr>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 90px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 55px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 40px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 40px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 35px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 35px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 110px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 90px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 35px;" />
                        </td>
                        <td>
                          <div class="skeleton skeleton--text" style="width: 50px;" />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        }
      >
        <Show when={!data.error} fallback={<ErrorState error={data.error} onRetry={refetch} />}>
          <Show when={showEmptyState()}>
            <Show
              when={params.agentName && setupCompleted()}
              fallback={
                <div class="empty-state">
                  <div class="empty-state__title">No requests yet</div>
                  <Show
                    when={params.agentName}
                    fallback={
                      <>
                        <p>
                          Create a harness and send a request. Every caller request shows up here.
                        </p>
                        <A
                          href="/harnesses"
                          class="btn btn--primary btn--sm"
                          style="margin-top: var(--gap-md);"
                        >
                          Go to Harnesses
                        </A>
                      </>
                    }
                  >
                    <p>
                      Set up your harness and send a request. Every caller request shows up here.
                    </p>
                    <button
                      class="btn btn--primary btn--sm"
                      style="margin-top: var(--gap-md);"
                      onClick={() => setSetupOpen(true)}
                    >
                      Set up harness
                    </button>
                  </Show>
                  <div class="empty-state__img-wrapper">
                    <img
                      src="/example-messages.svg"
                      alt="Example request log showing LLM request history"
                      class="empty-state__img"
                      loading="lazy"
                    />
                  </div>
                </div>
              }
            >
              <div class="empty-state">
                <div class="empty-state__title">No requests yet</div>
                <p>Connect a provider to start routing LLM calls.</p>
                <button
                  class="btn btn--primary btn--sm"
                  style="margin-top: var(--gap-md);"
                  onClick={() =>
                    navigate(`/harnesses/${encodeURIComponent(params.agentName)}/routing`, {
                      state: { openProviders: true },
                    })
                  }
                >
                  Connect provider
                </button>
                <div class="empty-state__img-wrapper">
                  <img
                    src="/example-messages.svg"
                    alt="Example request log showing LLM request history"
                    class="empty-state__img"
                    loading="lazy"
                  />
                </div>
              </div>
            </Show>
          </Show>
          <Show when={isFilteredEmpty()}>
            <div class="panel">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--gap-lg);">
                <div class="panel__title" style="margin-bottom: 0;">
                  Requests
                </div>
                <span style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                  0 results
                </span>
              </div>
              <div class="model-filter__empty">
                <p class="model-filter__empty-title">No requests match your filters</p>
                <p class="model-filter__empty-hint">
                  Try adjusting your provider, status, or cost filters to see more results.
                </p>
                <button class="btn btn--outline btn--sm" onClick={clearFilters} type="button">
                  Clear filters
                </button>
              </div>
            </div>
          </Show>
          <Show when={showMessages()}>
            <Show when={hasNoData() && hasProviders()}>
              <div class="waiting-banner">
                <i class="bxd bx-florist" />
                <p>No requests yet. They appear seconds after your first LLM call.</p>
              </div>
            </Show>
            <div class="panel">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--gap-lg);">
                <div class="panel__title" style="margin-bottom: 0;">
                  Requests
                </div>
                <span style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                  {totalForPager()} total
                </span>
              </div>
              <div class="data-table-scroll">
                <MessageTable
                  items={displayedItems()}
                  columns={columns()}
                  agentName={params.agentName}
                  customProviderName={() => undefined}
                  agentPlatformLookup={(name) => agentPlatformMap().get(name)}
                  onOpenMessage={scrollToMessage}
                  onRowSelect={openDrawer}
                  selectedRowId={selectedMessageId()}
                  rowIdPrefix="msg-"
                  showHeaderTooltips
                  expandable
                />
              </div>
              <Pagination
                currentPage={pager.currentPage}
                totalItems={totalForPager}
                pageSize={pager.pageSize}
                hasNextPage={pager.hasNextPage}
                isLoading={() => data.loading}
                onPrevious={pager.previousPage}
                onNext={pager.nextPage}
              />
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={!!params.agentName}>
        <SetupModal
          open={setupOpen()}
          agentName={decodeURIComponent(params.agentName)}
          agentPlatform={agentPlatform()}
          agentCategory={agentCategory()}
          onClose={() => setSetupOpen(false)}
        />
      </Show>
      <RequestDrawer
        messageId={selectedMessageId()}
        onClose={closeDrawer}
        onOpenMessage={handleOpenMessageInDrawer}
      />
    </div>
  );
};

export default MessageLog;
