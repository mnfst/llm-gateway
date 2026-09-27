import type { Repository } from 'typeorm';
import type { ModelRoute } from 'manifest-shared';
import { ResolveService } from '../resolve.service';
import { Agent } from '../../../entities/agent.entity';
import type { TierAssignment } from '../../../entities/tier-assignment.entity';
import type { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import type { HeaderTier } from '../../../entities/header-tier.entity';
import type { TierService } from '../../routing-core/tier.service';
import type { ProviderKeyService } from '../../routing-core/provider-key.service';
import type { RoutingCacheService } from '../../routing-core/routing-cache.service';
import type { SpecificityService } from '../../routing-core/specificity.service';
import type { SpecificityPenaltyService } from '../../routing-core/specificity-penalty.service';
import type { HeaderTierService } from '../../header-tiers/header-tier.service';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import type { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';

/**
 * Mock the scoring module so each test can drive scoreRequest / scanMessages
 * deterministically. Defaulting to a low confidence that fails the 0.4 gate
 * keeps "specificity falls through" the default unless a test opts in.
 */
jest.mock('../../../scoring', () => ({
  scoreRequest: jest.fn(),
  scanMessages: jest.fn(),
}));

jest.mock('../../../common/utils/provider-aliases', () => {
  const actual = jest.requireActual('../../../common/utils/provider-aliases');
  return { ...actual, inferProviderFromModelName: jest.fn(actual.inferProviderFromModelName) };
});

import { scoreRequest, scanMessages } from '../../../scoring';
import { inferProviderFromModelName } from '../../../common/utils/provider-aliases';

const mockedScore = scoreRequest as jest.MockedFunction<typeof scoreRequest>;
const mockedScan = scanMessages as jest.MockedFunction<typeof scanMessages>;
const mockedInferProvider = inferProviderFromModelName as jest.MockedFunction<
  typeof inferProviderFromModelName
>;

const route = (provider: string, authType: ModelRoute['authType'], model: string): ModelRoute => ({
  provider,
  authType,
  model,
});

describe('ResolveService', () => {
  let tierService: jest.Mocked<Pick<TierService, 'getTiers'>>;
  let providerKeyService: jest.Mocked<
    Pick<
      ProviderKeyService,
      | 'isModelAvailable'
      | 'isRouteAvailable'
      | 'hasActiveProvider'
      | 'getAuthType'
      | 'getDefaultKeyLabel'
      | 'hasRouteCredentials'
    >
  >;
  let specificityService: jest.Mocked<Pick<SpecificityService, 'getActiveAssignments'>>;
  let pricingCache: jest.Mocked<Pick<ModelPricingCacheService, 'getByModel'>>;
  let discoveryService: jest.Mocked<
    Pick<
      ModelDiscoveryService,
      'getModelForAgent' | 'getModelsForAgent' | 'invalidate' | 'invalidateTenant'
    >
  >;
  let penaltyService: jest.Mocked<Pick<SpecificityPenaltyService, 'getPenaltiesForAgent'>>;
  let headerTierService: jest.Mocked<Pick<HeaderTierService, 'list'>>;
  let agentRepo: { findOne: jest.Mock };
  let routingCache: {
    addInvalidationListener: jest.Mock;
    addTenantInvalidationListener: jest.Mock;
  };
  let svc: ResolveService;

  beforeEach(() => {
    jest.clearAllMocks();
    tierService = { getTiers: jest.fn().mockResolvedValue([]) };
    providerKeyService = {
      isModelAvailable: jest.fn().mockResolvedValue(true),
      isRouteAvailable: jest.fn().mockResolvedValue(true),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      // Default to undefined so resolved routes carry no `keyLabel` unless a
      // test explicitly sets one — keeps assertions on legacy route shapes
      // (no keyLabel) passing.
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
      hasRouteCredentials: jest.fn().mockResolvedValue(true),
    };
    specificityService = { getActiveAssignments: jest.fn().mockResolvedValue([]) };
    pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    discoveryService = {
      getModelForAgent: jest.fn().mockResolvedValue(null),
      getModelsForAgent: jest.fn().mockResolvedValue([]),
      invalidate: jest.fn(),
      invalidateTenant: jest.fn(),
    };
    penaltyService = { getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()) };
    headerTierService = { list: jest.fn().mockResolvedValue([]) };
    agentRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: true }),
    };
    routingCache = { addInvalidationListener: jest.fn(), addTenantInvalidationListener: jest.fn() };

    // Defaults — each test overrides as needed.
    mockedScore.mockReturnValue({
      tier: 'standard',
      confidence: 0.9,
      score: 5,
      reason: 'scored',
    } as unknown as ReturnType<typeof scoreRequest>);
    mockedScan.mockReturnValue(null);
    mockedInferProvider.mockReturnValue(undefined);

    svc = new ResolveService(
      tierService as unknown as TierService,
      providerKeyService as unknown as ProviderKeyService,
      specificityService as unknown as SpecificityService,
      pricingCache as unknown as ModelPricingCacheService,
      discoveryService as unknown as ModelDiscoveryService,
      penaltyService as unknown as SpecificityPenaltyService,
      headerTierService as unknown as HeaderTierService,
      agentRepo as unknown as Repository<Agent>,
      routingCache as unknown as RoutingCacheService,
    );
  });

  const messages = [{ role: 'user' as const, content: 'hello' }];

  describe('discovery cache invalidation bridge', () => {
    it('registers a routing-cache listener that invalidates the discovery cache', () => {
      expect(routingCache.addInvalidationListener).toHaveBeenCalledTimes(1);
      const listener = routingCache.addInvalidationListener.mock.calls[0][0] as (
        agentId: string,
      ) => void;

      listener('agent-42');

      expect(discoveryService.invalidate).toHaveBeenCalledWith('agent-42');
    });

    it('registers a tenant listener that drops the discovery cache tenant-wide', () => {
      expect(routingCache.addTenantInvalidationListener).toHaveBeenCalledTimes(1);
      const listener = routingCache.addTenantInvalidationListener.mock.calls[0][0] as (
        tenantId: string,
      ) => void;

      listener('tenant-42');

      expect(discoveryService.invalidateTenant).toHaveBeenCalledWith('tenant-42');
    });
  });

  describe('resolveLazy', () => {
    it('does not resolve scorer input when complexity routing is disabled', async () => {
      agentRepo.findOne.mockResolvedValue({
        id: 'agent-1',
        complexity_routing_enabled: false,
      });
      const resolveInput = jest.fn().mockResolvedValue({ messages });

      const result = await svc.resolveLazy('agent-1', 'user-1', resolveInput);

      expect(result.reason).toBe('default');
      expect(resolveInput).not.toHaveBeenCalled();
    });

    it('resolves scorer input once when scoring runs', async () => {
      const resolveInput = jest.fn().mockResolvedValue({ messages });

      await svc.resolveLazy('agent-1', 'user-1', resolveInput);

      expect(resolveInput).toHaveBeenCalledTimes(1);
      expect(mockedScore).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolve — header tier match', () => {
    it('returns the header-tier route when the rule matches', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          'x-tier': 'gold',
        },
      );

      expect(result.reason).toBe('header-match');
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(result.header_tier_id).toBe('h1');
      expect(result.header_tier_name).toBe('Premium');
      expect(result.header_tier_color).toBe('red');
    });

    it('returns null when no header tiers exist', async () => {
      headerTierService.list.mockResolvedValue([]);
      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      // Falls through to scored tier — reason should be 'scored', not 'header-match'.
      expect(result.reason).not.toBe('header-match');
    });

    it('falls through when the matched tier has no override route', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: null,
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).not.toBe('header-match');
    });

    it('falls through when the override model is not available', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).not.toBe('header-match');
    });

    it('validates the override with the route-aware check, not the name-only one', async () => {
      // Regression: a pinned override whose model id exists on two connections
      // (openai api_key + subscription) must stay available — the name-only
      // isModelAvailable lookup reports ambiguous ids as unavailable (#2210).
      const pinned = route('openai', 'subscription', 'gpt-5.5');
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: pinned,
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      providerKeyService.isRouteAvailable.mockResolvedValue(true);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).toBe('header-match');
      expect(result.route).toEqual(pinned);
      expect(providerKeyService.isRouteAvailable).toHaveBeenCalledWith('user-1', pinned, 'agent-1');
    });

    it('promotes the first available fallback when the override is unavailable', async () => {
      const primary = route('openai', 'subscription', 'gpt-5.5');
      const deadFallback = route('gemini', 'api_key', 'gemini-pro-latest');
      const liveFallback = route('minimax', 'subscription', 'MiniMax-M3');
      const lastFallback = route('xai', 'subscription', 'grok-4.3');
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: primary,
        fallback_routes: [deadFallback, liveFallback, lastFallback],
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);
      providerKeyService.isRouteAvailable.mockImplementation(
        async (_tenantId: string, r: ModelRoute) => r === liveFallback || r === lastFallback,
      );

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).toBe('header-match');
      expect(result.route).toEqual(liveFallback);
      expect(result.fallback_routes).toEqual([lastFallback]);
    });

    it('matches when the header value is provided as an array', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': ['silver', 'gold'] },
      );
      expect(result.reason).toBe('header-match');
    });

    it('skips disabled header tiers', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: false,
        badge_color: 'red',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).not.toBe('header-match');
    });

    it('returns null route when no provider can be resolved for the override model', async () => {
      const tier = {
        id: 'h1',
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'gold',
        enabled: true,
        badge_color: 'red',
        // Empty provider triggers the resolveProviderForModel fallback chain.
        // authType '' is also falsy, so getAuthType is consulted.
        override_route: {
          provider: '',
          authType: '',
          model: 'mystery-model',
        } as unknown as ModelRoute,
        fallback_routes: null,
      } as unknown as HeaderTier;
      headerTierService.list.mockResolvedValue([tier]);

      // None of the resolveProviderForModel paths produce a hit.
      mockedInferProvider.mockReturnValue(undefined);
      discoveryService.getModelForAgent.mockResolvedValue(undefined);
      pricingCache.getByModel.mockReturnValue(undefined);
      // No provider resolved → route is null even though authType defaults exist.
      providerKeyService.getAuthType.mockResolvedValue('api_key');

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).toBe('header-match');
      expect(result.route).toBeNull();
    });
  });

  describe('resolveProviderForModel paths (via header tier with bare model)', () => {
    // Provider field is empty (falsy) so resolveProviderForModel runs via the
    // `||` short-circuit. authType is a real value so the route can be built
    // when a provider is found.
    const bareTier = {
      id: 'h1',
      name: 'P',
      header_key: 'x-tier',
      header_value: 'gold',
      enabled: true,
      badge_color: 'red',
      override_route: {
        model: 'gpt-4o',
        provider: '',
        authType: 'api_key',
      } as unknown as ModelRoute,
      fallback_routes: null,
    } as unknown as HeaderTier;

    it('uses prefix inference when an active provider matches', async () => {
      headerTierService.list.mockResolvedValue([bareTier]);
      mockedInferProvider.mockReturnValue('openai');
      providerKeyService.hasActiveProvider.mockResolvedValue(true);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.reason).toBe('header-match');
      expect(result.route?.provider).toBe('openai');
    });

    it('uses discovery when prefix inference is null', async () => {
      headerTierService.list.mockResolvedValue([bareTier]);
      mockedInferProvider.mockReturnValue(undefined);
      discoveryService.getModelForAgent.mockResolvedValue({
        id: 'gpt-4o',
        provider: 'openai',
        authType: 'api_key',
      } as never);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.route?.provider).toBe('openai');
    });

    it('uses pricing cache when discovery has no entry', async () => {
      headerTierService.list.mockResolvedValue([bareTier]);
      mockedInferProvider.mockReturnValue(undefined);
      discoveryService.getModelForAgent.mockResolvedValue(undefined);
      pricingCache.getByModel.mockReturnValue({
        provider: 'OpenAI',
        model_name: 'gpt-4o',
        display_name: null,
        input_price_per_token: 0,
        output_price_per_token: 0,
      } as never);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.route?.provider).toBe('OpenAI');
    });

    it('skips OpenRouter aggregator entries', async () => {
      headerTierService.list.mockResolvedValue([bareTier]);
      mockedInferProvider.mockReturnValue(undefined);
      discoveryService.getModelForAgent.mockResolvedValue(undefined);
      pricingCache.getByModel.mockReturnValue({
        provider: 'OpenRouter',
        model_name: 'gpt-4o',
        display_name: null,
        input_price_per_token: 0,
        output_price_per_token: 0,
      } as never);
      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { 'x-tier': 'gold' },
      );
      expect(result.route).toBeNull();
    });
  });

  describe('resolve — complexity routing disabled', () => {
    it('returns the default tier route', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: route('openai', 'api_key', 'gpt-4o-mini'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.tier).toBe('default');
      expect(result.reason).toBe('default');
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o-mini'));
    });

    // #2494: a legacy auto_assigned_route pointing at a provider the agent no
    // longer has connected must not resolve. The proxy would otherwise emit an
    // M100 naming that unconfigured provider; a null route yields the neutral
    // "no providers configured" (M101) instead.
    it('drops an unavailable auto_assigned_route so no route is returned', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: route('opencode-go', 'api_key', 'glm-5.2'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      providerKeyService.hasRouteCredentials.mockResolvedValue(false);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.tier).toBe('default');
      expect(result.route).toBeNull();
      expect(result.fallback_routes).toBeNull();
      expect(providerKeyService.isRouteAvailable).not.toHaveBeenCalled();
    });

    // A pinned override whose model the connection no longer offers must name
    // itself so the proxy can return M302, not the neutral "no providers
    // configured" M101. The flag only applies while the connection still exists.
    it('flags the unavailable override model when its connection exists', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      const override = route('openai', 'subscription', 'gpt-6-astra');
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: override,
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenant, r: ModelRoute) => r === override,
      );

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toBeNull();
      expect(result.override_model_unavailable).toBe('gpt-6-astra');
    });

    it('keeps the neutral no-provider signal when the override connection is gone', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: route('openai', 'subscription', 'gpt-6-astra'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      providerKeyService.hasRouteCredentials.mockResolvedValue(false);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toBeNull();
      expect(result.override_model_unavailable).toBeUndefined();
    });

    // A configured fallback provider stays eligible when the auto-assigned
    // route's provider is not connected.
    it('promotes an available fallback when the auto_assigned_route is unavailable', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: route('opencode-go', 'api_key', 'glm-5.2'),
          fallback_routes: [route('anthropic', 'subscription', 'claude-opus-4-8')],
        } as unknown as TierAssignment,
      ]);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenant, r: ModelRoute) => r.provider !== 'opencode-go',
      );

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toEqual(route('anthropic', 'subscription', 'claude-opus-4-8'));
      expect(result.fallback_routes).toBeNull();
    });

    it('keeps an available auto route without a model-discovery availability check', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o-mini'),
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);

      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o-mini'));
      expect(providerKeyService.hasRouteCredentials).toHaveBeenCalledTimes(1);
      expect(providerKeyService.isRouteAvailable).not.toHaveBeenCalled();
    });

    // No override and no auto-assigned route: an available configured fallback
    // is still promoted to primary.
    it('promotes an available fallback when there is no override or auto route', async () => {
      agentRepo.findOne.mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: false });
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: null,
          fallback_routes: [route('openai', 'api_key', 'gpt-4o-mini')],
        } as unknown as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o-mini'));
      expect(result.fallback_routes).toBeNull();
    });
  });

  describe('resolve — specificity routing', () => {
    it('returns the specificity override when above the confidence gate', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: route('openai', 'api_key', 'gpt-4o'),
          auto_assigned_route: null,
          fallback_routes: [route('anthropic', 'api_key', 'claude')],
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('specificity');
      expect(result.specificity_category).toBe('coding');
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(result.fallback_routes).toEqual([route('anthropic', 'api_key', 'claude')]);
    });

    it('falls through when the override model is unavailable', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: route('openai', 'api_key', 'orphaned'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
    });

    it('ignores auto_assigned_route when there is no override', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).not.toBe('specificity');
      expect(result.route).toBeNull();
    });

    it('returns null when neither override nor auto are set', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: null,
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      // Specificity returned null — falls through to scored.
      expect(result.reason).toBe('scored');
    });

    it('skips specificity when no assignments are active', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([]);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
      expect(mockedScan).not.toHaveBeenCalled();
    });

    it('skips specificity when scan returns null', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        { category: 'coding', is_active: true } as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue(null);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
    });

    it('falls through when confidence is below the gate (no header override)', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: route('openai', 'api_key', 'gpt-4o'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.3 } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'fallback'),
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
    });

    it('honors a header override even when confidence is below the gate', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        {
          category: 'coding',
          is_active: true,
          override_route: route('openai', 'api_key', 'gpt-4o'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.1 } as never);

      const result = await svc.resolve(
        'agent-1',
        'user-1',
        messages,
        undefined,
        undefined,
        undefined,
        undefined,
        'coding',
      );
      expect(result.reason).toBe('specificity');
    });

    it('passes penalty map into scanMessages when penalties exist', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        { category: 'coding', is_active: true } as SpecificityAssignment,
      ]);
      const penalties = new Map<'coding', number>([['coding', 1]]);
      penaltyService.getPenaltiesForAgent.mockResolvedValue(penalties as never);
      mockedScan.mockReturnValue(null);

      await svc.resolve('agent-1', 'user-1', messages);
      expect(mockedScan).toHaveBeenCalled();
      const call = mockedScan.mock.calls[0];
      expect(call[4]).toBe(penalties);
    });

    it('returns null when the matched category has no active assignment', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([
        { category: 'web_browsing', is_active: true } as SpecificityAssignment,
      ]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
    });
  });

  describe('resolve — scored complexity tiers', () => {
    it('returns the matched tier route', async () => {
      mockedScore.mockReturnValue({
        tier: 'complex',
        confidence: 0.8,
        score: 12,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'complex',
          override_route: route('anthropic', 'api_key', 'claude-opus'),
          auto_assigned_route: null,
          fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
        } as unknown as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.tier).toBe('complex');
      expect(result.route).toEqual(route('anthropic', 'api_key', 'claude-opus'));
      expect(result.fallback_routes).toEqual([route('openai', 'api_key', 'gpt-4o')]);
    });

    it('flags the unavailable override model on the scored tier path', async () => {
      mockedScore.mockReturnValue({
        tier: 'standard',
        confidence: 0.7,
        score: 5,
        reason: 'scored',
      } as never);
      const override = route('openai', 'subscription', 'gpt-6-astra');
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: override,
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenant, r: ModelRoute) => r === override,
      );

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toBeNull();
      expect(result.override_model_unavailable).toBe('gpt-6-astra');
    });

    it('keeps the neutral no-provider signal on the scored tier path', async () => {
      mockedScore.mockReturnValue({
        tier: 'standard',
        confidence: 0.7,
        score: 5,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.hasRouteCredentials.mockResolvedValue(false);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toBeNull();
      expect(result.override_model_unavailable).toBeUndefined();
    });

    it('falls back to the default tier when the scored tier is missing', async () => {
      mockedScore.mockReturnValue({
        tier: 'reasoning',
        confidence: 0.95,
        score: 30,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'default-model'),
          fallback_routes: null,
        } as TierAssignment,
      ]);

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.tier).toBe('default');
      expect(result.reason).toBe('default');
    });

    it('uses the first fallback when the override is orphaned and auto is null', async () => {
      mockedScore.mockReturnValue({
        tier: 'standard',
        confidence: 0.7,
        score: 5,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: route('openai', 'api_key', 'orphaned'),
          auto_assigned_route: null,
          fallback_routes: [route('anthropic', 'api_key', 'fallback-1')],
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      // Only the orphaned override is unavailable; the fallback is connected.
      providerKeyService.isRouteAvailable.mockImplementation(
        async (_tenant, r: ModelRoute) => r.model !== 'orphaned',
      );

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.tier).toBe('standard');
      expect(result.route).toEqual(route('anthropic', 'api_key', 'fallback-1'));
      expect(result.fallback_routes).toBeNull();
    });

    it('tries fallbacks before auto when the override is orphaned but auto is set', async () => {
      mockedScore.mockReturnValue({
        tier: 'standard',
        confidence: 0.7,
        score: 5,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: route('openai', 'api_key', 'orphaned'),
          auto_assigned_route: route('openai', 'api_key', 'auto'),
          fallback_routes: [
            route('anthropic', 'api_key', 'fallback-1'),
            route('google', 'api_key', 'fallback-2'),
          ],
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      // Only the orphaned override is unavailable; the fallbacks are connected.
      providerKeyService.isRouteAvailable.mockImplementation(
        async (_tenant, r: ModelRoute) => r.model !== 'orphaned',
      );

      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.route).toEqual(route('anthropic', 'api_key', 'fallback-1'));
      expect(result.fallback_routes).toEqual([
        route('google', 'api_key', 'fallback-2'),
        route('openai', 'api_key', 'auto'),
      ]);
    });

    it('passes momentum input when recentTiers is non-empty', async () => {
      mockedScore.mockReturnValue({
        tier: 'standard',
        confidence: 0.7,
        score: 5,
        reason: 'scored',
      } as never);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      await svc.resolve('agent-1', 'user-1', messages, undefined, undefined, undefined, ['simple']);
      const [, , momentum] = mockedScore.mock.calls[0];
      expect(momentum).toEqual({ recentTiers: ['simple'] });
    });

    it('passes undefined momentum when recentTiers is empty', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      await svc.resolve('agent-1', 'user-1', messages, undefined, undefined, undefined, []);
      const [, , momentum] = mockedScore.mock.calls[0];
      expect(momentum).toBeUndefined();
    });
  });

  describe('resolveForTier', () => {
    it('returns null route when tier assignment is missing', async () => {
      tierService.getTiers.mockResolvedValue([]);
      const result = await svc.resolveForTier('agent-1', 'user-1', 'simple', 'heartbeat');
      expect(result.tier).toBe('simple');
      expect(result.route).toBeNull();
      expect(result.fallback_routes).toBeNull();
      expect(result.confidence).toBe(1);
      expect(result.reason).toBe('heartbeat');
    });

    it('keeps the neutral signal for heartbeats even with an unavailable override', async () => {
      const override = route('openai', 'subscription', 'gpt-6-astra');
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_route: override,
          auto_assigned_route: null,
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenant, r: ModelRoute) => r === override,
      );

      const result = await svc.resolveForTier('agent-1', 'user-1', 'simple', 'heartbeat');
      expect(result.route).toBeNull();
      expect(result.override_model_unavailable).toBeUndefined();
    });

    it('returns the override route when present', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_route: route('openai', 'api_key', 'gpt-4o-mini'),
          auto_assigned_route: null,
          fallback_routes: [route('anthropic', 'api_key', 'haiku')],
        } as unknown as TierAssignment,
      ]);
      const result = await svc.resolveForTier('agent-1', 'user-1', 'simple');
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o-mini'));
      expect(result.fallback_routes).toEqual([route('anthropic', 'api_key', 'haiku')]);
      expect(result.reason).toBe('heartbeat');
    });

    it('uses the first stream-capable fallback as the effective route in stream mode', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_route: route('openai', 'api_key', 'gpt-image-1'),
          auto_assigned_route: null,
          fallback_routes: [
            route('openai', 'api_key', 'gpt-4o'),
            route('anthropic', 'api_key', 'claude-3-5-sonnet'),
          ],
          response_mode: 'stream',
        } as TierAssignment,
      ]);

      const result = await svc.resolveForTier('agent-1', 'user-1', 'simple');

      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(result.fallback_routes).toEqual([route('anthropic', 'api_key', 'claude-3-5-sonnet')]);
    });

    it('filters non-stream fallbacks from the effective route chain in stream mode', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'simple',
          override_route: route('openai', 'api_key', 'gpt-4o'),
          auto_assigned_route: null,
          fallback_routes: [route('openai', 'api_key', 'gpt-image-1')],
          response_mode: 'stream',
        } as TierAssignment,
      ]);

      const result = await svc.resolveForTier('agent-1', 'user-1', 'simple');

      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(result.fallback_routes).toBeNull();
    });

    it('uses the default reason when the caller passes "default"', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'default',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o-mini'),
          fallback_routes: null,
        } as TierAssignment,
      ]);
      const result = await svc.resolveForTier('agent-1', 'user-1', 'default', 'default');
      expect(result.reason).toBe('default');
    });
  });

  /**
   * Shared with the proxy's explicit-model path: a request that names a
   * concrete model skips tier resolution, so this is the only place its route
   * can pick up the connection the operator pinned.
   */
  describe('pinRouteKeyLabel', () => {
    const defaultTier = (override: ModelRoute | null): TierAssignment =>
      ({
        tier: 'default',
        override_route: override,
        auto_assigned_route: null,
        fallback_routes: null,
      }) as TierAssignment;

    it('keeps a label the route already pins', async () => {
      const pinned = { ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Explicit' };

      const result = await svc.pinRouteKeyLabel('agent-1', 'tenant-1', pinned);

      expect(result).toBe(pinned);
      expect(tierService.getTiers).not.toHaveBeenCalled();
    });

    it('adopts the default tier pin when provider and auth match', async () => {
      tierService.getTiers.mockResolvedValue([
        defaultTier({ ...route('OpenAI', 'api_key', 'gpt-4o-mini'), keyLabel: 'Work' }),
      ]);

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      // Model differs on purpose: the pin follows the connection, not the model.
      expect(result).toEqual({ ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Work' });
      expect(providerKeyService.getDefaultKeyLabel).not.toHaveBeenCalled();
    });

    it('ignores a default tier pin for a different provider', async () => {
      tierService.getTiers.mockResolvedValue([
        defaultTier({ ...route('anthropic', 'api_key', 'claude-sonnet-4-5'), keyLabel: 'Work' }),
      ]);
      providerKeyService.getDefaultKeyLabel.mockResolvedValue('Default');

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      expect(result).toEqual({ ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Default' });
    });

    it('ignores a default tier pin for a different auth type', async () => {
      tierService.getTiers.mockResolvedValue([
        defaultTier({ ...route('openai', 'subscription', 'gpt-5.5'), keyLabel: 'Work' }),
      ]);
      providerKeyService.getDefaultKeyLabel.mockResolvedValue('Default');

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      expect(result).toEqual({ ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Default' });
    });

    it('falls back to the default connection label when the default tier pins nothing', async () => {
      tierService.getTiers.mockResolvedValue([
        defaultTier(route('openai', 'api_key', 'gpt-4o-mini')),
      ]);
      providerKeyService.getDefaultKeyLabel.mockResolvedValue('Default');

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      expect(result).toEqual({ ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Default' });
    });

    it('falls back to the default connection label when there is no default tier row', async () => {
      tierService.getTiers.mockResolvedValue([]);
      providerKeyService.getDefaultKeyLabel.mockResolvedValue('Only');

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      expect(result).toEqual({ ...route('openai', 'api_key', 'gpt-4o'), keyLabel: 'Only' });
    });

    it('leaves the route unlabelled when no connection resolves at all', async () => {
      tierService.getTiers.mockResolvedValue([defaultTier(null)]);
      providerKeyService.getDefaultKeyLabel.mockResolvedValue(undefined);

      const result = await svc.pinRouteKeyLabel(
        'agent-1',
        'tenant-1',
        route('openai', 'api_key', 'gpt-4o'),
      );

      expect(result).toEqual(route('openai', 'api_key', 'gpt-4o'));
    });
  });
});
