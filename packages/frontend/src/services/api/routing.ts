import type {
  AuthType,
  ModelCapability,
  ModelModality,
  ModelRoute,
  ResponseMode,
  OutputModality,
} from 'manifest-shared';
import { BASE_URL, fetchJson, fetchMutate, parseErrorMessage, routingPath } from './core.js';

export type { AuthType, ModelCapability, ModelModality, ModelRoute, ResponseMode, OutputModality };

export interface RoutingProvider {
  id: string;
  provider: string;
  auth_type: AuthType;
  is_active: boolean;
  has_api_key: boolean;
  key_prefix?: string | null;
  /**
   * User-facing key label. Defaults to "Default" for legacy single-key
   * providers; multi-key chains expose user-supplied names like "Personal"
   * or "Work" and are ordered by `priority` (0 = primary).
   */
  label: string;
  priority: number;
  region?: string | null;
  connected_at: string;
  models_fetched_at?: string | null;
  cached_model_count?: number;
}

/* -- Routing: Status -- */

export type RoutingStatusReason =
  'no_provider' | 'no_routable_models' | 'pricing_cache_empty' | null;

export interface RoutingStatus {
  enabled: boolean;
  reason: RoutingStatusReason;
}

export function getRoutingStatus(agentName: string) {
  return fetchJson<RoutingStatus>(routingPath(agentName, 'status'));
}

/* -- Routing: Providers -- */

export function getProviders(agentName: string) {
  return fetchJson<RoutingProvider[]>(routingPath(agentName, 'providers'));
}

export function connectProvider(
  agentName: string,
  data: {
    provider: string;
    apiKey?: string;
    authType?: AuthType;
    label?: string;
    region?: string;
    baseUrl?: string;
    base_url?: string;
  },
) {
  return fetchMutate<{
    id: string;
    provider: string;
    auth_type: AuthType;
    is_active: boolean;
    label: string;
    priority: number;
    region?: string | null;
  }>(routingPath(agentName, 'providers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function disconnectProvider(
  agentName: string,
  provider: string,
  authType?: AuthType,
  label?: string,
) {
  const base = routingPath(agentName, `providers/${encodeURIComponent(provider)}`);
  const params = new URLSearchParams();
  if (authType) params.set('authType', authType);
  if (label) params.set('label', label);
  const qs = params.toString();
  const path = qs ? `${base}?${qs}` : base;
  return fetchMutate<{ ok: boolean; notifications: string[] }>(path, { method: 'DELETE' });
}

export function renameProviderKey(
  agentName: string,
  provider: string,
  currentLabel: string,
  newLabel: string,
  authType?: AuthType,
) {
  return fetchMutate<{ id: string; label: string; priority: number }>(
    routingPath(
      agentName,
      `providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(currentLabel)}`,
    ),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newLabel, ...(authType && { authType }) }),
    },
  );
}

export function reorderProviderKeys(
  agentName: string,
  provider: string,
  labels: string[],
  authType?: AuthType,
) {
  return fetchMutate<Array<{ id: string; label: string; priority: number }>>(
    routingPath(agentName, `providers/${encodeURIComponent(provider)}/keys/order`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels, ...(authType && { authType }) }),
    },
  );
}

/* -- Routing: Copilot Device Login -- */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type CopilotPollStatus = 'pending' | 'complete' | 'expired' | 'denied' | 'slow_down';

export function copilotDeviceCode(agentName: string) {
  return fetchMutate<DeviceCodeResponse>(routingPath(agentName, 'copilot/device-code'), {
    method: 'POST',
  });
}

export async function copilotPollToken(agentName: string, deviceCode: string) {
  const res = await fetch(`/api/v1${routingPath(agentName, 'copilot/poll-token')}`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });
  if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
  return res.json() as Promise<{ status: CopilotPollStatus }>;
}

/* -- Routing: Complexity Toggle -- */

export interface ComplexityStatus {
  enabled: boolean;
}

export function getComplexityStatus(agentName: string) {
  return fetchJson<ComplexityStatus>(routingPath(agentName, 'complexity/status'));
}

export function toggleComplexity(agentName: string) {
  return fetchMutate<ComplexityStatus>(routingPath(agentName, 'complexity/toggle'), {
    method: 'POST',
  });
}

/* -- Routing: Autofix -- */

export interface AutofixConfig {
  enabled: boolean;
  /** True once the self-hosted install consented (modal hidden thereafter). */
  consented?: boolean;
}

export function getAutofix(agentName: string) {
  return fetchJson<AutofixConfig>(routingPath(agentName, 'autofix'));
}

export function updateAutofix(agentName: string, body: { enabled?: boolean }) {
  return fetchMutate<AutofixConfig>(routingPath(agentName, 'autofix'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* -- Routing: Message recording -- */

export interface RecordingConfig {
  enabled: boolean;
}

export function getRecording(agentName: string) {
  return fetchJson<RecordingConfig>(routingPath(agentName, 'recording'));
}

export function updateRecording(agentName: string, body: { enabled?: boolean }) {
  return fetchMutate<RecordingConfig>(routingPath(agentName, 'recording'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* -- Routing: Tier Assignments -- */

/**
 * Per-route outbound request body parameters merged into the provider
 * request before forwarding. Today's only knob is DeepSeek's `thinking`
 * toggle; new keys (`reasoning_effort`, `safety`, custom-provider params)
 * land here as their UI ships. Storage is per-(agent, route) on the
 * `agent_model_params` table — see `services/api/model-params.ts` for the
 * CRUD client.
 */
export type { RequestParamDefaults } from 'manifest-shared';

export interface TierAssignment {
  id: string;
  agent_id: string;
  tier: string;
  override_route: ModelRoute | null;
  auto_assigned_route: ModelRoute | null;
  fallback_routes: ModelRoute[] | null;
  output_modality?: OutputModality;
  response_mode?: ResponseMode;
  updated_at: string;
}

export function getTierAssignments(agentName: string) {
  return fetchJson<TierAssignment[]>(routingPath(agentName, 'tiers'));
}

export function overrideTier(
  agentName: string,
  tier: string,
  model: string,
  provider: string,
  authType?: AuthType,
  providerKeyLabel?: string,
) {
  // The backend requires the structured (provider, authType, model) tuple now
  // that legacy column persistence is gone. authType is optional only for
  // backwards-compatible callsites that haven't yet been updated; the request
  // will be rejected by the backend when authType is missing for an ambiguous
  // model name.
  const body: Record<string, unknown> = { model, provider };
  if (authType) {
    body.authType = authType;
    const route: ModelRoute = providerKeyLabel
      ? { provider, authType, model, keyLabel: providerKeyLabel }
      : { provider, authType, model };
    body.route = route;
  }
  if (providerKeyLabel) body.providerKeyLabel = providerKeyLabel;
  return fetchMutate<TierAssignment>(routingPath(agentName, `tiers/${encodeURIComponent(tier)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function resetTier(agentName: string, tier: string) {
  return fetchMutate(routingPath(agentName, `tiers/${encodeURIComponent(tier)}`), {
    method: 'DELETE',
  });
}

export function setTierResponseMode(agentName: string, tier: string, responseMode: ResponseMode) {
  return fetchMutate<TierAssignment>(
    routingPath(agentName, `tiers/${encodeURIComponent(tier)}/response-mode`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_mode: responseMode }),
    },
  );
}

export function resetAllTiers(agentName: string) {
  return fetchMutate(routingPath(agentName, 'tiers/reset-all'), { method: 'POST' });
}

/* -- Routing: Fallbacks -- */

export function getFallbacks(agentName: string, tier: string) {
  return fetchJson<ModelRoute[]>(
    routingPath(agentName, `tiers/${encodeURIComponent(tier)}/fallbacks`),
  );
}

export function setFallbacks(
  agentName: string,
  tier: string,
  models: string[],
  routes?: ModelRoute[],
) {
  const body: Record<string, unknown> = { models };
  if (routes && routes.length === models.length) body.routes = routes;
  return fetchMutate<ModelRoute[]>(
    routingPath(agentName, `tiers/${encodeURIComponent(tier)}/fallbacks`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function clearFallbacks(agentName: string, tier: string) {
  return fetchMutate(routingPath(agentName, `tiers/${encodeURIComponent(tier)}/fallbacks`), {
    method: 'DELETE',
  });
}

/* -- Routing: Available Models -- */

export interface AvailableModel {
  model_name: string;
  provider: string;
  auth_type?: AuthType;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  /** Per-request USD cost for per-request subscriptions (e.g. OpenCode Go). */
  cost_per_request?: number | null;
  context_window: number;
  capability_reasoning: boolean;
  capability_code: boolean;
  capabilities?: ModelCapability[];
  input_modalities?: ModelModality[];
  output_modalities?: ModelModality[];
  quality_score: number;
  display_name?: string | null;
  provider_display_name?: string | null;
}

export function getAvailableModels(agentName: string) {
  return fetchJson<AvailableModel[]>(routingPath(agentName, 'available-models'));
}

export function refreshModels(agentName: string) {
  return fetchMutate<{ ok: boolean }>(routingPath(agentName, 'refresh-models'), {
    method: 'POST',
  });
}

export interface ProviderRefreshResult {
  ok: boolean;
  model_count: number;
  last_fetched_at: string | null;
  error: string | null;
}

export function refreshProviderModels(agentName: string, provider: string, authType?: AuthType) {
  const base = routingPath(agentName, `providers/${encodeURIComponent(provider)}/refresh-models`);
  const path = authType ? `${base}?authType=${authType}` : base;
  return fetchMutate<ProviderRefreshResult>(path, { method: 'POST' });
}

/* -- Agent Enabled Providers -- */

export interface EnabledProviders {
  enabled: string[];
}

export interface AgentProviderDisableImpact {
  affected_tiers: Array<{ tier: string; model: string; position: string }>;
}

function enabledProvidersPath(agentName: string, suffix = ''): string {
  const encodedAgent = encodeURIComponent(agentName);
  return suffix
    ? `/agents/${encodedAgent}/enabled-providers${suffix.startsWith('/') ? suffix : `/${suffix}`}`
    : `/agents/${encodedAgent}/enabled-providers`;
}

export function getEnabledProviders(agentName: string) {
  return fetchJson<EnabledProviders>(enabledProvidersPath(agentName));
}

export function getAgentProviderDisableImpact(agentName: string, userProviderId: string) {
  return fetchJson<AgentProviderDisableImpact>(
    enabledProvidersPath(agentName, `${encodeURIComponent(userProviderId)}/impact`),
  );
}

export function enableProviderForAgent(agentName: string, userProviderId: string) {
  return fetchMutate<{ ok: boolean }>(
    enabledProvidersPath(agentName, encodeURIComponent(userProviderId)),
    { method: 'PUT' },
  );
}

export function disableProviderForAgent(agentName: string, userProviderId: string) {
  return fetchMutate<{ ok: boolean }>(
    enabledProvidersPath(agentName, encodeURIComponent(userProviderId)),
    { method: 'DELETE' },
  );
}

/* -- Routing: Pricing cache health -- */

export interface PricingHealth {
  model_count: number;
  last_fetched_at: string | null;
}

export function getPricingHealth() {
  return fetchJson<PricingHealth>('/routing/pricing-health');
}

export function refreshPricing() {
  return fetchMutate<{ ok: boolean; model_count: number; last_fetched_at: string | null }>(
    '/routing/pricing/refresh',
    { method: 'POST' },
  );
}

/* -- Routing: Custom Providers -- */

export type CustomProviderApiKind = 'openai' | 'anthropic';

export interface CustomProviderModel {
  model_name: string;
  input_price_per_million_tokens?: number;
  output_price_per_million_tokens?: number;
  context_window?: number;
  price_estimated?: boolean;
}

export interface CustomProviderData {
  id: string;
  name: string;
  /** Public prefix of the provider's model ids (`<alias>/<model>`); null = internal id. */
  alias: string | null;
  base_url: string;
  api_kind: CustomProviderApiKind;
  has_api_key: boolean;
  stream_warmup_ms?: number | null;
  models: CustomProviderModel[];
  created_at: string;
}

// Module-scoped cache so Overview / MessageLog / Routing don't each refetch
// the same custom-providers list when mounting in sequence. Custom providers
// are user-global, so a create/update/delete from one agent changes the list
// every agent sees — mutations below invalidate ALL entries, and the 'routing'
// SSE event (emitted by the backend on those mutations) does the same for other
// already-open clients.
const customProvidersCache = new Map<string, Promise<CustomProviderData[]>>();

export function invalidateCustomProvidersCache(agentName?: string): void {
  if (agentName === undefined) {
    customProvidersCache.clear();
    return;
  }
  customProvidersCache.delete(agentName);
}

export function getCustomProviders(agentName: string): Promise<CustomProviderData[]> {
  const cached = customProvidersCache.get(agentName);
  if (cached) return cached;
  // Opt out of the shared SWR cache (core.ts): this endpoint already has its own
  // module-scoped cache + invalidation (above), and double-caching would let a
  // stale SWR entry mask the invalidations this function manages.
  const promise = fetchJson<CustomProviderData[]>(
    routingPath(agentName, 'custom-providers'),
    undefined,
    { cache: false },
  ).catch((err) => {
    customProvidersCache.delete(agentName);
    throw err;
  });
  customProvidersCache.set(agentName, promise);
  return promise;
}

export function createCustomProvider(
  agentName: string,
  data: {
    name: string;
    alias?: string | null;
    base_url: string;
    api_kind?: CustomProviderApiKind;
    apiKey?: string;
    models: CustomProviderModel[];
  },
) {
  invalidateCustomProvidersCache();
  return fetchMutate<CustomProviderData>(routingPath(agentName, 'custom-providers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function updateCustomProvider(
  agentName: string,
  id: string,
  data: {
    name?: string;
    alias?: string | null;
    base_url?: string;
    api_kind?: CustomProviderApiKind;
    apiKey?: string;
    models?: CustomProviderModel[];
  },
) {
  invalidateCustomProvidersCache();
  return fetchMutate<CustomProviderData>(
    routingPath(agentName, `custom-providers/${encodeURIComponent(id)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
}

export async function probeCustomProvider(
  agentName: string,
  base_url: string,
  apiKey?: string,
  api_kind?: CustomProviderApiKind,
  provider_name?: string,
) {
  const res = await fetch(`${BASE_URL}${routingPath(agentName, 'custom-providers/probe')}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url, apiKey, api_kind, provider_name }),
  });
  if (!res.ok) {
    const message = await parseErrorMessage(res);
    throw new Error(message);
  }
  const text = await res.text();
  if (!text) return { models: [] } as { models: CustomProviderModel[] };
  return JSON.parse(text) as { models: CustomProviderModel[] };
}

export function deleteCustomProvider(agentName: string, id: string) {
  invalidateCustomProvidersCache();
  return fetchMutate<{ ok: boolean }>(
    routingPath(agentName, `custom-providers/${encodeURIComponent(id)}`),
    { method: 'DELETE' },
  );
}
