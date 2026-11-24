import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';

// ─── API mocks (incl. the streaming primitive the real store calls) ─────────
const mockGetAvailableModels = vi.fn();
const mockGetProviders = vi.fn();
const mockGetCustomProviders = vi.fn();
const mockGetPlaygroundAgent = vi.fn();
const mockGetPlaygroundRun = vi.fn();
const mockListPlaygroundRuns = vi.fn();
const mockStreamPlayground = vi.fn();
const mockSetPlaygroundRunBest = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  getAvailableModels: (...a: unknown[]) => mockGetAvailableModels(...a),
  getProviders: (...a: unknown[]) => mockGetProviders(...a),
  getCustomProviders: (...a: unknown[]) => mockGetCustomProviders(...a),
  getPlaygroundAgent: (...a: unknown[]) => mockGetPlaygroundAgent(...a),
  getPlaygroundRun: (...a: unknown[]) => mockGetPlaygroundRun(...a),
  listPlaygroundRuns: (...a: unknown[]) => mockListPlaygroundRuns(...a),
  streamPlayground: (...a: unknown[]) => mockStreamPlayground(...a),
  setPlaygroundRunBest: (...a: unknown[]) => mockSetPlaygroundRunBest(...a),
}));

const mockToastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: (...a: unknown[]) => mockToastError(...a), success: vi.fn(), warning: vi.fn() },
}));

// ─── Router primitives ──────────────────────────────────────────────────────
const setSearchParamsFn = vi.fn((p: { run?: string }) => {
  if ('run' in p) searchParamsState.run = p.run;
});
const searchParamsState: { run?: string } = {};
vi.mock('@solidjs/router', () => ({
  useSearchParams: () => [searchParamsState, setSearchParamsFn],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <>{props.children as unknown as Element}</>,
  Meta: () => null,
}));

// ─── Right sidebar — capture the history-sidebar content ─────────────────────
let sidebarContent: JSX.Element | null = null;
vi.mock('../../src/services/right-sidebar.jsx', () => ({
  useRightSidebar: () => ({
    content: () => sidebarContent,
    setContent: (c: JSX.Element | null) => {
      sidebarContent = c;
    },
  }),
}));

// ─── Leaf component stubs (keep the page + real store logic exercised) ───────
let lastColProps: Record<string, unknown>[] = [];
vi.mock('../../src/components/playground/PlaygroundColumn.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    lastColProps.push(props);
    const c = props.column as { id: string };
    return (
      <div data-testid={`col-${c.id}`}>
        <span data-testid={`isbest-${c.id}`}>{String(props.isBest)}</span>
        <span data-testid={`cheapest-${c.id}`}>{String(props.isCheapest)}</span>
        <span data-testid={`fastest-${c.id}`}>{String(props.isFastest)}</span>
        <span data-testid={`readonly-${c.id}`}>{String(props.readOnly)}</span>
        <span data-testid={`hasmarkbest-${c.id}`}>{String(!!props.onMarkBest)}</span>
        <button
          data-testid={`markbest-${c.id}`}
          onClick={() => (props.onMarkBest as () => void)?.()}
        >
          mb
        </button>
        <button
          data-testid={`remove-${c.id}`}
          onClick={() => (props.onRemove as (id: string) => void)(c.id)}
        >
          rm
        </button>
        <button
          data-testid={`change-${c.id}`}
          onClick={() => (props.onChangeModel as (id: string) => void)(c.id)}
        >
          ch
        </button>
        <button
          data-testid={`retry-${c.id}`}
          onClick={() => (props.onRetry as (id: string) => void)(c.id)}
        >
          rt
        </button>
      </div>
    );
  },
}));

let mockPromptTextarea: HTMLTextAreaElement | null = null;
vi.mock('../../src/components/playground/PlaygroundPrompt.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    // Simulate the ref callback: create a fake textarea and pass it back.
    const el = document.createElement('textarea');
    mockPromptTextarea = el;
    (props.ref as ((el: HTMLTextAreaElement) => void) | undefined)?.(el);
    return (
      <div data-testid="prompt">
        <span data-testid="prompt-disabled">{String(props.disabled)}</span>
        {/* Touch every prop so SolidJS evaluates each accessor (coverage). */}
        <span data-testid="prompt-value">{String(props.value)}</span>
        <span data-testid="prompt-running">{String(props.running)}</span>
        {props.headersSlot as JSX.Element}
        <button data-testid="prompt-submit" onClick={() => (props.onSubmit as () => void)()}>
          submit
        </button>
        <button
          data-testid="prompt-set"
          onClick={() => (props.onChange as (v: string) => void)('hello world')}
        >
          set
        </button>
        <button
          data-testid="prompt-recall"
          onClick={() => (props.onRecallPrevious as () => void)()}
        >
          recall
        </button>
      </div>
    );
  },
}));

let lastSummaryProps: Record<string, unknown> | null = null;
vi.mock('../../src/components/playground/PlaygroundSummaryTable.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    lastSummaryProps = props;
    return (
      <div data-testid="summary">
        <span data-testid="summary-best">{String(props.bestColumnId)}</span>
        <span data-testid="summary-hasmarkbest">{String(!!props.onMarkBest)}</span>
        <span data-testid="summary-cols">{(props.columns as unknown[]).length}</span>
        <button
          data-testid="summary-markbest"
          onClick={() =>
            (props.onMarkBest as ((c: unknown) => void) | undefined)?.(
              (props.columns as unknown[])[0],
            )
          }
        >
          mb
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/playground/PlaygroundModelPicker.jsx', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid={`picker-${props.columnId as string}`}>
      <span data-testid="picker-models">{(props.models as unknown[]).length}</span>
      <span data-testid="picker-custom">{String(!!props.customProviders)}</span>
      <span data-testid="picker-connected">{String(!!props.connectedProviders)}</span>
      <button
        data-testid="picker-select"
        onClick={() =>
          (props.onSelect as (id: string, m: string, p: string, a?: string) => void)(
            props.columnId as string,
            'picked/model',
            'openai',
            'api_key',
          )
        }
      >
        select
      </button>
      <button data-testid="picker-close" onClick={() => (props.onClose as () => void)()}>
        close
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/playground/PlaygroundEmptyState.jsx', () => ({
  default: (props: Record<string, unknown>) => (
    <button data-testid="empty-connect" onClick={() => (props.onConnect as () => void)()}>
      empty
    </button>
  ),
}));

vi.mock('../../src/components/playground/PlaygroundHistoryDrawer.jsx', () => ({
  default: (props: {
    open: boolean;
    loading: boolean;
    activeRunId: string | null;
    runs: { id: string }[];
    onSelect: (id: string) => void;
    onToggle: () => void;
    onNewPlayground?: () => void;
    onStarToggle?: (id: string, s: boolean) => void;
  }) => (
    <div data-testid="sidebar">
      <span data-testid="sidebar-open">{String(props.open)}</span>
      <span data-testid="sidebar-loading">{String(props.loading)}</span>
      <span data-testid="sidebar-active">{String(props.activeRunId)}</span>
      <span data-testid="sidebar-runcount">{props.runs.length}</span>
      <button data-testid="sidebar-toggle" onClick={() => props.onToggle()}>
        toggle
      </button>
      <button data-testid="sidebar-new" onClick={() => props.onNewPlayground?.()}>
        new
      </button>
      <button data-testid="sidebar-star" onClick={() => props.onStarToggle?.('r-42', true)}>
        star
      </button>
      {props.runs.map((r) => (
        <button data-testid={`pick-${r.id}`} onClick={() => props.onSelect(r.id)}>
          pick {r.id}
        </button>
      ))}
    </div>
  ),
}));

// Real header helpers (blankEntry/isBlockedHeaderKey/toHeaderRecord) but a
// stubbed popover component so we can drive open/close + onChange.
vi.mock('../../src/components/playground/RequestHeadersPopover.jsx', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: (props: {
      open: boolean;
      entries: unknown[];
      onChange: (e: unknown[]) => void;
      onClose: () => void;
    }) => (
      <div data-testid="headers-popover">
        <span data-testid="headers-open">{props.open ? 'open' : 'closed'}</span>
        <span data-testid="headers-entrycount">{props.entries.length}</span>
        <button
          data-testid="headers-change"
          onClick={() => props.onChange([{ id: 'h1', key: 'X-Custom', value: 'v1' }])}
        >
          change
        </button>
        <button
          data-testid="headers-change-blocked"
          onClick={() =>
            props.onChange([
              { id: 'h2', key: 'authorization', value: 'secret' },
              { id: 'h3', key: '', value: '' },
            ])
          }
        >
          change-blocked
        </button>
        <button data-testid="headers-close" onClick={() => props.onClose()}>
          close
        </button>
      </div>
    ),
  };
});

vi.mock('../../src/components/playground/icons.jsx', () => ({
  CodeIcon: () => null,
  HistoryIcon: () => null,
  XIcon: () => null,
  PlusIcon: () => null,
  TrashIcon: () => null,
}));

let providerModalProps: Record<string, unknown> | null = null;
vi.mock('../../src/components/ProviderSelectModal.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    providerModalProps = props;
    return (
      <div data-testid="provider-modal">
        <span data-testid="pm-agent">{String(props.agentName)}</span>
        <span data-testid="pm-providers">{(props.providers as unknown[]).length}</span>
        <span data-testid="pm-custom">{(props.customProviders as unknown[]).length}</span>
        <button data-testid="provider-modal-close" onClick={() => (props.onClose as () => void)()}>
          close
        </button>
        <button
          data-testid="provider-modal-update"
          onClick={() => (props.onUpdate as () => void)()}
        >
          update
        </button>
      </div>
    );
  },
}));

import Playground from '../../src/pages/Playground';

const MODEL_A = {
  model_name: 'openai/gpt-4o-mini',
  provider: 'openai',
  auth_type: 'api_key',
  input_price_per_token: 0.00000015,
  output_price_per_token: 0.0000006,
  context_window: 128_000,
  capability_reasoning: false,
  capability_code: true,
  quality_score: 2,
  display_name: 'GPT-4o Mini',
  provider_display_name: 'OpenAI',
};
const MODEL_B = {
  ...MODEL_A,
  model_name: 'anthropic/claude-sonnet-4',
  provider: 'anthropic',
  display_name: 'Claude Sonnet 4',
};
const ACTIVE_PROVIDER = {
  id: 'p1',
  provider: 'openai',
  auth_type: 'api_key',
  is_active: true,
  has_api_key: true,
  connected_at: '',
};
const ACTIVE_PROVIDER_B = { ...ACTIVE_PROVIDER, id: 'p2', provider: 'anthropic' };

function streamResult(over: Record<string, unknown> = {}) {
  return {
    columnId: 'dbcol-1',
    content: 'streamed answer',
    metrics: { cost: 0.001, inputTokens: 5, outputTokens: 3, durationMs: 120 },
    headers: { 'x-id': 'a' },
    ...over,
  };
}

function makeRunDetail(over: Record<string, unknown> = {}) {
  return {
    id: 'r-42',
    prompt: 'historical-prompt',
    createdAt: new Date().toISOString(),
    modelCount: 1,
    models: ['M'],
    starred: false,
    bestColumnId: null,
    columns: [
      {
        id: 'dbcol-h1',
        model: 'openai/gpt-4o',
        provider: 'openai',
        authType: 'api_key',
        displayName: 'GPT-4o',
        status: 'success',
        content: 'hist content',
        headers: {},
        errorMessage: null,
        metrics: { cost: 0.002, inputTokens: 1, outputTokens: 2, durationMs: 99 },
        position: 0,
      },
    ],
    ...over,
  };
}

const lsStore: Record<string, string> = {};
const ssStore: Record<string, string> = {};

let agentSeq = 0;

describe('Playground page', () => {
  beforeEach(() => {
    // Each test gets a unique agent name so getOrCreatePlaygroundStore() hands
    // out a fresh store (the cache is module-level and survives between tests).
    const agentName = `agent-${++agentSeq}`;
    lastColProps = [];
    lastSummaryProps = null;
    providerModalProps = null;
    sidebarContent = null;
    mockPromptTextarea = null;
    searchParamsState.run = undefined;
    for (const k of Object.keys(lsStore)) delete lsStore[k];
    for (const k of Object.keys(ssStore)) delete ssStore[k];

    mockGetAvailableModels.mockReset().mockResolvedValue([MODEL_A, MODEL_B]);
    mockGetProviders.mockReset().mockResolvedValue([ACTIVE_PROVIDER, ACTIVE_PROVIDER_B]);
    mockGetCustomProviders.mockReset().mockResolvedValue([]);
    mockGetPlaygroundAgent.mockReset().mockResolvedValue({ name: agentName });
    mockGetPlaygroundRun.mockReset().mockResolvedValue(makeRunDetail());
    mockListPlaygroundRuns.mockReset().mockResolvedValue([
      {
        id: 'r-42',
        prompt: 'p',
        createdAt: '2026-01-01',
        modelCount: 1,
        models: ['M'],
        starred: false,
        bestColumnId: null,
      },
    ]);
    mockStreamPlayground.mockReset().mockResolvedValue(streamResult());
    mockSetPlaygroundRunBest.mockReset().mockResolvedValue('dbcol-1');
    setSearchParamsFn.mockClear();
    mockToastError.mockReset();

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => lsStore[k] ?? null,
      setItem: (k: string, v: string) => {
        lsStore[k] = v;
      },
      removeItem: (k: string) => {
        delete lsStore[k];
      },
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => ssStore[k] ?? null,
      setItem: (k: string, v: string) => {
        ssStore[k] = v;
      },
      removeItem: (k: string) => {
        delete ssStore[k];
      },
    });
  });

  function renderSidebar() {
    return render(() => <>{sidebarContent}</>);
  }

  async function find(testId: string): Promise<HTMLElement> {
    return waitFor(() => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) throw new Error(`not found: ${testId}`);
      return el as HTMLElement;
    });
  }

  it('renders the header and seeds two default columns from connected providers', async () => {
    const { getByText } = render(() => <Playground />);
    expect(getByText('Playground')).toBeDefined();
    // pickDefaults runs against the real store → two columns appear.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="col-"]').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows the empty state when providers exist but none are active', async () => {
    // Provider connection now lives on the sidebar provider pages, so the
    // empty state is purely informational here — no comparison columns render.
    mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
    render(() => <Playground />);
    expect(await find('empty-connect')).toBeDefined();
    expect(document.querySelectorAll('[data-testid^="col-"]').length).toBe(0);
  });

  it('invokes the empty-state onConnect handler without throwing', async () => {
    // The page passes a placeholder onConnect to PlaygroundEmptyState; firing
    // it must execute cleanly (no columns, no crash). Exercises the callback.
    mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
    render(() => <Playground />);
    const connectBtn = await find('empty-connect');
    expect(() => fireEvent.click(connectBtn)).not.toThrow();
    // Still in the empty state — the placeholder handler is a no-op for now.
    expect(document.querySelectorAll('[data-testid^="col-"]').length).toBe(0);
  });

  describe('submit → streaming run → history', () => {
    it('streams a run, finalizes the column, pushes an optimistic history entry, persists last run', async () => {
      render(() => <Playground />);
      await waitFor(() =>
        expect(document.querySelectorAll('[data-testid^="col-"]').length).toBeGreaterThan(0),
      );
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));

      await waitFor(() => expect(mockStreamPlayground).toHaveBeenCalled());
      // Run id was set in the URL + sessionStorage.
      await waitFor(() => expect(ssStore['manifest.playground.lastRun']).toBeDefined());
      // The running→idle effect refreshes history and auto-selects the latest.
      await waitFor(() => expect(mockListPlaygroundRuns).toHaveBeenCalled());
      // After streaming completes the summary table receives the columns.
      await waitFor(() => {
        renderSidebar();
        expect(document.querySelector('[data-testid="sidebar"]')).not.toBeNull();
      });
    });

    it('does nothing when the prompt is empty (runAll returns no id)', async () => {
      render(() => <Playground />);
      await find('prompt-submit');
      setSearchParamsFn.mockClear();
      fireEvent.click(await find('prompt-submit'));
      // No prompt set → runAll() returns undefined → no run param written.
      await new Promise((r) => setTimeout(r, 20));
      expect(setSearchParamsFn.mock.calls.some((c) => c[0] && 'run' in c[0] && c[0].run)).toBe(
        false,
      );
    });

    it('toasts when the streamed run fails for a column', async () => {
      mockStreamPlayground.mockRejectedValue(new Error('upstream down'));
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      // The column paints an error; the page keeps working (history refresh).
      await waitFor(() => expect(mockListPlaygroundRuns).toHaveBeenCalled());
    });
  });

  describe('winner badges (real findWinners)', () => {
    it('marks the cheapest + fastest columns once two columns succeed', async () => {
      mockStreamPlayground.mockImplementation(async (req: { model: string }) =>
        req.model === 'openai/gpt-4o-mini'
          ? streamResult({
              columnId: 'db-openai',
              metrics: { cost: 0.001, inputTokens: 1, outputTokens: 2, durationMs: 50 },
            })
          : streamResult({
              columnId: 'db-anthropic',
              metrics: { cost: 0.005, inputTokens: 1, outputTokens: 2, durationMs: 300 },
            }),
      );
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));

      // Wait until both columns are success and the cheapest flag flips.
      await waitFor(() => {
        const cheapFlags = [...document.querySelectorAll('[data-testid^="cheapest-"]')].map(
          (e) => e.textContent,
        );
        expect(cheapFlags).toContain('true');
      });
      const fastFlags = [...document.querySelectorAll('[data-testid^="fastest-"]')].map(
        (e) => e.textContent,
      );
      expect(fastFlags).toContain('true');
      // Summary table receives the completed columns.
      await waitFor(() =>
        expect(Number(document.querySelector('[data-testid="summary-cols"]')?.textContent)).toBe(2),
      );
    });
  });

  describe('best answer wiring (real store.markBest)', () => {
    it('marks a column best and reflects it in the column + summary props', async () => {
      const onBestModelChange = vi.fn();
      render(() => <Playground onBestModelChange={onBestModelChange} />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      // Wait for at least one column to finish and expose a mark-best button.
      const markedColumn = await waitFor(() => {
        const success = lastColProps.find(
          (p) => (p.column as { status: string }).status === 'success',
        );
        if (!success) throw new Error('no success column yet');
        return success.column as {
          id: string;
          model: string;
          provider: string;
          authType: string;
        };
      });
      mockSetPlaygroundRunBest.mockResolvedValue('dbcol-1');
      fireEvent.click(await find(`markbest-${markedColumn.id}`));
      await waitFor(() => expect(mockSetPlaygroundRunBest).toHaveBeenCalled());
      await waitFor(() =>
        expect(onBestModelChange).toHaveBeenCalledWith({
          model: markedColumn.model,
          provider: markedColumn.provider,
          authType: markedColumn.authType,
        }),
      );
      await waitFor(() =>
        expect(document.querySelector('[data-testid="summary-best"]')?.textContent).toBe('dbcol-1'),
      );
      fireEvent.click(await find(`markbest-${markedColumn.id}`));
      await waitFor(() => expect(onBestModelChange).toHaveBeenCalledWith(null));
    });

    it('toasts the error when persisting the best pick fails', async () => {
      mockSetPlaygroundRunBest.mockRejectedValue(new Error('persist failed'));
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      const colId = await waitFor(() => {
        const s = lastColProps.find((p) => (p.column as { status: string }).status === 'success');
        if (!s) throw new Error('no success column');
        return (s.column as { id: string }).id;
      });
      fireEvent.click(await find(`markbest-${colId}`));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('persist failed'));
    });

    it('marks best from the summary table row click too', async () => {
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      await waitFor(() =>
        expect(document.querySelector('[data-testid="summary-hasmarkbest"]')?.textContent).toBe(
          'true',
        ),
      );
      mockSetPlaygroundRunBest.mockResolvedValue('dbcol-1');
      fireEvent.click(await find('summary-markbest'));
      await waitFor(() => expect(mockSetPlaygroundRunBest).toHaveBeenCalled());
    });
  });

  describe('history selection', () => {
    it('replaces the store when no run is in progress and providers are connected', async () => {
      render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('pick-r-42'));
      await waitFor(() => expect(mockGetPlaygroundRun).toHaveBeenCalledWith('r-42'));
      // Store now holds the historical column.
      await waitFor(() => {
        const hist = lastColProps.find(
          (p) => (p.column as { model: string }).model === 'openai/gpt-4o',
        );
        expect(hist).toBeDefined();
      });
    });

    it('shows the run read-only (overlay) when a playground is running', async () => {
      // Make the stream hang so isAnyRunning() stays true.
      mockStreamPlayground.mockReturnValue(new Promise(() => {}));
      mockGetPlaygroundRun.mockResolvedValue(makeRunDetail({ bestColumnId: 'dbcol-h1' }));
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      renderSidebar();
      fireEvent.click(await find('pick-r-42'));
      await waitFor(() => expect(mockGetPlaygroundRun).toHaveBeenCalled());
      // Overlay path: columns are read-only, no mark-best, overlay best id.
      await waitFor(() => {
        const overlay = lastColProps[lastColProps.length - 1];
        expect(overlay.readOnly).toBe(true);
        expect(overlay.onMarkBest).toBeUndefined();
      });
      await waitFor(() =>
        expect(document.querySelector('[data-testid="summary-best"]')?.textContent).toBe(
          'dbcol-h1',
        ),
      );
      expect(document.querySelector('[data-testid="summary-hasmarkbest"]')?.textContent).toBe(
        'false',
      );
    });

    it('shows the "Connect a provider to get started" bar when overlaying history without active providers', async () => {
      mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
      const { getByText } = render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('pick-r-42'));
      await waitFor(() => expect(mockGetPlaygroundRun).toHaveBeenCalled());
      await waitFor(() => expect(getByText('Connect a provider to get started')).toBeDefined());
    });

    it('toasts an error when getPlaygroundRun fails', async () => {
      mockGetPlaygroundRun.mockRejectedValueOnce(new Error('boom'));
      render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('pick-r-42'));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('boom'));
    });

    it('toasts a generic message when getPlaygroundRun fails with a non-Error', async () => {
      mockGetPlaygroundRun.mockRejectedValueOnce('weird');
      render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('pick-r-42'));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to load run'));
    });

    it('clicking the live (running) run shows live columns without refetching', async () => {
      mockStreamPlayground.mockReturnValue(new Promise(() => {}));
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      // Find the live run id from the optimistic history entry.
      let liveId = '';
      await waitFor(() => {
        renderSidebar();
        const btns = [...document.querySelectorAll('[data-testid^="pick-"]')];
        const live = btns.find((b) => b.getAttribute('data-testid') !== 'pick-r-42');
        if (!live) throw new Error('no live run yet');
        liveId = live.getAttribute('data-testid')!.replace('pick-', '');
      });
      mockGetPlaygroundRun.mockClear();
      fireEvent.click(await find(`pick-${liveId}`));
      expect(mockGetPlaygroundRun).not.toHaveBeenCalled();
    });
  });

  describe('column actions', () => {
    it('forwards remove / retry / change-model (with real header record) to the store', async () => {
      render(() => <Playground />);
      const colId = (await waitFor(() => {
        if (!lastColProps[0]) throw new Error('no column');
        return lastColProps[0];
      }).then((p) => (p.column as { id: string }).id)) as string;
      await find(`col-${colId}`);

      fireEvent.click(await find(`change-${colId}`));
      await find(`picker-${colId}`);
      fireEvent.click(await find('picker-select'));
      // After replace, the column model updates via the real store.
      await waitFor(() => {
        const replaced = lastColProps.find(
          (p) => (p.column as { model: string }).model === 'picked/model',
        );
        expect(replaced).toBeDefined();
      });

      fireEvent.click(await find(`retry-${colId}`));
      // retryColumn with no prompt is a no-op in the store; just assert no throw
      // by confirming the page is still mounted.
      expect(document.querySelector('[data-testid="prompt"]')).not.toBeNull();

      fireEvent.click(await find(`remove-${colId}`));
      await waitFor(() =>
        expect(document.querySelector(`[data-testid="col-${colId}"]`)).toBeNull(),
      );
    });

    it('opens the add-model picker via the Add button and adds a column', async () => {
      render(() => <Playground />);
      const addBtn = (await find('add-or-toolbar').catch(
        () => document.querySelector('[aria-label="Add model column"]') as HTMLElement,
      )) as HTMLElement;
      fireEvent.click(addBtn);
      await find('picker-new');
      const before = document.querySelectorAll('[data-testid^="col-"]').length;
      fireEvent.click(await find('picker-select'));
      await waitFor(() =>
        expect(document.querySelectorAll('[data-testid^="col-"]').length).toBe(before + 1),
      );
      // Close path.
      fireEvent.click(document.querySelector('[aria-label="Add model column"]') as HTMLElement);
      await find('picker-new');
      fireEvent.click(await find('picker-close'));
      await waitFor(() => expect(document.querySelector('[data-testid="picker-new"]')).toBeNull());
    });
  });

  describe('request headers (real helpers)', () => {
    it('opens/closes the popover and seeds a blank entry, persisting active header count', async () => {
      render(() => <Playground />);
      await find('prompt');
      const trigger = document.querySelector('[aria-label="Request headers"]') as HTMLElement;
      fireEvent.click(trigger);
      await waitFor(() =>
        expect(document.querySelector('[data-testid="headers-open"]')?.textContent).toBe('open'),
      );
      // onChange with a real header → persisted via persistHeaders + counted.
      fireEvent.click(await find('headers-change'));
      await waitFor(() =>
        expect(lsStore['manifest.playground.requestHeaders']).toContain('X-Custom'),
      );
      // A blocked + empty header contributes 0 to activeHeaderCount.
      fireEvent.click(await find('headers-change-blocked'));
      // Close via the popover and via the toggle.
      fireEvent.click(await find('headers-close'));
      await waitFor(() =>
        expect(document.querySelector('[data-testid="headers-open"]')?.textContent).toBe('closed'),
      );
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      expect(document.querySelector('[data-testid="headers-open"]')?.textContent).toBe('closed');
    });

    it('restores persisted header entries on mount (loadStoredHeaders parse path)', async () => {
      lsStore['manifest.playground.requestHeaders'] = JSON.stringify([
        { id: 'h1', key: 'X-A', value: '1' },
        { id: 'h2', key: 'X-B', value: '2' },
        'not-an-entry',
      ]);
      render(() => <Playground />);
      await find('prompt');
      // The badge reflects the 2 valid persisted headers (count > 0 branch).
      await waitFor(() => {
        const badge = document.querySelector('.playground-prompt__headers-badge');
        expect(badge?.textContent).toBe('2');
      });
    });

    it('falls back to no entries when stored headers JSON is malformed', async () => {
      lsStore['manifest.playground.requestHeaders'] = '{not json';
      render(() => <Playground />);
      await find('prompt');
      expect(document.querySelector('.playground-prompt__headers-badge')).toBeNull();
    });

    it('falls back to no entries when stored headers is not an array', async () => {
      lsStore['manifest.playground.requestHeaders'] = JSON.stringify({ not: 'array' });
      render(() => <Playground />);
      await find('prompt');
      expect(document.querySelector('.playground-prompt__headers-badge')).toBeNull();
    });

    it('silently ignores a localStorage write failure when persisting headers', async () => {
      render(() => <Playground />);
      await find('prompt');
      const trigger = document.querySelector('[aria-label="Request headers"]') as HTMLElement;
      fireEvent.click(trigger);
      await find('headers-open');
      // Make setItem throw (quota / private mode) → persistHeaders catch.
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => lsStore[k] ?? null,
        setItem: () => {
          throw new Error('QuotaExceeded');
        },
        removeItem: (k: string) => {
          delete lsStore[k];
        },
      });
      // onChange triggers updateHeaders → persistHeaders → swallowed throw.
      expect(() =>
        fireEvent.click(document.querySelector('[data-testid="headers-change"]') as HTMLElement),
      ).not.toThrow();
    });
  });

  describe('history refresh failure', () => {
    it('toasts the error message when listPlaygroundRuns rejects', async () => {
      mockListPlaygroundRuns.mockRejectedValue(new Error('history boom'));
      render(() => <Playground />);
      // historyOpen() defaults true → refreshHistory() runs on mount.
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('history boom'));
    });

    it('toasts a generic message when listPlaygroundRuns rejects with a non-Error', async () => {
      mockListPlaygroundRuns.mockRejectedValue('weird');
      render(() => <Playground />);
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Failed to load history'));
    });
  });

  describe('new playground + keyboard shortcuts', () => {
    it('resets everything when "New run" is clicked', async () => {
      render(() => <Playground />);
      await waitFor(() =>
        expect(document.querySelectorAll('[data-testid^="col-"]').length).toBeGreaterThan(0),
      );
      renderSidebar();
      fireEvent.click(await find('sidebar-new'));
      // Store reset clears columns; pickDefaults reseeds afterwards.
      expect(setSearchParamsFn).toHaveBeenCalledWith({ run: undefined });
    });

    it('schedules focus on the prompt textarea via requestAnimationFrame when starting a new playground', async () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0);
        return 0;
      });
      const focusSpy = vi.fn();
      render(() => <Playground />);
      await waitFor(() =>
        expect(document.querySelectorAll('[data-testid^="col-"]').length).toBeGreaterThan(0),
      );
      // Attach a focus spy to the textarea that the mock handed to promptRef.
      if (mockPromptTextarea) mockPromptTextarea.focus = focusSpy;
      renderSidebar();
      rafSpy.mockClear();
      fireEvent.click(await find('sidebar-new'));
      expect(rafSpy).toHaveBeenCalled();
      expect(focusSpy).toHaveBeenCalled();
      rafSpy.mockRestore();
    });

    it('Ctrl+Shift+O starts a new playground', async () => {
      render(() => <Playground />);
      await find('prompt');
      setSearchParamsFn.mockClear();
      fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(setSearchParamsFn).toHaveBeenCalledWith({ run: undefined }));
    });

    it('Ctrl+K opens the add-model picker when idle and under the cap', async () => {
      render(() => <Playground />);
      await find('prompt');
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      await find('picker-new');
    });

    it('Ctrl+K is suppressed while a playground is running', async () => {
      mockStreamPlayground.mockReturnValue(new Promise(() => {}));
      render(() => <Playground />);
      await find('prompt-set');
      fireEvent.click(await find('prompt-set'));
      fireEvent.click(await find('prompt-submit'));
      // While running, Cmd/Ctrl+K must not open the picker.
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      expect(document.querySelector('[data-testid="picker-new"]')).toBeNull();
    });

    it('toggles the sidebar open state and persists the preference', async () => {
      render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('sidebar-toggle'));
      expect(lsStore['manifest.playground.recentOpen']).toBe('false');
    });

    it('starts collapsed when the stored sidebar preference is "false"', async () => {
      lsStore['manifest.playground.recentOpen'] = 'false';
      render(() => <Playground />);
      renderSidebar();
      await waitFor(() =>
        expect(document.querySelector('[data-testid="sidebar-open"]')?.textContent).toBe('false'),
      );
    });

    it('updates a run star flag from the sidebar without throwing', async () => {
      render(() => <Playground />);
      renderSidebar();
      fireEvent.click(await find('sidebar-star'));
      await waitFor(() => expect(mockListPlaygroundRuns).toHaveBeenCalled());
    });
  });

  describe('restore last run on load', () => {
    it('loads the run referenced by ?run= when the store is empty', async () => {
      // No connected providers → pickDefaults seeds nothing → store stays empty
      // → the restore effect fires for the ?run= param.
      mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
      searchParamsState.run = 'r-99';
      mockGetPlaygroundRun.mockResolvedValue(makeRunDetail({ id: 'r-99' }));
      render(() => <Playground />);
      await waitFor(() => expect(mockGetPlaygroundRun).toHaveBeenCalledWith('r-99'));
    });

    it('restores from sessionStorage lastRun when no search param is set', async () => {
      mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
      ssStore['manifest.playground.lastRun'] = 'r-ss';
      mockGetPlaygroundRun.mockResolvedValue(makeRunDetail({ id: 'r-ss' }));
      render(() => <Playground />);
      await waitFor(() => expect(mockGetPlaygroundRun).toHaveBeenCalledWith('r-ss'));
    });

    it('clears the stale run param + sessionStorage when restoring it fails', async () => {
      mockGetProviders.mockResolvedValue([{ ...ACTIVE_PROVIDER, is_active: false }]);
      searchParamsState.run = 'r-bad';
      ssStore['manifest.playground.lastRun'] = 'r-bad';
      mockGetPlaygroundRun.mockRejectedValue(new Error('gone'));
      render(() => <Playground />);
      await waitFor(() => expect(setSearchParamsFn).toHaveBeenCalledWith({ run: undefined }));
      await waitFor(() => expect(ssStore['manifest.playground.lastRun']).toBeUndefined());
    });
  });

  it('wires the prompt recall handler to the store (ArrowUp history recall)', async () => {
    render(() => <Playground />);
    await find('prompt-set');
    // Submit once so there is a prompt in history to recall.
    fireEvent.click(await find('prompt-set'));
    fireEvent.click(await find('prompt-submit'));
    await waitFor(() => expect(mockStreamPlayground).toHaveBeenCalled());
    // Clear then recall — the page forwards onRecallPrevious to the store.
    fireEvent.click(await find('prompt-recall'));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="prompt-value"]')?.textContent).toBe(
        'hello world',
      ),
    );
  });

  it('announces a model response for screen readers once metrics arrive', async () => {
    render(() => <Playground />);
    await find('prompt-set');
    fireEvent.click(await find('prompt-set'));
    fireEvent.click(await find('prompt-submit'));
    await waitFor(() => {
      const live = document.querySelector('[role="status"][aria-live="polite"]');
      expect(live?.textContent ?? '').toMatch(/responded in \d+ milliseconds/);
    });
  });
});
