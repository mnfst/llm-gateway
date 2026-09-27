import { createSignal, For, Show, type Component, type Accessor, type JSX } from 'solid-js';
import { toast } from '../services/toast-store.js';
import {
  toggleSpecificity,
  setSpecificityFallbacks,
  clearSpecificityFallbacks,
} from '../services/api.js';
import { SPECIFICITY_STAGES } from '../services/providers.js';
import RoutingTierCard from './RoutingTierCard.js';
import type {
  SpecificityAssignment,
  TierAssignment,
  AvailableModel,
  AuthType,
  ModelRoute,
  RequestParamDefaults,
  ResponseMode,
  RoutingProvider,
  CustomProviderData,
} from '../services/api.js';
import '../styles/routing-specificity.css';
import OutputControls from '../components/OutputControls.js';
import RoutingDeprecationNotice from '../components/RoutingDeprecationNotice.js';

const SPECIFICITY_ICONS: Record<string, () => JSX.Element> = {
  coding: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M5 16v.18c-1.16.41-2 1.51-2 2.82 0 1.65 1.35 3 3 3s3-1.35 3-3c0-1.3-.84-2.4-2-2.82V13h8c2.21 0 4-1.79 4-4V7.82c1.16-.41 2-1.51 2-2.82 0-1.65-1.35-3-3-3s-3 1.35-3 3c0 1.3.84 2.4 2 2.82V9c0 1.1-.9 2-2 2H7V7.82C8.16 7.41 9 6.31 9 5c0-1.65-1.35-3-3-3S3 3.35 3 5c0 1.3.84 2.4 2 2.82zM18 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1M6 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m0 16c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1" />
    </svg>
  ),
  web_browsing: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M18 3H6C3.79 3 2 4.79 2 7v10c0 2.21 1.79 4 4 4h12c2.21 0 4-1.79 4-4V7c0-2.21-1.79-4-4-4m2 14c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-6h16zm0-8H4V7c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2z" />
      <rect width="2" height="2" x="14" y="6" rx=".5" ry=".5" />
      <rect width="2" height="2" x="17" y="6" rx=".5" ry=".5" />
    </svg>
  ),
  data_analysis: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="m21,20H4.5c-.28,0-.5-.22-.5-.5V3c0-.55-.45-1-1-1s-1,.45-1,1v16.5c0,1.38,1.12,2.5,2.5,2.5h16.5c.55,0,1-.45,1-1s-.45-1-1-1Z" />
      <path d="m6.74,11.96c.53.15,1.08-.17,1.23-.7l1.2-4.43c.13-.49.58-.83,1.08-.83s.95.34,1.08.83l2.4,8.86c.37,1.36,1.61,2.31,3.02,2.31s2.65-.95,3.02-2.31l1.2-4.43c.14-.53-.17-1.08-.7-1.23-.53-.15-1.08.17-1.23.7l-1.2,4.43c-.13.49-.58.83-1.08.83s-.95-.34-1.08-.83l-2.4-8.86c-.37-1.36-1.61-2.31-3.02-2.31s-2.65.95-3.02,2.31l-1.2,4.43c-.14.53.17,1.08.7,1.23Z" />
    </svg>
  ),
  image_generation: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M8.5 7A1.5 1.5 0 1 0 8.5 10 1.5 1.5 0 1 0 8.5 7z" />
      <path d="m12,19h-5c-.97,0-1.79-.7-1.96-1.62l2.61-2.61c.13-.13.28-.15.35-.15s.23.02.35.15l.41.41c.68.68,1.79.68,2.47,0l4.41-4.41c.13-.13.28-.15.35-.15s.23.02.35.15l2.94,2.94c.18.18.43.29.71.29.55,0,1-.45,1-1v-6c0-2.21-1.79-4-4-4H7c-2.21,0-4,1.79-4,4v10c0,2.21,1.79,4,4,4h5c.55,0,1-.45,1-1s-.45-1-1-1ZM7,5h10c1.1,0,2,.9,2,2v3.59l-1.23-1.23c-.94-.95-2.59-.95-3.54,0l-4.23,4.23-.23-.23c-.94-.95-2.59-.95-3.54,0l-1.23,1.23v-7.59c0-1.1.9-2,2-2Z" />
      <path d="m21.54,17.8l-1.07-.47c-.35-.16-.63-.44-.79-.79l-.48-1.08c-.12-.28-.39-.46-.7-.46h0c-.3,0-.58.18-.7.45,0,0,0,0,0,0l-.48,1.05c-.15.33-.41.59-.73.75l-1.15.55c-.27.13-.44.4-.44.71,0,.3.18.57.46.7l1.09.48c.35.16.63.44.79.79l.47,1.07c.12.28.4.46.71.46s.58-.18.71-.46l.47-1.07c.16-.35.43-.63.79-.79l1.07-.47c.28-.12.46-.4.46-.71s-.18-.58-.46-.71Z" />
    </svg>
  ),
  video_generation: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="m18,3H6c-2.21,0-4,1.79-4,4v10c0,2.21,1.79,4,4,4h12c2.21,0,4-1.79,4-4V7c0-2.21-1.79-4-4-4Zm-8.46,6l-2.67-4h2.6l2.67,4h-2.6Zm5,0l-2.67-4h2.6l2.67,4h-2.6Zm-10.54-2c0-.63.3-1.19.76-1.56l2.37,3.56h-3.13v-2Zm16,10c0,1.1-.9,2-2,2H6c-1.1,0-2-.9-2-2v-6h16v6Zm0-8h-.46l-2.67-4h1.13c1.1,0,2,.9,2,2v2Z" />
      <path d="m10.76,17.55l3.53-2.12c.32-.19.32-.66,0-.86l-3.53-2.12c-.33-.2-.76.04-.76.43v4.23c0,.39.42.63.76.43Z" />
    </svg>
  ),
  social_media: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M18 3H6C3.79 3 2 4.79 2 7v8c0 2.21 1.79 4 4 4h1v1.82c0 .7.4 1.31 1.04 1.6.23.1.48.16.72.16.42 0 .83-.16 1.16-.45l3.46-3.12H18c2.21 0 4-1.79 4-4V7c0-2.21-1.79-4-4-4m2 12c0 1.1-.9 2-2 2h-5c-.25 0-.49.09-.67.26l-3.33 3v-2.25c0-.55-.45-1-1-1H6c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2z" />
      <path d="M15.35 8.14c-.87-.86-2.26-.86-3.12 0l-.22.22-.22-.22c-.87-.86-2.26-.86-3.12 0-.85.82-.87 2.16-.06 3.01l.06.06 2.82 2.77c.29.29.76.29 1.05 0l2.82-2.77c.85-.82.87-2.16.06-3.01l-.06-.06Z" />
    </svg>
  ),
  email_management: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M19.86 10.4 5.04 3.81c-.65-.29-1.4-.16-1.91.33s-.69 1.23-.44 1.89L4.93 12l-2.24 5.97c-.25.66-.08 1.4.44 1.89.33.31.76.48 1.2.48.24 0 .48-.05.71-.15l14.82-6.59c.64-.29 1.04-.9 1.04-1.6s-.4-1.31-1.04-1.6M4.77 18.12 6 14.85V15l5.11-2.55c.37-.18.37-.71 0-.89L6 9.01v.15L4.77 5.89l13.76 6.12-13.76 6.12Z" />
    </svg>
  ),
  calendar_management: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="m17,4v-1c0-.55-.45-1-1-1s-1,.45-1,1v1h-6v-1c0-.55-.45-1-1-1s-1,.45-1,1v1c-2.21,0-4,1.79-4,4v10c0,2.21,1.79,4,4,4h10c2.21,0,4-1.79,4-4v-10c0-2.21-1.79-4-4-4Zm2,14c0,1.1-.9,2-2,2H7c-1.1,0-2-.9-2-2v-10h14v10Z" />
      <rect x="7" y="11" width="2" height="2" rx=".75" ry=".75" />
      <rect x="11" y="11" width="2" height="2" rx=".75" ry=".75" />
      <rect x="15" y="11" width="2" height="2" rx=".75" ry=".75" />
      <rect x="7" y="15" width="2" height="2" rx=".75" ry=".75" />
      <rect x="11" y="15" width="2" height="2" rx=".75" ry=".75" />
      <rect x="15" y="15" width="2" height="2" rx=".75" ry=".75" />
    </svg>
  ),
  trading: () => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M9 5V3c0-.55-.45-1-1-1s-1 .45-1 1v2c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2v2c0 .55.45 1 1 1s1-.45 1-1v-2c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2M7 17V7h2v10zM17 7V5c0-.55-.45-1-1-1s-1 .45-1 1v2c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2v2c0 .55.45 1 1 1s1-.45 1-1v-2c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2m-2 8V9h2v6z" />
    </svg>
  ),
};

export interface RoutingSpecificitySectionProps {
  agentName: () => string;
  assignments: Accessor<SpecificityAssignment[] | undefined>;
  models: () => AvailableModel[];
  customProviders: () => CustomProviderData[];
  activeProviders: () => RoutingProvider[];
  connectedProviders: () => RoutingProvider[];
  changingTier: () => string | null;
  resettingTier: () => string | null;
  resettingAll: () => boolean;
  addingFallback: () => string | null;
  onDropdownOpen: (category: string) => void;
  onOverride: (category: string, model: string, provider: string, authType?: AuthType) => void;
  onPinKey?: (
    category: string,
    providerId: string,
    providerKeyLabel: string | null,
    authType?: AuthType,
  ) => void;
  onReset: (category: string) => void;
  onFallbackUpdate: (category: string, fallbacks: string[], routes?: ModelRoute[] | null) => void;
  onAddFallback: (category: string) => void;
  responseMode: () => ResponseMode;
  changingResponseMode: () => boolean;
  onResponseModeChange: (mode: ResponseMode) => void | Promise<void>;
  refetchAll: () => Promise<void>;
  refetchSpecificity?: () => Promise<void>;
  embedded?: boolean;
  /**
   * Read saved per-route params from the parent's loaded map. Threaded
   * down to every model row so each affordance reflects the configured
   * state without per-row fetches.
   */
  getModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
  ) => RequestParamDefaults | null;
  /** Persist new params for a single route. */
  setModelParams?: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
    params: RequestParamDefaults | null,
  ) => Promise<unknown>;
}

function toTierAssignment(a: SpecificityAssignment | undefined): TierAssignment | undefined {
  if (!a) return undefined;
  return { ...a, tier: a.category };
}

const RoutingSpecificitySection: Component<RoutingSpecificitySectionProps> = (props) => {
  const [toggling, setToggling] = createSignal<string | null>(null);
  const [showModal, setShowModal] = createSignal(false);

  const getAssignment = (category: string) =>
    props.assignments()?.find((a) => a.category === category);

  const isActive = (category: string) => getAssignment(category)?.is_active ?? false;

  const hasAnyActive = () => SPECIFICITY_STAGES.some((s) => isActive(s.id));

  const activeTiers = () => SPECIFICITY_STAGES.filter((s) => isActive(s.id));

  const handleToggle = async (category: string, label: string, active: boolean) => {
    const shouldInheritStreaming = active && props.responseMode() === 'stream';
    setToggling(category);
    try {
      await toggleSpecificity(props.agentName(), category, active);
      if (showModal() && props.refetchSpecificity) {
        await props.refetchSpecificity();
      } else {
        await props.refetchAll();
      }
      if (shouldInheritStreaming) {
        await props.onResponseModeChange('stream');
      }
      toast.success(`${active ? 'Enabled' : 'Disabled'} ${label} routing`);
    } catch {
      toast.error('Failed to update task-specific routing');
    } finally {
      setToggling(null);
    }
  };

  const manageButton = () => (
    <Show when={hasAnyActive()}>
      <button class="btn btn--primary btn--sm" onClick={() => setShowModal(true)}>
        Manage task-specific routing
      </button>
    </Show>
  );

  // This section only renders for legacy/invested agents (gated in Routing.tsx),
  // so the deprecation banner is always appropriate here.
  const deprecationNotice = () => (
    <RoutingDeprecationNotice title="We're deprecating rule-based routing.">
      You can still use it until September 1, 2026, but we recommend migrating to default or custom
      routing.
    </RoutingDeprecationNotice>
  );

  const content = () => (
    <>
      <Show
        when={activeTiers().length > 0}
        fallback={
          <div class="specificity-empty">
            <span class="specificity-empty__title">No task-specific tiers yet</span>
            <span class="specificity-empty__desc">
              Route specialized tasks to dedicated models.
            </span>
            <button class="btn btn--primary btn--sm" onClick={() => setShowModal(true)}>
              Add a task-specific tier
            </button>
          </div>
        }
      >
        <div class="specificity-output-controls">
          <OutputControls
            responseMode={props.responseMode}
            disabled={props.changingResponseMode}
            onResponseModeChange={props.onResponseModeChange}
          />
        </div>
        <div class="specificity-cards">
          <For each={activeTiers()}>
            {(stage) => (
              <RoutingTierCard
                stage={stage}
                tier={() => toTierAssignment(getAssignment(stage.id))}
                models={props.models}
                customProviders={props.customProviders}
                activeProviders={props.activeProviders}
                tiersLoading={false}
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
                getFallbacksFor={(cat) =>
                  getAssignment(cat)?.fallback_routes?.map((r) => r.model) ?? []
                }
                connectedProviders={props.connectedProviders}
                persistFallbacks={(_agentName, category, models, routes) =>
                  setSpecificityFallbacks(_agentName, category, models, routes)
                }
                persistClearFallbacks={(_agentName, category) =>
                  clearSpecificityFallbacks(_agentName, category)
                }
                getModelParams={props.getModelParams}
                setModelParams={props.setModelParams}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={showModal()}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowModal(false);
          }}
        >
          <div
            class="modal-card specificity-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="specificity-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="specificity-modal-title" class="specificity-modal__title">
              Manage task-specific routing
            </h2>
            <p class="specificity-modal__desc">
              Route specialized tasks to dedicated models. Overrides complexity and default routing
              when a task matches.
            </p>
            <div class="specificity-modal__list">
              <For each={SPECIFICITY_STAGES}>
                {(stage) => {
                  const active = () => isActive(stage.id);
                  const loading = () => toggling() === stage.id;
                  return (
                    <div
                      class="specificity-modal__row"
                      role="button"
                      tabIndex={0}
                      style="cursor: pointer;"
                      onClick={() => !loading() && handleToggle(stage.id, stage.label, !active())}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (!loading()) handleToggle(stage.id, stage.label, !active());
                        }
                      }}
                    >
                      <span class="specificity-modal__icon">{SPECIFICITY_ICONS[stage.id]?.()}</span>
                      <div class="specificity-modal__info">
                        <span class="specificity-modal__name">{stage.label}</span>
                        <span class="specificity-modal__stage-desc">{stage.desc}</span>
                      </div>
                      <button
                        class="specificity-modal__toggle"
                        classList={{
                          'specificity-modal__toggle--on': active(),
                        }}
                        disabled={loading()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!loading()) handleToggle(stage.id, stage.label, !active());
                        }}
                        aria-label={`${active() ? 'Disable' : 'Enable'} ${stage.label}`}
                      >
                        <Show
                          when={loading()}
                          fallback={<span class="specificity-modal__toggle-thumb" />}
                        >
                          <span class="specificity-modal__toggle-thumb">
                            <span class="spinner" style="width: 10px; height: 10px;" />
                          </span>
                        </Show>
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
            <div class="specificity-modal__footer">
              <button
                class="btn btn--primary"
                onClick={() => {
                  setShowModal(false);
                  const firstEmpty = SPECIFICITY_STAGES.find((s) => {
                    const a = getAssignment(s.id);
                    return a?.is_active && !a.override_route && !a.auto_assigned_route;
                  });
                  if (firstEmpty) {
                    props.onDropdownOpen(firstEmpty.id);
                  }
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );

  if (props.embedded) {
    return (
      <div>
        {deprecationNotice()}
        <div class="routing-section__header specificity-header" style="margin-bottom: 16px;">
          <div class="specificity-header__left">
            <span class="routing-section__subtitle">
              Send specific tasks (coding, trading, image gen…) to dedicated models. Overrides
              default and complexity routing when a task matches.
            </span>
          </div>
          {manageButton()}
        </div>
        {content()}
      </div>
    );
  }

  return (
    <div class="routing-section">
      {deprecationNotice()}
      <div class="routing-section__header specificity-header">
        <div class="specificity-header__left">
          <span class="routing-section__title">Task-specific routing</span>
          <span class="routing-section__subtitle">
            Send specific tasks (coding, trading, image gen…) to dedicated models. Overrides default
            and complexity routing when a task matches.
          </span>
        </div>
        {manageButton()}
      </div>
      {content()}
    </div>
  );
};

export default RoutingSpecificitySection;
