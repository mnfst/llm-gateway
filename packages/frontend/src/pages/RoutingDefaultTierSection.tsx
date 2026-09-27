import { For, Show, type Component } from 'solid-js';
import type {
  AuthType,
  AvailableModel,
  CustomProviderData,
  RequestParamDefaults,
  ResponseMode,
  RoutingProvider,
  TierAssignment,
} from '../services/api.js';
import { DEFAULT_STAGE, STAGES } from '../services/providers.js';
import OutputControls from '../components/OutputControls.js';
import RoutingDeprecationNotice from '../components/RoutingDeprecationNotice.js';
import RoutingTierCard from './RoutingTierCard.js';

export interface RoutingDefaultTierSectionProps {
  agentName: () => string;
  tier: () => TierAssignment | undefined;
  models: () => AvailableModel[];
  customProviders: () => CustomProviderData[];
  activeProviders: () => RoutingProvider[];
  connectedProviders: () => RoutingProvider[];
  tiersLoading: boolean;
  changingTier: () => string | null;
  resettingTier: () => string | null;
  resettingAll: () => boolean;
  addingFallback: () => string | null;
  onDropdownOpen: (tierId: string) => void;
  onOverride: (tierId: string, model: string, provider: string, authType?: AuthType) => void;
  onPinKey: (
    tierId: string,
    providerId: string,
    providerKeyLabel: string | null,
    authType?: AuthType,
  ) => void;
  onReset: (tierId: string) => void;
  onFallbackUpdate: (tierId: string, fallbacks: string[]) => void;
  onAddFallback: (tierId: string) => void;
  getFallbacksFor: (tierId: string) => string[];
  getTier: (tierId: string) => TierAssignment | undefined;
  complexityEnabled: () => boolean;
  togglingComplexity: () => boolean;
  onToggleComplexity: () => void;
  /**
   * Gate for the deprecated "Route by complexity" toggle. When this returns
   * false the toggle is hidden entirely and the section shows only the single
   * default model + fallbacks. Hidden for agents that never enabled complexity
   * routing (see `legacyComplexityVisible` in Routing.tsx). Defaults to shown.
   */
  showComplexityToggle?: () => boolean;
  responseMode: () => ResponseMode;
  changingResponseMode: () => boolean;
  onResponseModeChange: (mode: ResponseMode) => void | Promise<void>;
  embedded?: boolean;
  /**
   * Read saved per-route params from the parent's loaded map. Threaded
   * down to every model row across the tier card + fallback list so each
   * affordance shows the configured-state badge without per-row fetches.
   */
  getModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
  ) => RequestParamDefaults | null;
  /**
   * Persist new params for a single route. Parent is responsible for the
   * server call and the local cache update; this section just threads the
   * callback down to the affordance.
   */
  setModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
    params: RequestParamDefaults | null,
  ) => Promise<unknown>;
}

const RoutingDefaultTierSection: Component<RoutingDefaultTierSectionProps> = (props) => {
  const defaultCard = () => (
    <div
      class="routing-cards"
      classList={{
        'routing-cards--wide': !props.embedded,
        'routing-cards--centered': !!props.embedded,
      }}
    >
      <RoutingTierCard
        stage={DEFAULT_STAGE}
        tier={props.tier}
        models={props.models}
        customProviders={props.customProviders}
        activeProviders={props.activeProviders}
        tiersLoading={props.tiersLoading}
        changingTier={props.changingTier}
        resettingTier={props.resettingTier}
        resettingAll={props.resettingAll}
        addingFallback={props.addingFallback}
        agentName={props.agentName}
        onDropdownOpen={props.onDropdownOpen}
        onOverride={props.onOverride}
        onPinKey={props.onPinKey}
        onReset={props.onReset}
        onFallbackUpdate={props.onFallbackUpdate}
        onAddFallback={props.onAddFallback}
        getFallbacksFor={props.getFallbacksFor}
        connectedProviders={props.connectedProviders}
        getModelParams={props.getModelParams}
        setModelParams={props.setModelParams}
      />
    </div>
  );

  const complexityCards = () => (
    <div class="routing-cards">
      <For each={STAGES}>
        {(stage) => (
          <RoutingTierCard
            stage={stage}
            tier={() => props.getTier(stage.id)}
            models={props.models}
            customProviders={props.customProviders}
            activeProviders={props.activeProviders}
            tiersLoading={props.tiersLoading}
            changingTier={props.changingTier}
            resettingTier={props.resettingTier}
            resettingAll={props.resettingAll}
            addingFallback={props.addingFallback}
            agentName={props.agentName}
            onDropdownOpen={props.onDropdownOpen}
            onOverride={props.onOverride}
            onPinKey={props.onPinKey}
            onReset={props.onReset}
            onFallbackUpdate={props.onFallbackUpdate}
            onAddFallback={props.onAddFallback}
            getFallbacksFor={props.getFallbacksFor}
            connectedProviders={props.connectedProviders}
            getModelParams={props.getModelParams}
            setModelParams={props.setModelParams}
          />
        )}
      </For>
    </div>
  );

  const switchButton = () => (
    <button
      class="routing-switch"
      classList={{ 'routing-switch--on': props.complexityEnabled() }}
      disabled={props.togglingComplexity()}
      onClick={() => props.onToggleComplexity()}
    >
      <span class="routing-switch__label">Route by complexity</span>
      <span class="routing-switch__track">
        <span class="routing-switch__thumb" />
      </span>
    </button>
  );

  const subtitle = () =>
    props.complexityEnabled()
      ? 'Analyzes the complexity of each request on the fly and routes it to the matching tier.'
      : 'Pick one model and up to 5 fallbacks as your default routing.';

  const showComplexityToggle = () => props.showComplexityToggle?.() ?? true;
  const controls = () => (
    <Show when={showComplexityToggle()}>
      <div class="routing-section__controls">{switchButton()}</div>
    </Show>
  );

  // Deprecation banner: shown to legacy/invested agents (the only ones with the
  // toggle) while complexity routing is actually active.
  const deprecationNotice = () => (
    <Show when={showComplexityToggle() && props.complexityEnabled()}>
      <RoutingDeprecationNotice title="We're deprecating rule-based routing.">
        You can still use it until September 1, 2026, but we recommend migrating to default or
        custom routing.
      </RoutingDeprecationNotice>
    </Show>
  );

  if (props.embedded) {
    return (
      <div>
        {deprecationNotice()}
        <div
          class="routing-section__header routing-section__header--with-control"
          style="margin-bottom: 16px;"
        >
          <span class="routing-section__subtitle">{subtitle()}</span>
          {controls()}
        </div>
        <Show
          when={props.complexityEnabled()}
          fallback={<div class="routing-cards-backdrop">{defaultCard()}</div>}
        >
          {complexityCards()}
        </Show>
      </div>
    );
  }

  return (
    <div class="routing-section">
      {deprecationNotice()}
      <div class="routing-section__header routing-section__header--with-control">
        <div>
          <span class="routing-section__title">Default routing</span>
          <span class="routing-section__subtitle">{subtitle()}</span>
        </div>
        {controls()}
      </div>
      <Show when={props.complexityEnabled()} fallback={defaultCard()}>
        {complexityCards()}
      </Show>
    </div>
  );
};

export default RoutingDefaultTierSection;
