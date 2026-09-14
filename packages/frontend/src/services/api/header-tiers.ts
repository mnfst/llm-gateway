import { fetchJson, fetchMutate, routingPath } from './core.js';
import type { AuthType, ModelRoute, ResponseMode, OutputModality } from './routing.js';
import type { TierColor } from 'manifest-shared';

export interface HeaderTier {
  id: string;
  agent_id: string;
  name: string;
  header_key: string;
  header_value: string;
  badge_color: TierColor;
  sort_order: number;
  enabled: boolean;
  override_route: ModelRoute | null;
  fallback_routes: ModelRoute[] | null;
  output_modality?: OutputModality;
  response_mode?: ResponseMode;
  /** Per-tier stream warmup override (ms). null/absent => provider/global default. */
  stream_warmup_ms?: number | null;
  created_at: string;
  updated_at: string;
}

export interface SeenHeader {
  key: string;
  count: number;
  top_values: string[];
  sdks: string[];
}

export interface CreateHeaderTierInput {
  name: string;
  header_key: string;
  header_value: string;
  badge_color: TierColor;
}

export function listHeaderTiers(agentName: string) {
  return fetchJson<HeaderTier[]>(routingPath(agentName, 'header-tiers'));
}

export function getSeenHeaders(agentName: string, scope?: 'all' | 'agent') {
  const qs = scope === 'all' ? '?scope=all' : '';
  return fetchJson<SeenHeader[]>(routingPath(agentName, `seen-headers${qs}`));
}

export function createHeaderTier(agentName: string, input: CreateHeaderTierInput) {
  return fetchMutate<HeaderTier>(routingPath(agentName, 'header-tiers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateHeaderTier(
  agentName: string,
  id: string,
  patch: Partial<CreateHeaderTierInput>,
) {
  return fetchMutate<HeaderTier>(routingPath(agentName, `header-tiers/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function toggleHeaderTier(agentName: string, id: string, enabled: boolean) {
  return fetchMutate<HeaderTier>(
    routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/toggle`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
}

export function setHeaderTierResponseMode(
  agentName: string,
  id: string,
  responseMode: ResponseMode,
) {
  return fetchMutate<HeaderTier>(
    routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/response-mode`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_mode: responseMode }),
    },
  );
}

export function setHeaderTierStreamWarmup(
  agentName: string,
  id: string,
  streamWarmupMs: number | null,
) {
  return fetchMutate<HeaderTier>(
    routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/stream-warmup`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream_warmup_ms: streamWarmupMs }),
    },
  );
}

export function deleteHeaderTier(agentName: string, id: string) {
  return fetchMutate(routingPath(agentName, `header-tiers/${encodeURIComponent(id)}`), {
    method: 'DELETE',
  });
}

export function reorderHeaderTiers(agentName: string, ids: string[]) {
  return fetchMutate(routingPath(agentName, 'header-tiers/reorder'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export function overrideHeaderTier(
  agentName: string,
  id: string,
  model: string,
  provider: string,
  authType?: AuthType,
  providerKeyLabel?: string,
) {
  const body: Record<string, unknown> = { model, provider };
  if (authType) {
    body.authType = authType;
    body.route = providerKeyLabel
      ? { provider, authType, model, keyLabel: providerKeyLabel }
      : { provider, authType, model };
  }
  if (providerKeyLabel) body.providerKeyLabel = providerKeyLabel;
  return fetchMutate<HeaderTier>(
    routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/override`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function resetHeaderTier(agentName: string, id: string) {
  return fetchMutate(routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/override`), {
    method: 'DELETE',
  });
}

export function setHeaderTierFallbacks(
  agentName: string,
  id: string,
  models: string[],
  routes?: ModelRoute[],
) {
  const body: Record<string, unknown> = { models };
  if (routes && routes.length === models.length) body.routes = routes;
  return fetchMutate<string[]>(
    routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/fallbacks`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function clearHeaderTierFallbacks(agentName: string, id: string) {
  return fetchMutate(routingPath(agentName, `header-tiers/${encodeURIComponent(id)}/fallbacks`), {
    method: 'DELETE',
  });
}
