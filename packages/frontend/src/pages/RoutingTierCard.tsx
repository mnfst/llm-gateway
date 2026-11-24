import { createSignal, Show, type Component } from 'solid-js';
import { PROVIDERS } from '../services/providers.js';
import type { StageDef } from '../services/providers.js';
import { getModelLabel } from '../services/provider-utils.js';
import { providerIcon, customProviderLogo } from '../components/ProviderIcon.js';
import { authBadgeFor } from '../components/AuthBadge.js';
import {
  pricePerM,
  resolveProviderId,
  inferProviderFromModel,
  usedKeyLabelsForModelInTier,
} from '../services/routing-utils.js';
import { customProviderColor, formatPerRequestCost } from '../services/formatters.js';
import FallbackList from '../components/FallbackList.js';
import ModelParamsAffordance from '../components/ModelParamsAffordance.jsx';
import RouteKeyChip from '../components/RouteKeyChip.js';
import { setFallbacks as setFallbacksApi } from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { modelParamsScopeForTier } from 'manifest-shared';
import type {
  TierAssignment,
  AvailableModel,
  AuthType,
  ModelRoute,
  RequestParamDefaults,
  RoutingProvider,
  CustomProviderData,
} from '../services/api.js';

/** @internal Exported for testing only. */
export function providerIdForModel(model: string, apiModels: AvailableModel[]): string | undefined {
  const m =
    apiModels.find((x) => x.model_name === model) ??
    apiModels.find((x) => x.model_name.startsWith(model + '-'));
  if (m) {
    const dbId = resolveProviderId(m.provider);
    // OpenRouter is the one provider where the vendor prefix is genuinely the
    // best attribution: an OR row for `anthropic/claude-…` should show the
    // Anthropic logo, not the OpenRouter logo. For every other registered
    // first-party provider the stored `m.provider` is the truth — Groq's
    // `qwen/qwen3-32b` is being served BY Groq, so it must show the Groq
    // logo (and use Groq's pricing) regardless of the model-id prefix.
    if (dbId && dbId !== 'openrouter' && PROVIDERS.find((p) => p.id === dbId)) {
      return dbId;
    }
    const prefixId = inferProviderFromModel(m.model_name);
    if (prefixId && PROVIDERS.find((p) => p.id === prefixId)) return prefixId;
    return dbId ?? prefixId;
  }
  const prefix = inferProviderFromModel(model);
  if (prefix && PROVIDERS.find((p) => p.id === prefix)) return prefix;
  for (const prov of PROVIDERS) {
    if (
      prov.models.some(
        (pm) =>
          pm.value === model ||
          model.startsWith(pm.value + '-') ||
          pm.value.startsWith(model + '-'),
      )
    ) {
      return prov.id;
    }
  }
  return undefined;
}

export interface RoutingTierCardProps {
  stage: StageDef;
  tier: () => TierAssignment | undefined;
  models: () => AvailableModel[];
  customProviders: () => CustomProviderData[];
  activeProviders: () => RoutingProvider[];
  tiersLoading: boolean;
  changingTier: () => string | null;
  resettingTier: () => string | null;
  resettingAll: () => boolean;
  addingFallback: () => string | null;
  agentName: () => string;
  onDropdownOpen: (tierId: string) => void;
  onOverride: (
    tierId: string,
    model: string,
    providerId: string,
    authType?: AuthType,
    providerKeyLabel?: string,
  ) => void;
  onPinKey?: (
    tierId: string,
    providerId: string,
    providerKeyLabel: string | null,
    authType?: AuthType,
  ) => void;
  onReset: (tierId: string) => void;
  onFallbackUpdate: (
    tierId: string,
    fallbacks: string[],
    fallbackRoutes?: ModelRoute[] | null,
  ) => void;
  onAddFallback: (tierId: string) => void;
  getFallbacksFor: (tierId: string) => string[];
  connectedProviders: () => RoutingProvider[];
  persistFallbacks?: (
    agentName: string,
    tier: string,
    models: string[],
    routes?: ModelRoute[],
  ) => Promise<unknown>;
  persistClearFallbacks?: (agentName: string, tier: string) => Promise<unknown>;
  /**
   * Read saved per-route params from the parent's loaded map. The
   * affordance reads through this so saving in one slot reflects on every
   * other slot that resolves to the same `(provider, authType, model)`.
   */
  getModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
  ) => RequestParamDefaults | null;
  /**
   * Persist new params for a single route. Parent owns the server call
   * and the local cache update; the card just threads the callback down.
   */
  setModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
    params: RequestParamDefaults | null,
  ) => Promise<unknown>;
}

const effectiveRoute = (
  t: TierAssignment,
): { provider: string; authType: AuthType; model: string } | null => t.override_route;

const effectiveModel = (t: TierAssignment): string | null => effectiveRoute(t)?.model ?? null;

const RoutingTierCard: Component<RoutingTierCardProps> = (props) => {
  const eff = () => {
    const t = props.tier();
    return t ? effectiveModel(t) : null;
  };
  const manualProviderId = () => {
    const t = props.tier();
    return t?.override_route?.provider;
  };
  const isManual = () => props.tier()?.override_route != null;
  const hasFallbacks = () => (props.tier()?.fallback_routes ?? []).length > 0;
  const hasCustomizations = () => isManual() || hasFallbacks();
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [primaryDragging, setPrimaryDragging] = createSignal(false);
  const [fallbackDragging, setFallbackDragging] = createSignal<number | null>(null);
  const [primaryDropTarget, setPrimaryDropTarget] = createSignal(false);
  const [swappingFbIndex, setSwappingFbIndex] = createSignal<number | null>(null);
  // Set while FallbackList persists a reorder. The primary chip is a drag
  // source into that same list, so it stays locked until the write lands.
  const [fallbackReordering, setFallbackReordering] = createSignal(false);

  const handlePrimaryDragStart = (e: DragEvent) => {
    setPrimaryDragging(true);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'primary');
      e.dataTransfer.setData('application/x-primary', 'true');
    }
  };

  const handlePrimaryDragEnd = () => {
    setPrimaryDragging(false);
    setPrimaryDropTarget(false);
  };

  const handlePrimaryDragOver = (e: DragEvent) => {
    if (fallbackDragging() === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setPrimaryDropTarget(true);
  };

  const handlePrimaryDragLeave = () => {
    setPrimaryDropTarget(false);
  };

  const handlePrimaryDrop = (e: DragEvent) => {
    e.preventDefault();
    setPrimaryDropTarget(false);
    const fbIndex = fallbackDragging();
    if (fbIndex === null) return;
    setFallbackDragging(null);
    swapPrimaryWithFallback(fbIndex);
  };

  const handlePrimaryDropAtSlot = async (slot: number) => {
    const tier = props.tier();
    if (!tier) return;
    const currentModel = eff();
    if (!currentModel) return;
    setSwappingFbIndex(slot > 0 ? slot - 1 : 0);
    // Carry the full primary route through the swap. Without this, the same
    // model name on a different auth (subscription vs api_key) collapses back
    // to "first match in discovery" when the backend rebuilds fallback_routes
    // — and the UI ends up rendering a ghost row whose auth no longer matches.
    const currentRoute = effectiveRoute(tier);
    const fallbacks = props.getFallbacksFor(props.stage.id);
    const fallbackRoutes = tier.fallback_routes ?? null;
    // Build the unified list: insert current primary at drop slot
    const newFallbacks = [...fallbacks];
    newFallbacks.splice(slot, 0, currentModel);
    const newPrimary = newFallbacks.shift()!;
    if (newPrimary === currentModel && slot === 0) {
      setSwappingFbIndex(null);
      return;
    } // no-op
    // Build the parallel route list when we have full coverage. The route
    // shape carries `keyLabel`, so multi-key pins ride along with the swap
    // automatically — primary→fallback or fallback→primary keeps the same
    // (provider, authType, model, keyLabel) tuple. If any fallback predates
    // the dual-write migration we drop to the bare model-name persist.
    const buildRoutes = (): typeof fallbackRoutes => {
      if (!currentRoute || !fallbackRoutes || fallbackRoutes.length !== fallbacks.length) {
        return null;
      }
      const next = [...fallbackRoutes];
      next.splice(slot, 0, currentRoute);
      next.shift();
      return next;
    };
    const newRoutes = buildRoutes();
    // Resolve the new primary's route for the override call.
    const newPrimaryRoute =
      newRoutes && newRoutes.length === newFallbacks.length
        ? // newPrimary came from position 0 of the post-splice list, which
          // corresponds to the original fallback at the same slot
          fallbackRoutes![0]
        : null;
    // Optimistic update: set BOTH model names and routes so the FallbackList
    // doesn't render new names against stale fallback_routes (causes a gray
    // ghost row when the routes describe a different auth than the new model).
    props.onFallbackUpdate(props.stage.id, newFallbacks, newRoutes);
    try {
      const persistFn = props.persistFallbacks ?? setFallbacksApi;
      await persistFn(props.agentName(), props.stage.id, newFallbacks, newRoutes ?? undefined);
    } catch {
      props.onFallbackUpdate(props.stage.id, fallbacks, fallbackRoutes);
      toast.error('Failed to update fallbacks');
      setSwappingFbIndex(null);
      return;
    }
    const provId = newPrimaryRoute?.provider ?? providerIdForModel(newPrimary, props.models());
    try {
      await props.onOverride(
        props.stage.id,
        newPrimary,
        provId ?? '',
        newPrimaryRoute?.authType,
        newPrimaryRoute?.keyLabel ?? undefined,
      );
    } finally {
      setSwappingFbIndex(null);
    }
  };

  const swapPrimaryWithFallback = async (fbIndex: number) => {
    const tier = props.tier();
    if (!tier) return;
    const currentModel = eff();
    if (!currentModel) return;
    setSwappingFbIndex(fbIndex);
    const currentRoute = effectiveRoute(tier);
    const fallbacks = props.getFallbacksFor(props.stage.id);
    const fbModel = fallbacks[fbIndex];
    if (!fbModel) {
      setSwappingFbIndex(null);
      return;
    }
    const fallbackRoutes = tier.fallback_routes ?? null;
    const fbRoute = fallbackRoutes?.[fbIndex] ?? null;
    // Swap: fallback model goes to primary, current primary takes its place.
    // Carry routes alongside model names so same-name-different-auth swaps
    // don't collapse to a single auth on persist. The route shape carries
    // `keyLabel`, so the multi-key pin rides along with this swap too —
    // SebConejo flagged that drag-drop should preserve the API key, and the
    // ModelRoute structure makes this happen naturally.
    const newFallbacks = [...fallbacks];
    newFallbacks[fbIndex] = currentModel;
    const newRoutes =
      fallbackRoutes && currentRoute && fallbackRoutes.length === fallbacks.length
        ? fallbackRoutes.map((r, i) => (i === fbIndex ? currentRoute : r))
        : null;
    props.onFallbackUpdate(props.stage.id, newFallbacks, newRoutes);
    try {
      const persistFn = props.persistFallbacks ?? setFallbacksApi;
      await persistFn(props.agentName(), props.stage.id, newFallbacks, newRoutes ?? undefined);
    } catch {
      props.onFallbackUpdate(props.stage.id, fallbacks, fallbackRoutes);
      toast.error('Failed to update fallbacks');
      setSwappingFbIndex(null);
      return;
    }
    const provId = fbRoute?.provider ?? providerIdForModel(fbModel, props.models());
    try {
      await props.onOverride(
        props.stage.id,
        fbModel,
        provId ?? '',
        fbRoute?.authType,
        fbRoute?.keyLabel ?? undefined,
      );
    } finally {
      setSwappingFbIndex(null);
    }
  };

  const modelInfo = (modelName: string): AvailableModel | undefined => {
    const all = props.models();
    return (
      all.find((m) => m.model_name === modelName) ??
      all.find((m) => m.model_name.startsWith(modelName + '-'))
    );
  };

  const labelFor = (modelName: string): string => {
    const info = modelInfo(modelName);
    if (info) {
      if (info.display_name) {
        const provName = info.provider_display_name;
        return provName ? `${provName} / ${info.display_name}` : info.display_name;
      }
      const prefixId = inferProviderFromModel(modelName);
      const provId =
        prefixId && PROVIDERS.find((p) => p.id === prefixId)
          ? prefixId
          : resolveProviderId(info.provider);
      if (provId) return getModelLabel(provId, modelName);
    }
    return modelName;
  };

  const priceLabel = (modelName: string): string => {
    const info = modelInfo(modelName);
    if (!info) return '';
    return `${pricePerM(info.input_price_per_token)} in · ${pricePerM(info.output_price_per_token)} out per 1M`;
  };

  const modelCapabilities = (modelName: string) => modelInfo(modelName)?.capabilities;
  const isStreamMode = () => props.tier()?.response_mode === 'stream';

  return (
    <div class="routing-card">
      <div class="routing-card__header">
        <span class="routing-card__tier">{props.stage.label}</span>
        <Show when={hasCustomizations()}>
          <button
            class="routing-card__header-action routing-card__header-action--danger"
            onClick={() => setConfirmReset(true)}
            disabled={props.resettingTier() === props.stage.id || props.resettingAll()}
          >
            {props.resettingTier() === props.stage.id ? (
              <span class="spinner" style="width: 12px; height: 12px;" />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="m7.77,12.97c.49.41,1.23.06,1.23-.58v-2.4h6c2.21,0,4,1.79,4,4v5c0,.55.45,1,1,1s1-.45,1-1v-5c0-3.31-2.69-6-6-6h-6v-2.4c0-.64-.74-.98-1.23-.58l-4.08,3.4c-.36.3-.36.85,0,1.15l4.08,3.4Z" />
              </svg>
            )}
            Reset
          </button>
        </Show>
        <Show when={!eff() && !props.tiersLoading}>
          <button
            class="routing-card__header-add"
            onClick={() => props.onDropdownOpen(props.stage.id)}
          >
            + Add model
          </button>
        </Show>
      </div>
      <Show
        when={!props.tiersLoading}
        fallback={
          <div class="routing-card__body">
            <div class="routing-card__model-chip">
              <div class="routing-card__chip-main">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <div
                    class="skeleton"
                    style="width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;"
                  />
                  <div class="skeleton skeleton--text" style="width: 120px;" />
                </div>
              </div>
              <div class="routing-card__chip-footer">
                <div class="skeleton skeleton--text" style="width: 150px; height: 12px;" />
              </div>
            </div>
          </div>
        }
      >
        <div class="routing-card__body">
          <Show when={eff()} fallback={null}>
            {(modelName) => {
              const provId = () =>
                manualProviderId() ?? providerIdForModel(modelName(), props.models());
              const primarySkipped = () =>
                isStreamMode() && !(modelCapabilities(modelName())?.includes('stream') ?? false);
              const effectiveAuth = (): AuthType | null => {
                const t = props.tier();
                const route = t ? effectiveRoute(t) : null;
                if (route?.authType) return route.authType;
                const id = provId();
                if (!id) return null;
                const provs = props
                  .activeProviders()
                  .filter((p) => p.provider.toLowerCase() === id.toLowerCase());
                if (provs.some((p) => p.auth_type === 'subscription')) return 'subscription';
                if (provs.some((p) => p.auth_type === 'api_key')) return 'api_key';
                return null;
              };
              const isSwapping = () =>
                swappingFbIndex() !== null || props.changingTier() === props.stage.id;
              return (
                <>
                  <Show
                    when={!isSwapping()}
                    fallback={
                      <div class="routing-card__model-chip">
                        <div class="routing-card__chip-main">
                          <div style="display: flex; align-items: center; gap: 8px;">
                            <div
                              class="skeleton"
                              style="width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;"
                            />
                            <div class="skeleton skeleton--text" style="width: 120px;" />
                          </div>
                        </div>
                        <div class="routing-card__chip-footer">
                          <div
                            class="skeleton skeleton--text"
                            style="width: 150px; height: 12px;"
                          />
                        </div>
                      </div>
                    }
                  >
                    <div
                      class="routing-card__model-chip"
                      classList={{
                        'routing-card__model-chip--dragging': primaryDragging(),
                        'routing-card__model-chip--drop-target': primaryDropTarget(),
                        'routing-card__model-chip--skipped': primarySkipped(),
                      }}
                      title={primarySkipped() ? 'Skipped while Stream mode is active' : undefined}
                      draggable={!fallbackReordering()}
                      onDragStart={handlePrimaryDragStart}
                      onDragEnd={handlePrimaryDragEnd}
                      onDragOver={handlePrimaryDragOver}
                      onDragLeave={handlePrimaryDragLeave}
                      onDrop={handlePrimaryDrop}
                    >
                      <div class="routing-card__chip-main">
                        <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                          <div class="routing-card__override">
                            <Show
                              when={provId()?.startsWith('custom:')}
                              fallback={
                                <Show when={provId()}>
                                  {(p) => (
                                    <span class="routing-card__override-icon">
                                      {providerIcon(p(), 14)}
                                      {authBadgeFor(effectiveAuth(), 8)}
                                    </span>
                                  )}
                                </Show>
                              }
                            >
                              {(() => {
                                const cp = () =>
                                  props
                                    .customProviders()
                                    ?.find((c) => `custom:${c.id}` === provId());
                                const logo = () => {
                                  const c = cp();
                                  return c
                                    ? customProviderLogo(c.name, 14, c.base_url, modelName())
                                    : null;
                                };
                                return (
                                  <span class="routing-card__override-icon">
                                    <Show
                                      when={logo()}
                                      fallback={
                                        <span
                                          class="provider-card__logo-letter"
                                          style={{
                                            background: customProviderColor(cp()?.name ?? 'C'),
                                            width: '14px',
                                            height: '14px',
                                            'font-size': '8px',
                                            'border-radius': '50%',
                                          }}
                                        >
                                          {(cp()?.name ?? 'C').charAt(0).toUpperCase()}
                                        </span>
                                      }
                                    >
                                      {logo()}
                                    </Show>
                                  </span>
                                );
                              })()}
                            </Show>
                            <span class="routing-card__main">{labelFor(modelName())}</span>
                            <Show when={!isManual()}>
                              <span class="routing-card__auto-tag">auto</span>
                            </Show>
                          </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                          <PrimaryKeyChip
                            tier={props.tier}
                            provId={provId}
                            effectiveAuth={effectiveAuth}
                            connectedProviders={props.connectedProviders}
                            modelLabel={labelFor(modelName())}
                            modelName={modelName}
                            onPinKey={(label) => {
                              const id = provId();
                              if (!id) return;
                              props.onPinKey?.(
                                props.stage.id,
                                id,
                                label,
                                effectiveAuth() ?? undefined,
                              );
                            }}
                            disabled={() => props.changingTier() === props.stage.id}
                          />
                          <Show
                            when={props.setModelParams && props.getModelParams && effectiveAuth()}
                          >
                            <ModelParamsAffordance
                              provider={provId()}
                              authType={effectiveAuth() ?? undefined}
                              model={modelName()}
                              slotLabel={labelFor(modelName())}
                              scope={modelParamsScopeForTier(props.stage.id)}
                              agentName={props.agentName()}
                              getParams={props.getModelParams!}
                              setParams={props.setModelParams!}
                              disabled={props.changingTier() === props.stage.id}
                            />
                          </Show>
                          <button
                            class="routing-card__chip-action"
                            onClick={() => props.onDropdownOpen(props.stage.id)}
                            disabled={props.changingTier() === props.stage.id}
                            aria-label={`Change model for ${props.stage.label}`}
                          >
                            <span class="routing-tooltip">Change</span>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="12"
                              height="12"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path d="M5 21h14c1.1 0 2-.9 2-2v-7h-2v7H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2" />
                              <path d="M7 13v3c0 .55.45 1 1 1h3c.27 0 .52-.11.71-.29l9-9a.996.996 0 0 0 0-1.41l-3-3a.996.996 0 0 0-1.41 0l-9.01 8.99A1 1 0 0 0 7 13m10-7.59L18.59 7 17.5 8.09 15.91 6.5zm-8 8 5.5-5.5 1.59 1.59-5.5 5.5H9z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div class="routing-card__chip-footer">
                        <Show
                          when={effectiveAuth() !== 'subscription'}
                          fallback={
                            <span class="routing-card__chip-meta">
                              <span class="routing-card__chip-price">
                                {formatPerRequestCost(modelInfo(modelName())?.cost_per_request) ??
                                  'Included in subscription'}
                              </span>
                              <Show when={primarySkipped()}>
                                <span class="routing-card__skipped-badge">Skipped in Stream</span>
                              </Show>
                            </span>
                          }
                        >
                          <span class="routing-card__chip-meta">
                            <span class="routing-card__chip-price">{priceLabel(modelName())}</span>
                            <Show when={primarySkipped()}>
                              <span class="routing-card__skipped-badge">Skipped in Stream</span>
                            </Show>
                          </span>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </>
              );
            }}
          </Show>
        </div>
        <Show when={eff()}>
          <div class="routing-card__right">
            <FallbackList
              agentName={props.agentName()}
              tier={props.stage.id}
              tierData={props.tier}
              fallbacks={props.getFallbacksFor(props.stage.id)}
              fallbackRoutes={props.tier()?.fallback_routes ?? null}
              models={props.models()}
              customProviders={props.customProviders()}
              connectedProviders={props.activeProviders()}
              onUpdate={(updatedFallbacks, updatedRoutes) =>
                // Thread routes through optimistic state so the UI doesn't
                // render the new model list against stale fallback_routes
                // (the gray "ghost row" bug for same-name-different-auth).
                props.onFallbackUpdate(props.stage.id, updatedFallbacks, updatedRoutes)
              }
              onAddFallback={() => props.onAddFallback(props.stage.id)}
              adding={props.addingFallback() === props.stage.id}
              primaryDragging={primaryDragging()}
              onPrimaryDropAtSlot={handlePrimaryDropAtSlot}
              onFallbackDragStart={(index) => setFallbackDragging(index)}
              onFallbackDragEnd={() => setFallbackDragging(null)}
              persistFallbacks={props.persistFallbacks}
              persistClearFallbacks={props.persistClearFallbacks}
              getModelParams={props.getModelParams}
              setModelParams={props.setModelParams}
              swappingIndex={swappingFbIndex()}
              onReorderingChange={setFallbackReordering}
              modelParamsScope={modelParamsScopeForTier(props.stage.id)}
              responseMode={props.tier()?.response_mode ?? 'buffered'}
            />
          </div>
        </Show>
      </Show>

      <Show when={confirmReset()}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmReset(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirmReset(false);
          }}
        >
          <div
            class="modal-card"
            style="max-width: 420px;"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-tier-modal-title"
          >
            <h2
              id="reset-tier-modal-title"
              style="margin: 0 0 12px; font-size: var(--font-size-lg); font-weight: 600;"
            >
              Reset tier?
            </h2>
            <p style="margin: 0 0 20px; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); line-height: 1.5;">
              This will clear the model override and remove all fallback models for this tier.
            </p>
            <div style="display: flex; justify-content: flex-end; gap: 8px;">
              <button class="btn btn--outline" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                class="btn btn--danger"
                disabled={props.resettingTier() === props.stage.id}
                onClick={() => {
                  setConfirmReset(false);
                  props.onReset(props.stage.id);
                }}
              >
                {props.resettingTier() === props.stage.id ? <span class="spinner" /> : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

/**
 * Compact inline chip for the primary model row that shows the currently-
 * pinned provider key and lets the user change it without leaving the card.
 * Mirrors the pill on each fallback row so multi-key users see a consistent
 * affordance across primary + fallbacks. Renders nothing when only one key
 * exists for the provider — single-key users never see it.
 */
interface PrimaryKeyChipProps {
  tier: () => TierAssignment | undefined;
  provId: () => string | undefined;
  effectiveAuth: () => AuthType | null;
  connectedProviders: () => RoutingProvider[];
  modelLabel: string;
  modelName: () => string;
  onPinKey: (label: string | null) => void;
  disabled: () => boolean;
}

const PrimaryKeyChip: Component<PrimaryKeyChipProps> = (props) => {
  const keys = () => {
    const id = props.provId();
    const auth = props.effectiveAuth();
    if (!id || !auth || auth === 'local') return [];
    return props
      .connectedProviders()
      .filter(
        (p) =>
          p.provider.toLowerCase() === id.toLowerCase() &&
          p.auth_type === auth &&
          p.is_active &&
          p.has_api_key,
      )
      .slice()
      .sort((a, b) => a.priority - b.priority);
  };

  // The pinned key label lives inside the explicit primary route's `keyLabel`
  // field. When no pin is set, fall back to the first connected key.
  const pinned = () => {
    const t = props.tier();
    const effective = t?.override_route ?? null;
    return effective?.keyLabel ?? null;
  };

  const usedByFallbacks = () =>
    usedKeyLabelsForModelInTier(props.tier(), props.modelName(), 'primary', keys()[0]?.label);

  return (
    <Show when={keys().length > 1}>
      <RouteKeyChip
        keys={keys()}
        currentLabel={pinned()}
        modelLabel={props.modelLabel}
        usedLabels={usedByFallbacks}
        buttonClass="routing-card__key-chip"
        disabled={props.disabled()}
        leadingMargin
        menuMinWidth={140}
        onPick={(label) => {
          if (label) props.onPinKey(label);
        }}
      />
    </Show>
  );
};

export default RoutingTierCard;
