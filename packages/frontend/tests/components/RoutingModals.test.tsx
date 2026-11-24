import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

// Capture all ModelPickerModal renders so the test can assert which models /
// tiers got passed through.
const pickerCalls: Array<Record<string, unknown>> = [];

vi.mock('../../src/components/ModelPickerModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    pickerCalls.push({
      tierId: props.tierId,
      agentName: props.agentName,
      modelsCount: (props.models as { length: number } | undefined)?.length ?? 0,
      modelsList: ((props.models as { model_name: string }[] | undefined) ?? []).map(
        (m) => `${m.model_name}:${(m as { auth_type?: string }).auth_type ?? ''}`,
      ),
      tiersCount: (props.tiers as { length: number } | undefined)?.length ?? 0,
      customProvidersCount: (props.customProviders as { length: number } | undefined)?.length ?? 0,
      connectedProvidersCount:
        (props.connectedProviders as { length: number } | undefined)?.length ?? 0,
      requiredCapability: props.requiredCapability,
      providerRefreshed: props.onProviderRefreshed,
    });
    return (
      <div
        data-testid={`picker-${props.tierId}`}
        onClick={() =>
          (props.onSelect as (id: string, m: string, p: string, a?: string) => void)(
            props.tierId as string,
            'gpt-4o',
            'openai',
            'api_key',
          )
        }
      >
        picker
        <button
          data-testid={`picker-close-${props.tierId}`}
          onClick={() => (props.onClose as () => void)()}
        >
          close
        </button>
        <button
          data-testid={`picker-connect-${props.tierId}`}
          onClick={() => (props.onConnectProviders as () => void)?.()}
        >
          connect
        </button>
      </div>
    );
  },
}));

const psmProps: Array<Record<string, unknown>> = [];
vi.mock('../../src/components/ProviderSelectModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    psmProps.push({
      agentName: props.agentName,
      providersCount: (props.providers as { length: number })?.length ?? 0,
      customProvidersCount: (props.customProviders as { length: number })?.length ?? 0,
      customProviderPrefill: props.customProviderPrefill,
      providerDeepLink: props.providerDeepLink,
    });
    return (
      <div data-testid="provider-select-modal">
        <button data-testid="psm-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
        <button
          data-testid="psm-update"
          onClick={() => (props.onUpdate as () => Promise<void>)?.()}
        >
          update
        </button>
      </div>
    );
  },
}));

const kpmProps: Array<Record<string, unknown>> = [];
vi.mock('../../src/components/KeyPickerModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    kpmProps.push({
      providerName: props.providerName,
      modelName: props.modelName,
      keysCount: (props.keys as { length: number })?.length ?? 0,
    });
    return (
      <div data-testid="key-picker-modal">
        <button
          data-testid="kpm-pick-work"
          onClick={() => (props.onPick as (label: string | null) => void)('Work')}
        >
          pick-work
        </button>
        <button
          data-testid="kpm-pick-default"
          onClick={() => (props.onPick as (label: string | null) => void)(null)}
        >
          pick-default
        </button>
        <button data-testid="kpm-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
      </div>
    );
  },
}));

const riProps: Array<Record<string, unknown>> = [];
vi.mock('../../src/components/RoutingInstructionModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    riProps.push({
      open: props.open,
      mode: props.mode,
      agentName: props.agentName,
      connectedProvider: props.connectedProvider,
    });
    return (
      <div
        data-testid={`instruction-modal-${(props.open as boolean) ? 'open' : 'closed'}-${props.mode as string}`}
      >
        <button data-testid="ri-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
      </div>
    );
  },
}));

const mockNavigate = vi.fn();
vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
}));

import RoutingModals from '../../src/components/RoutingModals';
import type {
  TierAssignment,
  AvailableModel,
  CustomProviderData,
  RoutingProvider,
  SpecificityAssignment,
} from '../../src/services/api';

const sampleModels: AvailableModel[] = [
  {
    model_name: 'gpt-4o',
    provider: 'openai',
    auth_type: 'api_key',
    input_price_per_token: 0,
    output_price_per_token: 0,
    context_window: 0,
    capability_reasoning: false,
    capability_code: false,
    quality_score: 0,
  },
  {
    model_name: 'gpt-4o',
    provider: 'openai',
    auth_type: 'subscription',
    input_price_per_token: 0,
    output_price_per_token: 0,
    context_window: 0,
    capability_reasoning: false,
    capability_code: false,
    quality_score: 0,
  },
  {
    model_name: 'claude-opus',
    provider: 'anthropic',
    auth_type: 'api_key',
    input_price_per_token: 0,
    output_price_per_token: 0,
    context_window: 0,
    capability_reasoning: false,
    capability_code: false,
    quality_score: 0,
  },
];

const tiers: TierAssignment[] = [
  {
    id: 't1',
    agent_id: 'a',
    tier: 'simple',
    override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
    auto_assigned_route: null,
    fallback_routes: [{ provider: 'anthropic', authType: 'api_key', model: 'claude-opus' }],
    updated_at: '2025-01-01',
  },
];

const specificityAssignments: SpecificityAssignment[] = [
  {
    id: 's1',
    agent_id: 'a',
    category: 'coding',
    is_active: true,
    override_route: null,
    auto_assigned_route: null,
    fallback_routes: null,
    updated_at: '2025-01-01',
  },
  {
    id: 's2',
    agent_id: 'a',
    category: 'trading',
    is_active: false,
    override_route: null,
    auto_assigned_route: null,
    fallback_routes: null,
    updated_at: '2025-01-01',
  },
];

const baseProps = {
  agentName: () => 'demo',
  onDropdownClose: vi.fn(),
  onSpecificityDropdownClose: vi.fn(),
  onSpecificityOverride: vi.fn(),
  onFallbackPickerClose: vi.fn(),
  onProviderModalClose: vi.fn(),
  onInstructionClose: vi.fn(),
  onProviderUpdate: vi.fn().mockResolvedValue(undefined),
  models: () => sampleModels,
  tiers: () => tiers,
  specificityAssignments: () => specificityAssignments,
  customProviders: () => [] as CustomProviderData[],
  connectedProviders: () => [] as RoutingProvider[],
  getTier: (id: string) => tiers.find((t) => t.tier === id),
  onOverride: vi.fn(),
  onAddFallback: vi.fn(),
};

function makeProps(overrides: Partial<Parameters<typeof RoutingModals>[0]> = {}) {
  return {
    ...baseProps,
    dropdownTier: () => null,
    specificityDropdown: () => null,
    fallbackPickerTier: () => null,
    showProviderModal: () => false,
    instructionModal: () => null,
    instructionProvider: () => null,
    ...overrides,
  } as Parameters<typeof RoutingModals>[0];
}

async function waitForPicker() {
  await waitFor(() => expect(pickerCalls).not.toHaveLength(0));
}

describe('RoutingModals', () => {
  beforeEach(() => {
    pickerCalls.length = 0;
    psmProps.length = 0;
    riProps.length = 0;
    kpmProps.length = 0;
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  it('renders the dropdown picker when dropdownTier is set', async () => {
    // ModelPickerModal is lazy-loaded behind <Suspense>, so the picker mounts
    // on a microtask — await it instead of asserting synchronously.
    const { findByTestId } = render(() => (
      <RoutingModals {...makeProps({ dropdownTier: () => 'simple' })} />
    ));
    expect(await findByTestId('picker-simple')).not.toBeNull();
  });

  it('requires stream-capable models for stream-mode tier pickers', async () => {
    render(() => (
      <RoutingModals
        {...makeProps({
          dropdownTier: () => 'simple',
          tiers: () => [{ ...tiers[0]!, response_mode: 'stream' }],
          getTier: (id) =>
            id === 'simple' ? { ...tiers[0]!, response_mode: 'stream' } : undefined,
        })}
      />
    ));
    await waitForPicker();
    expect(pickerCalls[0].requiredCapability).toBe('stream');
  });

  it('requires stream-capable models for stream-mode specificity pickers', async () => {
    render(() => (
      <RoutingModals
        {...makeProps({
          specificityDropdown: () => 'coding',
          specificityAssignments: () => [
            { ...specificityAssignments[0]!, response_mode: 'stream' },
          ],
        })}
      />
    ));
    await waitForPicker();
    expect(pickerCalls[0].requiredCapability).toBe('stream');
  });

  it('forwards onDropdownClose when picker closes', async () => {
    const onDropdownClose = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals {...makeProps({ dropdownTier: () => 'simple', onDropdownClose })} />
    ));
    await waitForPicker();
    fireEvent.click(getByTestId('picker-close-simple'));
    expect(onDropdownClose).toHaveBeenCalled();
  });

  it('calls onOverride when picker selects a model', async () => {
    const onOverride = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals {...makeProps({ dropdownTier: () => 'simple', onOverride })} />
    ));
    await waitForPicker();
    fireEvent.click(getByTestId('picker-simple'));
    expect(onOverride).toHaveBeenCalledWith('simple', 'gpt-4o', 'openai', 'api_key');
  });

  it('opens specificity picker only filtered to active assignments', async () => {
    render(() => <RoutingModals {...makeProps({ specificityDropdown: () => 'coding' })} />);
    await waitForPicker();
    // 1 active assignment → tiersCount === 1
    expect(pickerCalls[0].tiersCount).toBe(1);
  });

  it('invokes onSpecificityOverride with the category, model, provider, and authType', async () => {
    const onSpecificityOverride = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals
        {...makeProps({ specificityDropdown: () => 'coding', onSpecificityOverride })}
      />
    ));
    await waitForPicker();
    fireEvent.click(getByTestId('picker-coding'));
    expect(onSpecificityOverride).toHaveBeenCalledWith('coding', 'gpt-4o', 'openai', 'api_key');
  });

  describe('fallback picker filtering', () => {
    it('filters out the primary route entry by full (model, provider, authType)', async () => {
      render(() => <RoutingModals {...makeProps({ fallbackPickerTier: () => 'simple' })} />);
      await waitForPicker();
      // 3 sample models. Primary is gpt-4o on openai/api_key — that one filtered.
      // Already-fallback claude-opus on anthropic/api_key — that one filtered.
      // gpt-4o on openai/subscription should remain (different auth tuple).
      const list = pickerCalls[0].modelsList as string[];
      expect(list).toEqual(['gpt-4o:subscription']);
    });

    it('does NOT dedupe same model name on different authType', async () => {
      // The primary route is api_key. The subscription variant must remain.
      render(() => <RoutingModals {...makeProps({ fallbackPickerTier: () => 'simple' })} />);
      await waitForPicker();
      const list = pickerCalls[0].modelsList as string[];
      expect(list).toContain('gpt-4o:subscription');
    });

    it('treats no-auth-type model rows as non-primary and non-fallback (kept in list)', async () => {
      const noAuthModels: AvailableModel[] = [
        {
          model_name: 'anonymous-model',
          provider: 'openai',
          input_price_per_token: 0,
          output_price_per_token: 0,
          context_window: 0,
          capability_reasoning: false,
          capability_code: false,
          quality_score: 0,
        },
      ];
      render(() => (
        <RoutingModals
          {...makeProps({
            fallbackPickerTier: () => 'simple',
            models: () => noAuthModels,
          })}
        />
      ));
      await waitForPicker();
      expect((pickerCalls[0].modelsList as string[])[0]).toBe('anonymous-model:');
    });

    it('requires stream-capable models for stream-mode fallback pickers', async () => {
      render(() => (
        <RoutingModals
          {...makeProps({
            fallbackPickerTier: () => 'simple',
            tiers: () => [{ ...tiers[0]!, response_mode: 'stream' }],
            getTier: (id: string) =>
              id === 'simple' ? { ...tiers[0]!, response_mode: 'stream' } : undefined,
          })}
        />
      ));
      await waitForPicker();
      expect(pickerCalls[0].requiredCapability).toBe('stream');
      expect(typeof pickerCalls[0].providerRefreshed).toBe('function');
    });
  });

  it('forwards onFallbackPickerClose when the fallback picker closes', async () => {
    const onFallbackPickerClose = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals
        {...makeProps({
          fallbackPickerTier: () => 'simple',
          onFallbackPickerClose,
        })}
      />
    ));
    await waitForPicker();
    fireEvent.click(getByTestId('picker-close-simple'));
    expect(onFallbackPickerClose).toHaveBeenCalled();
  });

  // ProviderSelectModal was removed from RoutingModals on this branch —
  // provider connection now happens via the dedicated sidebar provider pages,
  // not from an in-routing modal. RoutingModals still accepts the (now inert)
  // showProviderModal / customProviderPrefill / providerDeepLink props for
  // backward compatibility, but never mounts the modal.
  it('does not render ProviderSelectModal when showProviderModal is false', () => {
    const { queryByTestId } = render(() => (
      <RoutingModals {...makeProps({ showProviderModal: () => false })} />
    ));
    expect(queryByTestId('provider-select-modal')).toBeNull();
  });

  it('still does not render ProviderSelectModal even when showProviderModal is true', async () => {
    const { queryByTestId } = render(() => (
      <RoutingModals {...makeProps({ showProviderModal: () => true })} />
    ));
    // Give any lazy/Suspense boundary a chance to flush — the modal must stay
    // absent because it was removed from this component.
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByTestId('provider-select-modal')).toBeNull();
    // The ProviderSelectModal mock is never invoked.
    expect(psmProps.length).toBe(0);
  });

  it("renders the instruction modal in the open state when instructionModal returns 'enable'", () => {
    const { getByTestId } = render(() => (
      <RoutingModals {...makeProps({ instructionModal: () => 'enable' })} />
    ));
    expect(getByTestId('instruction-modal-open-enable')).not.toBeNull();
  });

  it('renders the instruction modal in the closed state when instructionModal returns null', () => {
    const { queryByTestId } = render(() => (
      <RoutingModals {...makeProps({ instructionModal: () => null })} />
    ));
    expect(queryByTestId('instruction-modal-closed-enable')).not.toBeNull();
  });

  it('navigates to the providers page when the dropdown picker fires onConnectProviders', async () => {
    const onDropdownClose = vi.fn();
    const { findByTestId } = render(() => (
      <RoutingModals {...makeProps({ dropdownTier: () => 'simple', onDropdownClose })} />
    ));
    fireEvent.click(await findByTestId('picker-connect-simple'));
    expect(onDropdownClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/harnesses/demo/providers');
  });

  it('uses onOpenProviderModal instead of navigation when supplied', async () => {
    const onDropdownClose = vi.fn();
    const onOpenProviderModal = vi.fn();
    const { findByTestId } = render(() => (
      <RoutingModals
        {...makeProps({
          dropdownTier: () => 'simple',
          onDropdownClose,
          onOpenProviderModal,
        })}
      />
    ));
    fireEvent.click(await findByTestId('picker-connect-simple'));
    expect(onDropdownClose).toHaveBeenCalled();
    expect(onOpenProviderModal).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates to the providers page when the fallback picker fires onConnectProviders', async () => {
    const onFallbackPickerClose = vi.fn();
    const { findByTestId } = render(() => (
      <RoutingModals
        {...makeProps({ fallbackPickerTier: () => 'simple', onFallbackPickerClose })}
      />
    ));
    fireEvent.click(await findByTestId('picker-connect-simple'));
    expect(onFallbackPickerClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/harnesses/demo/providers');
  });

  it('navigates to the providers page when the specificity picker fires onConnectProviders', async () => {
    const onSpecificityDropdownClose = vi.fn();
    const { findByTestId } = render(() => (
      <RoutingModals
        {...makeProps({
          specificityDropdown: () => 'coding',
          onSpecificityDropdownClose,
        })}
      />
    ));
    fireEvent.click(await findByTestId('picker-connect-coding'));
    expect(onSpecificityDropdownClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/harnesses/demo/providers');
  });

  it('calls onAddFallback when fallback picker selects a model', async () => {
    const onAddFallback = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals {...makeProps({ fallbackPickerTier: () => 'simple', onAddFallback })} />
    ));
    await waitForPicker();
    fireEvent.click(getByTestId('picker-simple'));
    expect(onAddFallback).toHaveBeenCalledWith('simple', 'gpt-4o', 'openai', 'api_key');
  });

  it('renders RoutingInstructionModal with the provider name from the accessor', () => {
    render(() => (
      <RoutingModals
        {...makeProps({
          instructionModal: () => 'disable',
          instructionProvider: () => 'openai',
        })}
      />
    ));
    const last = riProps[riProps.length - 1];
    expect(last.open).toBe(true);
    expect(last.mode).toBe('disable');
    expect(last.connectedProvider).toBe('openai');
  });

  it("falls back to mode='enable' when instructionModal returns null", () => {
    render(() => <RoutingModals {...makeProps({ instructionModal: () => null })} />);
    const last = riProps[riProps.length - 1];
    expect(last.open).toBe(false);
    expect(last.mode).toBe('enable');
  });

  it('invokes onInstructionClose when the instruction modal closes', () => {
    const onInstructionClose = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingModals {...makeProps({ instructionModal: () => 'enable', onInstructionClose })} />
    ));
    fireEvent.click(getByTestId('ri-close'));
    expect(onInstructionClose).toHaveBeenCalled();
  });

  describe('KeyPickerModal flow (multi-key override)', () => {
    const multiKeyProviders: RoutingProvider[] = [
      {
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        label: 'Work',
        priority: 0,
        connected_at: '2025-01-01',
      },
      {
        id: 'p2',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: true,
        label: 'Personal',
        priority: 1,
        connected_at: '2025-01-01',
      },
    ];

    it('opens the key picker (instead of overriding) when 2+ keys match the selection', async () => {
      const onOverride = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            dropdownTier: () => 'simple',
            connectedProviders: () => multiKeyProviders,
            onOverride,
          })}
        />
      ));
      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));
      // onOverride is deferred — KeyPickerModal renders.
      expect(onOverride).not.toHaveBeenCalled();
      expect(queryByTestId('key-picker-modal')).not.toBeNull();
      expect(kpmProps[kpmProps.length - 1].keysCount).toBe(2);
    });

    it('forwards the picked label to onOverride and closes the picker', async () => {
      const onOverride = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            dropdownTier: () => 'simple',
            connectedProviders: () => multiKeyProviders,
            onOverride,
          })}
        />
      ));
      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));
      fireEvent.click(getByTestId('kpm-pick-work'));
      expect(onOverride).toHaveBeenCalledWith('simple', 'gpt-4o', 'openai', 'api_key', 'Work');
      expect(queryByTestId('key-picker-modal')).toBeNull();
    });

    it("forwards null label as 'use default' to onOverride", async () => {
      const onOverride = vi.fn();
      const { getByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            dropdownTier: () => 'simple',
            connectedProviders: () => multiKeyProviders,
            onOverride,
          })}
        />
      ));
      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));
      fireEvent.click(getByTestId('kpm-pick-default'));
      expect(onOverride).toHaveBeenCalledWith('simple', 'gpt-4o', 'openai', 'api_key', undefined);
    });

    it('opens the key picker via the fallback flow and forwards the label to onAddFallback', async () => {
      // Use a tier where the primary is a *different* model so neither key
      // is "implicitly used" — both Work and Personal stay available, and
      // handleFallbackSelect routes through the multi-key picker.
      const tierWithDifferentPrimary: TierAssignment = {
        ...tiers[0]!,
        override_route: {
          provider: 'anthropic',
          authType: 'api_key',
          model: 'claude-opus',
        },
        fallback_routes: [],
      };
      const onAddFallback = vi.fn();
      const onFallbackPickerClose = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            fallbackPickerTier: () => 'simple',
            tiers: () => [tierWithDifferentPrimary],
            getTier: (id: string) => [tierWithDifferentPrimary].find((t) => t.tier === id),
            connectedProviders: () => multiKeyProviders,
            onAddFallback,
            onFallbackPickerClose,
          })}
        />
      ));
      await waitForPicker();
      // Fallback picker fires onSelect → multi-key path → KeyPickerModal opens.
      fireEvent.click(getByTestId('picker-simple'));
      expect(queryByTestId('key-picker-modal')).not.toBeNull();
      // Pick a label — the fallback path closes the fallback picker first
      // (so used-key filtering refreshes on next open) and forwards the label.
      fireEvent.click(getByTestId('kpm-pick-work'));
      expect(onFallbackPickerClose).toHaveBeenCalled();
      expect(onAddFallback).toHaveBeenCalledWith('simple', 'gpt-4o', 'openai', 'api_key', 'Work');
    });

    it('auto-selects the only remaining key (no picker shown) when one is filtered out by usage', async () => {
      // The primary already pins "Work" — used-key filtering removes "Work"
      // from the available list, leaving only "Personal" → auto-select.
      const tierWithKeyPin: TierAssignment = {
        ...tiers[0]!,
        override_route: {
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-4o',
          keyLabel: 'Work',
        },
      };
      const onAddFallback = vi.fn();
      const onFallbackPickerClose = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            fallbackPickerTier: () => 'simple',
            tiers: () => [tierWithKeyPin],
            getTier: (id: string) => [tierWithKeyPin].find((t) => t.tier === id),
            connectedProviders: () => multiKeyProviders,
            onAddFallback,
            onFallbackPickerClose,
          })}
        />
      ));
      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));
      expect(queryByTestId('key-picker-modal')).toBeNull();
      expect(onFallbackPickerClose).toHaveBeenCalled();
      expect(onAddFallback).toHaveBeenCalledWith(
        'simple',
        'gpt-4o',
        'openai',
        'api_key',
        'Personal',
      );
    });

    it('does nothing if a stale fallback selection has no available keys left', async () => {
      const tierWithEveryKeyUsed: TierAssignment = {
        ...tiers[0]!,
        override_route: {
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-4o',
          keyLabel: 'Work',
        },
        fallback_routes: [
          { provider: 'openai', authType: 'api_key', model: 'gpt-4o', keyLabel: 'Personal' },
        ],
      };
      const onAddFallback = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            fallbackPickerTier: () => 'simple',
            tiers: () => [tierWithEveryKeyUsed],
            getTier: (id: string) => [tierWithEveryKeyUsed].find((t) => t.tier === id),
            connectedProviders: () => multiKeyProviders,
            onAddFallback,
          })}
        />
      ));

      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));

      expect(onAddFallback).not.toHaveBeenCalled();
      expect(queryByTestId('key-picker-modal')).toBeNull();
    });

    it('closes the picker without calling onOverride when the user cancels', async () => {
      const onOverride = vi.fn();
      const { getByTestId, queryByTestId } = render(() => (
        <RoutingModals
          {...makeProps({
            dropdownTier: () => 'simple',
            connectedProviders: () => multiKeyProviders,
            onOverride,
          })}
        />
      ));
      await waitForPicker();
      fireEvent.click(getByTestId('picker-simple'));
      fireEvent.click(getByTestId('kpm-close'));
      expect(onOverride).not.toHaveBeenCalled();
      expect(queryByTestId('key-picker-modal')).toBeNull();
    });
  });

  it('accepts customProviderPrefill and providerDeepLink props without rendering a provider modal', () => {
    const customProviderPrefill = () => ({ name: 'MyProv', baseUrl: 'https://x' });
    const providerDeepLink = () => ({ providerId: 'openai' });
    const { queryByTestId } = render(() => (
      <RoutingModals
        {...makeProps({
          showProviderModal: () => true,
          customProviderPrefill,
          providerDeepLink,
        })}
      />
    ));
    // These props are now inert — RoutingModals no longer forwards them to a
    // ProviderSelectModal because that modal was removed from this component.
    expect(queryByTestId('provider-select-modal')).toBeNull();
    expect(psmProps.length).toBe(0);
  });
});
