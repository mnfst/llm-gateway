/* v8 ignore start -- route-level onboarding UI is validated through browser QA; pure logic is covered in welcome-helpers.ts. */
import { Meta, Title } from '@solidjs/meta';
import { useNavigate, useSearchParams } from '@solidjs/router';
import type { AnimationPlaybackControls, AnimationSequence } from 'motion';
import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onCleanup,
  untrack,
  type Component,
  type JSX,
} from 'solid-js';
import ProviderSelectModal from '../components/ProviderSelectModal.jsx';
import AgentTypeSelect from '../components/AgentTypeSelect.jsx';
import SetupStepAddProvider from '../components/SetupStepAddProvider.jsx';
import RoutingModals from '../components/RoutingModals.js';
import RoutingDefaultTierSection from './RoutingDefaultTierSection.js';
import Playground from './Playground.jsx';
import {
  findResumableAgent,
  isSuccessfulAgentMessage,
  type OnboardingAgentSummary,
  type OnboardingMessageSummary,
} from './welcome-helpers.js';
import { createRoutingActions } from './RoutingActions.js';
import { providerIcon } from '../components/ProviderIcon.jsx';
import { PROVIDERS, subscriptionCatalog } from '../services/providers.js';
import { authClient } from '../services/auth-client.js';
import { installOrigin } from '../services/install-endpoints.js';
import {
  createAgent,
  deleteModelParams,
  getAgentKey,
  getAgents,
  getAvailableModels,
  getCustomProviders,
  getPlaygroundAgent,
  getProviders,
  getTierAssignments,
  listModelParams,
  modelParamsKey,
  refreshModels,
  setModelParams as setModelParamsApi,
  type AgentModelParamsRow,
  type AuthType,
  type AvailableModel,
} from '../services/api.js';
import type { RequestParamDefaults } from 'manifest-shared';
import { getMessages } from '../services/api/messages.js';
import { customProviderColor } from '../services/formatters.js';
import { markAgentCreated } from '../services/recent-agents.js';
import { useRightSidebar } from '../services/right-sidebar.jsx';
import { hasOnboardingBeenDone, markOnboardingDone } from '../services/onboarding.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import {
  type AgentCategory,
  type AgentPlatform,
  PLATFORM_ICONS,
  PLATFORM_LABELS,
  PLATFORMS_BY_CATEGORY,
  manifestErrorDocsUrl,
} from 'manifest-shared';
import '../styles/routing.css';
import '../styles/routing-providers.css';
import '../styles/routing-modal.css';
import '../styles/welcome.css';

// Dev-only gateway tester, same compile-time gating as App.tsx: rollup drops
// the component and its deps from production/self-hosted bundles. Mounted on
// the activate step so the first request can be fired without leaving the UI.
const WingmanDevTools = __DEV_MODE__
  ? lazy(() => import('../components/WingmanDevTools.jsx'))
  : null;

type StepId = 'harness' | 'providers' | 'playground' | 'route' | 'activate';
const STEP_ORDER: StepId[] = ['harness', 'providers', 'playground', 'route', 'activate'];

/** The theme lives in "Launch sequence"; the rest is plain wayfinding. */
const eyebrow = (id: StepId) =>
  `Launch sequence · Step ${STEP_ORDER.indexOf(id) + 1} of ${STEP_ORDER.length}`;

const STEP_META: Record<StepId, { label: string }> = {
  harness: { label: 'Create harness' },
  providers: { label: 'Connect providers' },
  playground: { label: 'Test models' },
  route: { label: 'Configure routing' },
  activate: { label: 'Connect harness & go live' },
};

/** Replicates ProviderMark from ProviderConnectionsPage (icon or colored initial). */
const ProviderMark: Component<{ providerId: string; name: string; size?: number }> = (props) => {
  const s = () => props.size ?? 20;
  return (
    <Show
      when={providerIcon(props.providerId, s())}
      fallback={
        <span
          style={
            {
              display: 'inline-flex',
              'align-items': 'center',
              'justify-content': 'center',
              width: `${s()}px`,
              height: `${s()}px`,
              'border-radius': '4px',
              'font-size': s() > 20 ? '12px' : '11px',
              'font-weight': '600',
              color: 'white',
              background: customProviderColor(props.name || props.providerId),
            } as JSX.CSSProperties
          }
        >
          {(props.name || props.providerId).charAt(0).toUpperCase()}
        </span>
      }
    >
      <span style={`display:flex;align-items:center;width:${s()}px;height:${s()}px`}>
        {providerIcon(props.providerId, s())}
      </span>
    </Show>
  );
};

const Welcome: Component = () => {
  const navigate = useNavigate();
  // Playground pushes its run-details drawer here; App renders it in the
  // dashboard shell, so the standalone onboarding layout must render it too.
  const { content: rightSidebar } = useRightSidebar();
  const [searchParams] = useSearchParams();
  const liftoffPreview = () => import.meta.env.DEV && searchParams.preview === 'liftoff';
  const session = authClient.useSession();
  const userId = () => session()?.data?.user?.id ?? '';
  // Redirect users who already completed onboarding so they don't see the
  // wizard again on a manual visit to /welcome.
  createEffect(() => {
    const uid = userId();
    if (uid && hasOnboardingBeenDone(uid)) navigate('/', { replace: true });
  });
  const [step, setStep] = createSignal<StepId>('harness');
  const [maxStepReached, setMaxStepReached] = createSignal(0);
  createEffect(() => {
    const index = STEP_ORDER.indexOf(step());
    if (index > untrack(maxStepReached)) setMaxStepReached(index);
  });
  const goTo = (id: StepId) => {
    setStep(id);
    // Provider connections can complete after this harness's models resource
    // initially resolved empty. Refresh before opening routing so a newly
    // connected provider is immediately available for the default proposal.
    if (id === 'playground' || id === 'route') {
      const slug = harnessSlug();
      if (slug && (models() ?? []).length === 0) {
        void refreshModels(slug)
          .catch(() => undefined)
          .then(refetchRouting);
      } else {
        void refetchRouting();
      }
    }
  };
  // ── Shared resources ─────────────────────────────────────────────────
  const [selfHosted] = createResource(checkIsSelfHosted);

  // The Playground agent gives provider connections an agent context before
  // the user's own harness exists (providers are tenant-global anyway).
  const [agent] = createResource(() => getPlaygroundAgent());
  const contextAgent = () => agent()?.name;

  // Providers connect against the user's harness once it exists; the reserved
  // Playground agent only bridges the gap before creation. Declared before the
  // resources below because createResource evaluates its source immediately.
  const [harnessName, setHarnessName] = createSignal('');
  const [harnessSlug, setHarnessSlug] = createSignal('');
  const providerAgent = () => harnessSlug() || contextAgent();
  const [providers, { refetch: refetchProviders }] = createResource(providerAgent, (name) =>
    getProviders(name),
  );
  const [customProviders, { refetch: refetchCustom }] = createResource(providerAgent, (name) =>
    getCustomProviders(name),
  );
  const [existingAgents] = createResource(
    () => getAgents() as Promise<{ agents?: OnboardingAgentSummary[] }>,
  );
  const handleProvidersUpdate = async () => {
    await Promise.all([refetchProviders(), refetchCustom()]);
    const slug = harnessSlug();
    if (!slug) return;
    // Force discovery once a connection finishes. The harness may have asked
    // for models before the provider existed, leaving an empty server cache for
    // its two-minute TTL; a plain GET would keep returning that stale result.
    await refreshModels(slug).catch(() => undefined);
    await refetchRouting();
  };

  const connectedCount = createMemo(() => {
    const ids = new Set<string>();
    for (const p of providers() ?? []) {
      const active = p.auth_type === 'subscription' ? p.is_active : p.is_active && p.has_api_key;
      if (active) ids.add(p.provider);
    }
    for (const c of customProviders() ?? []) ids.add(`custom:${c.id}`);
    return ids.size;
  });

  // ── Step: providers ──────────────────────────────────────────────────
  const [connectTarget, setConnectTarget] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<'subscription' | 'api_key' | 'local'>('api_key');
  const selectProviderTab = (next: 'subscription' | 'api_key' | 'local', focus = false) => {
    setTab(next);
    if (focus) {
      requestAnimationFrame(() => document.getElementById(`welcome-provider-tab-${next}`)?.focus());
    }
  };
  const handleProviderTabKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const order: Array<'api_key' | 'subscription' | 'local'> = selfHosted()
      ? ['api_key', 'subscription', 'local']
      : ['api_key', 'subscription'];
    const idx = order.indexOf(tab() as 'api_key' | 'subscription' | 'local');
    const next =
      event.key === 'ArrowRight'
        ? order[(idx + 1) % order.length]
        : order[(idx - 1 + order.length) % order.length];
    selectProviderTab(next!, true);
  };

  // Household names first — a new user scans for the provider they already
  // use; the long tail lives behind "Show all".
  const POPULAR = [
    'openai',
    'anthropic',
    'gemini',
    'groq',
    'deepseek',
    'mistral',
    'openrouter',
    'xai',
    'copilot',
  ];

  const allTabProviders = () => {
    if (tab() === 'subscription')
      return subscriptionCatalog(PROVIDERS, (id) => isConnected(id, 'subscription'));
    if (tab() === 'local') return PROVIDERS.filter((p) => p.localOnly);
    return PROVIDERS.filter((p) => !p.subscriptionOnly && !p.localOnly);
  };

  // Popular providers first, then the rest in catalog order.
  const tabProviders = () => {
    const all = allTabProviders();
    const popular = all.filter((p) => POPULAR.includes(p.id));
    return [...popular, ...all.filter((p) => !POPULAR.includes(p.id))];
  };

  const isConnected = (id: string, authType: 'subscription' | 'api_key' | 'local') => {
    const resolvedType = authType === 'local' ? 'api_key' : authType;
    return (providers() ?? []).some(
      (p) =>
        p.provider === id &&
        p.auth_type === resolvedType &&
        p.is_active &&
        (resolvedType === 'subscription' || p.has_api_key),
    );
  };

  // ── Step: harness ────────────────────────────────────────────────────
  const [harnessKey, setHarnessKey] = createSignal<string | null>(null);
  const [harnessKeyPrefix, setHarnessKeyPrefix] = createSignal<string | null>(null);
  const [category, setCategory] = createSignal<AgentCategory | null>('personal');
  const [platform, setPlatform] = createSignal<AgentPlatform | null>(
    PLATFORMS_BY_CATEGORY['personal'][0] ?? null,
  );
  const [creating, setCreating] = createSignal(false);
  const [harnessError, setHarnessError] = createSignal('');
  // Both default ON, mirroring the Connect Harness modal — explicit so create
  // always sends a choice rather than relying on the server-side inherit path
  // (which is OFF for Autofix on self-hosted). Creating with Autofix on is
  // itself the consent act (the backend records it), so the form shows the
  // legal line inline instead of a consent dialog mid-onboarding.
  const [autofixEnabled, setAutofixEnabled] = createSignal(true);
  const [logsEnabled, setLogsEnabled] = createSignal(true);
  const harnessCreated = () => !!harnessSlug();

  const handleCategoryChange = (c: AgentCategory) => {
    setCategory(c);
    setPlatform(PLATFORMS_BY_CATEGORY[c][0] ?? null);
  };

  const baseUrl = () => {
    return `${installOrigin()}/v1`;
  };

  const createHarness = async () => {
    const name = harnessName().trim();
    if (!name || creating()) return;
    setCreating(true);
    setHarnessError('');
    try {
      const result = await createAgent({
        name,
        ...(category() ? { agent_category: category()! } : {}),
        ...(platform() ? { agent_platform: platform()! } : {}),
        autofix_enabled: autofixEnabled(),
        record_messages: logsEnabled(),
      });
      const slug = result?.agent?.name ?? name;
      setHarnessSlug(slug);
      setHarnessKey(result.apiKey);
      markAgentCreated(slug);
      goTo('providers');
    } catch (e) {
      setHarnessError(e instanceof Error ? e.message : 'Failed to create harness');
    } finally {
      setCreating(false);
    }
  };

  // ── Step: routing — the app's real default-routing card ──────────────
  const [models, { refetch: refetchModels }] = createResource(harnessSlug, (slug) =>
    slug ? getAvailableModels(slug) : Promise.resolve([]),
  );
  const [tiers, { refetch: refetchTiers, mutate: mutateTiers }] = createResource(
    harnessSlug,
    (slug) => (slug ? getTierAssignments(slug) : Promise.resolve([])),
  );
  const [harnessProviders, { refetch: refetchHarnessProviders }] = createResource(
    harnessSlug,
    (slug) => (slug ? getProviders(slug) : Promise.resolve([])),
  );
  const [harnessCustomProviders, { refetch: refetchHarnessCustom }] = createResource(
    harnessSlug,
    (slug) => (slug ? getCustomProviders(slug) : Promise.resolve([])),
  );

  const refetchRouting = async () => {
    await Promise.all([
      refetchTiers(),
      refetchModels(),
      refetchHarnessProviders(),
      refetchHarnessCustom(),
    ]);
  };

  // Per-route request params — same wiring as Routing.tsx so the card's
  // params affordance works here too.
  const [modelParams, { mutate: mutateModelParams }] = createResource(harnessSlug, (slug) =>
    slug ? listModelParams(slug).catch(() => [] as AgentModelParamsRow[]) : Promise.resolve([]),
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
    const matches = (r: AgentModelParamsRow) =>
      r.scope === scope &&
      r.provider.toLowerCase() === provider.toLowerCase() &&
      r.authType === authType &&
      r.model === model;
    if (next === null) {
      await deleteModelParams(harnessSlug(), { scope, provider, authType, model });
      mutateModelParams((rows) => (rows ?? []).filter((r) => !matches(r)));
      return;
    }
    const saved = await setModelParamsApi(harnessSlug(), {
      scope,
      provider,
      authType,
      model,
      params: next,
    });
    mutateModelParams((rows) => [...(rows ?? []).filter((r) => !matches(r)), saved]);
  };

  // New agents get every provider enabled, so connected == enabled here.
  const harnessConnected = () => harnessProviders() ?? [];
  const harnessActive = () => harnessConnected().filter((p) => p.is_active);

  const [dropdownTier, setDropdownTier] = createSignal<string | null>(null);
  const [fallbackPickerTier, setFallbackPickerTier] = createSignal<string | null>(null);
  const [instructionModal, setInstructionModal] = createSignal<'enable' | 'disable' | null>(null);

  const actions = createRoutingActions({
    agentName: harnessSlug,
    tiers,
    mutateTiers,
    refetchAll: refetchRouting,
    setInstructionModal,
  });

  const handleOverride: typeof actions.handleOverride = async (...args) => {
    setDropdownTier(null);
    return actions.handleOverride(...args);
  };

  const handleAddFallback: typeof actions.handleAddFallback = async (...args) => {
    setFallbackPickerTier(null);
    return actions.handleAddFallback(...args);
  };

  const defaultRoute = () => actions.getTier('default');
  const routedProviderCount = () => {
    const tier = defaultRoute();
    const primary = tier?.override_route ?? tier?.auto_assigned_route;
    if (!primary) return 0;
    const providersInRoute = [primary, ...(tier?.fallback_routes ?? [])].map((route) =>
      route.provider.toLowerCase(),
    );
    return new Set(providersInRoute).size;
  };

  // ── Step: first real agent request ───────────────────────────────────
  // Activation only counts traffic that arrives through the user's own
  // integration. Playground is intentionally separate: it is useful for
  // comparing models, but it is not evidence that their agent is connected.
  const [agentRequestSeen, setAgentRequestSeen] = createSignal(false);
  const [checkingForRequest, setCheckingForRequest] = createSignal(false);
  const [requestCheckError, setRequestCheckError] = createSignal(false);
  const [latestAgentRequest, setLatestAgentRequest] = createSignal<OnboardingMessageSummary | null>(
    null,
  );
  // Manifest's own errors carry a documented M### code — link it.
  const errorDocCode = () => latestAgentRequest()?.error_message?.match(/\bM\d{3}\b/)?.[0] ?? null;
  const [waitedLong, setWaitedLong] = createSignal(false);
  let liftoffRoot: HTMLElement | undefined;
  let liftoffStarsNear: HTMLElement | undefined;
  let liftoffStarsFar: HTMLElement | undefined;
  let liftoffFlash: HTMLElement | undefined;
  let liftoffOrbit: SVGSVGElement | undefined;
  let liftoffOrbitPath: SVGEllipseElement | undefined;
  let liftoffEarth: HTMLElement | undefined;
  let liftoffSmoke: HTMLElement | undefined;
  let liftoffRocket: HTMLElement | undefined;
  let liftoffPlume: HTMLElement | undefined;
  let liftoffInnerPlume: HTMLElement | undefined;
  let liftoffKicker: HTMLElement | undefined;
  let liftoffLaunchTitle: HTMLElement | undefined;
  let liftoffOrbitTitle: HTMLElement | undefined;
  let liftoffDescription: HTMLElement | undefined;
  let liftoffAction: HTMLElement | undefined;
  let liftoffStatus: HTMLElement | undefined;
  let liftoffAnimation: AnimationPlaybackControls | undefined;

  createEffect(() => {
    if (!agentRequestSeen() && !liftoffPreview()) {
      liftoffAnimation?.stop();
      liftoffAnimation = undefined;
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (
        !liftoffRoot ||
        !liftoffStarsNear ||
        !liftoffStarsFar ||
        !liftoffFlash ||
        !liftoffOrbit ||
        !liftoffOrbitPath ||
        !liftoffEarth ||
        !liftoffSmoke ||
        !liftoffRocket ||
        !liftoffPlume ||
        !liftoffInnerPlume ||
        !liftoffKicker ||
        !liftoffLaunchTitle ||
        !liftoffOrbitTitle ||
        !liftoffDescription ||
        !liftoffAction ||
        !liftoffStatus
      )
        return;

      void import('motion').then(({ animate }) => {
        if (cancelled) return;
        liftoffAnimation?.stop();
        const sequence: AnimationSequence = [
          [liftoffRoot, { opacity: [0, 1] }, { duration: 0.18, ease: 'easeOut', at: 0 }],
          [liftoffEarth, { opacity: [0, 0.74] }, { duration: 0.5, ease: 'easeOut', at: 0 }],
          [liftoffStarsFar, { opacity: [0, 0.3] }, { duration: 0.8, ease: 'easeOut', at: 0 }],
          [
            liftoffKicker,
            { opacity: [0, 1], y: [8, 0] },
            { duration: 0.45, ease: 'easeOut', at: 0.15 },
          ],
          [liftoffRocket, { opacity: [0, 1] }, { duration: 0.25, ease: 'easeOut', at: 0.05 }],
          // Ignition: the engine lights and the vehicle strains against the
          // pad before it moves — anticipation is what gives the rise weight.
          [
            liftoffInnerPlume,
            { opacity: [0, 1, 0.55, 1], scaleY: [0.2, 0.6, 0.5, 0.95] },
            { duration: 0.5, times: [0, 0.35, 0.55, 1], ease: 'linear', at: 0.3 },
          ],
          [
            liftoffInnerPlume,
            { opacity: [1, 1, 0], scaleY: [0.95, 1, 0.75] },
            { duration: 3.4, times: [0, 0.8, 1], ease: 'linear', at: 0.8 },
          ],
          [
            liftoffPlume,
            { opacity: [0, 0.85, 0.95, 0.85, 0], scaleY: [0.15, 0.85, 1, 1, 0.7] },
            { duration: 4, times: [0, 0.14, 0.4, 0.82, 1], ease: 'linear', at: 0.3 },
          ],
          [
            liftoffFlash,
            { opacity: [0, 0.85, 0.3, 0], scale: [0.2, 0.5, 0.95, 1.3] },
            { duration: 1.5, times: [0, 0.16, 0.55, 1], ease: 'easeOut', at: 0.32 },
          ],
          // Pad smoke billows and lingers instead of vanishing mid-ascent.
          [
            liftoffSmoke,
            {
              opacity: [0, 0.7, 0.45, 0],
              scaleX: [0.3, 1.05, 1.6, 2.1],
              scaleY: [0.5, 1, 1.2, 1.3],
              y: [0, -3, -9, -15],
            },
            { duration: 3.4, times: [0, 0.22, 0.6, 1], ease: 'easeOut', at: 0.35 },
          ],
          // Hold-down shake: jitter builds until release.
          [
            liftoffRocket,
            { x: [0, -1.2, 1.4, -1.8, 2.1, -1.4, 0.9, 0] },
            { duration: 0.62, ease: 'linear', at: 0.33 },
          ],
          // One continuous gravity turn. Evenly spaced keyframes with
          // quadratic-ish y spacing = constant acceleration (never a slowdown),
          // the pitch tracks the velocity vector, and the rocket leaves the
          // frame still under thrust — it never parks.
          [
            liftoffRocket,
            {
              y: ['0vh', '-1.5vh', '-6vh', '-14vh', '-26vh', '-42vh', '-62vh', '-86vh'],
              x: ['0vw', '0vw', '0.4vw', '1.5vw', '3.5vw', '7vw', '12vw', '18vw'],
              rotate: [0, 1, 8, 13, 17, 21, 24, 26],
              scale: [1, 1, 0.97, 0.93, 0.87, 0.8, 0.72, 0.64],
            },
            {
              duration: 3.4,
              ease: ['easeIn', 'linear', 'linear', 'linear', 'linear', 'linear', 'linear'],
              at: 0.95,
            },
          ],
          // Camera weight: the world falls away as the rocket gains speed.
          [
            liftoffStarsNear,
            { opacity: [0, 0.58], y: [0, '9vh'] },
            { duration: 3.5, ease: [0.55, 0, 0.85, 0.85], at: 0.95 },
          ],
          [
            liftoffStarsFar,
            { y: [0, '3vh'] },
            { duration: 3.5, ease: [0.55, 0, 0.85, 0.85], at: 0.95 },
          ],
          [
            liftoffEarth,
            { y: ['0%', '9%'] },
            { duration: 3.65, ease: [0.45, 0, 0.35, 1], at: 0.95 },
          ],
          [
            liftoffLaunchTitle,
            { opacity: [0, 1, 1, 0], y: [24, 0, 0, -14] },
            { duration: 3.1, times: [0, 0.15, 0.76, 1], ease: 'easeOut', at: 0.9 },
          ],
          [liftoffOrbit, { opacity: [0, 0.5] }, { duration: 0.35, ease: 'easeOut', at: 3.9 }],
          [
            liftoffOrbitPath,
            { opacity: [0, 0.48], pathLength: [0, 1] },
            { duration: 1.4, ease: [0.22, 0.61, 0.36, 1], at: 4 },
          ],
          [
            liftoffOrbitTitle,
            { opacity: [0, 1], y: [22, 0] },
            { duration: 0.78, ease: [0.16, 1, 0.3, 1], at: 4.6 },
          ],
          [
            liftoffDescription,
            { opacity: [0, 1], y: [10, 0] },
            { duration: 0.6, ease: 'easeOut', at: 4.95 },
          ],
          [
            liftoffStatus,
            { opacity: [0, 1], y: [6, 0] },
            { duration: 0.5, ease: 'easeOut', at: 5.05 },
          ],
          [
            liftoffAction,
            { opacity: [0, 1], y: [10, 0] },
            { duration: 0.6, ease: 'easeOut', at: 5.2 },
          ],
        ];
        liftoffAnimation = animate(sequence);
      });
    });

    onCleanup(() => {
      cancelled = true;
      cancelAnimationFrame(frame);
      liftoffAnimation?.stop();
      liftoffAnimation = undefined;
    });
  });

  const checkForFirstAgentRequest = async () => {
    const slug = harnessSlug();
    if (!slug || agentRequestSeen() || checkingForRequest()) return;
    setCheckingForRequest(true);
    try {
      const result = (await getMessages(
        {
          agent_name: slug,
          limit: '1',
          include_total: 'false',
        },
        { cache: false },
      )) as {
        items?: OnboardingMessageSummary[];
      };
      setRequestCheckError(false);
      const latest = result.items?.[0] ?? null;
      setLatestAgentRequest(latest);
      if (isSuccessfulAgentMessage(latest)) {
        setAgentRequestSeen(true);
        const uid = userId();
        if (uid) markOnboardingDone(uid);
      }
    } catch {
      // Polling should never surface an unhandled rejection. Keep trying in
      // the background and give the user a useful manual recovery affordance.
      setRequestCheckError(true);
    } finally {
      setCheckingForRequest(false);
    }
  };

  createEffect(() => {
    if (step() !== 'activate' || !harnessSlug() || agentRequestSeen()) return;
    setWaitedLong(false);
    // The check toggles `checkingForRequest`; keep that implementation detail
    // out of this effect's dependencies or it becomes a request loop instead
    // of the intended four-second poll.
    untrack(() => void checkForFirstAgentRequest());
    const timer = window.setInterval(() => void checkForFirstAgentRequest(), 4_000);
    // A minute of silence usually means the agent kept its old config.
    const stallTimer = window.setTimeout(() => setWaitedLong(true), 60_000);
    onCleanup(() => {
      window.clearInterval(timer);
      window.clearTimeout(stallTimer);
    });
  });

  // Resume the newest zero-message harness after a reload. Server state is the
  // source of truth: providers, routes determine the next useful
  // stage, while the restored key keeps the connection instructions usable.
  const [resumeHydrated, setResumeHydrated] = createSignal(false);
  const [resumeChecked, setResumeChecked] = createSignal(false);
  let resumeStarted = false;
  let resumeStageResolved = false;
  createEffect(() => {
    if (existingAgents.loading || resumeStarted) return;
    resumeStarted = true;
    const candidate = findResumableAgent(existingAgents()?.agents ?? []);
    if (!candidate) {
      setResumeChecked(true);
      return;
    }
    setHarnessName(candidate.display_name || candidate.agent_name);
    setHarnessSlug(candidate.agent_name);
    if (candidate.agent_category) setCategory(candidate.agent_category as AgentCategory);
    if (candidate.agent_platform) setPlatform(candidate.agent_platform as AgentPlatform);
    setStep('providers');
    setResumeHydrated(true);
    setResumeChecked(true);
    void getAgentKey(candidate.agent_name)
      .then((key) => {
        setHarnessKey(key.apiKey ?? null);
        setHarnessKeyPrefix(key.keyPrefix ?? null);
      })
      .catch(() => undefined);
  });

  createEffect(() => {
    if (!resumeHydrated() || resumeStageResolved || providers.loading || customProviders.loading)
      return;
    if (connectedCount() === 0) {
      setStep('providers');
      resumeStageResolved = true;
      return;
    }
    if (tiers.loading) return;
    if (routedProviderCount() === 0) setStep('playground');
    else setStep('activate');
    resumeStageResolved = true;
  });

  // Never trap users: setup resumes from server state on the next visit, so
  // skipping only skips the guidance, not the work.
  const skipOnboarding = () => {
    const uid = userId();
    if (uid) markOnboardingDone(uid);
    navigate('/register?step=plan');
  };

  const openOnboardingPaywall = () => {
    const uid = userId();
    if (uid) markOnboardingDone(uid);
    navigate('/register?step=plan');
  };

  // Which steps are completed, for the sidebar checkmarks. Steps without
  // server state ('playground') count the furthest step reached,
  // not the current one, so navigating back never un-ticks them.
  const stepDone = (id: StepId): boolean => {
    switch (id) {
      case 'harness':
        return harnessCreated();
      case 'providers':
        return connectedCount() > 0;
      case 'playground':
        return maxStepReached() > STEP_ORDER.indexOf('playground');
      case 'route':
        return routedProviderCount() > 0;
      case 'activate':
        return agentRequestSeen();
    }
  };

  const completedStepCount = () => STEP_ORDER.filter(stepDone).length;

  return (
    <div class="welcome">
      <Title>Welcome - Manifest</Title>
      <Meta
        name="description"
        content="Connect your AI harness and send its first reliable request through Manifest."
      />

      {/* ── Sidebar: activation progress + steps ───── */}
      <aside class="welcome__sidebar">
        <div class="welcome__sidebar-top">
          <img
            src="/logotype-white.svg"
            alt="Manifest LLM Gateway"
            class="welcome__logo-mark welcome__logo-light"
          />
          <img src="/logotype-dark.svg" alt="" class="welcome__logo-mark welcome__logo-dark" />
        </div>

        <section
          class="welcome__progress"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`${completedStepCount()} of ${STEP_ORDER.length} setup steps complete`}
        >
          <div class="welcome__progress-header">
            <p>Setup progress</p>
            <span>
              {completedStepCount()}/{STEP_ORDER.length}
            </span>
          </div>
          <ol class="welcome__nav">
            <For each={STEP_ORDER}>
              {(id, index) => (
                <li
                  class="welcome__nav-item"
                  classList={{
                    'welcome__nav-item--active': step() === id,
                    'welcome__nav-item--done': stepDone(id),
                  }}
                >
                  {/* Reached steps stay revisitable; unreached ones stay locked
                      so the wizard can't be skipped ahead from the sidebar. */}
                  <button
                    type="button"
                    class="welcome__nav-btn"
                    disabled={index() > maxStepReached()}
                    tabindex={index() > maxStepReached() ? -1 : undefined}
                    aria-current={step() === id ? 'step' : undefined}
                    onClick={() => goTo(id)}
                  >
                    <span class="welcome__nav-check" aria-hidden="true">
                      <Show when={stepDone(id)} fallback={index() + 1}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="3"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </Show>
                    </span>
                    <span class="welcome__nav-label">{STEP_META[id].label}</span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </section>

        <div class="welcome__sidebar-footer">
          <button type="button" class="btn btn--ghost btn--sm" onClick={skipOnboarding}>
            Skip setup for now
          </button>
        </div>
      </aside>

      {/* ── Content ────────────────────────────────── */}
      <main class="welcome__main">
        <Show when={!resumeChecked()}>
          <div class="welcome__panel welcome__pending" role="status">
            <span class="welcome__spinner" />
            <span>Restoring your setup…</span>
          </div>
        </Show>

        <Show when={resumeChecked()}>
          {/* ====== Harness ====== */}
          <Show when={step() === 'harness'}>
            <div class="welcome__panel">
              <div class="welcome__panel-header">
                <p class="welcome__eyebrow">{eyebrow('harness')}</p>
                <h1 class="welcome__panel-title">Create your first harness</h1>
                <p class="welcome__panel-desc">
                  A harness represents the agent or application whose requests Manifest will route,
                  repair and observe.
                </p>
              </div>

              <Show
                when={!harnessCreated()}
                fallback={
                  <div
                    class="panel welcome__form-panel welcome__harness-summary"
                    style="padding: 20px; margin-bottom: 0;"
                  >
                    <Show when={platform() && PLATFORM_ICONS[platform()!]}>
                      <img
                        src={PLATFORM_ICONS[platform()!]}
                        alt=""
                        class="welcome__harness-summary-icon"
                        aria-hidden="true"
                      />
                    </Show>
                    <div>
                      <p class="welcome__harness-summary-name">{harnessName()}</p>
                      <Show when={platform()}>
                        <p class="welcome__harness-summary-type">{PLATFORM_LABELS[platform()!]}</p>
                      </Show>
                    </div>
                  </div>
                }
              >
                <form
                  class="panel welcome__form-panel"
                  style="padding: 20px; margin-bottom: 0;"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createHarness();
                  }}
                >
                  <div class="agent-type-select-row">
                    <div>
                      <label class="modal-card__field-label">Type</label>
                      <AgentTypeSelect
                        category={category()}
                        platform={platform()}
                        onCategoryChange={handleCategoryChange}
                        onPlatformChange={setPlatform}
                        disabled={creating()}
                      />
                    </div>
                    <div style="flex: 1;">
                      <label class="modal-card__field-label" for="welcome-harness-name">
                        Harness name
                      </label>
                      <input
                        ref={(el) => requestAnimationFrame(() => el.focus())}
                        id="welcome-harness-name"
                        class="modal-card__input modal-card__input--lg"
                        type="text"
                        placeholder="e.g. My Cool Harness"
                        value={harnessName()}
                        onInput={(e) => setHarnessName(e.currentTarget.value)}
                        disabled={creating()}
                        required
                        aria-describedby={harnessError() ? 'welcome-harness-error' : undefined}
                      />
                    </div>
                  </div>
                  <div class="add-agent-toggles">
                    <div class="model-params__group">
                      {/* Same label treatment as the Type / Harness name field
                          labels, not the larger Model-params group header. */}
                      <div class="modal-card__field-label add-agent-toggles__header">Settings</div>
                      <div class="model-params__group-card">
                        <div class="model-params__row">
                          <div class="model-params__row-text">
                            <div class="model-params__label-title">
                              <span>Autofix</span>
                            </div>
                            <div class="model-params__label-hint">
                              Repair eligible failing requests before falling back. Failed requests
                              are sent to Manifest Autofix for diagnosis; provider authorization
                              credentials are never sent.
                            </div>
                          </div>
                          <div class="model-params__row-control">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={autofixEnabled()}
                              aria-label="Autofix"
                              class="settings-switch"
                              classList={{ 'settings-switch--on': autofixEnabled() }}
                              disabled={creating()}
                              onClick={() => setAutofixEnabled(!autofixEnabled())}
                            >
                              <span class="settings-switch__track">
                                <span class="settings-switch__thumb" />
                              </span>
                            </button>
                          </div>
                        </div>
                        <div class="model-params__separator" />
                        <div class="model-params__row">
                          <div class="model-params__row-text">
                            <div class="model-params__label-title">
                              <span>Enable logs</span>
                            </div>
                            <div class="model-params__label-hint">
                              See exactly what your agent sends on every attempt, and debug it
                              faster.{' '}
                              {selfHosted.state === 'ready' &&
                                (selfHosted()
                                  ? 'Logs stay in your own database.'
                                  : 'Logs are stored in your Manifest workspace.')}
                            </div>
                          </div>
                          <div class="model-params__row-control">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={logsEnabled()}
                              aria-label="Enable logs"
                              class="settings-switch"
                              classList={{ 'settings-switch--on': logsEnabled() }}
                              disabled={creating()}
                              onClick={() => setLogsEnabled(!logsEnabled())}
                            >
                              <span class="settings-switch__track">
                                <span class="settings-switch__thumb" />
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <Show when={autofixEnabled()}>
                    <p class="autofix-consent__legal welcome__legal">
                      By enabling Autofix, you agree to Manifest&apos;s{' '}
                      <a
                        href="https://manifest.build/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Terms
                      </a>{' '}
                      and{' '}
                      <a
                        href="https://manifest.build/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Privacy Policy
                      </a>
                      .
                    </p>
                  </Show>
                  <Show when={harnessError()}>
                    <p
                      id="welcome-harness-error"
                      class="welcome__error"
                      role="alert"
                      style="margin-top: 10px;"
                    >
                      {harnessError()}
                    </p>
                  </Show>
                  <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
                    <button
                      type="submit"
                      class="btn btn--primary btn--sm"
                      disabled={!harnessName().trim() || !platform() || creating()}
                    >
                      {creating() ? <span class="spinner" /> : 'Create harness'}
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </Show>

          {/* ====== Providers ====== */}
          <Show when={step() === 'providers'}>
            <div class="welcome__panel">
              <div class="welcome__panel-header">
                <p class="welcome__eyebrow">{eyebrow('providers')}</p>
                <h1 class="welcome__panel-title">Connect providers</h1>
                <p class="welcome__panel-desc">
                  {harnessName().trim() || 'Your harness'} routes requests across the providers you
                  connect. Start with one, then add two more independent providers for full fallback
                  coverage.
                </p>
              </div>

              <div class="panel__tabs" role="tablist">
                <button
                  id="welcome-provider-tab-api-key"
                  class="panel__tab"
                  classList={{ 'panel__tab--active': tab() === 'api_key' }}
                  type="button"
                  role="tab"
                  aria-selected={tab() === 'api_key'}
                  aria-controls="welcome-provider-panel-api-key"
                  tabindex={tab() === 'api_key' ? 0 : -1}
                  onClick={() => selectProviderTab('api_key')}
                  onKeyDown={handleProviderTabKeyDown}
                >
                  <svg
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
                <button
                  id="welcome-provider-tab-subscription"
                  class="panel__tab"
                  classList={{ 'panel__tab--active': tab() === 'subscription' }}
                  type="button"
                  role="tab"
                  aria-selected={tab() === 'subscription'}
                  aria-controls="welcome-provider-panel-subscription"
                  tabindex={tab() === 'subscription' ? 0 : -1}
                  onClick={() => selectProviderTab('subscription')}
                  onKeyDown={handleProviderTabKeyDown}
                >
                  <svg
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
                  Subscriptions
                </button>
                <Show when={selfHosted()}>
                  <button
                    id="welcome-provider-tab-local"
                    class="panel__tab"
                    classList={{ 'panel__tab--active': tab() === 'local' }}
                    type="button"
                    role="tab"
                    aria-selected={tab() === 'local'}
                    aria-controls="welcome-provider-panel-local"
                    tabindex={tab() === 'local' ? 0 : -1}
                    onClick={() => selectProviderTab('local')}
                    onKeyDown={handleProviderTabKeyDown}
                  >
                    <svg
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

              <Show
                when={!providers.loading && providerAgent()}
                fallback={
                  <div class="welcome__pending">
                    <span class="welcome__spinner" />
                    <span>Loading providers…</span>
                  </div>
                }
              >
                <div
                  id={`welcome-provider-panel-${tab()}`}
                  class="provider-modal__list welcome__provider-list"
                  role="tabpanel"
                  aria-labelledby={`welcome-provider-tab-${tab()}`}
                >
                  <For each={tabProviders()}>
                    {(p) => {
                      const con = () => isConnected(p.id, tab());
                      return (
                        <button
                          type="button"
                          class="provider-toggle"
                          onClick={() => setConnectTarget(p.id)}
                        >
                          <span class="provider-toggle__icon">
                            <ProviderMark providerId={p.id} name={p.name} size={22} />
                          </span>
                          <span class="provider-toggle__info">
                            <span class="provider-toggle__name">{p.name}</span>
                          </span>
                          <Show
                            when={con()}
                            fallback={<span class="btn btn--outline btn--sm">Connect</span>}
                          >
                            <span class="welcome__provider-connected">Connected</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={agent.error || providers.error}>
                <p class="welcome__error" role="alert">
                  We could not load your providers. Refresh the page and try again.
                </p>
              </Show>

              <div class="welcome__actions welcome__actions--split welcome__actions--sticky">
                <Show
                  when={connectedCount() > 0}
                  fallback={
                    <span class="welcome__actions-note">
                      Connect at least one provider to continue.
                    </span>
                  }
                >
                  <button type="button" class="welcome__text-link" onClick={() => goTo('route')}>
                    Test models later
                  </button>
                </Show>
                <div style="display:flex;align-items:center;gap:12px">
                  <Show when={connectedCount() > 0}>
                    <span class="welcome__actions-note">
                      {connectedCount()} {connectedCount() === 1 ? 'provider' : 'providers'}{' '}
                      connected.
                    </span>
                  </Show>
                  <button
                    type="button"
                    class="btn btn--primary"
                    disabled={connectedCount() === 0}
                    onClick={() => goTo('playground')}
                  >
                    Test models
                  </button>
                </div>
              </div>
            </div>
          </Show>

          {/* ====== Embedded Playground ====== */}
          <Show when={step() === 'playground'}>
            <div class="welcome__panel welcome__panel--playground">
              <div class="welcome__panel-header">
                <p class="welcome__eyebrow">{eyebrow('playground')}</p>
                <h1 class="welcome__panel-title">Test your models</h1>
                <p class="welcome__panel-desc">
                  Compare how your available models handle one representative prompt without leaving
                  onboarding.
                </p>
              </div>
              <Playground embedded />
              <div class="welcome__actions welcome__actions--split welcome__actions--sticky">
                <button type="button" class="btn btn--ghost" onClick={() => goTo('providers')}>
                  Back to providers
                </button>
                <span class="welcome__actions-note">This step is optional.</span>
                <button type="button" class="btn btn--primary" onClick={() => goTo('route')}>
                  Continue to routing
                </button>
              </div>
            </div>
          </Show>

          {/* ====== Reliability routing ====== */}
          <Show when={step() === 'route'}>
            <div class="welcome__panel welcome__panel--routing">
              <div class="welcome__panel-header">
                <p class="welcome__eyebrow">{eyebrow('route')}</p>
                <h1 class="welcome__panel-title">Configure default routing</h1>
              </div>

              <Show
                when={!tiers.loading}
                fallback={
                  <div class="welcome__pending">
                    <span class="welcome__spinner" />
                    <span>Loading routing…</span>
                  </div>
                }
              >
                <RoutingDefaultTierSection
                  agentName={harnessSlug}
                  tier={() => actions.getTier('default')}
                  models={() => models() ?? []}
                  customProviders={() => harnessCustomProviders() ?? []}
                  activeProviders={harnessActive}
                  connectedProviders={harnessConnected}
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
                  complexityEnabled={() => false}
                  togglingComplexity={() => false}
                  onToggleComplexity={() => {}}
                  showComplexityToggle={() => false}
                  responseMode={() => actions.getTier('default')?.response_mode ?? 'buffered'}
                  changingResponseMode={() => false}
                  onResponseModeChange={() => {}}
                  embedded
                  getModelParams={getModelParamsFor}
                  setModelParams={setModelParamsFor}
                />
              </Show>

              <div class="welcome__actions welcome__actions--split">
                <button class="btn btn--ghost" onClick={() => goTo('playground')}>
                  Back to test models
                </button>
                <button
                  class="btn btn--primary"
                  disabled={routedProviderCount() === 0}
                  onClick={() => goTo('activate')}
                >
                  Continue
                </button>
              </div>
            </div>
          </Show>

          {/* ====== First request from the real harness ====== */}
          <Show when={step() === 'activate'}>
            <div class="welcome__panel welcome__panel--setup">
              <div class="welcome__panel-header">
                <p class="welcome__eyebrow">{eyebrow('activate')}</p>
                <h1 class="welcome__panel-title">Connect your harness and go live</h1>
                <p class="welcome__panel-desc">
                  Point {harnessName().trim() || 'your agent'} at Manifest with the instructions
                  below, then send one message. We detect the first successful request
                  automatically.
                </p>
              </div>

              <section
                class="panel welcome__form-panel welcome__setup-snippets"
                style="padding: 20px; margin-bottom: 0;"
                aria-label="Harness setup instructions"
              >
                <SetupStepAddProvider
                  apiKey={harnessKey()}
                  keyPrefix={harnessKeyPrefix()}
                  baseUrl={baseUrl()}
                  platform={platform()}
                />
              </section>

              <p class="welcome__panel-desc">
                Once configured, send a message from your agent. Manifest detects the first
                successful request automatically.
              </p>

              <section
                class="welcome__agent-wait"
                classList={{ 'welcome__agent-wait--success': agentRequestSeen() }}
                aria-live="polite"
              >
                <Show
                  when={agentRequestSeen()}
                  fallback={
                    <>
                      <div class="welcome__agent-wait-heading">
                        <span class="welcome__spinner" aria-hidden="true" />
                        <div>
                          <h2 class="welcome__route-test-title">
                            Waiting for your agent’s first request
                          </h2>
                          <p class="welcome__section-desc">
                            Keep this page open and send a message from your agent. We check every
                            few seconds.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        class="welcome__text-link"
                        disabled={checkingForRequest()}
                        onClick={() => void checkForFirstAgentRequest()}
                      >
                        {checkingForRequest() ? 'Checking…' : 'Check again'}
                      </button>
                      <Show when={requestCheckError()}>
                        <p class="welcome__availability-note" role="status">
                          We couldn’t verify a request just now. Confirm that your agent can reach
                          Manifest, then try again.
                        </p>
                      </Show>
                      <Show when={waitedLong() && !latestAgentRequest()}>
                        <p class="welcome__availability-note" role="status">
                          Nothing yet? Most agents need a restart after configuration changes before
                          they pick up the new endpoint.
                        </p>
                      </Show>
                      <Show
                        when={
                          latestAgentRequest() && !isSuccessfulAgentMessage(latestAgentRequest())
                        }
                      >
                        <div class="welcome__request-failure" role="alert">
                          <strong>We received the request, but it failed.</strong>
                          <p>
                            {latestAgentRequest()?.error_message ||
                              `Manifest recorded status “${latestAgentRequest()?.status}”. Fix the issue and send another message.`}
                          </p>
                          <Show when={errorDocCode()}>
                            <a
                              class="welcome__text-link"
                              href={manifestErrorDocsUrl(errorDocCode()!)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              What does {errorDocCode()} mean?
                            </a>
                          </Show>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <div class="welcome__agent-wait-heading" role="status">
                    <span class="welcome__success-icon" aria-hidden="true">
                      ✓
                    </span>
                    <div>
                      <strong>Your harness is live.</strong>
                      <p class="welcome__section-desc">
                        Manifest successfully routed the first real request
                        <Show when={latestAgentRequest()?.model}>
                          {' '}
                          to {latestAgentRequest()?.model}
                        </Show>
                        <Show when={latestAgentRequest()?.duration_ms}>
                          {' '}
                          in {latestAgentRequest()?.duration_ms} ms
                        </Show>
                        .
                      </p>
                    </div>
                  </div>
                </Show>
              </section>

              <div class="welcome__actions welcome__actions--split">
                <button class="btn btn--ghost" onClick={() => goTo('route')}>
                  Back to routing
                </button>
                <Show when={agentRequestSeen()}>
                  <button class="btn btn--primary" onClick={openOnboardingPaywall}>
                    Go to dashboard
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
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      </main>

      {/* Playground run-details drawer (right sidebar) — rendered by App in
          the dashboard, by the wizard itself here. */}
      {rightSidebar()}

      {/* Dev-only: the liftoff cinematic, accessible via ?preview=liftoff. In
          production the activate step already says "it works", so a 5.6 s
          animation would be frustrating — route straight to the dashboard. */}
      <Show when={liftoffPreview()}>
        <section
          ref={(element) => (liftoffRoot = element)}
          class="welcome__liftoff"
          role="dialog"
          aria-modal="true"
          aria-labelledby="welcome-liftoff-title"
          aria-describedby="welcome-liftoff-description"
        >
          <div
            ref={(element) => (liftoffStarsNear = element)}
            class="welcome__liftoff-stars welcome__liftoff-stars--near"
            aria-hidden="true"
          />
          <div
            ref={(element) => (liftoffStarsFar = element)}
            class="welcome__liftoff-stars welcome__liftoff-stars--far"
            aria-hidden="true"
          />
          <div
            ref={(element) => (liftoffFlash = element)}
            class="welcome__liftoff-flash"
            aria-hidden="true"
          />
          <svg
            ref={(element) => (liftoffOrbit = element)}
            class="welcome__liftoff-orbit"
            viewBox="0 0 1000 460"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <ellipse
              ref={(element) => (liftoffOrbitPath = element)}
              cx="500"
              cy="230"
              rx="496"
              ry="226"
              pathLength="1"
            />
            {/* The departed rocket, now a beacon on the orbit line (CSS-timed). */}
            <circle class="welcome__liftoff-beacon" cx="929" cy="117" r="5" />
          </svg>
          <div
            ref={(element) => (liftoffEarth = element)}
            class="welcome__liftoff-earth"
            aria-hidden="true"
          />
          <div
            ref={(element) => (liftoffSmoke = element)}
            class="welcome__liftoff-smoke"
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
          </div>

          <div
            ref={(element) => (liftoffRocket = element)}
            class="welcome__liftoff-rocket"
            aria-hidden="true"
          >
            <span ref={(element) => (liftoffPlume = element)} class="welcome__liftoff-plume" />
            <span
              ref={(element) => (liftoffInnerPlume = element)}
              class="welcome__liftoff-plume-inner"
            />
            <svg viewBox="0 0 100 148" fill="none">
              <path
                d="M50 4C30.7 24.8 25 60.5 29 94l21 21 21-21c4-33.5-1.7-69.2-21-90Z"
                fill="currentColor"
              />
              <path
                d="M50 4c-8.2 8.9-14.1 20.3-17.6 33.4h35.2C64.1 24.3 58.2 12.9 50 4Z"
                fill="white"
                fill-opacity=".16"
              />
              <circle
                cx="50"
                cy="55"
                r="11"
                fill="hsl(var(--background))"
                stroke="currentColor"
                stroke-opacity=".72"
                stroke-width="4"
              />
              <circle cx="47" cy="52" r="4" fill="currentColor" fill-opacity=".72" />
              <path
                d="M29.8 78 10 99v28l25-18M70.2 78 90 99v28l-25-18"
                fill="currentColor"
                stroke="currentColor"
                stroke-opacity=".26"
                stroke-width="3"
                stroke-linejoin="round"
              />
              <path
                d="M39 110h22l-4 15H43l-4-15Z"
                fill="hsl(var(--muted))"
                stroke="currentColor"
                stroke-opacity=".36"
                stroke-width="2"
              />
            </svg>
          </div>

          <div class="welcome__liftoff-copy">
            <p ref={(element) => (liftoffKicker = element)} class="welcome__liftoff-kicker">
              Onboarding complete
            </p>
            <div class="welcome__liftoff-titles">
              <h1
                ref={(element) => (liftoffLaunchTitle = element)}
                class="welcome__liftoff-title welcome__liftoff-title--launch"
              >
                Liftoff
              </h1>
              <h1
                ref={(element) => (liftoffOrbitTitle = element)}
                id="welcome-liftoff-title"
                class="welcome__liftoff-title welcome__liftoff-title--orbit"
              >
                Orbit achieved
              </h1>
            </div>
            <p
              ref={(element) => (liftoffDescription = element)}
              id="welcome-liftoff-description"
              class="welcome__liftoff-description"
            >
              Your agent's first request just came through.
              <Show when={latestAgentRequest()?.model}>
                {' '}
                Routed to {latestAgentRequest()?.model}
                <Show when={latestAgentRequest()?.duration_ms}>
                  {' '}
                  in {latestAgentRequest()?.duration_ms} ms
                </Show>
                .
              </Show>
            </p>
          </div>

          {/* Exit cluster: reading ends top-left, the scene resolves bottom-right —
              status caption over the one action, at the Z-pattern terminus. */}
          <div class="welcome__liftoff-exit">
            <span
              ref={(element) => (liftoffStatus = element)}
              class="welcome__liftoff-status"
              aria-hidden="true"
            >
              {harnessSlug() || 'agent'} · live
            </span>
            <button
              ref={(element) => (liftoffAction = element)}
              class="welcome__liftoff-action btn btn--primary"
              onClick={openOnboardingPaywall}
            >
              Go to dashboard
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
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        </section>
      </Show>

      {/* Provider connect modal — root level so the fixed overlay fills the viewport */}
      <Show when={step() === 'providers' && connectTarget() && harnessSlug()}>
        <ProviderSelectModal
          agentName={harnessSlug()}
          providers={providers() ?? []}
          customProviders={customProviders() ?? []}
          providerDeepLink={{
            providerId: connectTarget()!,
            authType: tab() === 'local' ? 'api_key' : tab(),
          }}
          onClose={() => {
            setConnectTarget(null);
          }}
          onUpdate={handleProvidersUpdate}
          onPollProviders={handleProvidersUpdate}
        />
      </Show>

      {/* Model / fallback picker modals for the routing card — same as Routing.tsx */}
      <Show when={harnessSlug()}>
        <RoutingModals
          agentName={harnessSlug}
          dropdownTier={dropdownTier}
          onDropdownClose={() => {
            setDropdownTier(null);
          }}
          fallbackPickerTier={fallbackPickerTier}
          onFallbackPickerClose={() => {
            setFallbackPickerTier(null);
          }}
          showProviderModal={() => false}
          onProviderModalClose={() => {}}
          instructionModal={instructionModal}
          instructionProvider={() => null}
          onInstructionClose={() => {
            setInstructionModal(null);
          }}
          models={() => models() ?? []}
          tiers={() => tiers() ?? []}
          customProviders={() => harnessCustomProviders() ?? []}
          connectedProviders={harnessConnected}
          getTier={actions.getTier}
          onOverride={handleOverride}
          onAddFallback={handleAddFallback}
          onProviderUpdate={refetchRouting}
          onOpenProviderModal={() => setStep('providers')}
        />
      </Show>

      {/* Dev-only: fire the first request from the UI instead of a terminal.
          Hidden once liftoff takes over — the drawer would sit under it anyway. */}
      {__DEV_MODE__ && WingmanDevTools && (
        <Show when={step() === 'activate' && !agentRequestSeen()}>
          <Suspense fallback={null}>
            <WingmanDevTools />
          </Suspense>
        </Show>
      )}
    </div>
  );
};

export default Welcome;
/* v8 ignore stop */
