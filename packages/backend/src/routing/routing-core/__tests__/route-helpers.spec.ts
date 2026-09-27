import {
  effectiveRoute,
  explicitRoute,
  readAutoAssignedRoute,
  readFallbackRoutes,
  readOverrideRoute,
  routeMatches,
  subscriptionPreferredRoute,
  unambiguousRoute,
} from '../route-helpers';
import type { ModelRoute } from 'manifest-shared';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';

const route = (provider: string, authType: ModelRoute['authType'], model: string): ModelRoute => ({
  provider,
  authType,
  model,
});

const discovered = (
  id: string,
  provider: string,
  authType: ModelRoute['authType'],
): DiscoveredModel =>
  ({
    id,
    displayName: id,
    provider,
    contextWindow: 0,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
    authType,
  }) as DiscoveredModel;

describe('route-helpers', () => {
  describe('readOverrideRoute', () => {
    it('returns the structured route when present', () => {
      const r = route('openai', 'api_key', 'gpt-4o');
      expect(readOverrideRoute({ override_route: r, fallback_routes: null })).toEqual(r);
    });
    it('returns null when missing', () => {
      expect(readOverrideRoute({ override_route: null, fallback_routes: null })).toBeNull();
    });
    it('returns null on a malformed shape', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const malformed = { override_route: { foo: 'bar' } as any, fallback_routes: null };
      expect(readOverrideRoute(malformed)).toBeNull();
    });
  });

  describe('readAutoAssignedRoute', () => {
    it('returns the route when present', () => {
      const r = route('gemini', 'api_key', 'gemini-2.5-pro');
      expect(readAutoAssignedRoute({ auto_assigned_route: r })).toEqual(r);
    });
    it('returns null otherwise', () => {
      expect(readAutoAssignedRoute({ auto_assigned_route: null })).toBeNull();
    });
  });

  describe('readFallbackRoutes', () => {
    it('returns the route array when valid', () => {
      const arr = [route('openai', 'api_key', 'gpt-4o')];
      expect(readFallbackRoutes({ override_route: null, fallback_routes: arr })).toEqual(arr);
    });
    it('returns null when missing', () => {
      expect(readFallbackRoutes({ override_route: null, fallback_routes: null })).toBeNull();
    });
  });

  describe('effectiveRoute', () => {
    it('prefers override over auto', () => {
      const o = route('openai', 'api_key', 'gpt-4o');
      const a = route('gemini', 'api_key', 'gemini-2.5-pro');
      expect(
        effectiveRoute({ override_route: o, auto_assigned_route: a, fallback_routes: null }),
      ).toEqual(o);
    });
    it('falls back to the auto-assigned route when override is null', () => {
      const a = route('gemini', 'api_key', 'gemini-2.5-pro');
      expect(
        effectiveRoute({ override_route: null, auto_assigned_route: a, fallback_routes: null }),
      ).toEqual(a);
    });
    it('returns null when neither is set', () => {
      expect(
        effectiveRoute({ override_route: null, auto_assigned_route: null, fallback_routes: null }),
      ).toBeNull();
    });
  });

  describe('explicitRoute', () => {
    it('builds a route when all three fields are present', () => {
      expect(explicitRoute('gpt-4o', 'openai', 'api_key')).toEqual(
        route('openai', 'api_key', 'gpt-4o'),
      );
    });
    it('returns null when provider is missing', () => {
      expect(explicitRoute('gpt-4o', undefined, 'api_key')).toBeNull();
    });
    it('returns null when authType is missing', () => {
      expect(explicitRoute('gpt-4o', 'openai', undefined)).toBeNull();
    });
  });

  describe('unambiguousRoute', () => {
    it('returns the route when exactly one match', () => {
      const list = [discovered('gpt-4o', 'openai', 'api_key')];
      expect(unambiguousRoute('gpt-4o', list)).toEqual(route('openai', 'api_key', 'gpt-4o'));
    });
    it('returns null when zero matches', () => {
      expect(unambiguousRoute('missing', [])).toBeNull();
    });
    it('returns null when multiple matches (same name on two auths)', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
      ];
      expect(unambiguousRoute('gpt-4o', list)).toBeNull();
    });
    it('returns null when matched model has no authType', () => {
      const list = [discovered('gpt-4o', 'openai', undefined as never)];
      expect(unambiguousRoute('gpt-4o', list)).toBeNull();
    });
  });

  describe('subscriptionPreferredRoute', () => {
    it('resolves a same-provider subscription + api_key pair to the subscription', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toEqual(
        route('openai', 'subscription', 'gpt-4o'),
      );
    });
    it('matches provider case-insensitively', () => {
      const list = [
        discovered('gpt-4o', 'OpenAI', 'subscription'),
        discovered('gpt-4o', 'openai', 'api_key'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toEqual(
        route('OpenAI', 'subscription', 'gpt-4o'),
      );
    });
    it('returns null for a single match', () => {
      expect(
        subscriptionPreferredRoute('gpt-4o', [discovered('gpt-4o', 'openai', 'subscription')]),
      ).toBeNull();
    });
    it('returns null for three or more matches', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
        discovered('gpt-4o', 'openai', 'local'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toBeNull();
    });
    it('returns null when the pair is not subscription + api_key', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'subscription'),
        discovered('gpt-4o', 'openai', 'local'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toBeNull();
    });
    it('returns null for two matches of the same auth type', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'azure', 'api_key'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toBeNull();
    });
    it('returns null for a cross-provider collision', () => {
      const list = [
        discovered('gpt-4o', 'openai', 'subscription'),
        discovered('gpt-4o', 'azure', 'api_key'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toBeNull();
    });
    it('ignores matches without an authType', () => {
      const list = [
        discovered('gpt-4o', 'openai', undefined as never),
        discovered('gpt-4o', 'openai', 'subscription'),
      ];
      expect(subscriptionPreferredRoute('gpt-4o', list)).toBeNull();
    });
  });

  describe('routeMatches', () => {
    it('compares key labels case-insensitively after trimming', () => {
      const base = route('openai', 'api_key', 'gpt-4o');
      expect(routeMatches({ ...base, keyLabel: ' Work ' }, { ...base, keyLabel: 'work' })).toBe(
        true,
      );
      expect(routeMatches({ ...base, keyLabel: 'Work' }, { ...base, keyLabel: 'Home' })).toBe(
        false,
      );
    });
  });
});
