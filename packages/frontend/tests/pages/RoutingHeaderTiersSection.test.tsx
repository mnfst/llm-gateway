import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';

const mockListHeaderTiers = vi.fn();
const mockDeleteHeaderTier = vi.fn();
const mockOverrideHeaderTier = vi.fn();
const mockToggleHeaderTier = vi.fn();
const mockSetHeaderTierResponseMode = vi.fn();
vi.mock('../../src/services/api/header-tiers.js', () => ({
  listHeaderTiers: (...args: unknown[]) => mockListHeaderTiers(...args),
  deleteHeaderTier: (...args: unknown[]) => mockDeleteHeaderTier(...args),
  overrideHeaderTier: (...args: unknown[]) => mockOverrideHeaderTier(...args),
  toggleHeaderTier: (...args: unknown[]) => mockToggleHeaderTier(...args),
  setHeaderTierResponseMode: (...args: unknown[]) => mockSetHeaderTierResponseMode(...args),
}));

const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: vi.fn(),
  },
}));

const cardCalls: Array<Record<string, unknown>> = [];
vi.mock('../../src/components/HeaderTierCard.js', () => ({
  default: (props: Record<string, unknown>) => {
    cardCalls.push(props);
    const tier = props.tier as { id: string; name: string };
    // Read every prop so JSX attribute getters in the parent fire and count
    // as covered statements.
    const _read = [
      props.agentName,
      props.models,
      props.customProviders,
      props.connectedProviders,
      props.getModelParams,
      props.setModelParams,
      props.changingResponseMode,
      props.onResponseModeChange,
    ];
    void _read;
    return (
      <div data-testid={`card-${tier.id}`}>
        <span>{tier.name}</span>
        <button
          data-testid={`override-${tier.id}`}
          onClick={() =>
            (props.onOverride as (m: string, p: string, a?: string) => void)(
              'gpt-4o',
              'openai',
              'api_key',
            )
          }
        >
          override
        </button>
        <button
          data-testid={`fb-update-${tier.id}`}
          onClick={() => (props.onFallbacksUpdate as () => void)()}
        >
          fb-update
        </button>
        <button
          data-testid={`fb-update-routes-${tier.id}`}
          onClick={() =>
            (
              props.onFallbacksUpdate as (
                fallbacks: string[],
                routes: { provider: string; authType: string; model: string }[],
              ) => void
            )(['fb1'], [{ provider: 'openai', authType: 'api_key', model: 'fb1' }])
          }
        >
          fb-update-routes
        </button>
        <button data-testid={`edit-${tier.id}`} onClick={() => (props.onEdit as () => void)?.()}>
          edit
        </button>
        <button
          data-testid={`disable-${tier.id}`}
          onClick={() => (props.onDisable as () => void)?.()}
        >
          disable
        </button>
        <button
          data-testid={`response-${tier.id}`}
          onClick={() =>
            (props.onResponseModeChange as (mode: 'stream' | 'buffered') => void)('stream')
          }
        >
          response
        </button>
        <button
          data-testid={`response-buffered-${tier.id}`}
          onClick={() =>
            (props.onResponseModeChange as (mode: 'stream' | 'buffered') => void)('buffered')
          }
        >
          response-buffered
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/HeaderTierModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    const editing = props.editing as { id: string; name: string } | undefined;
    // Read every prop including agentName, existingTiers, models so JSX getters fire
    // (covers line 330: models={props.models()}).
    const _read = [props.agentName, props.existingTiers, props.models];
    void _read;
    return (
      <div data-testid="tier-modal">
        <span data-testid="tier-modal-mode">{editing ? 'edit' : 'create'}</span>
        <button
          data-testid="tier-modal-save"
          onClick={() =>
            (props.onSaved as (s: { id: string; name: string }) => void)({
              id: 'ht-saved',
              name: 'saved',
            })
          }
        >
          save
        </button>
        <button data-testid="tier-modal-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
        {props.onDelete ? (
          <button
            data-testid="tier-modal-delete"
            onClick={() => (props.onDelete as (id: string) => void)?.(editing?.id ?? '')}
          >
            delete
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock('../../src/components/HeaderTierSnippetModal.js', () => ({
  default: (props: Record<string, unknown>) => {
    // Read every prop so JSX attribute getters fire.
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

import RoutingHeaderTiersSection from '../../src/pages/RoutingHeaderTiersSection';
import type { HeaderTier } from '../../src/services/api/header-tiers';

const tier1: HeaderTier = {
  id: 'ht-1',
  agent_id: 'a',
  name: 'Premium',
  header_key: 'x-tier',
  header_value: 'premium',
  badge_color: 'indigo',
  sort_order: 0,
  enabled: true,
  override_route: null,
  fallback_routes: null,
  created_at: '2025-01-01',
  updated_at: '2025-01-01',
};
const tier2: HeaderTier = {
  ...tier1,
  id: 'ht-2',
  name: 'Free',
  header_value: 'free',
  enabled: false,
};

function makeProps(overrides: Partial<Parameters<typeof RoutingHeaderTiersSection>[0]> = {}) {
  return {
    agentName: () => 'demo',
    models: () => [],
    customProviders: () => [],
    connectedProviders: () => [],
    getModelParams: () => null,
    setModelParams: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Parameters<typeof RoutingHeaderTiersSection>[0];
}

async function waitForTierModal() {
  await waitFor(() => expect(screen.getByTestId('tier-modal')).not.toBeNull());
}

describe('RoutingHeaderTiersSection', () => {
  beforeEach(() => {
    cardCalls.length = 0;
    vi.clearAllMocks();
    mockListHeaderTiers.mockResolvedValue([tier1, tier2]);
    mockOverrideHeaderTier.mockResolvedValue(undefined);
    mockDeleteHeaderTier.mockResolvedValue(undefined);
    mockToggleHeaderTier.mockResolvedValue(undefined);
    mockSetHeaderTierResponseMode.mockImplementation(
      (_agent: string, id: string, response_mode: 'stream' | 'buffered') =>
        Promise.resolve({ ...tier1, id, response_mode }),
    );
  });

  it('renders the empty state when no tiers exist (with no externalTiers)', async () => {
    mockListHeaderTiers.mockResolvedValue([]);
    render(() => <RoutingHeaderTiersSection {...makeProps()} />);
    await waitFor(() => {
      expect(screen.getByText('No custom tiers activated')).toBeDefined();
    });
  });

  it('renders only enabled tiers as cards', async () => {
    render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    expect(screen.getByTestId('card-ht-1')).toBeDefined();
    expect(screen.queryByTestId('card-ht-2')).toBeNull();
  });

  it('renders the Manage button when at least one tier exists', () => {
    render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    expect(screen.getByText('Manage custom routing')).toBeDefined();
  });

  it('opens the manage modal when clicking the Manage button', () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    expect(container.querySelector('.header-tier-manage-modal')).not.toBeNull();
  });

  it('opens the create modal directly when there are zero tiers', async () => {
    // HeaderTierModal is lazy-loaded behind <Suspense>, so the modal mounts on
    // a microtask — await it instead of asserting synchronously.
    const { findByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [] })} />
    ));
    fireEvent.click(screen.getByText('Create custom tier'));
    expect(await findByTestId('tier-modal')).not.toBeNull();
  });

  it('opens edit modal when card.onEdit is invoked', async () => {
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('edit-ht-1'));
    await waitForTierModal();
    expect(getByTestId('tier-modal')).toBeDefined();
    expect(getByTestId('tier-modal-mode').textContent).toBe('edit');
  });

  it('calls overrideHeaderTier with the tier id when card emits override', async () => {
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('override-ht-1'));
    await waitFor(() => {
      expect(mockOverrideHeaderTier).toHaveBeenCalledWith(
        'demo',
        'ht-1',
        'gpt-4o',
        'openai',
        'api_key',
        undefined,
      );
    });
  });

  it('toasts an error when override fails', async () => {
    mockOverrideHeaderTier.mockRejectedValue(new Error('boom'));
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('override-ht-1'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('boom');
    });
  });

  it('refetches when a card fires onFallbacksUpdate without routes (e.g. tier reset)', async () => {
    mockListHeaderTiers.mockResolvedValue([tier1]);
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection
        {...makeProps({ externalTiers: undefined, externalRefetch: undefined })}
      />
    ));
    await waitFor(() => {
      expect(getByTestId('fb-update-ht-1')).toBeDefined();
    });
    mockListHeaderTiers.mockClear();
    fireEvent.click(getByTestId('fb-update-ht-1'));
    await waitFor(() => {
      expect(mockListHeaderTiers).toHaveBeenCalled();
    });
  });

  it('calls externalRefetch when fb update without routes and external prop wired', async () => {
    const externalRefetch = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection
        {...makeProps({ externalTiers: () => [tier1], externalRefetch })}
      />
    ));
    fireEvent.click(getByTestId('fb-update-ht-1'));
    expect(externalRefetch).toHaveBeenCalled();
  });

  it('calls externalMutate optimistically when fb update with routes and external prop wired', async () => {
    const externalMutate = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1], externalMutate })} />
    ));
    fireEvent.click(getByTestId('fb-update-routes-ht-1'));
    expect(externalMutate).toHaveBeenCalledTimes(1);
    const mutator = externalMutate.mock.calls[0]![0] as (
      prev: { id: string; fallback_routes: unknown }[] | undefined,
    ) => unknown;
    const result = mutator([tier1, tier2] as never) as { id: string; fallback_routes: unknown }[];
    expect(result.find((t) => t.id === 'ht-1')?.fallback_routes).toEqual([
      { provider: 'openai', authType: 'api_key', model: 'fb1' },
    ]);
    expect(result.find((t) => t.id === 'ht-2')?.fallback_routes).toEqual(tier2.fallback_routes);
  });

  it('uses internalMutate optimistically when fb update with routes and no external prop', async () => {
    mockListHeaderTiers.mockResolvedValue([tier1]);
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection
        {...makeProps({ externalTiers: undefined, externalRefetch: undefined })}
      />
    ));
    await waitFor(() => {
      expect(getByTestId('fb-update-routes-ht-1')).toBeDefined();
    });
    mockListHeaderTiers.mockClear();
    fireEvent.click(getByTestId('fb-update-routes-ht-1'));
    // internalMutate is synchronous and does not refetch
    await new Promise((r) => setTimeout(r, 10));
    expect(mockListHeaderTiers).not.toHaveBeenCalled();
  });

  it('calls toggleHeaderTier with false when disabling from a card', async () => {
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('disable-ht-1'));
    await waitFor(() => {
      expect(mockToggleHeaderTier).toHaveBeenCalledWith('demo', 'ht-1', false);
    });
  });

  it('updates a custom tier response mode from the card', async () => {
    const externalMutate = vi.fn();
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1], externalMutate })} />
    ));
    fireEvent.click(getByTestId('response-ht-1'));
    await waitFor(() => {
      expect(mockSetHeaderTierResponseMode).toHaveBeenCalledWith('demo', 'ht-1', 'stream');
      expect(externalMutate).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Streaming response mode enabled');
    });
    const update = externalMutate.mock.calls[0]![0] as (
      prev: HeaderTier[] | undefined,
    ) => HeaderTier[] | undefined;
    expect(update([tier1])?.[0]?.response_mode).toBe('stream');
  });

  it('toasts when a custom tier response mode update fails', async () => {
    mockSetHeaderTierResponseMode.mockRejectedValue(new Error('response-fail'));
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('response-ht-1'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('response-fail');
    });
  });

  it('uses internal state and buffered copy for response mode updates without external mutation', async () => {
    mockListHeaderTiers.mockResolvedValue([tier1]);
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection
        {...makeProps({ externalTiers: undefined, externalMutate: undefined })}
      />
    ));
    await waitFor(() => {
      expect(getByTestId('response-buffered-ht-1')).toBeDefined();
    });
    fireEvent.click(getByTestId('response-buffered-ht-1'));
    await waitFor(() => {
      expect(mockSetHeaderTierResponseMode).toHaveBeenCalledWith('demo', 'ht-1', 'buffered');
      expect(mockToastSuccess).toHaveBeenCalledWith('Buffered response mode enabled');
    });
  });

  it('toggles tiers from the manage modal rows', async () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    const rows = container.querySelectorAll('.specificity-modal__row');
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(mockToggleHeaderTier).toHaveBeenCalledWith('demo', 'ht-1', false);
    });
  });

  it('toggles via Enter key on a manage modal row', async () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    const rows = container.querySelectorAll('.specificity-modal__row');
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    await waitFor(() => {
      expect(mockToggleHeaderTier).toHaveBeenCalledWith('demo', 'ht-2', true);
    });
  });

  it('opens the create modal from inside the manage modal', async () => {
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    fireEvent.click(screen.getByText('Create new tier'));
    await waitForTierModal();
    expect(getByTestId('tier-modal-mode').textContent).toBe('create');
  });

  it('auto-opens the SDK snippet modal after a fresh tier is created', async () => {
    const { getByTestId, queryByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [] })} />
    ));
    fireEvent.click(screen.getByText('Create custom tier'));
    await waitForTierModal();
    fireEvent.click(getByTestId('tier-modal-save'));
    expect(queryByTestId('snippet-modal')).not.toBeNull();
  });

  it('does NOT auto-open the snippet modal after an edit', async () => {
    const { getByTestId, queryByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('edit-ht-1'));
    await waitForTierModal();
    fireEvent.click(getByTestId('tier-modal-save'));
    expect(queryByTestId('snippet-modal')).toBeNull();
  });

  it("invokes deleteHeaderTier from the modal's delete callback", async () => {
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('edit-ht-1'));
    await waitForTierModal();
    fireEvent.click(getByTestId('tier-modal-delete'));
    await waitFor(() => {
      expect(mockDeleteHeaderTier).toHaveBeenCalledWith('demo', 'ht-1');
    });
  });

  it('toasts an error when listHeaderTiers rejects on the internal resource', async () => {
    mockListHeaderTiers.mockRejectedValue(new Error('network'));
    render(() => <RoutingHeaderTiersSection {...makeProps()} />);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('network');
    });
  });

  it('renders the section title in standalone mode', () => {
    render(() => <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />);
    expect(screen.getByText('Custom routing')).toBeDefined();
  });

  it('hides the section title in embedded mode', () => {
    render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1], embedded: true })} />
    ));
    expect(screen.queryByText('Custom routing')).toBeNull();
  });

  it('toasts an error when delete fails (via the edit modal)', async () => {
    mockDeleteHeaderTier.mockRejectedValue(new Error('delete-fail'));
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('edit-ht-1'));
    await waitForTierModal();
    fireEvent.click(getByTestId('tier-modal-delete'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('delete-fail');
    });
  });

  it('toasts an error when toggle fails', async () => {
    mockToggleHeaderTier.mockRejectedValue(new Error('toggle-fail'));
    const { getByTestId } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1] })} />
    ));
    fireEvent.click(getByTestId('disable-ht-1'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('toggle-fail');
    });
  });

  it('closes the manage modal when clicking the overlay', () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    expect(container.querySelector('.header-tier-manage-modal')).not.toBeNull();
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(container.querySelector('.header-tier-manage-modal')).toBeNull();
  });

  it('closes the manage modal on Escape', () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    fireEvent.keyDown(container.querySelector('.modal-overlay') as HTMLElement, {
      key: 'Escape',
    });
    expect(container.querySelector('.header-tier-manage-modal')).toBeNull();
  });

  it('dismisses the manage modal via the Done button', () => {
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    const buttons = Array.from(container.querySelectorAll('button'));
    const done = buttons.find((b) => b.textContent === 'Done') as HTMLButtonElement;
    fireEvent.click(done);
    expect(container.querySelector('.header-tier-manage-modal')).toBeNull();
  });

  it("ignores duplicate clicks on a row while it's already toggling", async () => {
    let resolveToggle: () => void = () => {};
    mockToggleHeaderTier.mockReturnValue(
      new Promise<void>((r) => {
        resolveToggle = r;
      }),
    );
    const { container } = render(() => (
      <RoutingHeaderTiersSection {...makeProps({ externalTiers: () => [tier1, tier2] })} />
    ));
    fireEvent.click(screen.getByText('Manage custom routing'));
    const rows = container.querySelectorAll('.specificity-modal__row');
    fireEvent.click(rows[0]);
    fireEvent.click(rows[0]); // second click while toggling — should no-op
    resolveToggle();
    await waitFor(() => {
      expect(mockToggleHeaderTier).toHaveBeenCalledTimes(1);
    });
  });

  describe('headless mode', () => {
    it('renders only the modals (no header/cards) and exposes an opener that opens manage', async () => {
      let opener: (() => void) | undefined;
      const { container } = render(() => (
        <RoutingHeaderTiersSection
          {...makeProps({
            externalTiers: () => [tier1, tier2],
            headless: true,
            onOpenRef: (open) => {
              opener = open;
            },
          })}
        />
      ));
      // Headless mode renders neither the section title nor the card grid.
      expect(screen.queryByText('Custom routing')).toBeNull();
      expect(container.querySelector('.header-tier-list')).toBeNull();
      // The captured opener drives the manage modal (tiers exist).
      opener?.();
      await waitFor(() => {
        expect(container.querySelector('.header-tier-manage-modal')).not.toBeNull();
      });
    });

    it('opens the create modal via the onCreateRef opener', async () => {
      let createOpener: (() => void) | undefined;
      const { findByTestId } = render(() => (
        <RoutingHeaderTiersSection
          {...makeProps({
            externalTiers: () => [tier1],
            headless: true,
            onCreateRef: (open) => {
              createOpener = open;
            },
          })}
        />
      ));
      createOpener?.();
      expect((await findByTestId('tier-modal-mode')).textContent).toBe('create');
    });

    it('opens the edit modal for a specific tier via the onEditRef opener', async () => {
      let editOpener: ((tier: HeaderTier) => void) | undefined;
      const { findByTestId } = render(() => (
        <RoutingHeaderTiersSection
          {...makeProps({
            externalTiers: () => [tier1],
            headless: true,
            onEditRef: (open) => {
              editOpener = open;
            },
          })}
        />
      ));
      editOpener?.(tier1);
      expect((await findByTestId('tier-modal-mode')).textContent).toBe('edit');
    });
  });
});
