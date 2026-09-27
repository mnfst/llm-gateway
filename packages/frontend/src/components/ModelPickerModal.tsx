import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  startTransition,
  type Component,
} from 'solid-js';
import {
  refreshModels,
  refreshProviderModels,
  type AuthType,
  type AvailableModel,
  type CustomProviderData,
  type ModelCapability,
  type ModelModality,
  type RoutingProvider,
  type TierAssignment,
} from '../services/api.js';
import { PROVIDERS, STAGES, SPECIFICITY_STAGES, DEFAULT_STAGE } from '../services/providers.js';
import { customProviderColor, formatPerRequestCost } from '../services/formatters.js';
import { inferProviderFromModel, pricePerM, resolveProviderId } from '../services/routing-utils.js';
import { providerIcon, customProviderLogo } from './ProviderIcon.js';
import { toast } from '../services/toast-store.js';
import ModelCapabilityBadges, {
  CAPABILITY_ICONS,
  CAPABILITY_LABELS,
  ModelModalityBadges,
} from './ModelCapabilityBadges.js';
import VirtualList from './VirtualList.js';

const PICKER_NARROW_QUERY = '(max-width: 640px)';
const PICKER_GROUP_HEADER_HEIGHT = 32;
const PICKER_MODEL_ROW_HEIGHT = 40;
/** Stacked label + four cells + gaps + padding in the ≤640px layout. */
const PICKER_MODEL_ROW_HEIGHT_NARROW = 160;

type ModalModel = { value: string; label: string; pricing: AvailableModel };
type PickerItem =
  | { kind: 'header'; provId: string; name: string }
  | { kind: 'model'; provId: string; name: string; model: ModalModel };

interface Props {
  tierId: string;
  agentName?: string;
  models: AvailableModel[];
  tiers: TierAssignment[];
  customProviders?: CustomProviderData[];
  connectedProviders?: RoutingProvider[];
  onSelect: (tierId: string, modelName: string, providerId: string, authType?: AuthType) => void;
  onClose: () => void;
  onConnectProviders?: () => void;
  onProviderRefreshed?: () => void | Promise<void>;
  requiredCapability?: ModelCapability;
}

/** Resolve a display label for a model name, handling vendor-prefixed IDs. */
function labelForModel(
  name: string,
  labels: Map<string, string>,
  providerIds: Set<string>,
): string {
  const direct = labels.get(name);
  if (direct) return direct;
  const slash = name.indexOf('/');
  if (slash !== -1) {
    const bare = name.substring(slash + 1);
    const found = labels.get(bare);
    if (found) return found;
    return bare;
  }
  const parts = name.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!providerIds.has(parts[i]!.toLowerCase())) continue;
    const bare = parts.slice(i + 1).join('.');
    const found = labels.get(bare);
    if (found) return found;
    return bare;
  }
  return name;
}

const isFreeModel = (m: AvailableModel): boolean =>
  m.input_price_per_token != null &&
  m.output_price_per_token != null &&
  Number(m.input_price_per_token) === 0 &&
  Number(m.output_price_per_token) === 0;

const ACTION_CAPABILITIES: readonly ModelCapability[] = ['stream', 'tools'];
const MODALITY_ORDER: readonly ModelModality[] = ['text', 'image', 'audio', 'video'];
const DEFAULT_MODALITIES: readonly ModelModality[] = ['text'];

const wasFetchedToday = (fetchedAt: string | null | undefined, now: Date): boolean => {
  if (!fetchedAt) return false;
  const fetched = new Date(fetchedAt);
  if (Number.isNaN(fetched.getTime())) return false;
  return (
    fetched.getFullYear() === now.getFullYear() &&
    fetched.getMonth() === now.getMonth() &&
    fetched.getDate() === now.getDate()
  );
};

const unavailableCapabilityLabel = (capability: ModelCapability): string => {
  if (capability === 'stream') return 'Stream unavailable';
  return `${capability.charAt(0).toUpperCase()}${capability.slice(1)} unavailable`;
};

const ModelPickerModal: Component<Props> = (props) => {
  const isUsable = (p: { is_active: boolean; has_api_key: boolean; cached_model_count?: number }) =>
    p.is_active && (p.has_api_key || (p.cached_model_count ?? 0) > 0);
  const hasSubscription = () =>
    (props.connectedProviders ?? []).some((p) => isUsable(p) && p.auth_type === 'subscription');
  const hasApiKey = () =>
    (props.connectedProviders ?? []).some((p) => isUsable(p) && p.auth_type === 'api_key');
  const hasLocal = () =>
    (props.connectedProviders ?? []).some((p) => isUsable(p) && p.auth_type === 'local');
  // Show the tab strip whenever the user has models in more than one auth
  // category — otherwise the picker is single-category and the tabs add
  // noise. Local counts as its own category alongside subscription/api_key.
  const showTabs = () => [hasSubscription(), hasApiKey(), hasLocal()].filter(Boolean).length > 1;

  // Default to the first connected category (subscription > api_key > local)
  // so the picker opens on something the user actually has. When nothing is
  // connected the default is 'api_key' — matches the pre-local behavior so
  // existing snapshots / tests that assume the free-models pill is visible
  // (only shown for api_key) don't start failing.
  const resolveInitialTab = (): AuthType => {
    if (hasSubscription()) return 'subscription';
    if (hasLocal() && !hasApiKey()) return 'local';
    return 'api_key';
  };
  const [activeTab, setActiveTab] = createSignal<AuthType>(resolveInitialTab());
  const [search, setSearch] = createSignal('');
  const [showFreeOnly, setShowFreeOnly] = createSignal(false);
  /** Required capabilities: only show models that have ALL of these. */
  const [requiredCapabilities, setRequiredCapabilities] = createSignal<Set<ModelCapability>>(
    props.requiredCapability ? new Set([props.requiredCapability]) : new Set(),
  );
  const [refreshingProvId, setRefreshingProvId] = createSignal<string | null>(null);
  const [isNarrow, setIsNarrow] = createSignal(false);
  // Parent callbacks refetch resources read inside this modal's Suspense
  // boundary. Keep the current picker visible until those resources settle.
  const notifyProviderRefreshed = () => startTransition(() => props.onProviderRefreshed?.());

  onMount(() => {
    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia(PICKER_NARROW_QUERY);
      const sync = () => setIsNarrow(media.matches);
      sync();
      media.addEventListener('change', sync);
      onCleanup(() => media.removeEventListener('change', sync));
    }

    const agentName = props.agentName;
    if (!agentName) return;
    const now = new Date();
    const needsRefresh = (props.connectedProviders ?? []).some(
      (provider) =>
        provider.is_active &&
        !provider.provider.startsWith('custom:') &&
        !wasFetchedToday(provider.models_fetched_at, now),
    );
    if (!needsRefresh) return;

    const refreshKey = `manifest:routing-model-refresh:${agentName}`;
    const today = now.toDateString();
    if (sessionStorage.getItem(refreshKey) === today) return;
    sessionStorage.setItem(refreshKey, today);

    void refreshModels(agentName)
      .then(() => notifyProviderRefreshed())
      .catch(() => undefined);
  });

  const toggleCapability = (cap: ModelCapability) => {
    const current = new Set(requiredCapabilities());
    if (current.has(cap)) current.delete(cap);
    else current.add(cap);
    setRequiredCapabilities(current);
  };

  const isCapabilityRequired = (cap: ModelCapability) => requiredCapabilities().has(cap);

  /** Action capabilities that exist on at least one model in the current tab. */
  const availableCapabilities = (): ModelCapability[] => {
    const found = new Set<ModelCapability>();
    for (const m of props.models) {
      for (const c of m.capabilities ?? []) found.add(c);
    }
    return ACTION_CAPABILITIES.filter((c) => found.has(c));
  };

  const handleRefreshGroup = async (provId: string, displayName: string) => {
    if (!props.agentName) return;
    if (provId.startsWith('custom:')) return;
    setRefreshingProvId(provId);
    try {
      const result = await refreshProviderModels(props.agentName, provId, activeTab());
      if (result.ok) {
        toast.success(
          `${displayName}: refreshed ${result.model_count} model${result.model_count === 1 ? '' : 's'}`,
        );
      } else {
        toast.error(result.error ?? `Couldn't refresh ${displayName}`);
      }
      await notifyProviderRefreshed();
    } catch {
      // network/server error toast already raised by fetchMutate
    } finally {
      setRefreshingProvId(null);
    }
  };

  const providerLabelMap = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const prov of PROVIDERS) {
      for (const m of prov.models) map.set(m.value, m.label);
    }
    return map;
  };

  const providerIdSet = (): Set<string> => new Set(PROVIDERS.map((p) => p.id.toLowerCase()));

  const customProviderNameMap = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const cp of props.customProviders ?? []) {
      map.set(`custom:${cp.id}`, cp.name);
    }
    return map;
  };

  /** Provider IDs that have an active connection of the given auth type. */
  const providerIdsForTab = (authType: AuthType): Set<string> => {
    const ids = new Set<string>();
    for (const p of props.connectedProviders ?? []) {
      if (p.is_active && p.auth_type === authType) {
        ids.add(p.provider.toLowerCase());
        const resolved = resolveProviderId(p.provider);
        if (resolved) ids.add(resolved);
      }
    }
    return ids;
  };

  const groupedModels = createMemo(() => {
    const q = search().toLowerCase().trim();
    const labels = providerLabelMap();
    const providerIds = providerIdSet();
    const cpNames = customProviderNameMap();
    const tab = activeTab();
    const hasConnectedProviders = (props.connectedProviders ?? []).length > 0;

    const groupMap = new Map<string, { provId: string; name: string; models: ModalModel[] }>();

    const freeOnly = tab === 'api_key' && showFreeOnly();
    const allowedProviders = hasConnectedProviders ? providerIdsForTab(tab) : undefined;

    for (const m of props.models) {
      // Filter by the model's own auth_type to prevent subscription models
      // from leaking into the API Keys tab and vice versa (e.g. when the
      // same provider is connected with both auth types and they have
      // different model access levels).
      if (showTabs() && m.auth_type && m.auth_type !== tab) continue;
      if (freeOnly && !isFreeModel(m)) continue;
      const required = requiredCapabilities();
      if (required.size > 0) {
        const caps = m.capabilities ?? [];
        let pass = true;
        for (const r of required) {
          if (!caps.includes(r)) {
            pass = false;
            break;
          }
        }
        if (!pass) continue;
      }
      const dbProvId = resolveProviderId(m.provider);
      const prefixProvId = inferProviderFromModel(m.model_name);
      // OpenRouter is the one provider where the vendor prefix is genuinely
      // the best attribution: an OR row for `anthropic/claude-…` should be
      // grouped under Anthropic, not OpenRouter. For every other registered
      // first-party provider the stored `m.provider` is the truth — Groq's
      // `qwen/qwen3-32b` is being served BY Groq, so it must group under
      // Groq (and use Groq's pricing) regardless of the model-id prefix.
      // Mirrors the precedence rule in RoutingTierCard.providerIdForModel.
      const provId =
        dbProvId && dbProvId !== 'openrouter' && PROVIDERS.find((p) => p.id === dbProvId)
          ? dbProvId
          : prefixProvId && PROVIDERS.find((p) => p.id === prefixProvId)
            ? prefixProvId
            : (dbProvId ?? prefixProvId);
      if (!provId) continue;
      if (allowedProviders && !allowedProviders.has(provId)) continue;
      if (!groupMap.has(provId)) {
        const isCustom = provId.startsWith('custom:');
        const provDef = PROVIDERS.find((p) => p.id === provId);
        const name = isCustom
          ? (m.provider_display_name ?? cpNames.get(provId) ?? m.provider)
          : (provDef?.name ?? m.provider);
        groupMap.set(provId, { provId, name, models: [] });
      }
      const label =
        m.display_name && m.display_name !== m.model_name
          ? m.display_name
          : labelForModel(m.model_name, labels, providerIds);
      groupMap.get(provId)!.models.push({
        value: m.model_name,
        label,
        pricing: m,
      });
    }

    const groups: { provId: string; name: string; models: ModalModel[] }[] = [];
    for (const group of groupMap.values()) {
      group.models.sort((a, b) => {
        if (a.value === 'openrouter/free') return -1;
        if (b.value === 'openrouter/free') return 1;
        return a.label.localeCompare(b.label);
      });
      if (q) {
        const nameMatch = group.name.toLowerCase().includes(q);
        const filtered = nameMatch
          ? group.models
          : group.models.filter(
              (m) => m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q),
            );
        if (filtered.length > 0) groups.push({ ...group, models: filtered });
      } else if (group.models.length > 0) {
        groups.push(group);
      }
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  });

  const pickerItems = createMemo((): PickerItem[] => {
    const items: PickerItem[] = [];
    for (const group of groupedModels()) {
      items.push({
        kind: 'header',
        provId: group.provId,
        name: group.name,
      });
      for (const model of group.models) {
        items.push({
          kind: 'model',
          provId: group.provId,
          name: group.name,
          model,
        });
      }
    }
    return items;
  });

  const pickerItemHeight = (item: PickerItem) =>
    item.kind === 'header'
      ? PICKER_GROUP_HEADER_HEIGHT
      : isNarrow()
        ? PICKER_MODEL_ROW_HEIGHT_NARROW
        : PICKER_MODEL_ROW_HEIGHT;

  const pickerResetKey = () =>
    `${activeTab()}\0${search()}\0${showFreeOnly()}\0${[...requiredCapabilities()].sort().join(',')}`;

  /** Returns the role of a model in the current tier: "Primary", "Fallback 1", etc. or null */
  const modelRole = (
    modelName: string,
    providerId?: string,
    authType?: AuthType,
  ): string | null => {
    const t = props.tiers.find((r) => r.tier === props.tierId);
    if (!t) return null;
    const primaryRoute = t.override_route ?? null;
    if (primaryRoute) {
      const matches =
        providerId && authType
          ? primaryRoute.model === modelName &&
            primaryRoute.provider.toLowerCase() === providerId.toLowerCase() &&
            primaryRoute.authType === authType
          : primaryRoute.model === modelName;
      if (matches) return 'Primary';
    }
    const fbRoutes = t.fallback_routes ?? [];
    const idx =
      providerId && authType
        ? fbRoutes.findIndex(
            (r) =>
              r.model === modelName &&
              r.provider.toLowerCase() === providerId.toLowerCase() &&
              r.authType === authType,
          )
        : fbRoutes.findIndex((r) => r.model === modelName);
    if (idx !== -1) return `Fallback ${idx + 1}`;
    return null;
  };

  const totalVisibleModels = () => groupedModels().reduce((sum, g) => sum + g.models.length, 0);

  /** Total models available (ignoring search) — used to decide whether to show search bar */
  const totalAvailableModels = () => {
    const saved = search();
    if (!saved) return totalVisibleModels();
    // Count all models without applying search filter
    return props.models.length;
  };

  const isSub = () => activeTab() === 'subscription';
  const isLocal = () => activeTab() === 'local';
  const isPaid = () => !isSub() && !isLocal();
  const missingRequiredCapability = (model: AvailableModel): string | null => {
    const required = props.requiredCapability;
    if (!required) return null;
    return (model.capabilities ?? []).includes(required)
      ? null
      : unavailableCapabilityLabel(required);
  };
  const actionCapabilitiesFor = (model: AvailableModel): readonly ModelCapability[] => {
    return ACTION_CAPABILITIES.filter((capability) =>
      (model.capabilities ?? []).includes(capability),
    );
  };
  const inputModalitiesFor = (model: AvailableModel): readonly ModelModality[] => {
    if (model.input_modalities && model.input_modalities.length > 0) return model.input_modalities;
    const caps = new Set(model.capabilities ?? []);
    const modalities = MODALITY_ORDER.filter(
      (modality) => modality === 'text' || caps.has(modality),
    );
    return modalities.length > 0 ? modalities : DEFAULT_MODALITIES;
  };
  const outputModalitiesFor = (model: AvailableModel): readonly ModelModality[] =>
    model.output_modalities && model.output_modalities.length > 0
      ? model.output_modalities
      : DEFAULT_MODALITIES;

  // Resolve the routing-tier label for the subtitle. Callers outside the
  // routing context (e.g. the Playground) pass a non-tier id, so there is no
  // matching stage — render no subtitle instead of a bare "tier".
  const tierLabel = () =>
    [DEFAULT_STAGE, ...STAGES, ...SPECIFICITY_STAGES].find((s) => s.id === props.tierId)?.label;

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
    >
      <div
        class="modal-card routing-modal__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-picker-title"
      >
        <div class="routing-modal__header">
          <div>
            <div class="routing-modal__title" id="model-picker-title">
              Select a model
            </div>
            <Show when={tierLabel()}>
              {(label) => <div class="routing-modal__subtitle">{label()} tier</div>}
            </Show>
          </div>
          <button class="modal__close" onClick={() => props.onClose()} aria-label="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <Show when={showTabs()}>
          <div class="provider-modal__tabs-wrapper">
            <div class="panel__tabs" role="tablist">
              <Show when={hasSubscription()}>
                <button
                  role="tab"
                  aria-selected={activeTab() === 'subscription'}
                  class="panel__tab"
                  classList={{ 'panel__tab--active': activeTab() === 'subscription' }}
                  onClick={() => {
                    setActiveTab('subscription');
                    setShowFreeOnly(false);
                  }}
                >
                  <svg
                    class="provider-modal__tab-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    style="color: #1cc4bf"
                  >
                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  Subscription
                </button>
              </Show>
              <Show when={hasApiKey()}>
                <button
                  role="tab"
                  aria-selected={activeTab() === 'api_key'}
                  class="panel__tab"
                  classList={{ 'panel__tab--active': activeTab() === 'api_key' }}
                  onClick={() => setActiveTab('api_key')}
                >
                  <svg
                    class="provider-modal__tab-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    style="color: #e59d55"
                  >
                    <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
                  </svg>
                  Usage-based
                </button>
              </Show>
              <Show when={hasLocal()}>
                <button
                  role="tab"
                  aria-selected={activeTab() === 'local'}
                  class="panel__tab"
                  classList={{ 'panel__tab--active': activeTab() === 'local' }}
                  onClick={() => {
                    setActiveTab('local');
                    setShowFreeOnly(false);
                  }}
                >
                  <svg
                    class="provider-modal__tab-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                    style="color: #F72585"
                  >
                    <path d="m13.18 6.75 2.66-4.22-1.69-1.07L12 4.87 9.85 1.46 8.16 2.53l2.66 4.22-8.67 13.72A1.006 1.006 0 0 0 3 22.01h18c.36 0 .7-.2.88-.52s.16-.71-.03-1.02zM10.24 20 12 16.98 13.76 20zm5.83 0-3.21-5.5c-.36-.62-1.37-.62-1.73 0L7.92 20H4.81L12 8.62 19.19 20h-3.11Z" />
                  </svg>
                  Local
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={totalAvailableModels() > 5}>
          <div class="routing-modal__search-wrap">
            <svg
              class="routing-modal__search-icon"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={(el) => requestAnimationFrame(() => el.focus())}
              class="routing-modal__search"
              type="text"
              placeholder="Search models or providers..."
              aria-label="Search models or providers"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
        </Show>

        <div class="routing-modal__filter-bar">
          <div class="routing-modal__filter-left">
            <Show when={isPaid()}>
              <button
                type="button"
                class="routing-modal__cap-pill"
                classList={{ 'routing-modal__cap-pill--active': showFreeOnly() }}
                onClick={() => setShowFreeOnly(!showFreeOnly())}
              >
                Free models only
              </button>
            </Show>
          </div>
          <div class="routing-modal__filter-right">
            <For each={availableCapabilities()}>
              {(cap) => (
                <button
                  type="button"
                  class="routing-modal__cap-pill"
                  classList={{
                    'routing-modal__cap-pill--active': isCapabilityRequired(cap),
                  }}
                  onClick={() => toggleCapability(cap)}
                >
                  <span class="routing-modal__filter-pill-icon" innerHTML={CAPABILITY_ICONS[cap]} />
                  {CAPABILITY_LABELS[cap]}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={groupedModels().length > 0}>
          <div class="routing-modal__table-head" aria-hidden="true">
            <span>Model</span>
            <span>Capabilities</span>
            <span>Input</span>
            <span>Output</span>
            <span>Price</span>
          </div>
        </Show>
        <Show
          when={pickerItems().length > 0}
          fallback={
            <div class="routing-modal__list">
              <div class="routing-modal__empty">
                {search().trim()
                  ? 'No models match your search.'
                  : showFreeOnly()
                    ? 'No free models available from your connected providers.'
                    : isSub()
                      ? 'No subscription providers connected. Connect a provider to see models.'
                      : isLocal()
                        ? 'No local providers connected. Connect a local provider to see models.'
                        : 'No API key providers connected. Connect a provider to see models.'}
                <Show when={!search().trim() && !showFreeOnly() && props.onConnectProviders}>
                  <button
                    class="btn btn--primary btn--sm"
                    onClick={() => props.onConnectProviders?.()}
                  >
                    Connect provider
                  </button>
                </Show>
              </div>
            </div>
          }
        >
          <VirtualList
            class="routing-modal__list"
            items={pickerItems()}
            itemHeight={pickerItemHeight}
            resetKey={pickerResetKey()}
          >
            {(item) =>
              item.kind === 'header' ? (
                <div class="routing-modal__group-header">
                  <span class="routing-modal__group-icon">
                    {item.provId.startsWith('custom:')
                      ? (() => {
                          const cp = (props.customProviders ?? []).find(
                            (c) => `custom:${c.id}` === item.provId,
                          );
                          return (
                            customProviderLogo(item.name, 16, cp?.base_url) ?? (
                              <span
                                class="provider-card__logo-letter"
                                style={{
                                  background: customProviderColor(item.name),
                                  width: '16px',
                                  height: '16px',
                                  'font-size': '9px',
                                  'border-radius': '50%',
                                }}
                              >
                                {item.name.charAt(0).toUpperCase()}
                              </span>
                            )
                          );
                        })()
                      : providerIcon(item.provId, 16)}
                  </span>
                  <span class="routing-modal__group-name">{item.name}</span>
                  <Show when={props.agentName && !item.provId.startsWith('custom:')}>
                    <button
                      class="routing-modal__group-refresh"
                      disabled={refreshingProvId() !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRefreshGroup(item.provId, item.name);
                      }}
                      aria-label={`Refresh ${item.name} models`}
                      title={`Refresh ${item.name} models`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                        classList={{
                          'routing-modal__group-refresh-icon--spinning':
                            refreshingProvId() === item.provId,
                        }}
                      >
                        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                    </button>
                  </Show>
                </div>
              ) : (
                (() => {
                  const model = item.model;
                  const disabledReason = () => missingRequiredCapability(model.pricing);
                  const disabled = () => disabledReason() !== null;
                  return (
                    <button
                      class="routing-modal__model"
                      classList={{ 'routing-modal__model--disabled': disabled() }}
                      disabled={disabled()}
                      title={disabledReason() ?? undefined}
                      onClick={() =>
                        props.onSelect(props.tierId, model.value, item.provId, activeTab())
                      }
                    >
                      <span class="routing-modal__model-left">
                        <span class="routing-modal__model-label">
                          {model.label}
                          <Show when={modelRole(model.value, item.provId, activeTab())}>
                            {(role) => <span class="routing-modal__role-tag">{role()}</span>}
                          </Show>
                        </span>
                      </span>
                      <span class="routing-modal__model-cell">
                        <span class="routing-modal__model-cell-label">Capabilities</span>
                        <Show
                          when={actionCapabilitiesFor(model.pricing).length > 0}
                          fallback={
                            <span
                              class="model-capability-badges model-capability-badges--compact"
                              aria-label="No stream or tools"
                            />
                          }
                        >
                          <ModelCapabilityBadges
                            capabilities={actionCapabilitiesFor(model.pricing)}
                            compact
                            iconOnly
                          />
                        </Show>
                      </span>
                      <span class="routing-modal__model-cell">
                        <span class="routing-modal__model-cell-label">Input</span>
                        <ModelModalityBadges
                          modalities={inputModalitiesFor(model.pricing)}
                          direction="input"
                          compact
                          iconOnly
                        />
                      </span>
                      <span class="routing-modal__model-cell">
                        <span class="routing-modal__model-cell-label">Output</span>
                        <ModelModalityBadges
                          modalities={outputModalitiesFor(model.pricing)}
                          direction="output"
                          compact
                          iconOnly
                        />
                      </span>
                      <span class="routing-modal__model-cell routing-modal__model-cell--price">
                        <span class="routing-modal__model-cell-label">Price</span>
                        <Show
                          when={isPaid()}
                          fallback={
                            <span class="routing-modal__model-price">
                              {isLocal()
                                ? 'Runs on your machine'
                                : (formatPerRequestCost(model.pricing.cost_per_request) ??
                                  'Included in subscription')}
                            </span>
                          }
                        >
                          <Show when={model.pricing}>
                            {(p) => (
                              <span class="routing-modal__model-price">
                                {pricePerM(p().input_price_per_token)} in ·{' '}
                                {pricePerM(p().output_price_per_token)} out
                              </span>
                            )}
                          </Show>
                        </Show>
                      </span>
                    </button>
                  );
                })()
              )
            }
          </VirtualList>
        </Show>
      </div>
    </div>
  );
};

export default ModelPickerModal;
