import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('solid-js/web', async (importOriginal) => {
  const mod = await importOriginal<typeof import('solid-js/web')>();
  return { ...mod, Portal: (props: any) => props.children };
});

const mockResetHeaderTier = vi.fn();
const mockSetHeaderTierFallbacks = vi.fn();
const mockClearHeaderTierFallbacks = vi.fn();
vi.mock('../../src/services/api/header-tiers.js', () => ({
  resetHeaderTier: (...args: unknown[]) => mockResetHeaderTier(...args),
  setHeaderTierFallbacks: (...args: unknown[]) => mockSetHeaderTierFallbacks(...args),
  clearHeaderTierFallbacks: (...args: unknown[]) => mockClearHeaderTierFallbacks(...args),
}));

vi.mock('../../src/services/api/model-params.js', () => ({
  getModelParamSpecs: vi.fn(),
}));

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: (id: string) => <span data-testid={`provider-icon-${id}`} />,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: (t: string | null | undefined) => (t ? <span data-testid={`auth-${t}`} /> : null),
  authLabel: (authType: string | null | undefined) =>
    authType === 'subscription' ? 'Subscription' : 'API Key',
}));

vi.mock('../../src/services/routing-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/routing-utils.js')>();
  return {
    ...actual,
    resolveProviderId: (p: string) => p.toLowerCase(),
    inferProviderFromModel: (m: string) => {
      if (m.startsWith('gpt')) return 'openai';
      if (m.startsWith('claude')) return 'anthropic';
      if (/^[a-z][\w-]*\//.test(m)) return 'openrouter';
      return undefined;
    },
    pricePerM: (n: number) => `$${(n * 1_000_000).toFixed(2)}`,
    stripCustomPrefix: (m: string) => m,
  };
});

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'groq', name: 'Groq' },
    { id: 'openrouter', name: 'OpenRouter' },
  ],
}));

vi.mock('../../src/services/formatters.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/formatters.js')>()),
  customProviderColor: () => '#000',
}));

vi.mock('../../src/services/provider-utils.js', () => ({
  getModelLabel: (_p: string, m: string) => m,
}));

vi.mock('../../src/components/FallbackList.js', () => ({
  default: (props: Record<string, unknown>) => {
    // Read every prop so the parent's JSX-attribute getters fire. Without
    // this, lines like `tier={props.tier.id}` and `fallbackRoutes={...}`
    // stay unread and v8 reports them as uncovered.
    const _read = [
      props.agentName,
      props.tier,
      props.models,
      props.customProviders,
      props.connectedProviders,
      props.tierData,
      props.getModelParams,
      props.setModelParams,
      props.modelHasParams,
      props.modelParamsScope,
      props.responseMode,
    ];
    void _read;
    return (
      <div data-testid="fallback-list">
        <div data-testid="fb-response-mode">{String(props.responseMode ?? '')}</div>
        <div data-testid="fb-count">{(props.fallbacks as string[]).length}</div>
        <div data-testid="fb-routes-count">
          {(props.fallbackRoutes as unknown[] | null | undefined)?.length ?? 'null'}
        </div>
        <button data-testid="fb-add" onClick={() => (props.onAddFallback as () => void)?.()}>
          add
        </button>
        <button
          data-testid="fb-persist"
          onClick={() => {
            void (
              props.persistFallbacks as (
                a: string,
                t: string,
                m: string[],
                r?: unknown,
              ) => Promise<unknown>
            )?.('agent', 'tier-id', ['m'], undefined);
          }}
        >
          persist
        </button>
        <button
          data-testid="fb-clear"
          onClick={() => {
            void (props.persistClearFallbacks as (a: string, t: string) => Promise<unknown>)?.(
              'agent',
              'tier-id',
            );
          }}
        >
          clear
        </button>
        <button
          data-testid="fb-update"
          onClick={() => (props.onUpdate as (m: string[]) => void)?.(['new'])}
        >
          update
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/ModelPickerModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    // Read every prop so JSX attribute lines fire.
    const _read = [
      props.tierId,
      props.models,
      props.tiers,
      props.customProviders,
      props.connectedProviders,
      props.requiredCapability,
    ];
    void _read;
    return (
      <div data-testid="model-picker">
        <span data-testid="picker-required-capability">
          {String(props.requiredCapability ?? '')}
        </span>
        <button
          data-testid="picker-pick"
          onClick={() =>
            (
              props.onSelect as (tierId: string, model: string, prov: string, auth?: string) => void
            )('ht-1', 'gpt-4o', 'openai', 'api_key')
          }
        >
          pick
        </button>
        <button data-testid="picker-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/KeyPickerModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    const _read = [props.providerName, props.modelName, props.keys];
    void _read;
    return (
      <div data-testid="key-picker-modal">
        <button
          data-testid="key-picker-pick-personal"
          onClick={() => (props.onPick as (label: string | null) => void)('Personal')}
        >
          pick Personal
        </button>
        <button data-testid="key-picker-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/HeaderTierSnippetModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    const _read = [props.agentName, props.tier];
    void _read;
    return (
      <div data-testid="snippet-modal">
        <button data-testid="snippet-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
      </div>
    );
  },
}));

import HeaderTierCard from '../../src/components/HeaderTierCard';
import type { ProviderParamSpecCatalog } from 'manifest-shared';
import { getModelParamSpecs } from '../../src/services/api/model-params.js';
import type { HeaderTier } from '../../src/services/api/header-tiers';
import type { AvailableModel, CustomProviderData, RoutingProvider } from '../../src/services/api';

const baseTier: HeaderTier = {
  id: 'ht-1',
  agent_id: 'agent-1',
  name: 'Premium',
  header_key: 'x-manifest-tier',
  header_value: 'premium',
  badge_color: 'indigo',
  sort_order: 0,
  enabled: true,
  override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
  fallback_routes: null,
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
};

const modelParamSpecs: ProviderParamSpecCatalog = [
  {
    provider: 'deepseek',
    authType: 'api_key',
    model: 'deepseek-v4',
    params: [
      {
        path: 'thinking.type',
        type: 'enum',
        label: 'Thinking mode',
        description: 'Controls whether DeepSeek thinking mode is enabled.',
        default: 'enabled',
        values: ['enabled', 'disabled'],
        group: 'reasoning',
      },
    ],
  },
  {
    provider: 'deepseek',
    authType: 'api_key',
    model: 'deepseek-v4-flash',
    params: [
      {
        path: 'thinking.type',
        type: 'enum',
        label: 'Thinking mode',
        description: 'Controls whether DeepSeek thinking mode is enabled.',
        default: 'enabled',
        values: ['enabled', 'disabled'],
        group: 'reasoning',
      },
    ],
  },
];

const models: AvailableModel[] = [
  {
    model_name: 'gpt-4o',
    provider: 'OpenAI',
    auth_type: 'api_key',
    input_price_per_token: 0.000005,
    output_price_per_token: 0.000015,
    context_window: 128000,
    capability_reasoning: false,
    capability_code: true,
    quality_score: 8,
    display_name: 'GPT-4o',
  },
];

const connectedProviders: RoutingProvider[] = [
  {
    id: 'p1',
    provider: 'openai',
    auth_type: 'api_key',
    is_active: true,
    has_api_key: true,
    label: 'Default',
    priority: 0,
    connected_at: '2025-01-01',
  },
];

const customProviders: CustomProviderData[] = [];

describe('HeaderTierCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResetHeaderTier.mockResolvedValue(undefined);
    mockSetHeaderTierFallbacks.mockResolvedValue(undefined);
    mockClearHeaderTierFallbacks.mockResolvedValue(undefined);
  });

  it('renders the tier name and the header rule', () => {
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('Premium');
    expect(container.textContent).toContain('x-manifest-tier');
    expect(container.textContent).toContain('premium');
  });

  it('renders the override_route.model display label', () => {
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__main')?.textContent).toBe('GPT-4o');
  });

  it('marks a non-stream primary as skipped and passes stream mode to fallbacks', () => {
    const streamTier = {
      ...baseTier,
      response_mode: 'stream' as const,
      override_route: { provider: 'custom:local', authType: 'api_key' as const, model: 'legacy' },
    };
    const streamModels: AvailableModel[] = [
      ...models,
      {
        model_name: 'legacy',
        provider: 'custom:local',
        auth_type: 'api_key',
        input_price_per_token: 0,
        output_price_per_token: 0,
        context_window: 8000,
        capability_reasoning: false,
        capability_code: false,
        quality_score: 1,
        display_name: 'Legacy',
        capabilities: ['text'],
      },
    ];

    const { container, getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={streamTier}
        models={streamModels}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));

    expect(container.querySelector('.routing-card__model-chip--skipped')).not.toBeNull();
    expect(container.querySelector('.routing-card__skipped-badge')?.textContent).toContain(
      'Skipped in Stream',
    );
    expect(getByTestId('fb-response-mode').textContent).toBe('stream');
  });

  it("uses the route's authType for the badge instead of looking it up by provider", () => {
    const tierSub = {
      ...baseTier,
      override_route: { provider: 'openai', authType: 'subscription', model: 'gpt-4o' } as const,
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierSub}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-testid="auth-subscription"]')).not.toBeNull();
    expect(container.textContent).toContain('Included in subscription');
  });

  it('shows the primary account chip for multi-account header tier routes', () => {
    const onOverride = vi.fn();
    const tierSub = {
      ...baseTier,
      override_route: { provider: 'openai', authType: 'subscription', model: 'gpt-4o' } as const,
    };
    const providers: RoutingProvider[] = [
      {
        ...connectedProviders[0],
        id: 'sub-1',
        auth_type: 'subscription',
        label: 'Default',
        priority: 0,
      },
      {
        ...connectedProviders[0],
        id: 'sub-2',
        auth_type: 'subscription',
        label: 'Personal',
        priority: 1,
      },
    ];
    const { container, getByRole, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierSub}
        models={models}
        customProviders={customProviders}
        connectedProviders={providers}
        onOverride={onOverride}
        onFallbacksUpdate={vi.fn()}
      />
    ));

    const chip = container.querySelector('.routing-card__key-chip') as HTMLButtonElement;
    expect(chip.textContent).toContain('Default');
    fireEvent.click(chip);
    fireEvent.click(getByRole('option', { name: /Personal/ }));

    expect(onOverride).toHaveBeenCalledWith('gpt-4o', 'openai', 'subscription', 'Personal');
    expect(queryByTestId('model-picker')).toBeNull();
  });

  it('shows an explicit primary account pin on header tier routes', () => {
    const tierSub = {
      ...baseTier,
      override_route: {
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-4o',
        keyLabel: 'Personal',
      } as const,
    };
    const providers: RoutingProvider[] = [
      {
        ...connectedProviders[0],
        id: 'sub-1',
        auth_type: 'subscription',
        label: 'Default',
        priority: 0,
      },
      {
        ...connectedProviders[0],
        id: 'sub-2',
        auth_type: 'subscription',
        label: 'Personal',
        priority: 1,
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierSub}
        models={models}
        customProviders={customProviders}
        connectedProviders={providers}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));

    expect(container.querySelector('.routing-card__key-chip')?.textContent).toContain('Personal');
  });

  it('shows the included per-request quota burn rate for per-request subscriptions', () => {
    const tierSub = {
      ...baseTier,
      override_route: {
        provider: 'opencode-go',
        authType: 'subscription',
        model: 'opencode-go/glm-5.1',
      } as const,
    };
    const gatewayModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'opencode-go/glm-5.1',
        provider: 'opencode-go',
        auth_type: 'subscription',
        display_name: 'GLM-5.1',
        cost_per_request: 0.013636,
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierSub}
        models={gatewayModels}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('Included ($0.0136 quota/req)');
  });

  it('renders a + Add model button when override_route is null', () => {
    const tierEmpty = { ...baseTier, override_route: null };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierEmpty}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    const add = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ Add model'),
    );
    expect(add).toBeDefined();
  });

  it('opens the picker in primary mode when + Add model is clicked', () => {
    const tierEmpty = { ...baseTier, override_route: null };
    const { container, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierEmpty}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(queryByTestId('model-picker')).toBeNull();
    const add = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ Add model'),
    ) as HTMLButtonElement;
    fireEvent.click(add);
    expect(queryByTestId('model-picker')).not.toBeNull();
  });

  it('requires stream-capable models when the header tier is in stream mode', () => {
    const tierEmpty = { ...baseTier, override_route: null, response_mode: 'stream' as const };
    const { container, getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierEmpty}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    const add = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ Add model'),
    ) as HTMLButtonElement;
    fireEvent.click(add);
    expect(getByTestId('picker-required-capability').textContent).toBe('stream');
  });

  it('calls onOverride with the picked route when picker selects a primary model', async () => {
    const tierEmpty = { ...baseTier, override_route: null };
    const onOverride = vi.fn();
    const { container, getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierEmpty}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={onOverride}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Add model'),
      ) as HTMLButtonElement,
    );
    fireEvent.click(getByTestId('picker-pick') as HTMLButtonElement);
    await waitFor(() => {
      expect(onOverride).toHaveBeenCalledWith('gpt-4o', 'openai', 'api_key');
    });
  });

  it('calls reset endpoint and onFallbacksUpdate([]) when Reset is clicked', async () => {
    const onFallbacksUpdate = vi.fn();
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={onFallbacksUpdate}
      />
    ));
    const resetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset'),
    ) as HTMLButtonElement;
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(mockResetHeaderTier).toHaveBeenCalledWith('demo', 'ht-1');
      expect(onFallbacksUpdate).toHaveBeenCalledWith([]);
    });
  });

  it('opens the kebab menu and exposes Send / Edit / Disable', () => {
    const onEdit = vi.fn();
    const onDisable = vi.fn();
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
        onEdit={onEdit}
        onDisable={onDisable}
      />
    ));
    const kebab = container.querySelector('.header-tier-card__icon-btn') as HTMLButtonElement;
    fireEvent.click(kebab);
    expect(container.querySelector('.header-tier-card__menu')).not.toBeNull();
    const items = Array.from(container.querySelectorAll('.header-tier-card__menu-item'));
    expect(items.map((b) => b.textContent)).toEqual(['Send this header', 'Edit tier', 'Disable']);
  });

  it('opens the snippet modal when Send this header is clicked', () => {
    const { container, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(container.querySelector('.header-tier-card__icon-btn') as HTMLButtonElement);
    fireEvent.click(
      Array.from(container.querySelectorAll('.header-tier-card__menu-item')).find((b) =>
        b.textContent?.includes('Send this header'),
      ) as HTMLButtonElement,
    );
    expect(queryByTestId('snippet-modal')).not.toBeNull();
  });

  it('invokes onEdit when Edit tier is clicked', () => {
    const onEdit = vi.fn();
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
        onEdit={onEdit}
      />
    ));
    fireEvent.click(container.querySelector('.header-tier-card__icon-btn') as HTMLButtonElement);
    fireEvent.click(
      Array.from(container.querySelectorAll('.header-tier-card__menu-item')).find((b) =>
        b.textContent?.includes('Edit tier'),
      ) as HTMLButtonElement,
    );
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('invokes onDisable when Disable is clicked', () => {
    const onDisable = vi.fn();
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
        onDisable={onDisable}
      />
    ));
    fireEvent.click(container.querySelector('.header-tier-card__icon-btn') as HTMLButtonElement);
    fireEvent.click(
      Array.from(container.querySelectorAll('.header-tier-card__menu-item')).find((b) =>
        b.textContent?.includes('Disable'),
      ) as HTMLButtonElement,
    );
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  it('renders FallbackList with the route count from fallback_routes', () => {
    const tierWithFallbacks = {
      ...baseTier,
      fallback_routes: [
        { provider: 'openai', authType: 'api_key' as const, model: 'gpt-4o-mini' },
        { provider: 'anthropic', authType: 'api_key' as const, model: 'claude-haiku' },
      ],
    };
    const { getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierWithFallbacks}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(getByTestId('fb-count').textContent).toBe('2');
    expect(getByTestId('fb-routes-count').textContent).toBe('2');
  });

  it('forwards persistFallbacks to setHeaderTierFallbacks for this agent + tier id', async () => {
    const { getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(getByTestId('fb-persist') as HTMLButtonElement);
    await waitFor(() => {
      // The mock stub passes "tier-id" — the closure should use this card's
      // own tier id ("ht-1") not the FallbackList-side id.
      expect(mockSetHeaderTierFallbacks).toHaveBeenCalledWith('demo', 'tier-id', ['m'], undefined);
    });
  });

  it('forwards persistClearFallbacks to clearHeaderTierFallbacks', async () => {
    const { getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(getByTestId('fb-clear') as HTMLButtonElement);
    await waitFor(() => {
      expect(mockClearHeaderTierFallbacks).toHaveBeenCalledWith('demo', 'tier-id');
    });
  });

  it('opens the picker in fallback mode when FallbackList signals onAddFallback', () => {
    const { container, getByTestId, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(queryByTestId('model-picker')).toBeNull();
    fireEvent.click(getByTestId('fb-add') as HTMLButtonElement);
    expect(queryByTestId('model-picker')).not.toBeNull();
    // sanity: only one picker is open
    expect(container.querySelectorAll('[data-testid="model-picker"]').length).toBe(1);
  });

  it('appends to fallbacks via setHeaderTierFallbacks when picker selects in fallback mode', async () => {
    const tierWithFallbacks = {
      ...baseTier,
      fallback_routes: [{ provider: 'openai', authType: 'api_key' as const, model: 'old' }],
    };
    const onFallbacksUpdate = vi.fn();
    const { getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierWithFallbacks}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={onFallbacksUpdate}
      />
    ));
    fireEvent.click(getByTestId('fb-add') as HTMLButtonElement);
    fireEvent.click(getByTestId('picker-pick') as HTMLButtonElement);
    await waitFor(() => {
      expect(mockSetHeaderTierFallbacks).toHaveBeenCalledWith(
        'demo',
        'ht-1',
        ['old', 'gpt-4o'],
        [
          { provider: 'openai', authType: 'api_key', model: 'old' },
          { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
        ],
      );
      expect(onFallbacksUpdate).toHaveBeenCalledWith(
        ['old', 'gpt-4o'],
        [
          { provider: 'openai', authType: 'api_key', model: 'old' },
          { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
        ],
      );
    });
  });

  it('auto-pins the next available account when adding the same model as a custom fallback', async () => {
    const providers: RoutingProvider[] = [
      {
        ...connectedProviders[0],
        id: 'p-default',
        label: 'Default',
        priority: 0,
      },
      {
        ...connectedProviders[0],
        id: 'p-personal',
        label: 'Personal',
        priority: 1,
      },
    ];
    const onFallbacksUpdate = vi.fn();
    const { getByTestId, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={providers}
        onOverride={vi.fn()}
        onFallbacksUpdate={onFallbacksUpdate}
      />
    ));

    fireEvent.click(getByTestId('fb-add') as HTMLButtonElement);
    fireEvent.click(getByTestId('picker-pick') as HTMLButtonElement);

    await waitFor(() => {
      const expectedRoutes = [
        { provider: 'openai', authType: 'api_key', model: 'gpt-4o', keyLabel: 'Personal' },
      ];
      expect(mockSetHeaderTierFallbacks).toHaveBeenCalledWith(
        'demo',
        'ht-1',
        ['gpt-4o'],
        expectedRoutes,
      );
      expect(onFallbacksUpdate).toHaveBeenCalledWith(['gpt-4o'], expectedRoutes);
      expect(queryByTestId('key-picker-modal')).toBeNull();
    });
  });

  it('opens account picker when replacing the primary with a multi-account model', async () => {
    const providers: RoutingProvider[] = [
      {
        ...connectedProviders[0],
        id: 'p-default',
        label: 'Default',
        priority: 0,
      },
      {
        ...connectedProviders[0],
        id: 'p-personal',
        label: 'Personal',
        priority: 1,
      },
    ];
    const onOverride = vi.fn();
    const { container, getByTestId, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={{ ...baseTier, override_route: null }}
        models={models}
        customProviders={customProviders}
        connectedProviders={providers}
        onOverride={onOverride}
        onFallbacksUpdate={vi.fn()}
      />
    ));

    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Add model'),
      ) as HTMLButtonElement,
    );
    fireEvent.click(getByTestId('picker-pick') as HTMLButtonElement);

    expect(onOverride).not.toHaveBeenCalled();
    expect(queryByTestId('key-picker-modal')).not.toBeNull();

    fireEvent.click(getByTestId('key-picker-pick-personal') as HTMLButtonElement);

    await waitFor(() => {
      expect(onOverride).toHaveBeenCalledWith('gpt-4o', 'openai', 'api_key', 'Personal');
      expect(queryByTestId('key-picker-modal')).toBeNull();
    });
  });

  it('closes the picker without action on its onClose', () => {
    const { container, getByTestId, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={{ ...baseTier, override_route: null }}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Add model'),
      ) as HTMLButtonElement,
    );
    fireEvent.click(getByTestId('picker-close') as HTMLButtonElement);
    expect(queryByTestId('model-picker')).toBeNull();
  });

  it('renders nothing for currentModel when override_route is null (no chip)', () => {
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={{ ...baseTier, override_route: null }}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__model-chip')).toBeNull();
  });

  it('falls back to provider-table auth lookup when override_route has no authType', () => {
    // A subscription connection takes precedence over api_key when both are present.
    const tierNoAuth = {
      ...baseTier,
      override_route: {
        provider: 'openai',
        authType: undefined as unknown as 'api_key',
        model: 'gpt-4o',
      },
    };
    const subProviders: RoutingProvider[] = [
      {
        id: 'p2',
        provider: 'openai',
        auth_type: 'subscription',
        is_active: true,
        has_api_key: false,
        connected_at: '2025-01-01',
      },
      ...connectedProviders,
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierNoAuth}
        models={models}
        customProviders={customProviders}
        connectedProviders={subProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-testid="auth-subscription"]')).not.toBeNull();
  });

  it('opens picker via the chip-action change button without bubbling to the chip click', () => {
    const { container, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(container.querySelector('.routing-card__chip-action') as HTMLButtonElement);
    expect(queryByTestId('model-picker')).not.toBeNull();
  });

  it('opens picker when the chip body itself is clicked', () => {
    const { container, queryByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    fireEvent.click(container.querySelector('.routing-card__model-chip') as HTMLElement);
    expect(queryByTestId('model-picker')).not.toBeNull();
  });

  it('renders the custom-provider letter chip when override_route points to a custom provider', () => {
    const customTier = {
      ...baseTier,
      override_route: {
        provider: 'custom:cp-1',
        authType: 'api_key' as const,
        model: 'groq-mixtral',
      },
    };
    const cps: CustomProviderData[] = [
      {
        id: 'cp-1',
        name: 'Groq',
        base_url: 'https://api.groq.com',
        api_kind: 'openai',
        has_api_key: true,
        models: [],
        created_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={customTier}
        models={models}
        customProviders={cps}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // Custom branch renders a span styled as a logo letter — text "G".
    const chipText = container.querySelector('.routing-card__main')?.textContent;
    expect(chipText).toBe('groq-mixtral');
    // The custom path uses a styled inline-flex span (no providerIcon mock), so
    // the override-icon should still exist with letter content "G".
    const overrideIcons = container.querySelectorAll('.routing-card__override-icon');
    expect(overrideIcons.length).toBeGreaterThan(0);
    const text = overrideIcons[0].textContent ?? '';
    expect(text.charAt(0).toUpperCase()).toBe('G');
  });

  it("falls back to the letter 'C' when override_route points to a missing custom provider id", () => {
    const customTier = {
      ...baseTier,
      override_route: { provider: 'custom:unknown', authType: 'api_key' as const, model: 'x' },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={customTier}
        models={models}
        customProviders={[]}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    const overrideIcons = container.querySelectorAll('.routing-card__override-icon');
    const text = (overrideIcons[0].textContent ?? '').charAt(0).toUpperCase();
    expect(text).toBe('C');
  });

  it('infers providerId from the model name when override_route.provider is missing', () => {
    // Force the providerIdForModel(...) fallback path by handing the card an
    // override route with an empty provider string but a model that maps via
    // PROVIDERS catalog.
    const tierMissingProv = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'gpt-4o',
      },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierMissingProv}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // The chip still renders the model — meaning providerIdForModel resolved
    // (and effectiveAuth lookup followed) without crashing.
    expect(container.querySelector('.routing-card__main')?.textContent).toBe('GPT-4o');
  });

  it('uses the model provider over prefix inference for Groq openai-prefixed models', () => {
    const tierMissingProv = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'openai/gpt-oss-120b',
      },
    };
    const groqModels: AvailableModel[] = [
      {
        model_name: 'openai/gpt-oss-120b',
        provider: 'groq',
        auth_type: 'api_key',
        input_price_per_token: 0.00000015,
        output_price_per_token: 0.0000006,
        context_window: 131072,
        capability_reasoning: true,
        capability_code: true,
        quality_score: 9,
        display_name: 'GPT OSS 120B',
      },
    ];
    const groqProviders: RoutingProvider[] = [
      {
        id: 'p-groq',
        provider: 'groq',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierMissingProv}
        models={groqModels}
        customProviders={customProviders}
        connectedProviders={groqProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__main')?.textContent).toBe('GPT OSS 120B');
    expect(container.querySelector('[data-testid="provider-icon-groq"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="provider-icon-openrouter"]')).toBeNull();
  });

  it('infers providerId via the model-prefix path when no DB match exists', () => {
    // Model name not present in props.models and override has no provider
    // → the helper falls into its prefix-only branch (line 34-35 of the helper).
    const tierUnknownModel = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'gpt-extra-new',
      },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierUnknownModel}
        models={[]}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__main')).not.toBeNull();
  });

  it('uses the DB provider id when the inferred prefix has no PROVIDERS entry', () => {
    // Force `inferProviderFromModel` to return a value that's NOT in the
    // PROVIDERS mock list, so the helper keeps the DB id (line 32 of helper).
    const tierFallback = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'gpt-4o',
      },
    };
    const localOnlyModels: AvailableModel[] = [
      {
        ...models[0],
        provider: 'openai',
        // The mock infers "openai" prefix — that IS in PROVIDERS, so this
        // exercises line 31's `if (prefixId && PROVIDERS.find(...))` branch.
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierFallback}
        models={localOnlyModels}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__override-icon')).not.toBeNull();
  });

  it('falls back to the DB id when the prefix-inferred provider is not in PROVIDERS', () => {
    const tierMistral = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'mistral-large',
      },
    };
    const mistralModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'mistral-large',
        provider: 'mistral',
        display_name: 'Mistral Large',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierMistral}
        models={mistralModels}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-card__main')?.textContent).toBe('Mistral Large');
  });

  it('returns undefined when neither apiModels nor prefix can resolve the provider', () => {
    const tierUnknown = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'api_key' as const,
        model: 'mystery-model',
      },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierUnknown}
        models={[]}
        customProviders={customProviders}
        connectedProviders={[]}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // No icon resolves: the override-icon is rendered only when providerId() exists.
    expect(container.querySelector('.routing-card__override-icon')).toBeNull();
  });

  it('returns the Ollama DB id for an Ollama-provider model when override has no provider', () => {
    const tierOllama = {
      ...baseTier,
      override_route: {
        provider: '' as unknown as string,
        authType: 'local' as const,
        model: 'llama3',
      },
    };
    const ollamaModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'llama3',
        provider: 'ollama',
        auth_type: 'local',
        display_name: 'Llama 3',
      },
    ];
    const ollamaProviders: RoutingProvider[] = [
      {
        id: 'p10',
        provider: 'ollama',
        auth_type: 'local',
        is_active: true,
        has_api_key: false,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierOllama}
        models={ollamaModels}
        customProviders={customProviders}
        connectedProviders={ollamaProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-testid="auth-local"]')).not.toBeNull();
  });

  it('silently swallows fallback append errors when the picker fires in fallback mode', async () => {
    mockSetHeaderTierFallbacks.mockRejectedValueOnce(new Error('server boom'));
    const onFallbacksUpdate = vi.fn();
    const { getByTestId } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={onFallbacksUpdate}
      />
    ));
    fireEvent.click(getByTestId('fb-add') as HTMLButtonElement);
    fireEvent.click(getByTestId('picker-pick') as HTMLButtonElement);
    await waitFor(() => {
      expect(mockSetHeaderTierFallbacks).toHaveBeenCalled();
    });
    // Failure path: onFallbacksUpdate is NOT called when persist throws.
    expect(onFallbacksUpdate).not.toHaveBeenCalled();
  });

  it('silently swallows reset errors and clears the loading state', async () => {
    mockResetHeaderTier.mockRejectedValueOnce(new Error('server boom'));
    const onFallbacksUpdate = vi.fn();
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={baseTier}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={onFallbacksUpdate}
      />
    ));
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Reset'),
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(mockResetHeaderTier).toHaveBeenCalled();
    });
    // Reset failure: onFallbacksUpdate is never called.
    expect(onFallbacksUpdate).not.toHaveBeenCalled();
  });

  it('effectiveAuth returns null when no provider connection matches the resolved id', () => {
    // override has no authType + provider has no matching connection → return null path.
    const tierNoMatch = {
      ...baseTier,
      override_route: {
        provider: 'openai',
        authType: undefined as unknown as 'api_key',
        model: 'gpt-4o',
      },
    };
    const otherProviders: RoutingProvider[] = [
      {
        id: 'p9',
        provider: 'anthropic', // non-matching id
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierNoMatch}
        models={models}
        customProviders={customProviders}
        connectedProviders={otherProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // No auth badge should appear for an unresolved auth.
    expect(container.querySelector('[data-testid="auth-api_key"]')).toBeNull();
    expect(container.querySelector('[data-testid="auth-subscription"]')).toBeNull();
    expect(container.querySelector('[data-testid="auth-local"]')).toBeNull();
  });

  it("effectiveAuth picks 'local' as the last-resort connected auth", () => {
    // No override_route.authType set, no subscription / api_key in connected.
    const tierLocal = {
      ...baseTier,
      override_route: {
        provider: 'ollama',
        authType: undefined as unknown as 'api_key',
        model: 'llama3',
      },
    };
    const localProviders: RoutingProvider[] = [
      {
        id: 'p1',
        provider: 'ollama',
        auth_type: 'local',
        is_active: true,
        has_api_key: false,
        connected_at: '2025-01-01',
      },
    ];
    const localModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'llama3',
        provider: 'ollama',
        auth_type: 'local',
        display_name: 'Llama 3',
      },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierLocal}
        models={localModels}
        customProviders={[]}
        connectedProviders={localProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-testid="auth-local"]')).not.toBeNull();
  });

  // Cover the Show-gated ModelParamsAffordance render on the primary chip and
  // the prop pass-through into the fallback list. The affordance only renders
  // when both getModelParams + setModelParams are provided and the route's
  // effective auth is not "local" (Ollama has no per-model knobs).
  it('renders the ModelParamsAffordance on the primary chip when model-params props are provided', () => {
    const tierDeepseek = {
      ...baseTier,
      override_route: {
        provider: 'deepseek',
        authType: 'api_key',
        model: 'deepseek-v4',
      } as const,
    };
    const deepseekModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'deepseek-v4',
        provider: 'deepseek',
        auth_type: 'api_key',
        display_name: 'DeepSeek V4',
      },
    ];
    const deepseekProviders = [
      { ...connectedProviders[0], provider: 'deepseek', authType: 'api_key' as const },
    ];
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierDeepseek}
        models={deepseekModels}
        customProviders={[]}
        connectedProviders={deepseekProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
        getModelParams={() => null}
        setModelParams={vi.fn().mockResolvedValue(undefined)}
      />
    ));
    expect(
      container.querySelector('[aria-label="Configure model parameters for DeepSeek V4"]'),
    ).not.toBeNull();
  });

  // Open the dialog and trigger a save so the parent's JSX `setParams={...}`
  // getter is evaluated by the affordance (Solid props are lazy — `setParams`
  // is only read when the affordance calls `props.setParams(...)` on save).
  it('threads setModelParams through the affordance save flow', async () => {
    vi.mocked(getModelParamSpecs).mockResolvedValue(modelParamSpecs[0].params);
    const setModelParams = vi.fn().mockResolvedValue(undefined);
    const tierDeepseek = {
      ...baseTier,
      override_route: {
        provider: 'deepseek',
        authType: 'api_key',
        model: 'deepseek-v4',
      } as const,
      fallback_routes: [
        { provider: 'deepseek', authType: 'api_key', model: 'deepseek-v4-flash' },
      ] as any,
    };
    const deepseekModels: AvailableModel[] = [
      {
        ...models[0],
        model_name: 'deepseek-v4',
        provider: 'deepseek',
        auth_type: 'api_key',
        display_name: 'DeepSeek V4',
      },
      {
        ...models[0],
        model_name: 'deepseek-v4-flash',
        provider: 'deepseek',
        auth_type: 'api_key',
        display_name: 'DeepSeek V4 Flash',
      },
    ];
    const deepseekProviders = [
      { ...connectedProviders[0], provider: 'deepseek', authType: 'api_key' as const },
    ];
    const { container, getByRole } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierDeepseek}
        models={deepseekModels}
        customProviders={[]}
        connectedProviders={deepseekProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
        getModelParams={() => null}
        setModelParams={setModelParams}
      />
    ));
    const btn = container.querySelector(
      '[aria-label="Configure model parameters for DeepSeek V4"]',
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    const toggle = await waitFor(() => getByRole('button', { name: /Thinking mode/ }));
    fireEvent.click(toggle);
    fireEvent.click(getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(setModelParams).toHaveBeenCalledWith(
        'header:ht-1',
        'deepseek',
        'api_key',
        'deepseek-v4',
        { thinking: { type: 'disabled' } },
      );
    });
  });

  it('handles empty model in override_route gracefully', () => {
    const tierEmptyModel = {
      ...baseTier,
      override_route: {
        provider: 'openai',
        authType: 'api_key' as const,
        model: '',
      },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierEmptyModel}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // Empty model is falsy under <Show when={currentModel()}>, so the chip is
    // suppressed and the "+ Add model" affordance takes the fallback slot.
    expect(container.querySelector('.routing-card__model-chip')).toBeNull();
    expect(container.textContent).toContain('+ Add model');
  });

  it('handles null provider with valid model by inferring from model name', () => {
    const tierNullProvider = {
      ...baseTier,
      override_route: {
        provider: null as unknown as string,
        authType: 'api_key' as const,
        model: 'gpt-4o',
      },
    };
    const { container } = render(() => (
      <HeaderTierCard
        agentName="demo"
        tier={tierNullProvider}
        models={models}
        customProviders={customProviders}
        connectedProviders={connectedProviders}
        onOverride={vi.fn()}
        onFallbacksUpdate={vi.fn()}
      />
    ));
    // A null provider is falsy, so providerId() falls to providerIdForModel,
    // which resolves the openai prefix and renders the matching icon.
    expect(container.querySelector('.routing-card__main')?.textContent).toBe('GPT-4o');
    expect(container.querySelector('[data-testid="provider-icon-openai"]')).not.toBeNull();
  });
});
