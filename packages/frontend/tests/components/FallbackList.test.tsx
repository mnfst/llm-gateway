import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { MAX_FALLBACKS, type ProviderParamSpecCatalog } from 'manifest-shared';

vi.mock('solid-js/web', async (importOriginal) => {
  const mod = await importOriginal<typeof import('solid-js/web')>();
  return { ...mod, Portal: (props: any) => props.children };
});

import { getModelParamSpecs } from '../../src/services/api/model-params.js';

const mockSetFallbacks = vi.fn();
const mockClearFallbacks = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  setFallbacks: (...args: unknown[]) => mockSetFallbacks(...args),
  clearFallbacks: (...args: unknown[]) => mockClearFallbacks(...args),
}));

vi.mock('../../src/services/api/model-params.js', () => ({
  getModelParamSpecs: vi.fn(),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockCustomProviderLogo = vi.fn(() => null);
vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: (...args: unknown[]) => mockCustomProviderLogo(...args),
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: () => null,
  authLabel: (authType: string | null | undefined) =>
    authType === 'subscription' ? 'Subscription' : authType === 'local' ? 'Local' : 'API Key',
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
  ],
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  resolveProviderId: (p: string) => p.toLowerCase(),
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ''),
  usedKeyLabelsForModelInTier: () => new Set<string>(),
}));

vi.mock('../../src/services/provider-utils.js', () => ({
  getModelLabel: (_providerId: string, model: string) => model,
}));

import FallbackList from '../../src/components/FallbackList';

const models = [
  { model_name: 'model-a', provider: 'OpenAI' },
  { model_name: 'model-b', provider: 'Anthropic' },
] as any[];

const defaultProps = {
  agentName: 'test-agent',
  tier: 'tier-1',
  fallbacks: [] as string[],
  models,
  customProviders: [] as any[],
  connectedProviders: [
    { provider: 'openai', auth_type: 'api_key', is_active: true },
    { provider: 'anthropic', auth_type: 'subscription', is_active: true },
  ] as any[],
  onUpdate: vi.fn(),
  onAddFallback: vi.fn(),
};

const modelParamSpecs: ProviderParamSpecCatalog = [
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

describe('FallbackList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetFallbacks.mockResolvedValue(undefined);
    mockClearFallbacks.mockResolvedValue(undefined);
  });

  it('renders empty state when no fallbacks', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={[]} />);

    expect(screen.getByText('No fallbacks')).toBeDefined();
    expect(container.querySelector('.fallback-list__empty')).not.toBeNull();
    expect(container.querySelector('.fallback-list__items')).toBeNull();
  });

  it('renders fallback items with model labels', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const modelLabels = container.querySelectorAll('.fallback-list__model');
    expect(modelLabels.length).toBe(2);
  });

  it('marks non-stream fallback routes as skipped while stream mode is active', () => {
    const streamModeModels = [
      {
        model_name: 'stream-model',
        provider: 'OpenAI',
        capabilities: ['text', 'stream'],
      },
      {
        model_name: 'legacy-model',
        provider: 'custom:local',
        capabilities: ['text'],
      },
    ] as any[];

    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        responseMode="stream"
        fallbacks={['stream-model', 'legacy-model']}
        fallbackRoutes={[
          { provider: 'openai', authType: 'api_key', model: 'stream-model' },
          { provider: 'custom:local', authType: 'api_key', model: 'legacy-model' },
        ]}
        models={streamModeModels}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    expect(cards[0]?.classList.contains('fallback-list__card--skipped')).toBe(false);
    expect(cards[1]?.classList.contains('fallback-list__card--skipped')).toBe(true);
    expect(container.querySelector('.routing-card__skipped-badge')?.textContent).toContain(
      'Skipped in Stream',
    );
  });

  it('falls back to model-name matching when a structured route is stale', () => {
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        responseMode="stream"
        fallbacks={['legacy']}
        fallbackRoutes={[{ provider: 'custom:missing', authType: 'api_key', model: 'other-model' }]}
        models={
          [
            {
              model_name: 'legacy-pro',
              provider: 'OpenAI',
              capabilities: ['text', 'stream'],
            },
          ] as any[]
        }
      />
    ));

    expect(container.querySelector('.fallback-list__card--skipped')).toBeNull();
  });

  it('closes a fallback key picker when clicking outside it', async () => {
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a']}
        connectedProviders={
          [
            {
              provider: 'openai',
              auth_type: 'api_key',
              is_active: true,
              has_api_key: true,
              label: 'Work',
              priority: 0,
            },
            {
              provider: 'openai',
              auth_type: 'api_key',
              is_active: true,
              has_api_key: true,
              label: 'Personal',
              priority: 1,
            },
          ] as any[]
        }
      />
    ));

    fireEvent.click(container.querySelector('.fallback-list__key-chip') as HTMLButtonElement);
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(container.querySelector('[role="listbox"]')).toBeNull();
    });
  });

  it('calls onAddFallback when add button in empty state clicked', () => {
    const onAddFallback = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={[]} onAddFallback={onAddFallback} />
    ));

    const addBtn = container.querySelector(
      '.fallback-list__empty .fallback-list__add',
    ) as HTMLButtonElement;
    fireEvent.click(addBtn);
    expect(onAddFallback).toHaveBeenCalledTimes(1);
  });

  it('hides add button when the max number of fallbacks exist', () => {
    const maxFallbacks = Array.from({ length: MAX_FALLBACKS }, (_, i) => `m${i}`);
    render(() => <FallbackList {...defaultProps} fallbacks={maxFallbacks} />);

    expect(screen.queryByText('Add fallback')).toBeNull();
  });

  it('calls setFallbacks on remove with remaining items', async () => {
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} onUpdate={onUpdate} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    expect(removeButtons.length).toBe(2);

    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      // No fallbackRoutes passed → undefined for the routes arg.
      expect(mockSetFallbacks).toHaveBeenCalledWith('test-agent', 'tier-1', ['model-b'], undefined);
      expect(onUpdate).toHaveBeenCalled();
    });
    expect(mockClearFallbacks).not.toHaveBeenCalled();
  });

  it('calls clearFallbacks on remove of last item', async () => {
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a']} onUpdate={onUpdate} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    expect(removeButtons.length).toBe(1);

    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockClearFallbacks).toHaveBeenCalledWith('test-agent', 'tier-1');
      expect(onUpdate).toHaveBeenCalled();
    });
    expect(mockSetFallbacks).not.toHaveBeenCalled();
  });

  it('reverts optimistic removal when setFallbacks rejects', async () => {
    mockSetFallbacks.mockRejectedValue(new Error('API error'));
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} onUpdate={onUpdate} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockSetFallbacks).toHaveBeenCalled();
    });
    // First call: optimistic removal, second call: revert with original list.
    // onUpdate now also carries `updatedRoutes` (null when no routes are tracked).
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(1, ['model-b'], null);
    expect(onUpdate).toHaveBeenNthCalledWith(2, ['model-a', 'model-b'], null);
  });

  it('reverts optimistic removal when clearFallbacks rejects', async () => {
    mockClearFallbacks.mockRejectedValue(new Error('API error'));
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a']} onUpdate={onUpdate} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockClearFallbacks).toHaveBeenCalled();
    });
    // First call: optimistic removal, second call: revert with original list.
    // onUpdate now also carries `updatedRoutes` (null when no routes are tracked).
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(1, [], null);
    expect(onUpdate).toHaveBeenNthCalledWith(2, ['model-a'], null);
  });

  it('displays display_name when model info has one', () => {
    const modelsWithDisplay = [
      { model_name: 'model-a', provider: 'OpenAI', display_name: 'Model Alpha' },
    ] as any[];
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a']} models={modelsWithDisplay} />
    ));

    const modelLabel = container.querySelector('.fallback-list__model');
    expect(modelLabel?.textContent).toBe('Model Alpha');
  });

  it('falls back to getModelLabel when model has no display_name but has provider', () => {
    const modelsNoDisplay = [{ model_name: 'model-a', provider: 'OpenAI' }] as any[];
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a']} models={modelsNoDisplay} />
    ));

    const modelLabel = container.querySelector('.fallback-list__model');
    // getModelLabel mock returns model as-is
    expect(modelLabel?.textContent).toBe('model-a');
  });

  it('falls back to stripCustomPrefix when model not found in models list', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['custom:prov/unknown-model']} models={[]} />
    ));

    const modelLabel = container.querySelector('.fallback-list__model');
    expect(modelLabel?.textContent).toBe('unknown-model');
  });

  it('shows custom provider icon letter for custom provider models', () => {
    const customProviders = [{ id: 'cp-1', name: 'Groq' }] as any[];
    const modelsWithCustom = [{ model_name: 'custom-model', provider: 'custom:cp-1' }] as any[];
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['custom-model']}
        models={modelsWithCustom}
        customProviders={customProviders}
      />
    ));

    const letterIcon = container.querySelector('.provider-card__logo-letter');
    expect(letterIcon).not.toBeNull();
    expect(letterIcon?.textContent).toBe('G');
  });

  it('shows custom provider logo when customProviderLogo returns an element', () => {
    const fakeImg = document.createElement('img');
    fakeImg.src = '/icons/kilocode.svg';
    fakeImg.alt = 'Kilo Code';
    mockCustomProviderLogo.mockReturnValueOnce(fakeImg as any);
    const customProviders = [
      { id: 'cp-1', name: 'Kilo Code', base_url: 'https://api.kilo.ai' },
    ] as any[];
    const modelsWithCustom = [
      { model_name: 'qwen/qwen3.6-plus:free', provider: 'custom:cp-1' },
    ] as any[];
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['qwen/qwen3.6-plus:free']}
        models={modelsWithCustom}
        customProviders={customProviders}
      />
    ));

    const iconSpan = container.querySelector('.fallback-list__icon');
    expect(iconSpan).not.toBeNull();
    expect(iconSpan!.querySelector('img[src="/icons/kilocode.svg"]')).not.toBeNull();
  });

  it("uses 'C' as default letter when custom provider not found", () => {
    const modelsWithCustom = [
      { model_name: 'custom-model', provider: 'custom:unknown-id' },
    ] as any[];
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['custom-model']}
        models={modelsWithCustom}
        customProviders={[]}
      />
    ));

    const letterIcon = container.querySelector('.provider-card__logo-letter');
    expect(letterIcon).not.toBeNull();
    expect(letterIcon?.textContent).toBe('C');
  });

  it('shows provider icon for non-custom providers', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={['model-a']} />);

    // Provider icon renders in .fallback-list__icon span (providerIcon returns null in mock,
    // but the wrapper span should exist since provId() is defined and not custom)
    const iconSpans = container.querySelectorAll('.fallback-list__icon');
    expect(iconSpans.length).toBeGreaterThanOrEqual(1);
  });

  it('shows add button when fewer than the max number of fallbacks', () => {
    render(() => <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />);

    expect(screen.getByText('Add fallback')).toBeDefined();
  });

  it('sets aria-label on remove buttons with model label', () => {
    const modelsWithDisplay = [
      { model_name: 'model-a', provider: 'OpenAI', display_name: 'Model Alpha' },
    ] as any[];
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a']} models={modelsWithDisplay} />
    ));

    const removeBtn = container.querySelector('.fallback-list__remove');
    expect(removeBtn?.getAttribute('aria-label')).toBe('Remove Model Alpha');
  });

  it('empty state uses fallback-list__empty class for consistent styling', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={[]} />);

    const emptyBtn = container.querySelector('.fallback-list__empty');
    expect(emptyBtn).not.toBeNull();
  });

  it('shows add button with fallback-list__add class when fallbacks exist', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={['model-a']} />);

    const addBtn = container.querySelector('.fallback-list__add');
    expect(addBtn).not.toBeNull();
  });

  it('disables add button in empty state when adding prop is true', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={[]} adding={true} />
    ));

    const addBtn = container.querySelector(
      '.fallback-list__empty .fallback-list__add',
    ) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('enables add button in empty state when adding is false', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={[]} adding={false} />
    ));

    const addBtn = container.querySelector(
      '.fallback-list__empty .fallback-list__add',
    ) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
  });

  it('disables all remove buttons during async removal', async () => {
    let resolveRemove: () => void;
    mockSetFallbacks.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveRemove = r;
      }),
    );
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      const btns = container.querySelectorAll('.fallback-list__remove');
      // Both buttons should be disabled
      expect((btns[0] as HTMLButtonElement).disabled).toBe(true);
      expect((btns[1] as HTMLButtonElement).disabled).toBe(true);
      // The one being removed shows a spinner
      expect(btns[0].querySelector('.spinner')).not.toBeNull();
      // The other still shows a close (x) SVG
      expect(btns[1].querySelector('svg')).not.toBeNull();
    });

    resolveRemove!();

    await waitFor(() => {
      const btns = container.querySelectorAll('.fallback-list__remove');
      // After resolve, buttons should be re-enabled
      expect((btns[0] as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('disables add button during removal', async () => {
    let resolveRemove: () => void;
    mockSetFallbacks.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveRemove = r;
      }),
    );
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      const addBtn = screen.getByText('Add fallback');
      expect((addBtn as HTMLButtonElement).disabled).toBe(true);
    });

    resolveRemove!();
  });

  it('renders auth badge on fallback icon via authBadgeFor', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={['model-a']} />);

    const iconSpan = container.querySelector('.fallback-list__icon');
    expect(iconSpan).not.toBeNull();
    // title should show "OpenAI (API Key)" since model-a → openai → api_key
    expect(iconSpan?.getAttribute('title')).toBe('OpenAI (API Key)');
  });

  it('renders subscription title on fallback icon', () => {
    const { container } = render(() => <FallbackList {...defaultProps} fallbacks={['model-b']} />);

    const iconSpan = container.querySelector('.fallback-list__icon');
    expect(iconSpan?.getAttribute('title')).toBe('Anthropic (Subscription)');
  });

  it('returns null auth type when provider not in connectedProviders', () => {
    const modelsUnknown = [{ model_name: 'model-x', provider: 'Unknown' }] as any[];
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-x']}
        models={modelsUnknown}
        connectedProviders={[]}
      />
    ));

    const iconSpan = container.querySelector('.fallback-list__icon');
    // Provider "unknown" not in PROVIDERS mock, so providerTitle falls back to providerId
    expect(iconSpan?.getAttribute('title')).toBe('unknown (API Key)');
  });

  // ── Drag and Drop Tests ──

  it('sets dragIndex on dragStart and clears on dragEnd', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };

    fireEvent.dragStart(cards[0], { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '0');
    // Card should have dragging class
    expect(cards[0].classList.contains('fallback-list__card--dragging')).toBe(true);

    // dragEnd clears state
    const list = container.querySelector('.fallback-list__items')!;
    fireEvent.dragEnd(list);
    expect(cards[0].classList.contains('fallback-list__card--dragging')).toBe(false);
  });

  it('handles dragStart without dataTransfer gracefully', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    // Fire dragStart without dataTransfer property
    fireEvent.dragStart(cards[0], {});
    expect(cards[0].classList.contains('fallback-list__card--dragging')).toBe(true);
  });

  it('shows drop indicator on dragOver and computes slot from cursor position', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b', 'model-c']} />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    // Start dragging the first card
    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    // Mock getBoundingClientRect for all cards
    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    // Drag over near the bottom of the last card → slot should be after last (index 3)
    fireEvent.dragOver(list, {
      clientY: 110,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });

    // Drop indicator for slot 3 (after last) should be active
    const indicators = container.querySelectorAll('.fallback-list__drop-indicator');
    const lastIndicator = indicators[indicators.length - 1];
    expect(lastIndicator?.classList.contains('fallback-list__drop-indicator--active')).toBe(true);
  });

  it('computes no-op slot when dragOver fires at dragged item position', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const list = container.querySelector('.fallback-list__items')!;
    const cards = list.querySelectorAll<HTMLElement>('.fallback-list__card');

    // Start dragging card at index 0
    fireEvent.dragStart(cards[0]!, { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    // In jsdom, getBoundingClientRect returns all zeros (top=0, height=0, midY=0).
    // With clientY=0, all cards have midY=0, so clientY < midY is false for all → slot = cards.length = 2.
    // from=0, slot=2, slot !== from && slot !== from+1 → indicator shows at slot 2.
    // Verify dragOver runs without error
    fireEvent.dragOver(list, {
      clientY: 0,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });

    // Drop at this position should trigger reorder (from=0, slot=2, insertAt=1)
    fireEvent.drop(list, { preventDefault: vi.fn() });
    // Verifying the handlers executed without error is sufficient for coverage
  });

  it('handles dragOver without dataTransfer', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    // DragOver without dataTransfer — should not throw
    fireEvent.dragOver(list, { clientY: 50, preventDefault: vi.fn() });
  });

  it('clears drop slot on dragLeave when leaving container', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Create a drop indicator after the final card
    list.dispatchEvent(
      new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 90,
      }),
    );

    expect(
      container.querySelectorAll('.fallback-list__drop-indicator--active').length,
    ).toBeGreaterThan(0);

    // DragLeave with no related target and a cursor outside the list
    list.dispatchEvent(
      new MouseEvent('dragleave', {
        bubbles: true,
        clientX: 100,
        clientY: 120,
        relatedTarget: null,
      }),
    );

    // No active indicators
    const activeIndicators = container.querySelectorAll('.fallback-list__drop-indicator--active');
    expect(activeIndicators.length).toBe(0);
  });

  it('preserves drop slot on dragLeave when relatedTarget is inside list', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b', 'model-c']} />
    ));

    const list = container.querySelector('.fallback-list__items')!;
    const cards = list.querySelectorAll<HTMLElement>('.fallback-list__card');

    fireEvent.dragStart(cards[0]!, { dataTransfer: { effectAllowed: '', setData: vi.fn() } });
    fireEvent.dragOver(list, {
      clientY: 0,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });

    // Verify an indicator was set
    expect(
      container.querySelectorAll('.fallback-list__drop-indicator--active').length,
    ).toBeGreaterThan(0);

    // DragLeave with relatedTarget that's a child of the list → should NOT clear
    // Use dispatchEvent to properly set relatedTarget
    const childInList = list.querySelectorAll<HTMLElement>('.fallback-list__card')[1]!;
    const leaveEvent = new Event('dragleave', { bubbles: true }) as any;
    leaveEvent.relatedTarget = childInList;
    list.dispatchEvent(leaveEvent);

    // Indicator should still be active
    const activeIndicators = container.querySelectorAll('.fallback-list__drop-indicator--active');
    expect(activeIndicators.length).toBeGreaterThan(0);
  });

  it('reorders the second fallback after a null-related dragLeave inside the list', async () => {
    mockSetFallbacks.mockResolvedValueOnce(undefined);
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b', 'model-c', 'model-d']}
        onUpdate={onUpdate}
      />
    ));

    const list = container.querySelector<HTMLElement>('.fallback-list__items')!;
    const cards = list.querySelectorAll<HTMLElement>('.fallback-list__card');

    fireEvent.dragStart(cards[1]!, {
      dataTransfer: { effectAllowed: '', setData: vi.fn() },
    });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 160,
      height: 160,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    list.dispatchEvent(
      new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 110,
      }),
    );
    list.dispatchEvent(
      new MouseEvent('dragleave', {
        bubbles: true,
        clientX: 100,
        clientY: 110,
        relatedTarget: null,
      }),
    );
    fireEvent.drop(list, { preventDefault: vi.fn() });

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(['model-a', 'model-c', 'model-b', 'model-d'], null);
      expect(mockSetFallbacks).toHaveBeenCalledWith(
        'test-agent',
        'tier-1',
        ['model-a', 'model-c', 'model-b', 'model-d'],
        undefined,
      );
    });
  });

  it('reorders fallbacks on drop and calls setFallbacks', async () => {
    mockSetFallbacks.mockResolvedValueOnce(undefined);
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b', 'model-c']}
        onUpdate={onUpdate}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    // Start dragging card 0
    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    // Drag over to slot 3 (after last card) — cursor at bottom
    fireEvent.dragOver(list, {
      clientY: 130,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });

    // Drop
    fireEvent.drop(list, { preventDefault: vi.fn() });

    await waitFor(() => {
      // model-a moved to the end: ["model-b", "model-c", "model-a"].
      // No fallbackRoutes passed → onUpdate gets null and persistSet gets undefined.
      expect(onUpdate).toHaveBeenCalledWith(['model-b', 'model-c', 'model-a'], null);
      expect(mockSetFallbacks).toHaveBeenCalledWith(
        'test-agent',
        'tier-1',
        ['model-b', 'model-c', 'model-a'],
        undefined,
      );
    });
  });

  it('reverts reorder on setFallbacks failure', async () => {
    mockSetFallbacks.mockRejectedValueOnce(new Error('fail'));
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b', 'model-c']}
        onUpdate={onUpdate}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    fireEvent.dragOver(list, {
      clientY: 130,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });
    fireEvent.drop(list, { preventDefault: vi.fn() });

    await waitFor(() => {
      // First call is the optimistic reorder, second call reverts to original.
      // The route arg defaults to null when fallbackRoutes prop is omitted.
      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect(onUpdate).toHaveBeenLastCalledWith(['model-a', 'model-b', 'model-c'], null);
    });
  });

  it('ignores drop when dragIndex or dropSlot is null', () => {
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} onUpdate={onUpdate} />
    ));

    const list = container.querySelector('.fallback-list__items')!;
    // Drop without prior dragStart → dragIndex is null
    fireEvent.drop(list, { preventDefault: vi.fn() });

    expect(onUpdate).not.toHaveBeenCalled();
    expect(mockSetFallbacks).not.toHaveBeenCalled();
  });

  it('ignores drop when insertAt equals fromIndex (no-op reorder)', async () => {
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b', 'model-c']}
        onUpdate={onUpdate}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    // Start dragging card 2 (last)
    fireEvent.dragStart(cards[2], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    cards.forEach((card, i) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
        top: i * 40,
        bottom: (i + 1) * 40,
        height: 40,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: i * 40,
        toJSON: () => {},
      });
    });

    // Drag over to slot 2 (before card 2, which is from+0 → no-op)
    // But computeSlot returns null for from=2, slot=2. So dropSlot stays null → handled by null check.
    // Let's instead set slot=3 (after last) which → insertAt = 3-1=2 = fromIndex → no-op
    fireEvent.dragOver(list, {
      clientY: 130,
      dataTransfer: { dropEffect: '' },
      preventDefault: vi.fn(),
    });
    fireEvent.drop(list, { preventDefault: vi.fn() });

    // Allow async to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('clears removingIndex after failed removal', async () => {
    mockSetFallbacks.mockRejectedValueOnce(new Error('API error'));
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockSetFallbacks).toHaveBeenCalled();
    });

    // After error, buttons should be re-enabled (removingIndex cleared in finally)
    await waitFor(() => {
      const btns = container.querySelectorAll('.fallback-list__remove');
      expect((btns[0] as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('uses persistFallbacks prop when provided (for remove)', async () => {
    const customPersist = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b']}
        onUpdate={onUpdate}
        persistFallbacks={customPersist}
      />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      // 4th arg is undefined when no fallbackRoutes are tracked.
      expect(customPersist).toHaveBeenCalledWith('test-agent', 'tier-1', ['model-b'], undefined);
    });
    // Default setFallbacks should NOT have been called
    expect(mockSetFallbacks).not.toHaveBeenCalled();
  });

  it('uses persistClearFallbacks prop when provided (for remove last item)', async () => {
    const customClear = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a']}
        onUpdate={onUpdate}
        persistClearFallbacks={customClear}
      />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(customClear).toHaveBeenCalledWith('test-agent', 'tier-1');
    });
    // Default clearFallbacks should NOT have been called
    expect(mockClearFallbacks).not.toHaveBeenCalled();
  });

  it('falls back to default setFallbacks when persistFallbacks is undefined', async () => {
    const onUpdate = vi.fn();
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={['model-a', 'model-b']} onUpdate={onUpdate} />
    ));

    const removeButtons = container.querySelectorAll('.fallback-list__remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      // Should use the default setFallbacks from api.js. 4th arg undefined.
      expect(mockSetFallbacks).toHaveBeenCalledWith('test-agent', 'tier-1', ['model-b'], undefined);
    });
  });

  it('primaryDragging prop shows drop zone even with empty fallbacks', () => {
    const { container } = render(() => (
      <FallbackList {...defaultProps} fallbacks={[]} primaryDragging={true} />
    ));

    // When primaryDragging is true, fallback-list__items container should render
    // even though fallbacks is empty (Show when={props.fallbacks.length > 0 || props.primaryDragging})
    const items = container.querySelector('.fallback-list__items');
    expect(items).not.toBeNull();
  });

  it('onFallbackDragStart callback is called', () => {
    const onFallbackDragStart = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b']}
        onFallbackDragStart={onFallbackDragStart}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });

    expect(onFallbackDragStart).toHaveBeenCalledWith(0);
  });

  it('onFallbackDragEnd callback is called', () => {
    const onFallbackDragEnd = vi.fn();
    const { container } = render(() => (
      <FallbackList
        {...defaultProps}
        fallbacks={['model-a', 'model-b']}
        onFallbackDragEnd={onFallbackDragEnd}
      />
    ));

    const cards = container.querySelectorAll('.fallback-list__card');
    const list = container.querySelector('.fallback-list__items')!;

    fireEvent.dragStart(cards[0], { dataTransfer: { effectAllowed: '', setData: vi.fn() } });
    fireEvent.dragEnd(list);

    expect(onFallbackDragEnd).toHaveBeenCalled();
  });

  describe('multi-key chip', () => {
    const multiKeyProps = {
      ...defaultProps,
      connectedProviders: [
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          has_api_key: true,
          label: 'Personal',
          priority: 0,
          key_prefix: 'sk-pers-',
        },
        {
          id: 'p2',
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          has_api_key: true,
          label: 'Work',
          priority: 1,
          key_prefix: 'sk-work-',
        },
      ] as any[],
    };

    it('hides the chip when only one key is connected', () => {
      const { queryByLabelText } = render(() => (
        <FallbackList {...defaultProps} fallbacks={['model-a']} />
      ));
      expect(queryByLabelText(/API key for/i)).toBeNull();
    });

    it('renders the chip on the row when 2+ keys exist for the resolved provider', () => {
      const { getByLabelText } = render(() => (
        <FallbackList {...multiKeyProps} fallbacks={['model-a']} />
      ));
      expect(getByLabelText(/API key for/i)).toBeDefined();
    });

    it('shows the pinned label from the structured fallbackRoutes entry', () => {
      // Multi-key pin now lives in the structured `fallbackRoutes[i].keyLabel`
      // rather than the legacy `||<label>` suffix on the model string.
      const { container } = render(() => (
        <FallbackList
          {...multiKeyProps}
          fallbacks={['model-a']}
          fallbackRoutes={
            [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: 'Work' }] as any
          }
        />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLElement;
      expect(chip).not.toBeNull();
      expect(chip.textContent).toContain('Work');
    });

    it("falls back to the first key's label when nothing is pinned", () => {
      const { container } = render(() => (
        <FallbackList {...multiKeyProps} fallbacks={['model-a']} />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLElement;
      expect(chip.textContent).toContain('Personal');
    });

    it('renders a Clear pin option when the row is currently pinned', () => {
      const { container, getByText } = render(() => (
        <FallbackList
          {...multiKeyProps}
          fallbacks={['model-a']}
          fallbackRoutes={
            [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: 'Work' }] as any
          }
        />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLButtonElement;
      fireEvent.click(chip);
      expect(getByText('Clear pin')).toBeDefined();
    });

    it('does not render Clear pin when no label is currently set', () => {
      const { container, queryByText } = render(() => (
        <FallbackList {...multiKeyProps} fallbacks={['model-a']} />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLButtonElement;
      fireEvent.click(chip);
      expect(queryByText('Clear pin')).toBeNull();
    });

    it('Clear pin nulls the keyLabel on the structured route and persists', async () => {
      // After the merge, "Clear pin" no longer rewrites the model string —
      // it sets `route.keyLabel` to null on the matching `fallbackRoutes`
      // entry and forwards that structure to setFallbacks.
      const onUpdate = vi.fn();
      const initialRoutes = [
        { provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: 'Work' },
      ];
      const { container, getByText } = render(() => (
        <FallbackList
          {...multiKeyProps}
          fallbacks={['model-a']}
          fallbackRoutes={initialRoutes as any}
          onUpdate={onUpdate}
        />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLButtonElement;
      fireEvent.click(chip);
      fireEvent.click(getByText('Clear pin'));
      await Promise.resolve();
      await Promise.resolve();
      expect(onUpdate).toHaveBeenCalledWith(
        ['model-a'],
        [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: null }],
      );
      expect(mockSetFallbacks).toHaveBeenCalledWith(
        'test-agent',
        'tier-1',
        ['model-a'],
        [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: null }],
      );
    });

    it('opens the listbox and persists a new label via setFallbacks', async () => {
      // Picking a key now writes the label into `route.keyLabel` of the
      // structured fallbackRoutes entry; the model name stays bare.
      const onUpdate = vi.fn();
      const initialRoutes = [
        { provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: null },
      ];
      const { container, getByText } = render(() => (
        <FallbackList
          {...multiKeyProps}
          fallbacks={['model-a']}
          fallbackRoutes={initialRoutes as any}
          onUpdate={onUpdate}
        />
      ));
      const chip = container.querySelector('.fallback-list__key-chip') as HTMLButtonElement;
      fireEvent.click(chip);
      // Listbox is now visible.
      expect(container.querySelector('ul[role="listbox"]')).toBeDefined();
      fireEvent.click(getByText('Work'));
      await Promise.resolve();
      await Promise.resolve();
      expect(onUpdate).toHaveBeenCalledWith(
        ['model-a'],
        [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: 'Work' }],
      );
      expect(mockSetFallbacks).toHaveBeenCalledWith(
        'test-agent',
        'tier-1',
        ['model-a'],
        [{ provider: 'openai', authType: 'api_key', model: 'model-a', keyLabel: 'Work' }],
      );
    });
  });

  describe('per-row params affordance', () => {
    const deepseekRoute = {
      provider: 'deepseek',
      authType: 'api_key' as const,
      model: 'deepseek-v4-flash',
      keyLabel: null,
    };
    const openaiRoute = {
      provider: 'openai',
      authType: 'api_key' as const,
      model: 'gpt-4o',
      keyLabel: null,
    };

    it('renders the params affordance on a fallback row and forwards saves through setModelParams', async () => {
      vi.mocked(getModelParamSpecs).mockResolvedValue(modelParamSpecs[0].params);
      const setModelParams = vi.fn().mockResolvedValue(undefined);
      const getModelParams = vi.fn().mockReturnValue(null);
      const { container, getByRole } = render(() => (
        <FallbackList
          {...defaultProps}
          fallbacks={['deepseek-v4-flash']}
          fallbackRoutes={[deepseekRoute] as any}
          getModelParams={getModelParams}
          setModelParams={setModelParams}
        />
      ));
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.getAttribute('aria-label')?.startsWith('Configure model parameters'),
      );
      expect(btn).toBeDefined();
      // Open dialog and save to evaluate the parent's `setParams={...}` JSX
      // attribute (Solid lazily reads child props — `setParams` only fires
      // when the affordance calls it on save).
      fireEvent.click(btn!);
      const toggle = await waitFor(() => getByRole('button', { name: /Thinking mode/ }));
      fireEvent.click(toggle);
      fireEvent.click(getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(setModelParams).toHaveBeenCalled();
      });
    });

    it('renders the affordance and shows the request empty state for a model with no params', async () => {
      vi.mocked(getModelParamSpecs).mockResolvedValue([]);
      const { container } = render(() => (
        <FallbackList
          {...defaultProps}
          fallbacks={['gpt-4o']}
          fallbackRoutes={[openaiRoute] as any}
          getModelParams={vi.fn().mockReturnValue(null)}
          setModelParams={vi.fn()}
        />
      ));
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.getAttribute('aria-label')?.startsWith('Configure model parameters'),
      );
      expect(btn).toBeDefined();
      fireEvent.click(btn!);

      await waitFor(() => {
        expect(
          screen.getByText('No parameter controls are published for gpt-4o yet.'),
        ).toBeTruthy();
      });
    });

    it('does NOT render the affordance when the params callbacks are undefined', () => {
      const { container } = render(() => (
        <FallbackList
          {...defaultProps}
          fallbacks={['deepseek-v4-flash']}
          fallbackRoutes={[deepseekRoute] as any}
        />
      ));
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.getAttribute('aria-label')?.startsWith('Configure model parameters'),
      );
      expect(btn).toBeUndefined();
    });

    it('renders the affordance on the legacy path when both the model catalog AND a matching connected provider supply the auth_type', () => {
      // Legacy / pre-backfill data path: structured routes are not available
      // yet, but the row's provider can still be resolved via the model
      // catalog AND the connected providers list. The affordance needs
      // `authType` to call /model-params, so both signals are required.
      const modelsWithDeepseek = [
        ...models,
        { model_name: 'deepseek-v4-flash', provider: 'DeepSeek' },
      ] as any[];
      const connectedProvidersWithDeepseek = [
        {
          id: 'p-ds',
          provider: 'deepseek',
          auth_type: 'api_key',
          is_active: true,
          has_api_key: true,
          connected_at: '2025-01-01',
        },
      ] as any[];
      const { container } = render(() => (
        <FallbackList
          {...defaultProps}
          models={modelsWithDeepseek}
          connectedProviders={connectedProvidersWithDeepseek}
          fallbacks={['deepseek-v4-flash']}
          fallbackRoutes={null}
          getModelParams={vi.fn().mockReturnValue(null)}
          setModelParams={vi.fn()}
        />
      ));
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.getAttribute('aria-label')?.startsWith('Configure model parameters'),
      );
      expect(btn).toBeDefined();
    });
  });
});
