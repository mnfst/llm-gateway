import { SHARED_PROVIDERS, type AuthType } from 'manifest-shared';
import { invalidateAll } from './cache.js';
import { BASE_URL, fetchJson, parseErrorMessage } from './core.js';

export interface TenantProviderConnection {
  id: string;
  label: string;
  key_prefix: string | null;
  priority: number;
  connected_at: string;
  models_fetched_at: string | null;
  cached_model_count: number;
  is_active: boolean;
}

/**
 * CONFIG half of the provider list. Served by `GET /api/v1/providers`, which is
 * cheap (reads `tenant_providers` only) and never touches `agent_messages`.
 * Usage stats live on {@link TenantProviderUsage} and are fetched separately so
 * a config read paints the page immediately.
 */
export interface TenantProviderConfig {
  provider: string;
  auth_type: AuthType;
  /** Backend-resolved name for `custom:<uuid>` groups; null for built-ins. */
  display_name?: string | null;
  connection_count: number;
  connections: TenantProviderConnection[];
  total_models: number;
}

/**
 * USAGE half, keyed by (provider, auth_type). Served by
 * `GET /api/v1/providers/usage` (the expensive aggregation), fetched
 * independently and merged into the config by {@link mergeUsage}.
 */
export interface TenantProviderUsage {
  provider: string;
  auth_type: AuthType;
  /** Folded key label (NULL reads 'Default'): the connection identity. */
  key_label: string;
  consumption_tokens: number;
  consumption_messages: number;
  consumption_cost: number;
  /** Every provider call over the last 30 days, at THIS row's grain. */
  attempts_30d: number;
  /** Attempts that returned success over the last 30 days. */
  succeeded_30d: number;
  last_used_at: string | null;
  sparkline_7d: number[];
}

/**
 * Config decorated with usage. This is the shape the provider pages render —
 * usage fields are zeroed until the usage fetch resolves (callers track the
 * loading state separately so they can shimmer rather than render a real 0).
 */
export type TenantProviderSummary = TenantProviderConfig & TenantProviderUsage;

export interface ProvidersResponse {
  providers: TenantProviderConfig[];
  model_counts: Record<string, number>;
}

export interface ProviderUsageResponse {
  providers: TenantProviderUsage[];
}

export interface ManagedFreeEnsureResponse {
  connected: boolean;
  connection_id: string | null;
  source: 'existing' | 'auto' | 'manual' | 'none';
  auto_available: boolean;
}

const managedFreeEnsureInflight = new Map<string, Promise<ManagedFreeEnsureResponse>>();

export async function ensureManagedFreeProvider(
  providerId: string,
  apiKey?: string,
): Promise<ManagedFreeEnsureResponse> {
  const existing = managedFreeEnsureInflight.get(providerId);
  if (!apiKey && existing) return existing;

  const run = (async () => {
    const response = await fetch(`${BASE_URL}/providers/${encodeURIComponent(providerId)}/ensure`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiKey ? { apiKey } : {}),
    });
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response));
    }
    const data = (await response.json()) as ManagedFreeEnsureResponse;
    if (data.source === 'auto' || data.source === 'manual') {
      invalidateAll();
    }
    return data;
  })();

  if (!apiKey) {
    const tracked = run.finally(() => {
      if (managedFreeEnsureInflight.get(providerId) === tracked) {
        managedFreeEnsureInflight.delete(providerId);
      }
    });
    managedFreeEnsureInflight.set(providerId, tracked);
    return tracked;
  }
  return run;
}

/**
 * Fetch provider CONFIG only (cheap; paints immediately).
 * Managed free-provider provisioning stays in the background so an unavailable
 * LiteLLM gateway never blocks provider configuration or routing screens.
 */
export function getProviders() {
  const providers = fetchJson<ProvidersResponse>('/providers');
  for (const provider of SHARED_PROVIDERS) {
    if (provider.managedFree) {
      void ensureManagedFreeProvider(provider.id).catch(() => undefined);
    }
  }
  return providers;
}

/** Fetch provider USAGE stats (the expensive 30d aggregation). */
export function getProviderUsage() {
  return fetchJson<ProviderUsageResponse>('/providers/usage');
}

const USAGE_ZERO: Omit<TenantProviderUsage, 'provider' | 'auth_type'> = {
  key_label: 'Default',
  consumption_tokens: 0,
  consumption_messages: 0,
  consumption_cost: 0,
  attempts_30d: 0,
  succeeded_30d: 0,
  last_used_at: null,
  sparkline_7d: [],
};

/** Key a (provider, auth_type) pair the same way the backend groups them. */
function usageKey(provider: string, authType: string): string {
  return `${provider}::${authType}`;
}

/**
 * Per-connection usage lookup: rows arrive at (provider, auth_type, label)
 * grain, labels folded case-insensitively with NULL reading 'Default'. Two
 * connections of the same provider and auth type never share numbers.
 */
export function connectionUsage(
  usageList: TenantProviderUsage[] | undefined,
  provider: string,
  authType: TenantProviderUsage['auth_type'],
  label: string | null | undefined,
): TenantProviderUsage | undefined {
  if (usageList === undefined) return undefined;
  const wanted = (label ?? 'Default').toLowerCase();
  return (
    usageList.find(
      (u) =>
        u.provider === provider &&
        u.auth_type === authType &&
        (u.key_label ?? 'Default').toLowerCase() === wanted,
    ) ?? {
      ...USAGE_ZERO,
      provider,
      auth_type: authType,
      key_label: label ?? 'Default',
    }
  );
}

/**
 * Merge a usage list into a config list, keyed by (provider, auth_type). Every
 * config row gets a usage block: its matching usage when present, else zeros.
 * A missing/undefined `usageList` (still loading) yields all-zero usage, so
 * callers can render config now and rely on their own loading flag to decide
 * whether to shimmer the usage cells instead of showing a misleading 0.
 */
export function mergeUsage(
  configList: TenantProviderConfig[],
  usageList: TenantProviderUsage[] | undefined,
): TenantProviderSummary[] {
  // Usage rows arrive per connection (label grain); a config group row sums
  // every label of its (provider, auth_type) pair.
  const byGroup = new Map<string, TenantProviderUsage[]>();
  for (const u of usageList ?? []) {
    const k = usageKey(u.provider, u.auth_type);
    const list = byGroup.get(k);
    if (list) list.push(u);
    else byGroup.set(k, [u]);
  }

  return configList.map((config) => {
    const rows = byGroup.get(usageKey(config.provider, config.auth_type)) ?? [];
    const sum = (pick: (u: TenantProviderUsage) => number) =>
      rows.reduce((total, u) => total + pick(u), 0);
    const lastUsed = rows
      .map((u) => u.last_used_at)
      .filter((v): v is string => v != null)
      .sort()
      .at(-1);
    const spark =
      rows.length === 0
        ? USAGE_ZERO.sparkline_7d
        : rows
            .map((u) => u.sparkline_7d)
            .reduce((acc, sp) => {
              const out = [...acc];
              sp.forEach((v, i) => {
                out[i] = (out[i] ?? 0) + v;
              });
              return out;
            }, [] as number[]);
    return {
      ...config,
      key_label: rows[0]?.key_label ?? 'Default',
      consumption_tokens: rows.length ? sum((u) => u.consumption_tokens) : 0,
      consumption_messages: rows.length ? sum((u) => u.consumption_messages) : 0,
      consumption_cost: rows.length ? sum((u) => u.consumption_cost) : 0,
      attempts_30d: rows.length ? sum((u) => u.attempts_30d) : 0,
      succeeded_30d: rows.length ? sum((u) => u.succeeded_30d) : 0,
      last_used_at: lastUsed ?? null,
      sparkline_7d: spark,
    };
  });
}
