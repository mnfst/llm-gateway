import {
  createResource,
  createSignal,
  createMemo,
  createEffect,
  For,
  Show,
  onCleanup,
  type Component,
} from 'solid-js';
import '../styles/notifications-bell.css';
import { A } from '@solidjs/router';
import { getWorkspaceAutofixStatus } from '../services/api/analytics.js';
import { getAgents } from '../services/api.js';
import { agentPing, routingPing } from '../services/sse.js';

const READ_KEY = 'manifest_notif_read';

function getReadSet(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set();
}

function markRead(agentName: string) {
  const s = getReadSet();
  s.add(agentName);
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

interface AgentRow {
  agent_name: string;
  display_name: string;
}

const NotificationBell: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [readSet, setReadSet] = createSignal(getReadSet());
  let rootRef: HTMLDivElement | undefined;

  // Close on outside click
  if (typeof document !== 'undefined') {
    const handler = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    onCleanup(() => document.removeEventListener('mousedown', handler));
  }

  // Poll once a minute to catch autofix toggle changes (no SSE for this
  // mutation). The status only changes on a toggle, never on traffic, so it
  // must not key on messagePing: every gateway request fires that ping, and
  // refetching on each one made this bell the busiest dashboard endpoint in
  // production, competing with the Overview for the same database pool.
  const [tick, setTick] = createSignal(0);
  const interval = setInterval(() => setTick((n) => n + 1), 60_000);
  onCleanup(() => clearInterval(interval));

  const [status] = createResource(
    () => ({ _a: agentPing(), _r: routingPing(), _t: tick() }),
    async () => {
      try {
        return await getWorkspaceAutofixStatus();
      } catch {
        return null;
      }
    },
  );

  const [agentList] = createResource(
    () => ({ _a: agentPing() }),
    async () => {
      try {
        const data = (await getAgents()) as { agents?: AgentRow[] } | AgentRow[];
        return Array.isArray(data) ? data : (data?.agents ?? []);
      } catch {
        return [] as AgentRow[];
      }
    },
  );

  const disabledAgents = createMemo(() => {
    const s = status();
    const list = agentList() ?? [];
    if (!s) return [];
    const enabledSet = new Set(s.enabled_agents);
    return list
      .filter((a) => !enabledSet.has(a.agent_name))
      .map((a) => ({ name: a.agent_name, display: a.display_name || a.agent_name }));
  });

  // When an agent gets enabled, remove it from the read set so the
  // notification reappears fresh if it's later disabled again.
  createEffect(() => {
    const s = status();
    if (!s) return;
    const enabled = new Set(s.enabled_agents);
    const read = getReadSet();
    let changed = false;
    for (const name of read) {
      if (enabled.has(name)) {
        read.delete(name);
        changed = true;
      }
    }
    if (changed) {
      try {
        localStorage.setItem(READ_KEY, JSON.stringify([...read]));
      } catch {
        /* ignore */
      }
      setReadSet(new Set(read));
    }
  });

  const unreadCount = createMemo(
    () => disabledAgents().filter((a) => !readSet().has(a.name)).length,
  );

  const handleClick = (agentName: string) => {
    markRead(agentName);
    setReadSet(getReadSet());
    setOpen(false);
  };

  return (
    <Show when={disabledAgents().length > 0}>
      <div ref={rootRef} style="position: relative;">
        <button
          class="btn btn--outline btn--sm"
          style="position: relative; padding: 6px; display: flex; align-items: center;"
          onClick={() => setOpen(!open())}
          aria-label="Notifications"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M19 12.59V10c0-3.22-2.18-5.93-5.14-6.74C13.57 2.52 12.85 2 12 2s-1.56.52-1.86 1.26C7.18 4.08 5 6.79 5 10v2.59L3.29 14.3a1 1 0 0 0-.29.71v2c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-2c0-.27-.11-.52-.29-.71zM19 16H5v-.59l1.71-1.71a1 1 0 0 0 .29-.71v-3c0-2.76 2.24-5 5-5s5 2.24 5 5v3c0 .27.11.52.29.71L19 15.41zm-4.18 4H9.18c.41 1.17 1.51 2 2.82 2s2.41-.83 2.82-2" />
          </svg>
          <Show when={unreadCount() > 0}>
            <span style="position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: hsl(var(--destructive));" />
          </Show>
        </button>

        <Show when={open()}>
          <div class="notif-dropdown">
            <div class="notif-dropdown__header">Autofix notifications</div>
            <div class="notif-dropdown__list">
              <For each={disabledAgents()}>
                {(agent) => {
                  const isRead = () => readSet().has(agent.name);
                  return (
                    <A
                      href={`/harnesses/${encodeURIComponent(agent.name)}/settings?highlight=autofix`}
                      class="notif-dropdown__item"
                      classList={{ 'notif-dropdown__item--read': isRead() }}
                      onClick={() => handleClick(agent.name)}
                    >
                      <div class="notif-dropdown__dot-col">
                        <Show when={!isRead()}>
                          <span class="notif-dropdown__dot" />
                        </Show>
                      </div>
                      <span style="font-size: 14px;">
                        Autofix is inactive on <strong>{agent.display}</strong>. Enable it to get
                        the full dashboard experience.
                      </span>
                    </A>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default NotificationBell;
