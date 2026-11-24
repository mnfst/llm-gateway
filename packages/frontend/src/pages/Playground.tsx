import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Component,
} from 'solid-js';
import { useSearchParams, type RouteSectionProps } from '@solidjs/router';
import { Meta, Title } from '@solidjs/meta';
import type { AuthType, PlaygroundHistoryRunSummary } from '../services/api.js';
import {
  getAvailableModels,
  getPlaygroundAgent,
  getPlaygroundRun,
  getCustomProviders,
  getProviders,
  listPlaygroundRuns,
} from '../services/api.js';
import {
  getOrCreatePlaygroundStore,
  MAX_COLUMNS,
  type PlaygroundColumn as ColumnData,
} from '../services/playground-store.js';
import { toast } from '../services/toast-store.js';
import PlaygroundColumn from '../components/playground/PlaygroundColumn.jsx';
import PlaygroundPrompt from '../components/playground/PlaygroundPrompt.jsx';
import PlaygroundSummaryTable from '../components/playground/PlaygroundSummaryTable.jsx';
import PlaygroundModelPicker from '../components/playground/PlaygroundModelPicker.jsx';
import PlaygroundEmptyState from '../components/playground/PlaygroundEmptyState.jsx';
import PlaygroundRecentSidebar from '../components/playground/PlaygroundHistoryDrawer.jsx';
import RequestHeadersPopover, {
  blankEntry,
  isBlockedHeaderKey,
  toHeaderRecord,
  type HeaderEntry,
} from '../components/playground/RequestHeadersPopover.jsx';
import { CodeIcon } from '../components/playground/icons.jsx';
import { useRightSidebar } from '../services/right-sidebar.jsx';

// Route-scoped styles (kept out of the global theme bundle). routing.css is
// needed here because the shared ModelPickerModal / ProviderSelectModal use
// its `routing-modal__*` and capability-badge classes.
import '../styles/playground.css';
import '../styles/routing.css';

const REQUEST_HEADERS_STORAGE_KEY = 'manifest.playground.requestHeaders';

function loadStoredHeaders(): HeaderEntry[] {
  try {
    const raw = localStorage.getItem(REQUEST_HEADERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is HeaderEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as HeaderEntry).id === 'string' &&
          typeof (e as HeaderEntry).key === 'string' &&
          typeof (e as HeaderEntry).value === 'string',
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistHeaders(entries: HeaderEntry[]): void {
  try {
    localStorage.setItem(REQUEST_HEADERS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota / private mode — silently ignore */
  }
}

function activeHeaderCount(entries: HeaderEntry[]): number {
  let n = 0;
  for (const e of entries) {
    const k = e.key.trim();
    if (!k || !e.value) continue;
    if (isBlockedHeaderKey(k)) continue;
    n++;
  }
  return n;
}

function findDisplayName(
  available: { model_name: string; display_name?: string | null }[],
  modelName: string,
): string {
  const match = available.find((m) => m.model_name === modelName);
  return match?.display_name ?? modelName;
}

function findWinners(columns: readonly ColumnData[]): {
  cheapestCost?: number;
  fastestDuration?: number;
} {
  const success = columns.filter((c) => c.status === 'success' && c.metrics);
  if (success.length < 2) return {};

  let cheapestCost = Number.POSITIVE_INFINITY;
  for (const c of success) {
    const cost = c.metrics?.cost;
    if (cost != null && cost < cheapestCost) cheapestCost = cost;
  }

  let fastestDuration = Number.POSITIVE_INFINITY;
  for (const c of success) {
    const dur = c.metrics?.durationMs ?? Number.POSITIVE_INFINITY;
    if (dur < fastestDuration) fastestDuration = dur;
  }

  return {
    cheapestCost: cheapestCost < Number.POSITIVE_INFINITY ? cheapestCost : undefined,
    fastestDuration: fastestDuration < Number.POSITIVE_INFINITY ? fastestDuration : undefined,
  };
}

interface PlaygroundProps {
  onBestModelChange?: (
    selection: { model: string; provider: string; authType: AuthType } | null,
  ) => void;
  /**
   * Rendered inside another page (onboarding wizard): no document title,
   * no page header, and no run-history sidebar.
   */
  embedded?: boolean;
}

const Playground: Component<PlaygroundProps & Partial<RouteSectionProps>> = (props) => {
  const [searchParams, setSearchParams] = useSearchParams<{ run?: string }>();
  const [agent] = createResource(getPlaygroundAgent);
  // Only the resolved name (from the server) drives resource sources and the
  // store key. Using `undefined` as the source keeps resources idle until
  // getPlaygroundAgent resolves, preventing 404 fetches for models/providers
  // before the reserved agent row is guaranteed to exist server-side.
  const resolvedAgentName = () => agent()?.name;
  // Display fallback for UI text that needs a name before resolution.
  const agentName = () => resolvedAgentName() ?? 'Playground';

  const [available, { refetch: refetchAvailable }] = createResource(
    resolvedAgentName,
    getAvailableModels,
  );
  const [providers, { refetch: refetchProviders }] = createResource(
    resolvedAgentName,
    getProviders,
  );
  const [customProviders, { refetch: refetchCustomProviders }] = createResource(
    resolvedAgentName,
    getCustomProviders,
  );

  // Memo so the store key updates when resolvedAgentName() settles to the
  // actual server-assigned name ("Playground"). This ensures each test render
  // gets an isolated store keyed by the mock-resolved name.
  const store = createMemo(() => getOrCreatePlaygroundStore(agentName()));
  const [pickerForColumn, setPickerForColumn] = createSignal<string | null>(null);
  const [showAddPicker, setShowAddPicker] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal('');
  const [promptHeight, setPromptHeight] = createSignal(0);
  const [historyOpen, setHistoryOpen] = createSignal(
    !props.embedded && localStorage.getItem('manifest.playground.recentOpen') !== 'false',
  );
  const toggleRecent = () => {
    const next = !historyOpen();
    setHistoryOpen(next);
    localStorage.setItem('manifest.playground.recentOpen', String(next));
  };
  const [historyRuns, setHistoryRuns] = createSignal<PlaygroundHistoryRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [activeRunId, setActiveRunId] = createSignal<string | null>(null);
  const [liveRunId, setLiveRunId] = createSignal<string | null>(null);
  const [viewingHistory, setViewingHistory] = createSignal<
    import('../services/playground-store.js').PlaygroundColumn[] | null
  >(null);
  const [completedResults, setCompletedResults] = createSignal<
    import('../services/playground-store.js').PlaygroundColumn[] | null
  >(null);
  const [headerEntries, setHeaderEntries] = createSignal<HeaderEntry[]>(loadStoredHeaders());
  const [headersOpen, setHeadersOpen] = createSignal(false);
  // Best pick for a run shown read-only as an overlay (store isn't loaded in
  // that path, so its best state is tracked separately).
  const [overlayBestId, setOverlayBestId] = createSignal<string | null>(null);
  let promptRef: HTMLTextAreaElement | undefined;

  const effectiveBestId = () => (viewingHistory() ? overlayBestId() : store().bestColumnId());

  const handleMarkBest = (col: ColumnData) => {
    if (viewingHistory()) return; // read-only overlay
    const next =
      col.columnDbId != null && col.columnDbId !== store().bestColumnId()
        ? { model: col.model, provider: col.provider, authType: col.authType }
        : null;
    void store()
      .markBest(col)
      .then(() => props.onBestModelChange?.(next))
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : 'Failed to set best answer'),
      );
  };

  const refetchAllProviders = () => {
    void refetchProviders();
    void refetchAvailable();
    void refetchCustomProviders();
  };

  const { setContent: setRightSidebar } = useRightSidebar();

  const handleNewPlayground = () => {
    store().reset();
    setViewingHistory(null);
    setCompletedResults(null);
    setActiveRunId(null);
    setLiveRunId(null);
    setOverlayBestId(null);
    setSearchParams({ run: undefined });
    sessionStorage.removeItem('manifest.playground.lastRun');
    // pickDefaults will fire via the existing createEffect since columns are now empty
    requestAnimationFrame(() => promptRef?.focus());
  };

  // Cmd+K (Mac) / Ctrl+K (Windows) opens the model picker
  // Shift+Cmd+O (Mac) / Ctrl+Shift+O (Windows) starts a new playground
  createEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (!store().isAnyRunning() && store().columns.length < MAX_COLUMNS && !viewingHistory()) {
          setShowAddPicker(true);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleNewPlayground();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  // Restore the last viewed run on page load, but only if the store
  // doesn't already have columns (i.e. the user navigated away and back
  // while a playground was running -- the cached store still has state).
  createEffect(() => {
    // If store already has completed columns, snapshot them for the summary table
    if (store().columns.length > 0 && !store().isAnyRunning() && !completedResults()) {
      setCompletedResults([...store().columns]);
    }
    if (store().columns.length > 0) return;
    const runId = searchParams.run || sessionStorage.getItem('manifest.playground.lastRun');
    if (runId && !activeRunId()) {
      getPlaygroundRun(runId)
        .then((detail) => {
          store().loadHistoryRun(detail);
          setCompletedResults([...store().columns]);
          setActiveRunId(runId);
          setSearchParams({ run: runId });
        })
        .catch(() => {
          setSearchParams({ run: undefined });
          sessionStorage.removeItem('manifest.playground.lastRun');
        });
    }
  });

  const updateHeaders = (entries: HeaderEntry[]) => {
    setHeaderEntries(entries);
    persistHeaders(entries);
  };

  const openHeaders = () => {
    if (headerEntries().length === 0) setHeaderEntries([blankEntry()]);
    setHeadersOpen(true);
  };

  const handleSubmit = () => {
    const promptText = store().prompt().trim();
    const models = store().columns.map((c) => c.displayName ?? c.model);
    setCompletedResults(null);
    const runId = store().runAll({ requestHeaders: toHeaderRecord(headerEntries()) });
    if (!runId) return;

    // Add to history immediately so user sees the running playground
    setHistoryRuns((prev) => [
      {
        id: runId,
        prompt: promptText,
        createdAt: new Date().toISOString(),
        modelCount: models.length,
        models,
        starred: false,
        bestColumnId: null,
      },
      ...prev.filter((r) => r.id !== runId),
    ]);
    setActiveRunId(runId);
    setLiveRunId(runId);
    setViewingHistory(null);
    setSearchParams({ run: runId });
    sessionStorage.setItem('manifest.playground.lastRun', runId);
  };

  const handleRetry = (id: string) => {
    void store().retryColumn(id, { requestHeaders: toHeaderRecord(headerEntries()) });
  };

  const refreshHistory = async () => {
    setHistoryLoading(true);
    try {
      setHistoryRuns(await listPlaygroundRuns());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  };

  createEffect(() => {
    if (historyOpen()) void refreshHistory();
  });

  // Refresh history once per run, on the transition from running → idle.
  // Tracking historyRuns() here would cause an infinite loop because
  // refreshHistory() writes the signal it tracks.
  createEffect(
    on(
      () => store().isAnyRunning(),
      (running, prev) => {
        if (prev === true && running === false) {
          setLiveRunId(null);
          // Snapshot completed results so the summary table survives column removals
          setCompletedResults([...store().columns]);
          if (props.embedded) return;
          void refreshHistory().then(() => {
            // If user isn't viewing a past run, auto-select the latest
            if (!viewingHistory()) {
              const latest = historyRuns()[0];
              if (latest) {
                setActiveRunId(latest.id);
                setSearchParams({ run: latest.id });
              }
            }
          });
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const a = available();
    const p = providers();
    if (!a || !p) return;
    // Don't overwrite existing columns (e.g. after navigating away and back)
    if (store().columns.length > 0) return;
    store().pickDefaults(a, p);
  });

  createEffect(() => {
    for (const col of store().columns) {
      if (col.status === 'success' && col.metrics) {
        setAnnouncement(`${col.displayName} responded in ${col.metrics.durationMs} milliseconds.`);
      }
    }
  });

  const handlePickModel = (
    columnId: string,
    model: string,
    provider: string,
    authType?: AuthType,
  ) => {
    const displayName = findDisplayName(available() ?? [], model);
    store().replaceColumnModel(columnId, model, provider, authType ?? 'api_key', displayName);
    setPickerForColumn(null);
  };

  const handleAddModel = (
    _columnId: string,
    model: string,
    provider: string,
    authType?: AuthType,
  ) => {
    const displayName = findDisplayName(available() ?? [], model);
    store().addColumn(model, provider, authType ?? 'api_key', displayName);
    setShowAddPicker(false);
  };

  const handlePickHistory = async (runId: string) => {
    // If clicking on the live (currently running) run, just show live columns
    if (runId === liveRunId()) {
      setViewingHistory(null);
      setCompletedResults(null);
      setActiveRunId(runId);
      setSearchParams({ run: runId });
      return;
    }
    try {
      const detail = await getPlaygroundRun(runId);
      const toReadOnlyCols = (): import('../services/playground-store.js').PlaygroundColumn[] =>
        detail.columns.map((c, i) => ({
          id: `hist-${i}`,
          model: c.model,
          provider: c.provider,
          authType: (c.authType ?? 'api_key') as AuthType,
          displayName: c.displayName ?? c.model,
          status: c.status === 'success' ? ('success' as const) : ('error' as const),
          response: c.content ?? undefined,
          metrics: c.metrics ?? undefined,
          headers: c.headers ?? undefined,
          error: c.errorMessage ?? undefined,
          columnDbId: c.id,
        }));

      if (store().isAnyRunning() || !hasConnectedProviders()) {
        // Don't touch the store -- show history as a read-only overlay
        const cols = toReadOnlyCols();
        setViewingHistory(cols);
        setCompletedResults(cols);
        setOverlayBestId(detail.bestColumnId ?? null);
      } else {
        // No run in progress and providers available, safe to replace the store
        store().loadHistoryRun(detail);
        setViewingHistory(null);
        setCompletedResults([...store().columns]);
      }
      setActiveRunId(runId);
      setSearchParams({ run: runId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load run');
    }
  };

  const handleStarToggle = (runId: string, starred: boolean) => {
    setHistoryRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, starred } : r)));
  };

  createEffect(() => {
    if (props.embedded) return;
    setRightSidebar(
      <PlaygroundRecentSidebar
        open={historyOpen()}
        loading={historyLoading()}
        runs={historyRuns()}
        activeRunId={activeRunId()}
        onToggle={toggleRecent}
        onSelect={handlePickHistory}
        onStarToggle={handleStarToggle}
        onNewPlayground={handleNewPlayground}
      />,
    );
  });
  onCleanup(() => setRightSidebar(null));

  const hasConnectedProviders = () => (providers() ?? []).some((p) => p.is_active);
  // Compute winners from whatever set is actually rendered — when a history
  // run is open its columns drive the badges, not the live store.
  const winners = () => findWinners(viewingHistory() ?? store().columns);

  return (
    <div
      class="playground"
      classList={{ 'playground--embedded': props.embedded }}
      style={props.embedded ? undefined : { 'padding-bottom': `${promptHeight() + 48}px` }}
    >
      <Show when={!props.embedded}>
        <Title>Playground · Manifest</Title>
        <Meta
          name="description"
          content="Compare models side by side for cost, speed, and quality."
        />

        <header class="page-header">
          <div>
            <h1>Playground</h1>
            <p class="page-header__sub">
              Send one prompt to multiple models and compare cost, speed, and quality.
            </p>
          </div>
          {/* Provider connection now handled via sidebar provider pages */}
        </header>
      </Show>

      <Show
        when={(available() && providers() && hasConnectedProviders()) || viewingHistory()}
        fallback={
          <Show when={available() && providers()}>
            <PlaygroundEmptyState
              onConnect={() => {
                /* Will be replaced with cards in follow-up */
              }}
            />
          </Show>
        }
      >
        <div class="playground__columns" aria-label="Model comparison columns">
          <For each={viewingHistory() ?? store().columns}>
            {(col) => (
              <PlaygroundColumn
                column={col}
                isCheapest={
                  col.metrics?.cost != null && col.metrics.cost === winners().cheapestCost
                }
                isFastest={
                  col.metrics?.durationMs != null &&
                  col.metrics.durationMs === winners().fastestDuration
                }
                isBest={col.columnDbId != null && col.columnDbId === effectiveBestId()}
                readOnly={!!viewingHistory() || !hasConnectedProviders()}
                onRemove={viewingHistory() ? () => {} : store().removeColumn}
                onChangeModel={viewingHistory() ? () => {} : setPickerForColumn}
                onRetry={handleRetry}
                onMarkBest={viewingHistory() ? undefined : () => handleMarkBest(col)}
              />
            )}
          </For>
          <Show when={!viewingHistory() && store().columns.length < MAX_COLUMNS}>
            <button
              type="button"
              class="playground__add"
              onClick={() => setShowAddPicker(true)}
              aria-label="Add model column"
              disabled={store().isAnyRunning()}
            >
              <span class="playground__add-plus">+</span>
              <span>Add model</span>
              <kbd class="playground__add-shortcut">
                <span>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}</span>
                <span class="playground__add-shortcut-plus">+</span>
                <span>K</span>
              </kbd>
            </button>
          </Show>
        </div>

        <PlaygroundSummaryTable
          columns={viewingHistory() ?? completedResults() ?? store().columns}
          bestColumnId={effectiveBestId()}
          onMarkBest={viewingHistory() ? undefined : handleMarkBest}
        />

        <Show
          when={hasConnectedProviders()}
          fallback={
            <div class="playground-prompt-wrapper">
              <div class="playground-prompt playground-prompt--info">
                <span class="playground-prompt__info-text">Connect a provider to get started</span>
              </div>
            </div>
          }
        >
          <PlaygroundPrompt
            ref={(el) => {
              promptRef = el;
            }}
            value={store().prompt()}
            onChange={store().setPrompt}
            onSubmit={handleSubmit}
            onRecallPrevious={store().recallPreviousPrompt}
            disabled={store().isAnyRunning() || store().columns.length === 0}
            running={store().isAnyRunning()}
            historyOpen={historyOpen()}
            onHeightChange={setPromptHeight}
            headersSlot={
              <div class="playground-prompt__headers-slot">
                <button
                  type="button"
                  class="playground-prompt__headers"
                  aria-label="Request headers"
                  aria-expanded={headersOpen()}
                  title="Custom request headers"
                  onClick={() => (headersOpen() ? setHeadersOpen(false) : openHeaders())}
                >
                  <CodeIcon size={16} />
                  <Show when={activeHeaderCount(headerEntries()) > 0}>
                    <span class="playground-prompt__headers-badge">
                      {activeHeaderCount(headerEntries())}
                    </span>
                  </Show>
                </button>
                <RequestHeadersPopover
                  open={headersOpen()}
                  entries={headerEntries()}
                  onChange={updateHeaders}
                  onClose={() => setHeadersOpen(false)}
                />
              </div>
            }
          />
        </Show>
      </Show>

      <div class="sr-only" role="status" aria-live="polite">
        {announcement()}
      </div>

      <Show when={pickerForColumn()}>
        {(columnId) => (
          <PlaygroundModelPicker
            columnId={columnId()}
            models={available() ?? []}
            customProviders={customProviders()}
            connectedProviders={providers()}
            onSelect={handlePickModel}
            onClose={() => setPickerForColumn(null)}
          />
        )}
      </Show>

      <Show when={showAddPicker()}>
        <PlaygroundModelPicker
          columnId="new"
          models={available() ?? []}
          customProviders={customProviders()}
          connectedProviders={providers()}
          onSelect={handleAddModel}
          onClose={() => setShowAddPicker(false)}
        />
      </Show>
    </div>
  );
};

export default Playground;
