import { ApiClient } from '../client';
import { CliError } from '../errors';
import { resolveProviderId } from './provider';

interface DiscoveredModel {
  model: string;
  provider?: string;
  authType?: string;
}

/** The agent's discovered models (union of its ENABLED connections), with the
 * connection each came from so a route can be checked against its provider. */
async function discoveredModels(client: ApiClient, agent: string): Promise<DiscoveredModel[]> {
  const rows = (await client.request(
    'GET',
    `/routing/${encodeURIComponent(agent)}/available-models`,
  )) as unknown;
  return (Array.isArray(rows) ? rows : [])
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      model: typeof m['model_name'] === 'string' ? (m['model_name'] as string) : '',
      ...(typeof m['provider'] === 'string' ? { provider: m['provider'] as string } : {}),
      ...(typeof m['auth_type'] === 'string' ? { authType: m['auth_type'] as string } : {}),
    }))
    .filter((m) => m.model !== '');
}

/**
 * One gate for every command that writes a route: a model the agent cannot
 * see is a typo or a hollow connection, and catching it here beats finding
 * out on live traffic. Shared by `agent configure` and `routing custom
 * create` so the two can never drift.
 *
 * The first model is the route and is pinned to the requested provider. The
 * rest are fallbacks, stored provider-agnostic: each must be discoverable AND
 * resolvable to a single connection. A bare fallback name exposed by more than
 * one `(provider, auth_type)` would be rejected by the backend, so it is
 * rejected here BEFORE any write, leaving the primary route untouched.
 *
 * `force` skips the check — the backend still routes an uncatalogued model
 * through provider-qualified passthrough, so the CLI must not be the thing
 * that makes a brand-new model unusable.
 */
export async function assertModelsDiscovered(
  client: ApiClient,
  agent: string,
  models: readonly string[],
  force: boolean,
  provider?: string,
  authType?: string,
): Promise<string[]> {
  if (force || models.length === 0) return [...models];
  const rows = await discoveredModels(client, agent);

  let providerId: string | null = null;
  if (provider !== undefined) {
    try {
      providerId = resolveProviderId(provider);
    } catch {
      providerId = null; // custom provider or unknown input — name-only check
    }
  }
  const rowsCarryProvider = rows.some((r) => r.provider !== undefined);
  const rowsCarryAuthType = rows.some((r) => r.authType !== undefined);
  const enforceProvider = providerId !== null && rowsCarryProvider;
  const names = new Set(rows.map((r) => r.model));

  const withProvider = (model: string): DiscoveredModel[] =>
    rows.filter((r) => r.model === model && r.provider !== undefined);
  const identitiesFor = (model: string): Set<string> =>
    new Set(withProvider(model).map((r) => `${r.provider}|${r.authType ?? ''}`));
  const bareOf = (m: string): string => {
    const slash = m.indexOf('/');
    return slash > 0 ? m.slice(slash + 1) : m;
  };

  const missing: string[] = [];
  const ambiguous: string[] = [];
  const authTypeMismatch: Array<{ model: string; discovered: string[] }> = [];
  // The discovered spelling to write for each model (bare id normally, or the
  // provider-qualified form when that is what discovery actually exposes), so
  // the backend's exact-id fallback matching accepts it.
  const normalized: string[] = [...models];

  models.forEach((m, index) => {
    if (enforceProvider && providerId !== null && index === 0) {
      const pid = providerId;
      const qualified = m.startsWith(`${pid}/`) ? m.slice(pid.length + 1) : m;
      // The requested auth type must be the one that discovered the primary, or
      // the written (provider, authType, model) route is unroutable.
      const hit = rows.find(
        (r) =>
          r.provider === pid &&
          (r.model === m || r.model === qualified) &&
          (authType === undefined ||
            !rowsCarryAuthType ||
            (r.authType ?? 'api_key') === authType),
      );
      if (!hit) {
        // The model may exist under a different auth type; name that instead of
        // reporting it as undiscovered and pointing at --force.
        const discovered = [
          ...new Set(
            rows
              .filter((r) => r.provider === pid && (r.model === m || r.model === qualified))
              .map((r) => r.authType ?? 'api_key'),
          ),
        ];
        if (discovered.length > 0 && authType !== undefined && rowsCarryAuthType) {
          authTypeMismatch.push({ model: m, discovered });
        } else {
          missing.push(m);
        }
      } else {
        normalized[index] = hit.model;
      }
      return;
    }
    // Without provider identity there is nothing to disambiguate: name-only.
    if (!enforceProvider) {
      if (index === 0 && authType !== undefined && rowsCarryAuthType) {
        // A custom provider resolves no catalog id, but the requested auth type
        // must still match what discovered the primary. Scope to the requested
        // provider so a same-named model under another provider cannot raise a
        // false mismatch or supply the wrong --auth-type hint.
        const providerFilter = providerId ?? provider;
        const scoped = rows.filter(
          (r) =>
            (r.model === m || r.model === bareOf(m)) &&
            // Treat a row with no provider as matching: some discovery payloads
            // carry auth_type but omit provider, and excluding them would let
            // the mismatch through unchecked.
            (providerFilter === undefined ||
              r.provider === undefined ||
              r.provider === providerFilter),
        );
        const discovered = [...new Set(scoped.map((r) => r.authType ?? 'api_key'))];
        if (discovered.length > 0 && !discovered.includes(authType)) {
          authTypeMismatch.push({ model: m, discovered });
          return;
        }
      }
      if (!names.has(m)) missing.push(m);
      return;
    }
    if (names.has(m)) {
      if (identitiesFor(m).size > 1) ambiguous.push(m);
      return;
    }
    // Accept a provider-qualified fallback (`provider/model`) whose bare id is
    // discovered, as long as that provider resolves to one connection. Write
    // the BARE id back: the backend matches fallbacks by exact model id.
    const bare = bareOf(m);
    if (bare !== m && names.has(bare)) {
      const prefix = m.slice(0, m.indexOf('/'));
      const prefixRows = withProvider(bare).filter((r) => r.provider === prefix);
      if (prefixRows.length === 0) {
        missing.push(m);
        return;
      }
      const ids = new Set(prefixRows.map((r) => `${r.provider}|${r.authType ?? ''}`));
      if (ids.size > 1) ambiguous.push(m);
      else normalized[index] = bare;
      return;
    }
    missing.push(m);
  });

  if (authTypeMismatch.length > 0) {
    const [{ model, discovered }] = authTypeMismatch;
    throw new CliError(
      'auth_type_mismatch',
      `Model "${model}" is discovered under auth type ${discovered.join(', ')}, not "${authType}"`,
      `Pass --auth-type ${discovered[0]}`,
    );
  }
  if (ambiguous.length > 0) {
    throw new CliError(
      'ambiguous_model',
      `Ambiguous fallback for "${agent}" (several connections expose it): ${ambiguous.join(', ')}`,
      'Qualify the fallback with its provider (provider/model), or pass --force',
    );
  }
  if (missing.length > 0) {
    throw new CliError(
      'unknown_model',
      `Not in the models discovered for "${agent}"${
        enforceProvider ? ` under ${providerId}` : ''
      }: ${missing.join(', ')}`,
      `The catalog may be stale or empty — rediscover with mnfst provider refresh (and check mnfst models ${agent}); or pass --force to write the route anyway (the backend supports provider-qualified passthrough for uncatalogued models)`,
    );
  }
  return normalized;
}
