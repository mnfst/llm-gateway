import { Show, Suspense, createSignal, lazy, type Accessor, type Component } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import RoutingInstructionModal from './RoutingInstructionModal.js';
import KeyPickerModal from './KeyPickerModal.js';

// These modals only mount behind a `<Show>` (dropdown open / provider modal
// open). Lazy-load them so the heavy model picker and the ~130 kB
// provider-select chunk stay out of the Routing route's initial bundle.
const ModelPickerModal = lazy(() => import('./ModelPickerModal.js'));
import { PROVIDERS } from '../services/providers.js';
import type {
  TierAssignment,
  AuthType,
  CustomProviderData,
  AvailableModel,
  RoutingProvider,
  SpecificityAssignment,
  ModelCapability,
  ResponseMode,
} from '../services/api.js';
import type { CustomProviderPrefill, ProviderDeepLink } from '../services/routing-params.js';
import {
  activeRouteKeys,
  availableRouteKeysForModel,
  routeKeySelectionForModel,
} from '../services/routing-utils.js';

interface RoutingModalsProps {
  agentName: () => string;
  dropdownTier: Accessor<string | null>;
  onDropdownClose: () => void;
  specificityDropdown?: Accessor<string | null>;
  onSpecificityDropdownClose?: () => void;
  onSpecificityOverride?: (
    category: string,
    model: string,
    provider: string,
    authType?: AuthType,
  ) => void;
  fallbackPickerTier: Accessor<string | null>;
  onFallbackPickerClose: () => void;
  showProviderModal: Accessor<boolean>;
  onProviderModalClose: () => void;
  customProviderPrefill?: CustomProviderPrefill | null;
  providerDeepLink?: ProviderDeepLink | null;
  instructionModal: Accessor<'enable' | 'disable' | null>;
  instructionProvider: Accessor<string | null>;
  onInstructionClose: () => void;
  models: () => AvailableModel[];
  tiers: () => TierAssignment[];
  specificityAssignments?: () => SpecificityAssignment[];
  customProviders: () => CustomProviderData[];
  connectedProviders: () => RoutingProvider[];
  getTier: (tierId: string) => TierAssignment | undefined;
  onOverride: (
    tierId: string,
    modelName: string,
    providerId: string,
    authType?: AuthType,
    providerKeyLabel?: string,
  ) => void;
  onAddFallback: (
    tierId: string,
    modelName: string,
    providerId: string,
    authType?: AuthType,
    providerKeyLabel?: string,
  ) => void;
  onProviderUpdate: () => Promise<void>;
  onProviderPoll?: () => Promise<void>;
  onOpenProviderModal?: () => void;
}

interface PendingOverride {
  tierId: string;
  modelName: string;
  providerId: string;
  authType?: AuthType;
  keys: RoutingProvider[];
  isFallback?: boolean;
}

function providerDisplayName(providerId: string, customProviders: CustomProviderData[]): string {
  if (providerId.startsWith('custom:')) {
    const id = providerId.slice('custom:'.length);
    const cp = customProviders.find((c) => c.id === id);
    if (cp) return cp.name;
  }
  return PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId;
}

const RoutingModals: Component<RoutingModalsProps> = (props) => {
  const navigate = useNavigate();
  const [pendingOverride, setPendingOverride] = createSignal<PendingOverride | null>(null);
  const requiredCapabilityForResponseMode = (
    responseMode: ResponseMode | undefined,
  ): ModelCapability | undefined => (responseMode === 'stream' ? 'stream' : undefined);
  const requiredCapabilityForTier = (tierId: string): ModelCapability | undefined =>
    requiredCapabilityForResponseMode(props.getTier(tierId)?.response_mode);
  const requiredCapabilityForSpecificity = (category: string): ModelCapability | undefined =>
    requiredCapabilityForResponseMode(
      props.specificityAssignments?.().find((assignment) => assignment.category === category)
        ?.response_mode,
    );
  const openProviders = () => {
    if (props.onOpenProviderModal) {
      props.onOpenProviderModal();
      return;
    }
    navigate(`/harnesses/${encodeURIComponent(props.agentName())}/providers`);
  };

  const handleSelect = (
    tierId: string,
    modelName: string,
    providerId: string,
    authType?: AuthType,
  ) => {
    const effectiveAuth = authType ?? 'api_key';
    const selection = routeKeySelectionForModel({
      providers: props.connectedProviders(),
      tier: props.getTier(tierId),
      modelName,
      providerId,
      authType: effectiveAuth,
      slot: 'primary',
    });
    if (!selection.needsChoice) {
      props.onOverride(tierId, modelName, providerId, authType);
      return;
    }
    // 2+ keys → ask the user which one before persisting.
    setPendingOverride({ tierId, modelName, providerId, authType, keys: selection.keys });
  };

  const resolvePending = (label: string | null) => {
    const p = pendingOverride();
    if (!p) return;
    if (p.isFallback) {
      // Close the fallback picker so the user must re-open it — this ensures
      // the tier data is fresh and used-key filtering is accurate.
      props.onFallbackPickerClose();
      props.onAddFallback(p.tierId, p.modelName, p.providerId, p.authType, label ?? undefined);
    } else {
      props.onOverride(p.tierId, p.modelName, p.providerId, p.authType, label ?? undefined);
    }
    setPendingOverride(null);
  };

  return (
    <>
      <Show when={props.dropdownTier()}>
        {(tierId) => (
          <Suspense fallback={null}>
            <ModelPickerModal
              tierId={tierId()}
              agentName={props.agentName()}
              models={props.models()}
              tiers={props.tiers()}
              customProviders={props.customProviders()}
              connectedProviders={props.connectedProviders()}
              requiredCapability={requiredCapabilityForTier(tierId())}
              onSelect={handleSelect}
              onClose={props.onDropdownClose}
              onConnectProviders={() => {
                props.onDropdownClose();
                openProviders();
              }}
              onProviderRefreshed={props.onProviderUpdate}
            />
          </Suspense>
        )}
      </Show>

      <Show when={props.specificityDropdown?.()}>
        {(category) => {
          const specificityTiers = (): TierAssignment[] =>
            (props.specificityAssignments?.() ?? [])
              .filter((a) => a.is_active)
              .map((a) => ({ ...a, tier: a.category }));
          return (
            <Suspense fallback={null}>
              <ModelPickerModal
                tierId={category()}
                agentName={props.agentName()}
                models={props.models()}
                tiers={specificityTiers()}
                customProviders={props.customProviders()}
                connectedProviders={props.connectedProviders()}
                requiredCapability={requiredCapabilityForSpecificity(category())}
                onSelect={(_, model, provider, authType) =>
                  props.onSpecificityOverride?.(category(), model, provider, authType)
                }
                onClose={() => props.onSpecificityDropdownClose?.()}
                onConnectProviders={() => {
                  props.onSpecificityDropdownClose?.();
                  openProviders();
                }}
                onProviderRefreshed={props.onProviderUpdate}
              />
            </Suspense>
          );
        }}
      </Show>

      <Show when={props.fallbackPickerTier()}>
        {(tierId) => {
          const filteredModels = () => {
            return props.models().filter((m) => {
              // Find how many keys exist for this model's provider
              const providerId = m.provider;
              const authType = m.auth_type ?? 'api_key';
              const keys = activeRouteKeys(props.connectedProviders(), providerId, authType);
              if (keys.length <= 1) {
                // Single-key model: hide if already used as primary or fallback
                // (matched on the full route tuple — same model on a different
                // (provider, auth) is intentionally NOT filtered).
                const tier = props.getTier(tierId());
                const primaryRoute = tier?.override_route ?? null;
                if (
                  primaryRoute &&
                  primaryRoute.model === m.model_name &&
                  primaryRoute.provider.toLowerCase() === providerId.toLowerCase() &&
                  primaryRoute.authType === authType
                ) {
                  return false;
                }
                const routes = tier?.fallback_routes ?? [];
                return !routes.some(
                  (r) =>
                    r.model === m.model_name &&
                    r.provider.toLowerCase() === providerId.toLowerCase() &&
                    r.authType === authType,
                );
              }
              // Multi-key model: hide only if ALL keys are already used
              return (
                availableRouteKeysForModel(
                  props.connectedProviders(),
                  props.getTier(tierId()),
                  m.model_name,
                  providerId,
                  authType,
                ).length > 0
              );
            });
          };

          const handleFallbackSelect = (
            tid: string,
            modelName: string,
            providerId: string,
            authType?: AuthType,
          ) => {
            const effectiveAuth = authType ?? 'api_key';
            const allKeys = activeRouteKeys(props.connectedProviders(), providerId, effectiveAuth);
            if (allKeys.length <= 1) {
              // Single-key (or no-key) provider: add fallback without key selection
              props.onFallbackPickerClose();
              props.onAddFallback(tid, modelName, providerId, authType);
              return;
            }
            const selection = routeKeySelectionForModel({
              providers: props.connectedProviders(),
              tier: props.getTier(tierId()),
              modelName,
              providerId,
              authType: effectiveAuth,
              slot: 'fallback',
            });
            if (selection.exhausted) {
              // All keys exhausted — shouldn't happen since filteredModels hides it
              return;
            }
            if (selection.autoLabel) {
              // Only one key left — auto-select it, close picker for fresh data
              props.onFallbackPickerClose();
              props.onAddFallback(tid, modelName, providerId, authType, selection.autoLabel);
              return;
            }
            // 2+ keys available → ask which one
            setPendingOverride({
              tierId: tid,
              modelName,
              providerId,
              authType,
              keys: selection.keys,
              isFallback: true,
            });
          };
          return (
            <Suspense fallback={null}>
              <ModelPickerModal
                tierId={tierId()}
                agentName={props.agentName()}
                models={filteredModels()}
                tiers={props.tiers()}
                customProviders={props.customProviders()}
                connectedProviders={props.connectedProviders()}
                requiredCapability={requiredCapabilityForTier(tierId())}
                onSelect={handleFallbackSelect}
                onClose={props.onFallbackPickerClose}
                onConnectProviders={() => {
                  props.onFallbackPickerClose();
                  openProviders();
                }}
                onProviderRefreshed={props.onProviderUpdate}
              />
            </Suspense>
          );
        }}
      </Show>

      <Show when={pendingOverride()}>
        {(p) => (
          <KeyPickerModal
            providerName={providerDisplayName(p().providerId, props.customProviders())}
            modelName={p().modelName}
            keys={p().keys}
            onPick={resolvePending}
            onClose={() => setPendingOverride(null)}
          />
        )}
      </Show>

      {/* ProviderSelectModal removed — provider connection now via sidebar pages */}

      <RoutingInstructionModal
        open={props.instructionModal() !== null}
        mode={props.instructionModal() ?? 'enable'}
        agentName={props.agentName()}
        connectedProvider={props.instructionProvider()}
        onClose={props.onInstructionClose}
      />
    </>
  );
};

export default RoutingModals;
