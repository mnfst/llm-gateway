import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  For,
  Show,
  type Component,
} from 'solid-js';
import { useLocation, useParams, useSearchParams } from '@solidjs/router';
import { Title, Meta } from '@solidjs/meta';
import RoutingModals from '../components/RoutingModals.js';
import { buildPipelineHelp } from '../components/RoutingPipelineCard.js';
import RoutingTabs from '../components/RoutingTabs.js';
import ResponseModeModal from '../components/ResponseModeModal.js';
import { toast } from '../services/toast-store.js';
import { agentDisplayName } from '../services/agent-display-name.js';
import SetupModal from '../components/SetupModal.jsx';
import { isRecentlyCreated, isSetupPending, clearSetupPending } from '../services/recent-agents.js';
import { agentPlatform, agentCategory } from '../services/agent-platform-store.js';
import RoutingDefaultTierSection from './RoutingDefaultTierSection.js';
import RoutingSpecificitySection from './RoutingSpecificitySection.js';
import RoutingHeaderTiersSection from './RoutingHeaderTiersSection.js';
import RoutingTierCard from './RoutingTierCard.js';
import HeaderTierCard from '../components/HeaderTierCard.js';
import { RoutingLoadingSkeleton, ActiveProviderIcons, RoutingFooter } from './RoutingPanels.js';
import { createRoutingActions } from './RoutingActions.js';
import {
  listHeaderTiers,
  overrideHeaderTier,
  deleteHeaderTier,
  toggleHeaderTier,
  setHeaderTierResponseMode,
  type HeaderTier,
} from '../services/api/header-tiers.js';
import {
  getTierAssignments,
  setTierResponseMode,
  getAvailableModels,
  getProviders,
  getCustomProviders,
  getEnabledProviders,
  getSpecificityAssignments,
  setSpecificityResponseMode,
  overrideSpecificity,
  resetSpecificity,
  refreshModels,
  getPricingHealth,
  getComplexityStatus,
  toggleComplexity,
  listModelParams,
  setModelParams as setModelParamsApi,
  deleteModelParams,
  modelParamsKey,
  type AgentModelParamsRow,
  type AuthType,
  type RequestParamDefaults,
  type ResponseMode,
} from '../services/api.js';
import { parseCustomProviderParams, parseProviderDeepLink } from '../services/routing-params.js';
import { DEFAULT_STAGE, STAGES } from '../services/providers.js';
// Route-scoped: keep the large routing stylesheet (and its sub-imports) out
// of the global theme bundle so login/overview/etc. don't download it.
import NoConnectionsPrompt from '../components/NoConnectionsPrompt.jsx';
import '../styles/routing.css';

const Routing: Component = () => {
  const params = useParams<{ agentName: string }>();
  const location = useLocation<{ openProviders?: boolean }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentName = () => decodeURIComponent(params.agentName);

  // Newly created agents land on this tab; show the setup modal here too (it
  // used to live only on Overview). The open gate keys off a persistent
  // "setup pending" flag (localStorage) so the modal reliably reopens after a
  // page refresh until the user dismisses or completes it. The in-memory
  // `isRecentlyCreated` is kept as an in-session OR but is not required to
  // survive reloads.
  const [setupOpen, setSetupOpen] = createSignal(
    (isSetupPending(agentName()) || isRecentlyCreated(agentName())) &&
      !localStorage.getItem(`setup_completed_${params.agentName}`) &&
      !localStorage.getItem(`setup_dismissed_${params.agentName}`),
  );

  const customProviderPrefill = createMemo(() => parseCustomProviderParams(searchParams));
  const providerDeepLink = createMemo(() => parseProviderDeepLink(searchParams));

  const [tiers, { refetch: refetchTiers, mutate: mutateTiers }] = createResource(
    () => agentName(),
    getTierAssignments,
  );
  const [models, { refetch: refetchModels }] = createResource(
    () => agentName(),
    getAvailableModels,
  );
  const [connectedProviders, { refetch: refetchProviders }] = createResource(
    () => agentName(),
    getProviders,
  );
  const [customProviders, { refetch: refetchCustomProviders }] = createResource(
    () => agentName(),
    getCustomProviders,
  );
  const [enabledProviders, { refetch: refetchEnabledProviders }] = createResource(
    () => agentName(),
    async (name) => getEnabledProviders(name).catch(() => ({ enabled: [] })),
  );
  const [specificityAssignments, { refetch: refetchSpecificity, mutate: mutateSpecificity }] =
    createResource(() => agentName(), getSpecificityAssignments);
  const [headerTiers, { refetch: refetchHeaderTiers, mutate: mutateHeaderTiers }] = createResource(
    () => agentName(),
    (name) => listHeaderTiers(name).catch(() => [] as HeaderTier[]),
  );
  const [complexityStatus, { mutate: mutateComplexityStatus }] = createResource(
    () => agentName(),
    getComplexityStatus,
  );
  const [togglingComplexity, setTogglingComplexity] = createSignal(false);
  const [changingDefaultResponseMode, setChangingDefaultResponseMode] = createSignal(false);
  const [changingSpecificityResponseMode, setChangingSpecificityResponseMode] = createSignal(false);
  const complexityEnabled = () => complexityStatus()?.enabled ?? true;

  // ── Routing deprecation gate ──────────────────────────────────────────────
  // Complexity and task-specific routing are being retired. We hide both from
  // agents that never configured them (the "clean" cohort) while keeping them
  // fully visible for agents that already invested in them (the "legacy"
  // cohort). The gate keys off config-presence — not signup date — so long-time
  // users who never touched these features also get the simplified surface.
  // Stickiness is scoped per agent: once an agent reveals a deprecated surface
  // we remember it for that agent (so toggling complexity off mid-session
  // doesn't yank the control away), but the gate compares the remembered agent
  // against the current one, so switching agents re-evaluates from the new
  // agent's own config and never carries a legacy reveal onto a clean agent.
  const [legacyComplexityAgent, setLegacyComplexityAgent] = createSignal<string | null>(null);
  const [legacySpecificityAgent, setLegacySpecificityAgent] = createSignal<string | null>(null);
  createEffect(() => {
    const agent = agentName();
    const hasComplexityConfig =
      (complexityStatus()?.enabled ?? false) ||
      (tiers()?.some((t) => t.tier !== 'default' && t.override_route !== null) ?? false);
    if (hasComplexityConfig) setLegacyComplexityAgent(agent);
    const hasSpecificityConfig =
      specificityAssignments()?.some((a) => a.is_active || a.override_route !== null) ?? false;
    if (hasSpecificityConfig) setLegacySpecificityAgent(agent);
  });
  const legacyComplexityVisible = () => legacyComplexityAgent() === agentName();
  const legacySpecificityVisible = () => legacySpecificityAgent() === agentName();
  const isCleanAgent = () => !legacyComplexityVisible() && !legacySpecificityVisible();

  // For the unified (no-tabs) view: capture openers from HeaderTiersSection
  // so the header button, dashed add-card, and card edit buttons can trigger modals.
  let headerTierOpener: (() => void) | undefined;
  let headerTierCreator: (() => void) | undefined;
  let headerTierEditor: ((tier: HeaderTier) => void) | undefined;

  // Per-route model params, fetched once and threaded down. Scope separates
  // default/complexity tiers, task-specific tiers, and custom header tiers so
  // the same model can have different values in different routing surfaces.
  const [modelParams, { mutate: mutateModelParams }] = createResource(
    () => agentName(),
    (name) => listModelParams(name).catch(() => [] as AgentModelParamsRow[]),
  );
  const modelParamsMap = createMemo(() => {
    const map = new Map<string, RequestParamDefaults>();
    for (const row of modelParams() ?? []) {
      map.set(modelParamsKey(row.scope, row.provider, row.authType, row.model), row.params);
    }
    return map;
  });
  const getModelParamsFor = (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
  ): RequestParamDefaults | null =>
    modelParamsMap().get(modelParamsKey(scope, provider, authType, model)) ?? null;

  const setModelParamsFor = async (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
    next: RequestParamDefaults | null,
  ): Promise<void> => {
    if (next === null) {
      // Dialog returns null when the user collapses back to the provider's
      // natural default. Delete the row so the table stays clean and the
      // dashboard snapshot reflects the provider default, not an explicit
      // override.
      await deleteModelParams(agentName(), { scope, provider, authType, model });
      mutateModelParams((rows) =>
        (rows ?? []).filter(
          (r) =>
            !(
              r.scope === scope &&
              r.provider.toLowerCase() === provider.toLowerCase() &&
              r.authType === authType &&
              r.model === model
            ),
        ),
      );
      return;
    }
    const saved = await setModelParamsApi(agentName(), {
      scope,
      provider,
      authType,
      model,
      params: next,
    });
    mutateModelParams((rows) => {
      const without = (rows ?? []).filter(
        (r) =>
          !(
            r.scope === scope &&
            r.provider.toLowerCase() === provider.toLowerCase() &&
            r.authType === authType &&
            r.model === model
          ),
      );
      return [...without, saved];
    });
  };

  const handleToggleComplexity = async () => {
    const shouldInheritStreaming = defaultResponseMode() === 'stream';
    setTogglingComplexity(true);
    try {
      const result = await toggleComplexity(agentName());
      mutateComplexityStatus(result);
      if (shouldInheritStreaming) {
        await handleDefaultResponseModeChange('stream');
      }
    } catch {
      toast.error('Failed to toggle complexity routing');
    } finally {
      setTogglingComplexity(false);
    }
  };

  const defaultResponseMode = (): ResponseMode => {
    const ids = complexityEnabled() ? STAGES.map((stage) => stage.id) : ['default'];
    return ids.every((id) => actions.getTier(id)?.response_mode === 'stream')
      ? 'stream'
      : 'buffered';
  };

  const handleDefaultResponseModeChange = async (responseMode: ResponseMode) => {
    const ids = complexityEnabled() ? STAGES.map((stage) => stage.id) : ['default'];
    setChangingDefaultResponseMode(true);
    try {
      const updated = await Promise.all(
        ids.map((tier) => setTierResponseMode(agentName(), tier, responseMode)),
      );
      mutateTiers((prev) => {
        const byTier = new Map(updated.map((row) => [row.tier, row]));
        const merged = (prev ?? []).map((row) => byTier.get(row.tier) ?? row);
        for (const row of updated) {
          if (!merged.some((existing) => existing.tier === row.tier)) merged.push(row);
        }
        return merged;
      });
      toast.success(
        responseMode === 'stream'
          ? 'Streaming response mode enabled'
          : 'Buffered response mode enabled',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update response mode');
    } finally {
      setChangingDefaultResponseMode(false);
    }
  };

  const activeSpecificityAssignments = () =>
    specificityAssignments()?.filter((assignment) => assignment.is_active) ?? [];

  const specificityResponseMode = (): ResponseMode => {
    const active = activeSpecificityAssignments();
    return active.length > 0 && active.every((assignment) => assignment.response_mode === 'stream')
      ? 'stream'
      : 'buffered';
  };

  const handleSpecificityResponseModeChange = async (responseMode: ResponseMode) => {
    const active = activeSpecificityAssignments();
    if (active.length === 0) return;
    setChangingSpecificityResponseMode(true);
    try {
      const updated = await Promise.all(
        active.map((assignment) =>
          setSpecificityResponseMode(agentName(), assignment.category, responseMode),
        ),
      );
      mutateSpecificity((prev) => {
        const byCategory = new Map(updated.map((row) => [row.category, row]));
        return prev?.map((row) => byCategory.get(row.category) ?? row);
      });
      toast.success(
        responseMode === 'stream'
          ? 'Streaming response mode enabled'
          : 'Buffered response mode enabled',
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update task-specific response mode',
      );
    } finally {
      setChangingSpecificityResponseMode(false);
    }
  };

  const hasCustomTiersEnabled = () => headerTiers()?.some((t) => t.enabled) ?? false;
  const [dropdownTier, setDropdownTier] = createSignal<string | null>(null);
  const [specificityDropdown, setSpecificityDropdown] = createSignal<string | null>(null);
  const [changingSpecificity, setChangingSpecificity] = createSignal<string | null>(null);
  const [resettingSpecificity, setResettingSpecificity] = createSignal<string | null>(null);
  const [showProviderModal, setShowProviderModal] = createSignal(
    !!(location.state as { openProviders?: boolean } | undefined)?.openProviders ||
      !!customProviderPrefill() ||
      !!providerDeepLink(),
  );
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [responseModeModalOpen, setResponseModeModalOpen] = createSignal(false);
  const [instructionModal, setInstructionModal] = createSignal<'enable' | 'disable' | null>(null);
  const [instructionProvider, setInstructionProvider] = createSignal<string | null>(null);
  const [fallbackPickerTier, setFallbackPickerTier] = createSignal<string | null>(null);
  const [refreshingModels, setRefreshingModels] = createSignal(false);
  const [pricingHealth] = createResource(getPricingHealth);
  const [pricingWarningShown, setPricingWarningShown] = createSignal(false);
  const [wasEnabledBeforeModal, setWasEnabledBeforeModal] = createSignal(false);
  const [hadProvidersBeforeModal, setHadProvidersBeforeModal] = createSignal(false);

  createEffect(() => {
    const health = pricingHealth();
    if (!health) return;
    if (health.model_count > 0) {
      setPricingWarningShown(false);
      return;
    }
    if (pricingWarningShown()) return;
    setPricingWarningShown(true);
    toast.warning('Model pricing data is unavailable. Model cost details may be incomplete.');
  });

  const refetchAll = async () => {
    await Promise.all([
      refetchProviders(),
      refetchCustomProviders(),
      refetchTiers(),
      refetchModels(),
      refetchSpecificity(),
      refetchHeaderTiers(),
      refetchEnabledProviders(),
    ]);
  };

  const actions = createRoutingActions({
    agentName,
    tiers,
    mutateTiers,
    refetchAll,
    setInstructionModal,
  });

  const handleOverride: typeof actions.handleOverride = async (...args) => {
    setDropdownTier(null);
    return actions.handleOverride(...args);
  };

  const hasAnySpecificityActive = () => specificityAssignments()?.some((a) => a.is_active) ?? false;

  const isSpecificityTier = (tierId: string) =>
    specificityAssignments()?.some((a) => a.category === tierId) ?? false;

  const handleAddFallback: typeof actions.handleAddFallback = async (
    tierId,
    modelName,
    providerId,
    authType,
    providerKeyLabel,
  ) => {
    setFallbackPickerTier(null);
    if (isSpecificityTier(tierId)) {
      const sa = specificityAssignments()?.find((a) => a.category === tierId);
      const currentRoutes = sa?.fallback_routes ?? [];
      const current = currentRoutes.map((r) => r.model);
      if (current.includes(modelName)) return;
      const updated = [...current, modelName];
      // Pass explicit (provider, authType, model) routes so the backend can
      // disambiguate when the same model id is offered by multiple connected
      // providers (e.g. OpenAI subscription + OpenAI API key both expose
      // gpt-4o). Without this the backend silently stores nothing.
      const updatedRoutes =
        authType !== undefined
          ? [...currentRoutes, { provider: providerId, authType, model: modelName }]
          : undefined;
      try {
        const { setSpecificityFallbacks } = await import('../services/api.js');
        await setSpecificityFallbacks(agentName(), tierId, updated, updatedRoutes);
        await refetchSpecificity();
        toast.success('Fallback added');
      } catch {
        toast.error('Failed to add fallback');
      }
      return;
    }
    return actions.handleAddFallback(tierId, modelName, providerId, authType, providerKeyLabel);
  };

  const enabledProviderIds = () => new Set(enabledProviders()?.enabled ?? []);
  const enabledConnectedProviders = () =>
    (connectedProviders() ?? []).filter((provider) => enabledProviderIds().has(provider.id));
  const isEnabled = () => enabledConnectedProviders().some((p) => p.is_active);
  const activeProviders = () => enabledConnectedProviders().filter((p) => p.is_active);
  const hasProviders = () => activeProviders().length > 0;
  const hasOverrides = () => tiers()?.some((t) => t.override_route !== null) ?? false;

  const openProviderModal = () => {
    setWasEnabledBeforeModal(isEnabled());
    setHadProvidersBeforeModal((connectedProviders()?.length ?? 0) > 0);
    setShowProviderModal(true);
  };

  const closeProviderModal = () => {
    setShowProviderModal(false);
    if (customProviderPrefill() || providerDeepLink()) {
      setSearchParams({
        provider: undefined,
        name: undefined,
        baseUrl: undefined,
        apiKey: undefined,
        models: undefined,
      });
    }
    if (!wasEnabledBeforeModal() && isEnabled() && hadProvidersBeforeModal()) {
      setInstructionModal('enable');
    }
  };

  const handleProviderUpdate = async () => {
    await refetchAll();
  };

  const handleProviderPoll = async () => {
    await refetchProviders();
  };

  const handleSpecificityOverride = async (
    category: string,
    model: string,
    provider: string,
    authType?: 'api_key' | 'subscription' | 'local',
    providerKeyLabel?: string,
  ) => {
    setChangingSpecificity(category);
    try {
      await overrideSpecificity(agentName(), category, model, provider, authType, providerKeyLabel);
      await refetchSpecificity();
    } catch {
      toast.error('Failed to update specificity model');
    } finally {
      setChangingSpecificity(null);
    }
  };

  /**
   * Pin a task-specific (specificity) tier to a labeled provider key.
   * Re-uses the same PUT endpoint as `handleSpecificityOverride` — the
   * model/provider/auth_type stay the same, only the key label changes.
   */
  const handleSpecificityPinKey = async (
    category: string,
    provider: string,
    providerKeyLabel: string | null,
    authType?: 'api_key' | 'subscription' | 'local',
  ) => {
    const assignment = specificityAssignments()?.find((a) => a.category === category);
    const effective = assignment?.override_route ?? null;
    const model = effective?.model;
    if (!assignment || !model || !provider) return;
    setChangingSpecificity(category);
    try {
      await overrideSpecificity(
        agentName(),
        category,
        model,
        provider,
        authType ?? effective?.authType,
        providerKeyLabel ?? undefined,
      );
      await refetchSpecificity();
      toast.success(providerKeyLabel ? `Pinned to "${providerKeyLabel}" key` : 'Key pin cleared');
    } catch {
      // toast handled upstream
    } finally {
      setChangingSpecificity(null);
    }
  };

  return (
    <div class="container--lg">
      <Title>{agentDisplayName() ?? agentName()} Routing - Manifest</Title>
      <Meta
        name="description"
        content={`Configure model routing for ${agentDisplayName() ?? agentName()}.`}
      />

      <Show
        when={connectedProviders() !== undefined && enabledProviders() !== undefined}
        fallback={<RoutingLoadingSkeleton />}
      >
        <Show when={hasProviders()} fallback={<NoConnectionsPrompt />}>
          {/* Provider icons + action buttons in a single row */}
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
            <Show when={isEnabled()}>
              <ActiveProviderIcons
                activeProviders={activeProviders}
                customProviders={() => customProviders() ?? []}
              />
            </Show>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <Show when={isEnabled()}>
                <button
                  class="btn btn--outline btn--sm"
                  disabled={refreshingModels()}
                  onClick={async () => {
                    setRefreshingModels(true);
                    try {
                      await refreshModels(agentName());
                      refetchModels();
                      refetchTiers();
                      toast.success('Models refreshed');
                    } catch {
                      toast.error('Failed to refresh models');
                    } finally {
                      setRefreshingModels(false);
                    }
                  }}
                >
                  {refreshingModels() ? 'Refreshing...' : 'Refresh models'}
                </button>
              </Show>
              <button class="response-mode-btn" onClick={() => setResponseModeModalOpen(true)}>
                <span class="response-mode-btn__icon">
                  <svg
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
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </span>
                Response mode: {defaultResponseMode() === 'stream' ? 'Stream' : 'Buffered'}
              </button>
            </div>
          </div>

          <Show
            when={!isCleanAgent()}
            fallback={
              <>
                {/* ── Unified view for clean agents (no tabs) ──────── */}
                <div
                  class="routing-section__header routing-section__header--header-tiers"
                  style="margin-bottom: 16px; flex-direction: row; align-items: center; justify-content: space-between;"
                >
                  <div>
                    <span class="routing-section__subtitle">
                      Pick one model and up to 5 fallbacks as your default routing.
                    </span>
                  </div>
                  <Show when={(headerTiers() ?? []).length > 0}>
                    <button
                      type="button"
                      class="btn btn--primary btn--sm routing-section__cta"
                      onClick={() => headerTierOpener?.()}
                    >
                      Manage custom routing
                    </button>
                  </Show>
                  <Show when={(headerTiers() ?? []).length === 0}>
                    <button
                      type="button"
                      class="btn btn--primary btn--sm routing-section__cta"
                      onClick={() => headerTierCreator?.()}
                    >
                      Create custom tier
                    </button>
                  </Show>
                </div>
                <div
                  class="routing-cards"
                  classList={{
                    'routing-cards--unified-compact': !hasCustomTiersEnabled(),
                  }}
                >
                  <RoutingTierCard
                    stage={DEFAULT_STAGE}
                    tier={() => actions.getTier('default')}
                    models={() => models() ?? []}
                    customProviders={() => customProviders() ?? []}
                    activeProviders={activeProviders}
                    tiersLoading={tiers.loading}
                    changingTier={actions.changingTier}
                    resettingTier={actions.resettingTier}
                    resettingAll={actions.resettingAll}
                    addingFallback={actions.addingFallback}
                    agentName={agentName}
                    onDropdownOpen={(tierId) => setDropdownTier(tierId)}
                    onOverride={handleOverride}
                    onPinKey={actions.handlePinKey}
                    onReset={actions.handleReset}
                    onFallbackUpdate={actions.handleFallbackUpdate}
                    onAddFallback={(tierId) => setFallbackPickerTier(tierId)}
                    getFallbacksFor={actions.getFallbacksFor}
                    connectedProviders={enabledConnectedProviders}
                    getModelParams={getModelParamsFor}
                    setModelParams={setModelParamsFor}
                  />
                  <For each={(headerTiers() ?? []).filter((t) => t.enabled)}>
                    {(tier) => (
                      <HeaderTierCard
                        agentName={agentName()}
                        tier={tier}
                        models={models() ?? []}
                        customProviders={customProviders() ?? []}
                        connectedProviders={enabledConnectedProviders()}
                        onOverride={async (m, p, a, label) => {
                          try {
                            await overrideHeaderTier(agentName(), tier.id, m, p, a, label);
                            await refetchHeaderTiers();
                          } catch (err) {
                            toast.error(
                              err instanceof Error ? err.message : 'Failed to update tier',
                            );
                          }
                        }}
                        onFallbacksUpdate={(_fallbacks, updatedRoutes) => {
                          if (updatedRoutes === undefined) {
                            void refetchHeaderTiers();
                            return;
                          }
                          mutateHeaderTiers((prev) =>
                            prev?.map((t) =>
                              t.id === tier.id ? { ...t, fallback_routes: updatedRoutes } : t,
                            ),
                          );
                        }}
                        onEdit={() => headerTierEditor?.(tier)}
                        onDisable={async () => {
                          try {
                            await toggleHeaderTier(agentName(), tier.id, false);
                            await refetchHeaderTiers();
                          } catch (err) {
                            toast.error(
                              err instanceof Error ? err.message : 'Failed to toggle tier',
                            );
                          }
                        }}
                        getModelParams={getModelParamsFor}
                        setModelParams={setModelParamsFor}
                      />
                    )}
                  </For>
                  {/* Dashed add-card */}
                  <button
                    type="button"
                    class="routing-card routing-unified-add-card"
                    onClick={() => headerTierCreator?.()}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="m21,4h-1v-1c0-.55-.45-1-1-1s-1,.45-1,1v1h-1c-.55,0-1,.45-1,1s.45,1,1,1h1v1c0,.55.45,1,1,1s1-.45,1-1v-1h1c.55,0,1-.45,1-1s-.45-1-1-1Z" />
                      <path d="m3.24,16.5c0,.76.42,1.45,1.11,1.79l5.87,2.93c.56.28,1.18.42,1.79.42s1.23-.14,1.79-.42l5.87-2.93c.68-.34,1.11-1.03,1.11-1.79s-.42-1.45-1.11-1.79l-.42-.21.42-.21c.68-.34,1.11-1.03,1.11-1.79,0-.76-.42-1.45-1.11-1.79l-5.87-2.93c-1.12-.56-2.46-.56-3.58,0l-5.87,2.93c-.68.34-1.11,1.03-1.11,1.79,0,.76.42,1.45,1.11,1.79l.42.21-.42.21c-.68.34-1.11,1.03-1.11,1.79Zm2-4l5.87-2.93c.28-.14.59-.21.89-.21s.61.07.89.21l5.88,2.93-5.88,2.94c-.56.28-1.23.28-1.79,0l-4.11-2.05-1.76-.88Zm4.97,4.72c1.12.56,2.46.56,3.58,0l3.21-1.61,1.77.88-5.88,2.94c-.56.28-1.23.28-1.79,0l-5.87-2.93,1.76-.88,3.21,1.61Z" />
                    </svg>
                    <span>Create custom tier</span>
                  </button>
                </div>
                {/* Headless section for modals only */}
                <RoutingHeaderTiersSection
                  agentName={agentName}
                  models={() => models() ?? []}
                  customProviders={() => customProviders() ?? []}
                  connectedProviders={enabledConnectedProviders}
                  externalTiers={() => headerTiers()}
                  externalRefetch={() => void refetchHeaderTiers()}
                  externalMutate={mutateHeaderTiers}
                  headless
                  onOpenRef={(opener) => {
                    headerTierOpener = opener;
                  }}
                  onCreateRef={(opener) => {
                    headerTierCreator = opener;
                  }}
                  onEditRef={(opener) => {
                    headerTierEditor = opener;
                  }}
                  getModelParams={getModelParamsFor}
                  setModelParams={setModelParamsFor}
                />
              </>
            }
          >
            <RoutingTabs
              specificityEnabled={hasAnySpecificityActive}
              customEnabled={hasCustomTiersEnabled}
              showSpecificity={legacySpecificityVisible}
              pipelineHelp={() =>
                buildPipelineHelp(
                  hasAnySpecificityActive(),
                  hasCustomTiersEnabled(),
                  complexityEnabled(),
                )
              }
            >
              {{
                default: (
                  <RoutingDefaultTierSection
                    agentName={agentName}
                    tier={() => actions.getTier('default')}
                    models={() => models() ?? []}
                    customProviders={() => customProviders() ?? []}
                    activeProviders={activeProviders}
                    connectedProviders={enabledConnectedProviders}
                    tiersLoading={tiers.loading}
                    changingTier={actions.changingTier}
                    resettingTier={actions.resettingTier}
                    resettingAll={actions.resettingAll}
                    addingFallback={actions.addingFallback}
                    onDropdownOpen={(tierId) => setDropdownTier(tierId)}
                    onOverride={handleOverride}
                    onPinKey={actions.handlePinKey}
                    onReset={actions.handleReset}
                    onFallbackUpdate={actions.handleFallbackUpdate}
                    onAddFallback={(tierId) => setFallbackPickerTier(tierId)}
                    getFallbacksFor={actions.getFallbacksFor}
                    getTier={actions.getTier}
                    complexityEnabled={complexityEnabled}
                    togglingComplexity={togglingComplexity}
                    onToggleComplexity={handleToggleComplexity}
                    showComplexityToggle={legacyComplexityVisible}
                    responseMode={defaultResponseMode}
                    changingResponseMode={changingDefaultResponseMode}
                    onResponseModeChange={handleDefaultResponseModeChange}
                    embedded
                    getModelParams={getModelParamsFor}
                    setModelParams={setModelParamsFor}
                  />
                ),
                specificity: (
                  <RoutingSpecificitySection
                    agentName={agentName}
                    assignments={specificityAssignments}
                    models={() => models() ?? []}
                    customProviders={() => customProviders() ?? []}
                    activeProviders={activeProviders}
                    connectedProviders={enabledConnectedProviders}
                    changingTier={changingSpecificity}
                    resettingTier={resettingSpecificity}
                    resettingAll={() => false}
                    addingFallback={() => null}
                    onDropdownOpen={(category) => setSpecificityDropdown(category)}
                    onOverride={handleSpecificityOverride}
                    onPinKey={handleSpecificityPinKey}
                    onReset={async (category) => {
                      setResettingSpecificity(category);
                      try {
                        await resetSpecificity(agentName(), category);
                        await refetchSpecificity();
                      } catch {
                        toast.error('Failed to reset');
                      } finally {
                        setResettingSpecificity(null);
                      }
                    }}
                    onFallbackUpdate={(category, _updatedFallbacks, updatedRoutes) => {
                      if (updatedRoutes === undefined) return;
                      mutateSpecificity((prev) =>
                        prev?.map((a) =>
                          a.category === category ? { ...a, fallback_routes: updatedRoutes } : a,
                        ),
                      );
                    }}
                    onAddFallback={(category) => setFallbackPickerTier(category)}
                    responseMode={specificityResponseMode}
                    changingResponseMode={changingSpecificityResponseMode}
                    onResponseModeChange={handleSpecificityResponseModeChange}
                    refetchAll={refetchAll}
                    refetchSpecificity={() => refetchSpecificity() as unknown as Promise<void>}
                    embedded
                    getModelParams={getModelParamsFor}
                    setModelParams={setModelParamsFor}
                  />
                ),
                custom: (
                  <RoutingHeaderTiersSection
                    agentName={agentName}
                    models={() => models() ?? []}
                    customProviders={() => customProviders() ?? []}
                    connectedProviders={enabledConnectedProviders}
                    externalTiers={() => headerTiers()}
                    externalRefetch={() => void refetchHeaderTiers()}
                    externalMutate={mutateHeaderTiers}
                    embedded
                    getModelParams={getModelParamsFor}
                    setModelParams={setModelParamsFor}
                  />
                ),
              }}
            </RoutingTabs>
          </Show>

          <RoutingFooter
            hasOverrides={hasOverrides}
            resettingAll={actions.resettingAll}
            resettingTier={actions.resettingTier}
            onResetAll={actions.handleResetAll}
            onShowInstructions={() => setInstructionModal('enable')}
            onShowHowRoutingWorks={() => setHelpOpen(true)}
          />

          <Show when={helpOpen()}>
            {(() => {
              const content = buildPipelineHelp(
                hasAnySpecificityActive(),
                hasCustomTiersEnabled(),
                complexityEnabled(),
              );
              if (!content) return null;
              return (
                <div
                  class="modal-overlay"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setHelpOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setHelpOpen(false);
                  }}
                >
                  <div
                    class="modal-card"
                    style="max-width: 480px;"
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h2 style="margin: 0 0 16px; font-size: var(--font-size-lg); font-weight: 600;">
                      How routing works
                    </h2>
                    {content}
                    <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
                      <button class="btn btn--primary btn--sm" onClick={() => setHelpOpen(false)}>
                        Got it
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}
          </Show>
        </Show>
      </Show>

      <Show when={responseModeModalOpen()}>
        <ResponseModeModal
          responseMode={defaultResponseMode}
          onResponseModeChange={async (mode) => {
            await handleDefaultResponseModeChange(mode);
          }}
          disabled={changingDefaultResponseMode}
          tiers={tiers() ?? []}
          models={models() ?? []}
          onClose={() => setResponseModeModalOpen(false)}
          onReplace={(tierId) => {
            setResponseModeModalOpen(false);
            setDropdownTier(tierId);
          }}
        />
      </Show>

      <RoutingModals
        agentName={agentName}
        dropdownTier={dropdownTier}
        onDropdownClose={() => setDropdownTier(null)}
        specificityDropdown={specificityDropdown}
        onSpecificityDropdownClose={() => setSpecificityDropdown(null)}
        onSpecificityOverride={(category, model, provider, authType) => {
          setSpecificityDropdown(null);
          void handleSpecificityOverride(category, model, provider, authType);
        }}
        fallbackPickerTier={fallbackPickerTier}
        onFallbackPickerClose={() => setFallbackPickerTier(null)}
        showProviderModal={showProviderModal}
        onProviderModalClose={closeProviderModal}
        customProviderPrefill={customProviderPrefill()}
        providerDeepLink={providerDeepLink()}
        instructionModal={instructionModal}
        instructionProvider={instructionProvider}
        onInstructionClose={() => {
          setInstructionModal(null);
          setInstructionProvider(null);
        }}
        models={() => models() ?? []}
        tiers={() => tiers() ?? []}
        specificityAssignments={() => specificityAssignments() ?? []}
        customProviders={() => customProviders() ?? []}
        connectedProviders={enabledConnectedProviders}
        getTier={(tierId) => {
          const generalist = actions.getTier(tierId);
          if (generalist) return generalist;
          const sa = specificityAssignments()?.find((a) => a.category === tierId);
          return sa ? { ...sa, tier: sa.category } : undefined;
        }}
        onOverride={handleOverride}
        onAddFallback={handleAddFallback}
        onProviderUpdate={handleProviderUpdate}
        onProviderPoll={handleProviderPoll}
      />

      <SetupModal
        open={setupOpen()}
        agentName={agentName()}
        apiKey={(location.state as { newApiKey?: string } | undefined)?.newApiKey ?? null}
        agentPlatform={agentPlatform()}
        agentCategory={agentCategory()}
        onClose={() => {
          localStorage.setItem(`setup_dismissed_${params.agentName}`, '1');
          clearSetupPending(agentName());
          setSetupOpen(false);
        }}
        onDone={() => {
          localStorage.setItem(`setup_completed_${params.agentName}`, '1');
          clearSetupPending(agentName());
          setSetupOpen(false);
        }}
      />
    </div>
  );
};

export default Routing;
