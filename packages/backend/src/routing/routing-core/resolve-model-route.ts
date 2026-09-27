import type { AuthType, ModelRoute } from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';
import { openAiModelId } from './public-model-id';
import { routeMatches } from './route-helpers';

/** What the caller already knows about the route, besides the model name. */
export interface ModelRouteScope {
  provider?: string;
  authType?: AuthType;
  keyLabel?: string | null;
}

export type UnresolvedReason = 'not_found' | 'wrong_provider' | 'wrong_auth_type' | 'ambiguous';

export type ModelRouteResolution =
  { ok: true; route: ModelRoute } | { ok: false; reason: UnresolvedReason };

export type FallbackRoutesResolution =
  { ok: true; routes: ModelRoute[] } | { ok: false; model: string };

const HINT_LIMIT = 20;

/**
 * Whether `name` refers to this discovered model. Accepts every name Manifest
 * publishes for it: the internal id discovery stores, the public id from
 * `/v1/models` (`openrouter/…`, a custom provider's `<alias>/…` or
 * `custom:<uuid>/…`, `…-subscription`), and a custom model's bare name.
 */
export function matchesModelName(model: DiscoveredModel, name: string): boolean {
  if (model.id === name || openAiModelId(model) === name) return true;
  return model.provider.startsWith('custom:') && model.id === `${model.provider}/${name}`;
}

/**
 * Resolve a configured model name to one route on this agent's discovered
 * models. The stored route always carries the canonical provider and internal
 * model id, whichever name the caller used.
 *
 * An explicit `authType` must match the discovered one, so a subscription
 * model can never be stored as a metered `api_key` route (or the reverse).
 */
export function resolveModelRoute(
  name: string,
  available: readonly DiscoveredModel[],
  scope: ModelRouteScope = {},
): ModelRouteResolution {
  const named = available.filter((m) => m.authType && matchesModelName(m, name));
  if (named.length === 0) return { ok: false, reason: 'not_found' };

  const provider = scope.provider?.toLowerCase();
  const inProvider = provider ? named.filter((m) => m.provider.toLowerCase() === provider) : named;
  if (inProvider.length === 0) return { ok: false, reason: 'wrong_provider' };

  const candidates = scope.authType
    ? inProvider.filter((m) => m.authType === scope.authType)
    : inProvider;
  if (candidates.length === 0) return { ok: false, reason: 'wrong_auth_type' };

  const routeKey = (m: DiscoveredModel) =>
    [m.provider.toLowerCase(), m.authType, m.id].join('\u0000');
  if (new Set(candidates.map(routeKey)).size > 1) return { ok: false, reason: 'ambiguous' };

  const match = candidates[0];
  const route: ModelRoute = {
    provider: match.provider,
    authType: match.authType!,
    model: match.id,
  };
  return { ok: true, route: scope.keyLabel ? { ...route, keyLabel: scope.keyLabel } : route };
}

/**
 * Resolve a fallback chain. Caller-sent routes win when every one of them
 * resolves, so their key pins survive; otherwise each name is resolved alone.
 *
 * Entries carried over from the persisted chain are matched by identity and
 * trusted without re-checking discovery: they were validated when first added,
 * and re-validating them would make it impossible to shrink a list once a
 * provider disconnects (every remove is a PUT of the surviving entries).
 */
export function resolveFallbackRoutes(
  models: readonly string[],
  available: readonly DiscoveredModel[],
  routes?: readonly ModelRoute[],
  storedRoutes?: readonly ModelRoute[] | null,
): FallbackRoutesResolution {
  const aligned =
    routes !== undefined &&
    routes.length === models.length &&
    routes.every((r, i) => r.model === models[i]);
  const fromRoutes = aligned ? resolveGivenRoutes(routes, available, storedRoutes) : null;
  if (fromRoutes) return { ok: true, routes: fromRoutes };

  const pool = [...(storedRoutes ?? [])];
  const resolved: ModelRoute[] = [];
  for (const model of models) {
    const kept = pool.findIndex((s) => s.model === model);
    if (kept >= 0) {
      resolved.push(pool.splice(kept, 1)[0]);
      continue;
    }
    const resolution = resolveModelRoute(model, available);
    if (!resolution.ok) return { ok: false, model };
    resolved.push(resolution.route);
  }
  return { ok: true, routes: resolved };
}

/** Canonical copies of caller-sent routes, or null if any of them is invalid. */
function resolveGivenRoutes(
  routes: readonly ModelRoute[],
  available: readonly DiscoveredModel[],
  storedRoutes?: readonly ModelRoute[] | null,
): ModelRoute[] | null {
  const pool = [...(storedRoutes ?? [])];
  const resolved: ModelRoute[] = [];
  for (const route of routes) {
    const kept = pool.findIndex((s) => routeMatches(s, route));
    if (kept >= 0) {
      pool.splice(kept, 1);
      resolved.push(route);
      continue;
    }
    const resolution = resolveModelRoute(route.model, available, {
      provider: route.provider,
      authType: route.authType,
      keyLabel: route.keyLabel,
    });
    if (!resolution.ok) return null;
    resolved.push(resolution.route);
  }
  return resolved;
}

/** User-facing reason a fallback model could not be resolved. */
export function describeUnresolvedFallback(model: string): string {
  return (
    `Cannot resolve fallback model "${model}" to a single connected provider. ` +
    `Pass an explicit (provider, authType, model) route, or connect exactly one provider that offers this model.`
  );
}

/** User-facing reason a model name could not be resolved. */
export function describeUnresolvedModel(
  name: string,
  reason: UnresolvedReason,
  available: readonly DiscoveredModel[],
  scope: Pick<ModelRouteScope, 'provider' | 'authType'> = {},
): string {
  const { provider, authType } = scope;
  if (reason === 'ambiguous') {
    return (
      `Model "${name}" is offered by multiple providers — pass an explicit ` +
      `provider + authType so the route is unambiguous.`
    );
  }
  if (reason === 'wrong_provider') {
    return `Model "${name}" is not offered by provider "${provider}" for this agent.`;
  }
  if (reason === 'wrong_auth_type') {
    const by = provider ? ` by provider "${provider}"` : '';
    return `Model "${name}" is not offered with auth type "${authType}"${by} for this agent.`;
  }
  // Suggest the named provider's own models, under the names callers can send.
  const pool = provider
    ? available.filter((m) => m.provider.toLowerCase() === provider.toLowerCase())
    : available;
  const providerHint = provider ? ` (provider: ${provider})` : '';
  if (provider && pool.length === 0) {
    return (
      `Model "${name}" is not in this agent's discovered model list${providerHint}. ` +
      `This agent has no models from "${provider}": connect it or enable it for this agent first.`
    );
  }
  const options = [...new Set(pool.map(openAiModelId))];
  const shown = options.slice(0, HINT_LIMIT);
  return (
    `Model "${name}" is not in this agent's discovered model list${providerHint}. ` +
    `Connect the appropriate provider first, or choose from: ${shown.join(', ')}${
      options.length > shown.length ? ', …' : ''
    }`
  );
}
