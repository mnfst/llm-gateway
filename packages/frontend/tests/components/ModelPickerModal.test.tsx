import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { createResource, Suspense } from 'solid-js';

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [{ value: 'claude-opus', label: 'Claude Opus' }],
    },
    {
      id: 'bedrock',
      name: 'AWS Bedrock',
      models: [],
    },
  ],
  STAGES: [
    { id: 'simple', label: 'Simple' },
    { id: 'complex', label: 'Complex' },
  ],
  SPECIFICITY_STAGES: [{ id: 'coding', label: 'Coding' }],
  DEFAULT_STAGE: { id: 'default', label: 'Default' },
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  resolveProviderId: (p: string) => p.toLowerCase(),
  inferProviderFromModel: (m: string) => {
    if (m.startsWith('gpt')) return 'openai';
    if (m.startsWith('claude')) return 'anthropic';
    return undefined;
  },
  pricePerM: (n: number) => `$${(Number(n) * 1_000_000).toFixed(2)}`,
}));

vi.mock('../../src/services/formatters.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/formatters.js')>()),
  customProviderColor: () => '#000',
}));

const { mockRefreshModels, mockRefreshProviderModels, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockRefreshModels: vi.fn(),
    mockRefreshProviderModels: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock('../../src/services/api.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    refreshModels: (...args: unknown[]) => mockRefreshModels(...args),
    refreshProviderModels: (...args: unknown[]) => mockRefreshProviderModels(...args),
  };
});

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import ModelPickerModal from '../../src/components/ModelPickerModal';
import type {
  AvailableModel,
  CustomProviderData,
  RoutingProvider,
  TierAssignment,
} from '../../src/services/api';

const baseModels: AvailableModel[] = [
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
  {
    model_name: 'gpt-4o-mini',
    provider: 'OpenAI',
    auth_type: 'api_key',
    input_price_per_token: 0,
    output_price_per_token: 0,
    context_window: 128000,
    capability_reasoning: false,
    capability_code: true,
    quality_score: 6,
    display_name: 'GPT-4o mini',
  },
  {
    model_name: 'claude-opus',
    provider: 'Anthropic',
    auth_type: 'subscription',
    input_price_per_token: 0.000015,
    output_price_per_token: 0.000075,
    context_window: 200000,
    capability_reasoning: false,
    capability_code: true,
    quality_score: 9,
    display_name: 'Claude Opus',
  },
];

const apiKeyOnly: RoutingProvider[] = [
  {
    id: 'p1',
    provider: 'openai',
    auth_type: 'api_key',
    is_active: true,
    has_api_key: true,
    connected_at: '2025-01-01',
    models_fetched_at: new Date().toISOString(),
  },
];

const subAndApi: RoutingProvider[] = [
  ...apiKeyOnly,
  {
    id: 'p2',
    provider: 'anthropic',
    auth_type: 'subscription',
    is_active: true,
    has_api_key: false,
    // Subscriptions carry no API key, so a usable one is proven by cached models.
    cached_model_count: 3,
    connected_at: '2025-01-01',
    models_fetched_at: new Date().toISOString(),
  },
];

const tiers: TierAssignment[] = [
  {
    id: 't1',
    agent_id: 'a1',
    tier: 'simple',
    override_route: null,
    auto_assigned_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
    fallback_routes: [{ provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' }],
    updated_at: '2025-01-01',
  },
];

describe('ModelPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockRefreshModels.mockResolvedValue({ ok: true });
    mockRefreshProviderModels.mockResolvedValue({
      ok: true,
      model_count: 4,
      last_fetched_at: '2026-04-12T10:00:00Z',
      error: null,
    });
  });

  describe('automatic daily refresh', () => {
    it('refreshes stale models only once per agent and browser session each day', async () => {
      const onProviderRefreshed = vi.fn();
      const staleProviders = apiKeyOnly.map((provider) => ({
        ...provider,
        models_fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }));

      const first = render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={staleProviders}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onProviderRefreshed={onProviderRefreshed}
        />
      ));

      await waitFor(() => {
        expect(mockRefreshModels).toHaveBeenCalledOnce();
        expect(mockRefreshModels).toHaveBeenCalledWith('demo-agent');
        expect(onProviderRefreshed).toHaveBeenCalledOnce();
      });

      first.unmount();
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={staleProviders}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onProviderRefreshed={onProviderRefreshed}
        />
      ));

      await Promise.resolve();
      expect(mockRefreshModels).toHaveBeenCalledOnce();
      expect(onProviderRefreshed).toHaveBeenCalledOnce();
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('does not refresh when provider models were already fetched today', async () => {
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));

      await Promise.resolve();
      expect(mockRefreshModels).not.toHaveBeenCalled();
    });

    it('does not retry a failed refresh when the picker reopens that day', async () => {
      mockRefreshModels.mockRejectedValueOnce(new Error('refresh failed'));
      const staleProviders = apiKeyOnly.map((provider) => ({
        ...provider,
        models_fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }));

      const first = render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={staleProviders}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      await waitFor(() => expect(mockRefreshModels).toHaveBeenCalledOnce());

      first.unmount();
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={staleProviders}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));

      await Promise.resolve();
      expect(mockRefreshModels).toHaveBeenCalledOnce();
    });

    it('stays open while refreshed model data is loading after the user scrolls', async () => {
      let resolveAutomaticRefresh!: (value: { ok: boolean }) => void;
      let resolveModelsRefetch!: (value: AvailableModel[]) => void;
      let modelRequestCount = 0;
      mockRefreshModels.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAutomaticRefresh = resolve;
          }),
      );
      const staleProviders = apiKeyOnly.map((provider) => ({
        ...provider,
        models_fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }));

      const Parent = () => {
        const [models, { refetch }] = createResource(async () => {
          modelRequestCount += 1;
          if (modelRequestCount === 1) return baseModels;
          return new Promise<AvailableModel[]>((resolve) => {
            resolveModelsRefetch = resolve;
          });
        });

        return (
          <Suspense fallback={<div data-testid="picker-loading" />}>
            <ModelPickerModal
              tierId="default"
              agentName="demo-agent"
              models={models() ?? []}
              tiers={[]}
              connectedProviders={staleProviders}
              onSelect={vi.fn()}
              onClose={vi.fn()}
              onProviderRefreshed={async () => {
                await refetch();
              }}
            />
          </Suspense>
        );
      };

      const { container } = render(() => <Parent />);
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeDefined();
      });

      fireEvent.scroll(container.querySelector('.routing-modal__list') as HTMLElement, {
        target: { scrollTop: 200 },
      });
      resolveAutomaticRefresh({ ok: true });

      await waitFor(() => {
        expect(modelRequestCount).toBe(2);
      });
      expect(screen.queryByTestId('picker-loading')).toBeNull();
      expect(screen.getByRole('dialog')).toBeDefined();

      resolveModelsRefetch(baseModels);
    });

    it('ignores stale inactive and custom providers', async () => {
      const providers: RoutingProvider[] = [
        { ...apiKeyOnly[0]!, is_active: false, models_fetched_at: null },
        {
          ...apiKeyOnly[0]!,
          id: 'custom-1',
          provider: 'custom:provider-id',
          models_fetched_at: null,
        },
      ];

      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={providers}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));

      await Promise.resolve();
      expect(mockRefreshModels).not.toHaveBeenCalled();
    });
  });

  it('renders the tier label as subtitle when the tier matches a STAGES entry', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-modal__subtitle')?.textContent).toContain('Simple');
  });

  it('renders the SPECIFICITY_STAGES label when the tier matches a specificity stage', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="coding"
        models={baseModels}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-modal__subtitle')?.textContent).toContain('Coding');
  });

  it('renders the DEFAULT_STAGE label as subtitle for the default tier', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="default"
        models={baseModels}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-modal__subtitle')?.textContent).toContain(
      'Default tier',
    );
  });

  it('omits the subtitle entirely when the tier id matches no stage (Playground)', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="playground:col-1"
        models={baseModels}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // No matching stage → render nothing rather than a misleading bare "tier".
    expect(container.querySelector('.routing-modal__subtitle')).toBeNull();
  });

  it('filters out models that do not support the required stream capability', () => {
    const onSelect = vi.fn();
    const modelsWithCapabilities: AvailableModel[] = [
      { ...baseModels[0]!, capabilities: ['text', 'stream'] },
      { ...baseModels[1]!, capabilities: ['text'] },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="default"
        models={modelsWithCapabilities}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        requiredCapability="stream"
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    ));

    const buttons = Array.from(container.querySelectorAll('.routing-modal__model'));
    // requiredCapability pre-selects the capability filter, so models without
    // stream are filtered out entirely rather than shown as disabled.
    const streamModel = buttons.find((button) => button.textContent?.includes('GPT-4o'));
    const blockedModel = buttons.find((button) => button.textContent?.includes('GPT-4o mini'));
    expect(streamModel).toBeDefined();
    expect(blockedModel).toBeUndefined();

    fireEvent.click(streamModel as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith('default', 'gpt-4o', 'openai', 'api_key');
  });

  it('filters out all models when none support the required capability', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="default"
        models={baseModels}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        requiredCapability="image"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    // No models have the image capability, so all are filtered out
    const models = container.querySelectorAll('.routing-modal__model');
    expect(models.length).toBe(0);
  });

  describe('per-group refresh button', () => {
    it('does not render group refresh buttons when agentName is missing', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="default"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      expect(container.querySelector('.routing-modal__group-refresh')).toBeNull();
    });

    it('renders a refresh button next to each non-custom group when agentName is set', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const buttons = container.querySelectorAll('.routing-modal__group-refresh');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('calls refreshProviderModels with provider id and active tab on click', async () => {
      const onProviderRefreshed = vi.fn();
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onProviderRefreshed={onProviderRefreshed}
        />
      ));

      const btn = screen.getByLabelText('Refresh OpenAI models');
      fireEvent.click(btn);

      await waitFor(() => {
        expect(mockRefreshProviderModels).toHaveBeenCalledWith('demo-agent', 'openai', 'api_key');
        expect(mockToastSuccess).toHaveBeenCalledWith('OpenAI: refreshed 4 models');
        expect(onProviderRefreshed).toHaveBeenCalled();
      });
    });

    it('shows the backend error message when refresh fails', async () => {
      mockRefreshProviderModels.mockResolvedValueOnce({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: 'Provider returned no models',
      });
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));

      fireEvent.click(screen.getByLabelText('Refresh OpenAI models'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Provider returned no models');
      });
    });

    it('does not bubble click to the parent overlay', async () => {
      const onClose = vi.fn();
      render(() => (
        <ModelPickerModal
          tierId="default"
          agentName="demo-agent"
          models={baseModels}
          tiers={[]}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={onClose}
        />
      ));

      fireEvent.click(screen.getByLabelText('Refresh OpenAI models'));

      await waitFor(() => {
        expect(mockRefreshProviderModels).toHaveBeenCalled();
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('hides tabs when only one auth category is connected', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.panel__tabs')).toBeNull();
  });

  it('shows tabs when multiple auth categories are connected', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={subAndApi}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.panel__tabs')).not.toBeNull();
    expect(container.textContent).toContain('Subscription');
    expect(container.textContent).toContain('Usage-based');
  });

  it('defaults to the subscription tab when subscription is connected', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={subAndApi}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const subTab = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(subTab?.textContent).toContain('Subscription');
  });

  it('switches to api_key tab when clicked', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={subAndApi}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const apiTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes('Usage-based'),
    ) as HTMLButtonElement;
    fireEvent.click(apiTab);
    expect(apiTab.getAttribute('aria-selected')).toBe('true');
  });

  it('toggles the Free models filter on api_key tab', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const pill = container.querySelector('.routing-modal__cap-pill') as HTMLButtonElement;
    expect(pill).not.toBeNull();
    fireEvent.click(pill);
    expect(pill.classList.contains('routing-modal__cap-pill--active')).toBe(true);
    // Only gpt-4o-mini is free → only one model rendered
    const modelButtons = container.querySelectorAll('.routing-modal__model');
    expect(modelButtons.length).toBe(1);
    expect(modelButtons[0].textContent).toContain('GPT-4o mini');
  });

  it('does not render a recommendation tag for a legacy auto-assigned route', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const recommended = container.querySelector('.routing-modal__recommended');
    expect(recommended).toBeNull();
  });

  it("tags the primary model with 'Primary' when override_route matches", () => {
    const tiersWithOverride: TierAssignment[] = [
      {
        ...tiers[0],
        override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiersWithOverride}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const tags = Array.from(container.querySelectorAll('.routing-modal__role-tag')).map(
      (t) => t.textContent,
    );
    expect(tags).toContain('Primary');
  });

  it('tags fallback rows with their 1-based index', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const tags = Array.from(container.querySelectorAll('.routing-modal__role-tag')).map(
      (t) => t.textContent,
    );
    expect(tags).toContain('Fallback 1');
  });

  it('does NOT cross-tag primary with fallback when route tuples differ on authType', () => {
    // Same model name on a different auth type must NOT be flagged as Primary
    // when filtered to the api_key tab if the override is on subscription.
    const tiersSubOverride: TierAssignment[] = [
      {
        ...tiers[0],
        override_route: { provider: 'openai', authType: 'subscription', model: 'gpt-4o' },
        auto_assigned_route: null,
        fallback_routes: null,
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiersSubOverride}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const tags = Array.from(container.querySelectorAll('.routing-modal__role-tag')).map(
      (t) => t.textContent,
    );
    expect(tags).not.toContain('Primary');
  });

  it('invokes onSelect with (tierId, model, providerId, authType) on click', () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    ));
    const firstModel = container.querySelector('.routing-modal__model') as HTMLButtonElement;
    fireEvent.click(firstModel);
    expect(onSelect).toHaveBeenCalledWith(
      'simple',
      expect.any(String),
      expect.any(String),
      'api_key',
    );
  });

  it("groups a slash-prefixed model under the connection's provider, not the model-id prefix", () => {
    // A model whose name LOOKS like an Anthropic vendor-prefixed id but is
    // actually being served BY OpenAI must show up in the OpenAI group, not
    // be filtered out because allowedProviders only contains "openai".
    // Mirrors the precedence rule in RoutingTierCard.providerIdForModel.
    const crossProvider: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'claude-served-by-openai',
        provider: 'OpenAI',
        display_name: 'Cross-vendor model',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={crossProvider}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const groupName = container.querySelector('.routing-modal__group-name') as HTMLElement | null;
    expect(groupName?.textContent).toBe('OpenAI');
    expect(container.querySelector('.routing-modal__model')?.textContent).toContain(
      'Cross-vendor model',
    );
  });

  it('shows the search input only when more than 5 models are available', () => {
    const onlyOne: AvailableModel[] = [baseModels[0]];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={onlyOne}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.querySelector('.routing-modal__search')).toBeNull();
  });

  it('filters by search term against model labels', () => {
    const many: AvailableModel[] = [
      ...baseModels,
      { ...baseModels[0], model_name: 'gpt-extra-1', display_name: 'extra-1' },
      { ...baseModels[0], model_name: 'gpt-extra-2', display_name: 'extra-2' },
      { ...baseModels[0], model_name: 'gpt-extra-3', display_name: 'extra-3' },
      { ...baseModels[0], model_name: 'gpt-extra-4', display_name: 'extra-4' },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={many}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const search = container.querySelector('.routing-modal__search') as HTMLInputElement;
    expect(search).not.toBeNull();
    fireEvent.input(search, { target: { value: 'extra-1' } });
    const labels = Array.from(container.querySelectorAll('.routing-modal__model-label')).map(
      (e) => e.textContent,
    );
    expect(labels.some((l) => l?.includes('extra-1'))).toBe(true);
    expect(labels.some((l) => l?.includes('extra-2'))).toBe(false);
  });

  it('renders the empty state with a Connect providers button when handler is provided and nothing is connected', () => {
    const onConnect = vi.fn();
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[]}
        tiers={tiers}
        connectedProviders={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onConnectProviders={onConnect}
      />
    ));
    const empty = container.querySelector('.routing-modal__empty');
    expect(empty?.textContent).toMatch(/No API key providers connected/);
    const btn = empty?.querySelector('button') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onConnect).toHaveBeenCalled();
  });

  it('calls onClose on overlay click and Escape key', () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={onClose}
      />
    ));
    fireEvent.click(container.querySelector('.modal-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(container.querySelector('.modal-overlay') as HTMLElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('calls onClose on the explicit close button', () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={onClose}
      />
    ));
    fireEvent.click(container.querySelector('.modal__close') as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders Included in subscription / Runs on your machine in non-paid tabs', () => {
    const localOnly: RoutingProvider[] = [
      {
        id: 'p3',
        provider: 'ollama',
        auth_type: 'local',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
    ];
    const localModels: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'llama3',
        provider: 'ollama',
        auth_type: 'local',
        display_name: 'Llama 3',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={localModels}
        tiers={tiers}
        connectedProviders={localOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('Runs on your machine');
  });

  it('renders the included per-request quota burn rate when present', () => {
    const gatewayProviders: RoutingProvider[] = [
      {
        id: 'p4',
        provider: 'opencode-go',
        auth_type: 'subscription',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
    ];
    const gatewayModels: AvailableModel[] = [
      {
        ...baseModels[2],
        model_name: 'opencode-go/glm-5.1',
        provider: 'opencode-go',
        auth_type: 'subscription',
        display_name: 'GLM-5.1',
        cost_per_request: 0.013636,
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={gatewayModels}
        tiers={tiers}
        connectedProviders={gatewayProviders}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('Included ($0.0136 quota/req)');
  });

  it('filters the list by group name when search matches the group label', () => {
    const many: AvailableModel[] = [
      ...baseModels,
      { ...baseModels[0], model_name: 'extra-1', display_name: 'Extra 1' },
      { ...baseModels[0], model_name: 'extra-2', display_name: 'Extra 2' },
      { ...baseModels[0], model_name: 'extra-3', display_name: 'Extra 3' },
      { ...baseModels[0], model_name: 'extra-4', display_name: 'Extra 4' },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={many}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const search = container.querySelector('.routing-modal__search') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'openai' } });
    const groups = container.querySelectorAll('.routing-modal__group-name');
    expect(Array.from(groups).some((g) => g.textContent?.toLowerCase().includes('openai'))).toBe(
      true,
    );
  });

  it('falls back to labelForModel when display_name is missing (vendor prefix path)', () => {
    // A model name "anthropic/claude" with no display_name should resolve to
    // the bare label via the slash-stripping branch of labelForModel.
    const noDisplay: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'anthropic/claude-opus',
        provider: 'Anthropic',
        display_name: undefined as unknown as string,
      },
    ];
    const apiAnthropic: RoutingProvider[] = [
      {
        id: 'p9',
        provider: 'anthropic',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={noDisplay}
        tiers={[]}
        connectedProviders={apiAnthropic}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // The slash branch strips "anthropic/" and looks up the bare name in
    // the labels map → "Claude Opus" hits via PROVIDERS mock.
    expect(container.textContent).toContain('Claude Opus');
  });

  it('returns the bare name when the slash-stripped key is also unknown', () => {
    const noDisplay: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'anthropic/unknown-model',
        provider: 'Anthropic',
        display_name: undefined as unknown as string,
      },
    ];
    const apiAnthropic: RoutingProvider[] = [
      {
        id: 'p9',
        provider: 'anthropic',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={noDisplay}
        tiers={[]}
        connectedProviders={apiAnthropic}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('unknown-model');
  });

  it('uses a direct label-map hit when the bare name matches PROVIDERS catalog', () => {
    const bareName: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'gpt-4o',
        display_name: undefined as unknown as string,
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={bareName}
        tiers={[]}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // The direct labels.get("gpt-4o") hit returns "GPT-4o" from the PROVIDERS mock.
    expect(container.textContent).toContain('GPT-4o');
  });

  it('renders a custom-provider group with logo letter and exposes its name', () => {
    const customProviders: CustomProviderData[] = [
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
    const customModels: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'llama-3-8b',
        provider: 'custom:cp-1',
        provider_display_name: 'Groq',
        display_name: 'Llama 3 8B',
      },
    ];
    const customConnected: RoutingProvider[] = [
      {
        id: 'p10',
        provider: 'custom:cp-1',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={customModels}
        tiers={[]}
        customProviders={customProviders}
        connectedProviders={customConnected}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // Custom-provider header shows the provider name "Groq" (rendered through
    // customProviderNameMap + the cpNames fallback).
    const groupNames = Array.from(container.querySelectorAll('.routing-modal__group-name')).map(
      (e) => e.textContent,
    );
    expect(groupNames).toContain('Groq');
    // The icon falls back to a styled letter span ("G").
    const letter = container.querySelector('.provider-card__logo-letter');
    expect(letter?.textContent).toBe('G');
  });

  it('keeps Bedrock grouped by route provider while cleaning dotted model labels', () => {
    const bedrockModels: AvailableModel[] = [
      {
        ...baseModels[0],
        model_name: 'us.anthropic.claude-opus',
        provider: 'bedrock',
        display_name: 'us.anthropic.claude-opus',
        input_price_per_token: null,
        output_price_per_token: null,
      },
    ];
    const bedrockConnected: RoutingProvider[] = [
      {
        id: 'p-bedrock',
        provider: 'bedrock',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];

    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={bedrockModels}
        tiers={[]}
        connectedProviders={bedrockConnected}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(container.querySelector('.routing-modal__group-name')?.textContent).toBe('AWS Bedrock');
    expect(container.querySelector('.routing-modal__model-label')?.textContent).toBe('Claude Opus');
  });

  it('renders the no-search empty state when search is non-empty and matches nothing', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[
          ...baseModels,
          { ...baseModels[0], model_name: 'extra-1', display_name: 'Extra 1' },
          { ...baseModels[0], model_name: 'extra-2', display_name: 'Extra 2' },
          { ...baseModels[0], model_name: 'extra-3', display_name: 'Extra 3' },
          { ...baseModels[0], model_name: 'extra-4', display_name: 'Extra 4' },
        ]}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const search = container.querySelector('.routing-modal__search') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'zzznopnoresult' } });
    expect(container.textContent).toContain('No models match your search');
  });

  it('renders the no-free-models empty state when the Free filter has no matches', () => {
    // baseModels[0] has nonzero pricing — filter to free-only with only that
    // model leaves an empty list and triggers the dedicated empty-state copy.
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[baseModels[0]]}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const pill = container.querySelector('.routing-modal__cap-pill') as HTMLButtonElement;
    fireEvent.click(pill);
    expect(container.textContent).toContain(
      'No free models available from your connected providers',
    );
  });

  it('renders the no-subscription empty state on the subscription tab when nothing is connected', () => {
    const subOnly: RoutingProvider[] = [
      {
        id: 'p11',
        provider: 'anthropic',
        auth_type: 'subscription',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
      {
        id: 'p12',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    // Both tabs are present, but subscription tab has zero models in the list.
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[]}
        tiers={tiers}
        connectedProviders={subOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('No subscription providers connected');
  });

  it('renders the no-local empty state on the Local tab when no local models exist', () => {
    const localOnly: RoutingProvider[] = [
      {
        id: 'p13',
        provider: 'ollama',
        auth_type: 'local',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[]}
        tiers={tiers}
        connectedProviders={localOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(container.textContent).toContain('No local providers connected');
  });

  it('clicks the Subscription tab and resets the free-only filter', () => {
    const both: RoutingProvider[] = [
      {
        id: 'p14',
        provider: 'anthropic',
        auth_type: 'subscription',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
      {
        id: 'p15',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={both}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    // Switch to API Keys, toggle free-only on
    const apiTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes('Usage-based'),
    ) as HTMLButtonElement;
    fireEvent.click(apiTab);
    const pill = container.querySelector('.routing-modal__cap-pill') as HTMLButtonElement;
    fireEvent.click(pill);
    expect(pill.classList.contains('routing-modal__cap-pill--active')).toBe(true);
    // Click Subscription tab — the click handler sets activeTab + resets free-only.
    const subTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes('Subscription'),
    ) as HTMLButtonElement;
    fireEvent.click(subTab);
    expect(subTab.getAttribute('aria-selected')).toBe('true');
  });

  describe('capability filter pills', () => {
    const modelsWithCapabilities: AvailableModel[] = [
      { ...baseModels[0]!, capabilities: ['text', 'stream', 'tools'] },
      { ...baseModels[1]!, capabilities: ['text', 'stream'] },
      {
        ...baseModels[2]!,
        capabilities: ['text', 'image'],
        auth_type: 'api_key',
        provider: 'OpenAI',
      },
    ];

    it('renders capability filter pills for capabilities present in the model list', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={modelsWithCapabilities}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const pills = container.querySelectorAll(
        '.routing-modal__filter-right .routing-modal__cap-pill',
      );
      // Modalities are shown in the row columns; filter pills stay action-focused.
      const pillTexts = Array.from(pills).map((p) => p.textContent?.trim());
      expect(pillTexts.some((t) => t?.includes('Stream'))).toBe(true);
      expect(pillTexts.some((t) => t?.includes('Tools'))).toBe(true);
      expect(pillTexts.some((t) => t?.includes('Image'))).toBe(false);
    });

    it('toggles a capability filter on and off when clicking a pill', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={modelsWithCapabilities}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const pills = container.querySelectorAll(
        '.routing-modal__filter-right .routing-modal__cap-pill',
      );
      // Find the "Tools" pill
      const toolsPill = Array.from(pills).find((p) =>
        p.textContent?.includes('Tools'),
      ) as HTMLButtonElement;
      expect(toolsPill).toBeDefined();
      // Toggle on
      fireEvent.click(toolsPill);
      expect(toolsPill.classList.contains('routing-modal__cap-pill--active')).toBe(true);
      // Only one model has tools capability (gpt-4o)
      const modelButtons = container.querySelectorAll('.routing-modal__model');
      expect(modelButtons.length).toBe(1);
      expect(modelButtons[0].textContent).toContain('GPT-4o');
      // Toggle off
      fireEvent.click(toolsPill);
      expect(toolsPill.classList.contains('routing-modal__cap-pill--active')).toBe(false);
    });

    it('availableCapabilities returns correct set from model list', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={modelsWithCapabilities}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const pills = container.querySelectorAll(
        '.routing-modal__filter-right .routing-modal__cap-pill',
      );
      expect(pills.length).toBe(2);
    });
  });

  it('renders capabilities, input modalities, and output modalities as separate columns', () => {
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={[
          {
            ...baseModels[0]!,
            capabilities: ['text', 'image', 'stream', 'tools'],
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
        ]}
        tiers={tiers}
        connectedProviders={apiKeyOnly}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(container.querySelector('.routing-modal__table-head')?.textContent).toContain(
      'Capabilities',
    );
    expect(container.querySelector('[aria-label="Capabilities: Stream, Tools"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Input: Text, Image"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Output: Text"]')).toBeTruthy();
  });

  it('clicks the Local tab when local + api_key are both connected', () => {
    const localAndApi: RoutingProvider[] = [
      ...apiKeyOnly,
      {
        id: 'p16',
        provider: 'ollama',
        auth_type: 'local',
        is_active: true,
        has_api_key: false,
        cached_model_count: 1,
        connected_at: '2025-01-01',
      },
    ];
    const { container } = render(() => (
      <ModelPickerModal
        tierId="simple"
        models={baseModels}
        tiers={tiers}
        connectedProviders={localAndApi}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    const localTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes('Local'),
    ) as HTMLButtonElement;
    fireEvent.click(localTab);
    expect(localTab.getAttribute('aria-selected')).toBe('true');
  });

  describe('large catalogs', () => {
    const manyModels: AvailableModel[] = Array.from({ length: 200 }, (_, i) => ({
      ...baseModels[0]!,
      model_name: `gpt-4o-${i}`,
      display_name: `GPT-4o ${String(i).padStart(3, '0')}`,
    }));

    it('does not mount every model row when the catalog is large', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={manyModels}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));

      const rows = container.querySelectorAll('.routing-modal__model');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(80);
      expect(container.textContent).not.toContain('GPT-4o 199');
    });

    it('reveals a late model after the list is scrolled', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={manyModels}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const list = container.querySelector('.routing-modal__list') as HTMLElement;
      Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 7800 });
      fireEvent.scroll(list);

      expect(container.textContent).toContain('GPT-4o 199');
      expect(container.textContent).not.toContain('GPT-4o 000');
    });

    it('search still brings a late model into the window', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={manyModels}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const search = container.querySelector('.routing-modal__search') as HTMLInputElement;
      fireEvent.input(search, { target: { value: 'GPT-4o 199' } });

      expect(container.textContent).toContain('GPT-4o 199');
      expect(container.querySelectorAll('.routing-modal__model').length).toBe(1);
    });

    it('resets to the top of the filtered list after the user had scrolled', () => {
      const { container } = render(() => (
        <ModelPickerModal
          tierId="simple"
          models={manyModels}
          tiers={tiers}
          connectedProviders={apiKeyOnly}
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      ));
      const list = container.querySelector('.routing-modal__list') as HTMLElement;
      Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 7800 });
      fireEvent.scroll(list);

      expect(container.textContent).not.toContain('GPT-4o 000');

      const search = container.querySelector('.routing-modal__search') as HTMLInputElement;
      // Matches every row, so shrink-clamp cannot explain a jump back to the top.
      fireEvent.input(search, { target: { value: 'GPT-4o' } });

      expect(container.textContent).toContain('GPT-4o 000');
      expect(container.textContent).not.toContain('GPT-4o 199');
    });
  });

});
