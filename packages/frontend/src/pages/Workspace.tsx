import { createResource, createSignal, createEffect, Show, For, type Component } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { Title, Meta } from '@solidjs/meta';
import ErrorState from '../components/ErrorState.jsx';
import ActionMenu from '../components/ActionMenu.jsx';
import AddAgentModal from '../components/AddAgentModal.jsx';
import DuplicateAgentModal from '../components/DuplicateAgentModal.jsx';
import { getAgents, deleteAgent } from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { formatCost, formatNumber, formatTime } from '../services/formatters.js';
import Sparkline from '../components/Sparkline.jsx';
import { agentPing, analyticsPing } from '../services/sse.js';
import { platformIcon } from 'manifest-shared';

interface Agent {
  agent_name: string;
  display_name?: string;
  agent_category?: string | null;
  agent_platform?: string | null;
  message_count: number;
  last_active: string;
  total_cost: number;
  total_tokens: number;
  sparkline: number[];
}

interface AgentsData {
  agents: Agent[];
}

const DuplicateIcon: Component = () => (
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
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const DeleteIcon: Component = () => (
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
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

type HarnessView = 'grid' | 'table';
const VIEW_STORAGE_KEY = 'manifest_harness_view';

function readStoredView(): HarnessView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    return 'grid';
  }
}

const Workspace: Component = () => {
  const [data, { refetch }] = createResource(
    () => ({ _agentPing: agentPing(), _analyticsPing: analyticsPing() }),
    () => getAgents() as Promise<AgentsData>,
  );
  const [modalOpen, setModalOpen] = createSignal(false);
  const [view, setView] = createSignal<HarnessView>(readStoredView());
  const switchView = (next: HarnessView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  };
  // Deep-link support: visiting /harnesses?add=true auto-opens the connect modal so
  // onboarding surfaces can route a user straight into creating an agent. We
  // clear the param so a refresh or back-navigation doesn't re-trigger it.
  const [searchParams, setSearchParams] = useSearchParams();
  // React to the deep-link on every navigation, not just initial mount: opening
  // /harnesses?add=true while Workspace is already mounted still opens the modal. We
  // clear the param (replace) so a refresh or back-nav doesn't re-trigger it.
  createEffect(() => {
    if (searchParams.add === 'true') {
      setModalOpen(true);
      setSearchParams({ add: undefined }, { replace: true });
    }
  });
  const [duplicateSource, setDuplicateSource] = createSignal<string | null>(null);
  // Shared by the grid card menu and the table row menu so both views stay in sync.
  const harnessActionItems = (agentName: string) => [
    {
      label: 'Duplicate',
      icon: <DuplicateIcon />,
      onClick: () => setDuplicateSource(agentName),
    },
    {
      label: 'Delete',
      danger: true,
      icon: <DeleteIcon />,
      onClick: () => {
        setDeleteTarget(agentName);
        setDeleteConfirmName('');
      },
    },
  ];
  const [deleteTarget, setDeleteTarget] = createSignal<string | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = createSignal('');
  const [deleting, setDeleting] = createSignal(false);

  const closeDeleteModal = () => {
    setDeleteTarget(null);
    setDeleteConfirmName('');
  };

  const handleDelete = async () => {
    const target = deleteTarget();
    if (!target || deleteConfirmName() !== target) return;
    setDeleting(true);
    try {
      await deleteAgent(target);
      toast.success(`Harness "${target}" deleted`);
      closeDeleteModal();
      await refetch();
    } catch {
      // error toast handled by fetchMutate
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="container--lg">
      <Title>My Harnesses - Manifest</Title>
      <Meta
        name="description"
        content="View and manage all your harnesses. Monitor usage, requests, and costs."
      />
      <div class="page-header">
        <div>
          <h1>My Harnesses</h1>
          <span class="breadcrumb">View and manage all your connected harnesses</span>
        </div>
        <div class="header-controls">
          <div class="panel__tabs" role="group" aria-label="Harness list layout">
            <button
              type="button"
              class="panel__tab"
              classList={{ 'panel__tab--active': view() === 'grid' }}
              aria-pressed={view() === 'grid'}
              aria-label="Grid view"
              title="Grid view"
              onClick={() => switchView('grid')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" />
              </svg>
            </button>
            <button
              type="button"
              class="panel__tab"
              classList={{ 'panel__tab--active': view() === 'table' }}
              aria-pressed={view() === 'table'}
              aria-label="Table view"
              title="Table view"
              onClick={() => switchView('table')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4 5h16v3H4zm0 5.5h16v3H4zM4 16h16v3H4z" />
              </svg>
            </button>
          </div>
          <button class="btn btn--primary btn--sm" onClick={() => setModalOpen(true)}>
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
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Connect Harness
          </button>
        </div>
      </div>

      <Show
        when={!data.loading}
        fallback={
          <Show
            when={view() === 'grid'}
            fallback={
              <div class="panel" style="padding: 0;">
                <table class="data-table" style="width: 100%;">
                  <thead>
                    <tr>
                      <th>Harness</th>
                      <th>Requests</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                      <th>Last active</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={[1, 2, 3, 4, 5]}>
                      {() => (
                        <tr>
                          <td>
                            <div class="skeleton skeleton--text" style="width: 40%;" />
                          </td>
                          <td>
                            <div class="skeleton skeleton--text" style="width: 60%;" />
                          </td>
                          <td>
                            <div class="skeleton skeleton--text" style="width: 60%;" />
                          </td>
                          <td>
                            <div class="skeleton skeleton--text" style="width: 50%;" />
                          </td>
                          <td>
                            <div class="skeleton skeleton--text" style="width: 70%;" />
                          </td>
                          <td class="workspace-table__actions">
                            <div
                              class="skeleton"
                              style="width: 20px; height: 20px; margin-left: auto;"
                            />
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            }
          >
            <div class="agents-grid">
              <For each={[1, 2, 3, 4, 5, 6]}>
                {() => (
                  <div class="agent-card agent-card--skeleton">
                    <div class="skeleton skeleton--text" style="width: 60%; height: 20px;" />
                    <div style="display: flex; gap: 16px; margin-top: 12px;">
                      <div class="skeleton skeleton--text" style="width: 30%; height: 14px;" />
                      <div class="skeleton skeleton--text" style="width: 30%; height: 14px;" />
                    </div>
                    <div
                      class="skeleton skeleton--rect"
                      style="width: 100%; height: 50px; margin-top: 12px;"
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        }
      >
        <Show when={!data.error} fallback={<ErrorState error={data.error} onRetry={refetch} />}>
          <Show
            when={data()?.agents?.length}
            fallback={
              <div class="empty-state">
                <div class="empty-state__title">No harnesses yet</div>
                <p>
                  Connect a harness or an AI app to take control of your routing and your costs.
                </p>
                <button
                  class="btn btn--primary btn--sm"
                  style="margin-top: var(--gap-md);"
                  onClick={() => setModalOpen(true)}
                >
                  Connect your first harness
                </button>
              </div>
            }
          >
            <Show
              when={view() === 'grid'}
              fallback={
                <div class="panel" style="padding: 0; overflow-x: auto;">
                  <table class="data-table" style="width: 100%;">
                    <thead>
                      <tr>
                        <th>Harness</th>
                        <th>Requests</th>
                        <th>Tokens</th>
                        <th>Cost</th>
                        <th>Last active</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data()!.agents}>
                        {(agent) => (
                          <tr>
                            <td>
                              <A
                                href={`/harnesses/${encodeURIComponent(agent.agent_name)}`}
                                class="workspace-table__name"
                              >
                                <Show
                                  when={platformIcon(agent.agent_platform, agent.agent_category)}
                                >
                                  <img
                                    src={platformIcon(agent.agent_platform, agent.agent_category)}
                                    alt=""
                                    width="16"
                                    height="16"
                                    class="platform-icon workspace-table__icon"
                                  />
                                </Show>
                                {agent.display_name ?? agent.agent_name}
                              </A>
                            </td>
                            <td>{formatNumber(agent.message_count)}</td>
                            <td>{formatNumber(agent.total_tokens)}</td>
                            <td>{formatCost(agent.total_cost) ?? '—'}</td>
                            <td>{agent.last_active ? formatTime(agent.last_active) : '—'}</td>
                            <td class="workspace-table__actions">
                              <ActionMenu
                                ariaLabel={`Actions for ${agent.agent_name}`}
                                items={harnessActionItems(agent.agent_name)}
                              />
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              }
            >
              <div class="agents-grid">
                <For each={data()!.agents}>
                  {(agent) => (
                    <div class="agent-card-wrap">
                      <A
                        href={`/harnesses/${encodeURIComponent(agent.agent_name)}`}
                        class="agent-card"
                      >
                        <div class="agent-card__top">
                          <Show when={platformIcon(agent.agent_platform, agent.agent_category)}>
                            <img
                              src={platformIcon(agent.agent_platform, agent.agent_category)}
                              alt=""
                              width="18"
                              height="18"
                              class="platform-icon agent-card__platform-icon"
                            />
                          </Show>
                          <span class="agent-card__name">
                            {agent.display_name ?? agent.agent_name}
                          </span>
                        </div>
                        <div class="agent-card__stats">
                          <div class="agent-card__stat">
                            <span class="agent-card__stat-label">Tokens</span>
                            <span class="agent-card__stat-value">
                              {formatNumber(agent.total_tokens)}
                            </span>
                          </div>
                          <div class="agent-card__stat">
                            <span class="agent-card__stat-label">Requests</span>
                            <span class="agent-card__stat-value">
                              {formatNumber(agent.message_count)}
                            </span>
                          </div>
                        </div>
                        <div class="agent-card__chart">
                          <Sparkline data={agent.sparkline} width={280} height={50} />
                        </div>
                      </A>
                      <ActionMenu
                        class="agent-card__menu"
                        ariaLabel={`Actions for ${agent.agent_name}`}
                        items={harnessActionItems(agent.agent_name)}
                      />
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>

      <AddAgentModal open={modalOpen()} onClose={() => setModalOpen(false)} />
      <DuplicateAgentModal
        open={duplicateSource() !== null}
        sourceName={duplicateSource() ?? ''}
        onClose={() => setDuplicateSource(null)}
        onDuplicated={() => refetch()}
      />

      <Show when={deleteTarget()}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDeleteModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeDeleteModal();
          }}
        >
          <div
            class="modal-card"
            style="max-width: 440px;"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="workspace-delete-title"
              style="margin: 0 0 var(--gap-md); font-size: var(--font-size-lg);"
            >
              Delete {deleteTarget()}
            </h3>
            <p style="font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); margin-bottom: var(--gap-md);">
              This will permanently delete the{' '}
              <strong style="color: hsl(var(--foreground));">{deleteTarget()}</strong> harness and
              all its data. This action cannot be undone.
            </p>
            <label
              for="workspace-delete-confirm"
              style="display: block; font-size: var(--font-size-sm); color: hsl(var(--foreground)); margin-bottom: var(--gap-sm);"
            >
              To confirm, type <strong>"{deleteTarget()}"</strong> below
            </label>
            <input
              id="workspace-delete-confirm"
              class="modal-card__input modal-card__input--lg"
              type="text"
              value={deleteConfirmName()}
              onInput={(e) => setDeleteConfirmName(e.currentTarget.value)}
              placeholder={deleteTarget() ?? ''}
              style="margin-bottom: var(--gap-lg);"
            />
            <div class="modal-card__footer">
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                onClick={closeDeleteModal}
                disabled={deleting()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn--danger btn--sm"
                onClick={handleDelete}
                disabled={deleteConfirmName() !== deleteTarget() || deleting()}
              >
                {deleting() ? <span class="spinner" /> : 'Delete harness'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Workspace;
