import { createSignal } from 'solid-js';
import { invalidateCustomProvidersCache } from './api/routing.js';
import { DEFAULT_TTL_MS, invalidateGroup } from './api/cache.js';

// pingCount counts ANY event from the bus (legacy back-compat for callers that
// don't care which kind fired). New code should depend on the targeted
// signals so a routing-only change doesn't refetch the message log etc.
const [pingCount, setPingCount] = createSignal(0);
const [messagePing, setMessagePing] = createSignal(0);
const [analyticsPing, setAnalyticsPing] = createSignal(0);
const [agentPing, setAgentPing] = createSignal(0);
const [routingPing, setRoutingPing] = createSignal(0);

export { pingCount, messagePing, analyticsPing, agentPing, routingPing };

/** Refresh views derived from the harness list after a local mutation. */
export function refreshAgents(): void {
  invalidateGroup('agent');
  setAgentPing((n) => n + 1);
}

export function connectSse(): () => void {
  const es = new EventSource('/api/v1/events');

  const bumpPing = () => setPingCount((n) => n + 1);

  // Coalesce message-class bumps. A chatty agent emits one SSE `message` event
  // per ingested record. The recent-message feed refreshes every 500ms while
  // aggregate dashboard resources use the slower analytics bump below.
  let messageBumpTimer: ReturnType<typeof setTimeout> | null = null;
  let analyticsBumpTimer: ReturnType<typeof setTimeout> | null = null;
  const bumpMessagePing = () => {
    // Aggregate charts and 30-day summaries are much heavier than the recent
    // message feed. Match their server/client cache TTL so sustained ingest
    // cannot force every open dashboard to poll the analytics API every 5s.
    if (!analyticsBumpTimer) {
      analyticsBumpTimer = setTimeout(() => {
        analyticsBumpTimer = null;
        invalidateGroup('analytics');
        setAnalyticsPing((n) => n + 1);
      }, DEFAULT_TTL_MS);
    }
    if (messageBumpTimer) return;
    messageBumpTimer = setTimeout(() => {
      messageBumpTimer = null;
      // Invalidate the SWR cache BEFORE bumping the ping. The ping drives the
      // resource refetch; if stale message entries were still
      // cached, that refetch would read them and the dashboard wouldn't update
      // live. Dropping them first guarantees the refetch hits the network.
      invalidateGroup('message');
      setMessagePing((n) => n + 1);
    }, 500);
  };

  // Legacy generic 'ping' from older deployments — keep listening so a partial
  // upgrade (old backend, new frontend) still triggers refetches. The safe
  // default is to treat unknown 'ping' as a message-class change since that's
  // the kind the bus emitted before typed events landed.
  es.addEventListener('ping', () => {
    bumpMessagePing();
    bumpPing();
  });

  es.addEventListener('message', () => {
    bumpMessagePing();
    bumpPing();
  });
  es.addEventListener('agent', () => {
    // Drop agent-list/per-agent GET cache before the agentPing refetch reads it.
    refreshAgents();
    bumpPing();
  });
  es.addEventListener('routing', () => {
    // Custom providers are user-global; a routing change (incl. a custom-provider
    // create/update/delete on any agent) can change every agent's list, so drop
    // the cached lists before the routingPing-driven refetch reads them. Order
    // matters: invalidate the SWR cache (and the custom-providers cache) BEFORE
    // bumping routingPing so the refetch reads fresh routing/provider data.
    invalidateGroup('routing');
    invalidateCustomProvidersCache();
    setRoutingPing((n) => n + 1);
    bumpPing();
  });

  return () => {
    if (messageBumpTimer) clearTimeout(messageBumpTimer);
    if (analyticsBumpTimer) clearTimeout(analyticsBumpTimer);
    messageBumpTimer = null;
    analyticsBumpTimer = null;
    es.close();
  };
}
