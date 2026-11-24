import type { ModelRoute, AuthType } from 'manifest-shared';
import { isModelRoute, isModelRouteArray } from 'manifest-shared';
import type { TierAssignment } from '../../entities/tier-assignment.entity';
import type { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import type { HeaderTier } from '../../entities/header-tier.entity';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';

type AnyOverrideRow = Pick<
  TierAssignment | SpecificityAssignment | HeaderTier,
  'override_route' | 'fallback_routes'
>;

type AnyAutoRow = Pick<TierAssignment | SpecificityAssignment, 'auto_assigned_route'>;

export function readOverrideRoute(row: AnyOverrideRow): ModelRoute | null {
  return isModelRoute(row.override_route) ? row.override_route : null;
}

export function readAutoAssignedRoute(row: AnyAutoRow): ModelRoute | null {
  return isModelRoute(row.auto_assigned_route) ? row.auto_assigned_route : null;
}

export function readFallbackRoutes(row: AnyOverrideRow): ModelRoute[] | null {
  return isModelRouteArray(row.fallback_routes) ? row.fallback_routes : null;
}

/**
 * The route a row actually resolves to: the user override when present, else
 * the legacy auto-assigned route. Mirrors the read order of
 * ResolveService.buildResolvedRouteChain — upgraded installs whose tiers are
 * auto-assigned-only must count as routable, since the proxy routes them.
 */
export function effectiveRoute(row: AnyOverrideRow & AnyAutoRow): ModelRoute | null {
  return readOverrideRoute(row) ?? readAutoAssignedRoute(row);
}

/**
 * Build a ModelRoute from the explicit (provider, authType, model) triple,
 * with an optional keyLabel pin.
 *
 * Returns null when any required field is missing.
 */
export function explicitRoute(
  model: string,
  provider: string | undefined,
  authType: AuthType | undefined,
  keyLabel?: string | null,
): ModelRoute | null {
  if (!provider || !authType) return null;
  return keyLabel ? { provider, authType, model, keyLabel } : { provider, authType, model };
}

/**
 * Resolve a model name to a single ModelRoute via the discovered model list,
 * with an optional keyLabel pin.
 *
 * Returns null when the name doesn't match exactly one (provider, authType)
 * pair — ambiguous matches require the caller to pass an explicit route.
 */
export function unambiguousRoute(
  model: string,
  available: DiscoveredModel[],
  keyLabel?: string | null,
): ModelRoute | null {
  const matches = available.filter((m) => m.id === model);
  if (matches.length !== 1) return null;
  const m = matches[0];
  if (!m.authType) return null;
  return keyLabel
    ? { provider: m.provider, authType: m.authType, model: m.id, keyLabel }
    : { provider: m.provider, authType: m.authType, model: m.id };
}

/**
 * Resolve a bare model name carried by exactly two (provider, authType) route
 * classes of the SAME provider — one subscription, one api_key — to the
 * subscription route. A flat-fee subscription already covers the request, so
 * silently metering a key (or refusing outright) would charge the user for
 * traffic their subscription serves.
 *
 * Matches count route classes, not connections: discovery collapses multiple
 * api_key connections of one provider into a single api_key row, and the
 * subscription still wins over any number of metered keys — the same rationale
 * applies whether one key or several would otherwise be billed.
 *
 * Returns null for every other multi-match shape (single match, cross-provider
 * collision, three or more route classes, a `local` route involved) — those
 * stay ambiguous and keep M302, exactly as unambiguousRoute treated them.
 */
export function subscriptionPreferredRoute(
  model: string,
  available: DiscoveredModel[],
): ModelRoute | null {
  const matches = available.filter((m) => m.id === model && m.authType);
  if (matches.length !== 2) return null;
  const subscription = matches.find((m) => m.authType === 'subscription');
  const apiKey = matches.find((m) => m.authType === 'api_key');
  if (!subscription || !apiKey) return null;
  if (subscription.provider.toLowerCase() !== apiKey.provider.toLowerCase()) return null;
  return { provider: subscription.provider, authType: 'subscription', model: subscription.id };
}

/**
 * Strict equality on (provider, authType, model, keyLabel). Used for tier-card
 * dedup where the same model with two different keys must NOT collide.
 *
 * keyLabel is normalized: nullish/empty/whitespace all collapse to null, and
 * comparison is case-insensitive (matching the postgres unique index on
 * LOWER(label)).
 */
export function routeMatches(a: ModelRoute, b: ModelRoute): boolean {
  if (a.provider.toLowerCase() !== b.provider.toLowerCase()) return false;
  if (a.authType !== b.authType) return false;
  if (a.model !== b.model) return false;
  return normalizeKeyLabel(a.keyLabel) === normalizeKeyLabel(b.keyLabel);
}

function normalizeKeyLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}
