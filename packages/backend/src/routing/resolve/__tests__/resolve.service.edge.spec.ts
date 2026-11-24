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
 * Edge-case tests for ResolveService. Mirrors resolve.service.spec.ts mocking.
 * Covers: header passthrough when the required header key is absent;
 * specificity confidence boundary at exactly MIN_SPECIFICITY_CONFIDENCE;
 * logger output for orphaned overrides and low-confidence specificity.
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
import { Logger } from '@nestjs/common';

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

const fallbackTierAssignment = (): TierAssignment =>
  ({
    tier: 'standard',
    override_route: route('openai', 'api_key', 'fallback'),
    auto_assigned_route: null,
    fallback_routes: null,
  }) as TierAssignment;

const codingSpecificity = (overrideModel = 'gpt-4o'): SpecificityAssignment =>
  ({
    category: 'coding',
    is_active: true,
    override_route: route('openai', 'api_key', overrideModel),
    auto_assigned_route: null,
    fallback_routes: null,
  }) as unknown as SpecificityAssignment;

const headerTierFixture = (overrides: Partial<HeaderTier> = {}): HeaderTier =>
  ({
    id: 'h1',
    name: 'Premium',
    header_key: 'x-tier',
    header_value: 'gold',
    enabled: true,
    badge_color: 'red',
    override_route: route('openai', 'api_key', 'gpt-4o'),
    fallback_routes: null,
    ...overrides,
  }) as unknown as HeaderTier;

describe('ResolveService — edge cases', () => {
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
    Pick<ModelDiscoveryService, 'getModelForAgent' | 'getModelsForAgent'>
  >;
  let penaltyService: jest.Mocked<Pick<SpecificityPenaltyService, 'getPenaltiesForAgent'>>;
  let headerTierService: jest.Mocked<Pick<HeaderTierService, 'list'>>;
  let agentRepo: { findOne: jest.Mock };
  let svc: ResolveService;

  beforeEach(() => {
    jest.clearAllMocks();
    tierService = { getTiers: jest.fn().mockResolvedValue([]) };
    providerKeyService = {
      isModelAvailable: jest.fn().mockResolvedValue(true),
      isRouteAvailable: jest.fn().mockResolvedValue(true),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
      hasRouteCredentials: jest.fn().mockResolvedValue(true),
    };
    specificityService = { getActiveAssignments: jest.fn().mockResolvedValue([]) };
    pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    discoveryService = {
      getModelForAgent: jest.fn().mockResolvedValue(null),
      getModelsForAgent: jest.fn().mockResolvedValue([]),
    };
    penaltyService = { getPenaltiesForAgent: jest.fn().mockResolvedValue(new Map()) };
    headerTierService = { list: jest.fn().mockResolvedValue([]) };
    agentRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'agent-1', complexity_routing_enabled: true }),
    };
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
      {
        addInvalidationListener: jest.fn(),
        addTenantInvalidationListener: jest.fn(),
      } as unknown as RoutingCacheService,
    );
  });

  const messages = [{ role: 'user' as const, content: 'hello' }];

  describe('header tier — missing header key', () => {
    it('falls through when the required header key is absent from the request', async () => {
      headerTierService.list.mockResolvedValue([headerTierFixture()]);
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: route('openai', 'api_key', 'gpt-4o-mini'),
          auto_assigned_route: null,
          fallback_routes: null,
        } as TierAssignment,
      ]);

      // Headers object exists but lacks the configured header_key — the rule
      // should not match and we should fall through to scored routing.
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
        { 'other-header': 'value' },
      );

      expect(result.reason).not.toBe('header-match');
      expect(result.reason).toBe('scored');
      expect(result.route).toEqual(route('openai', 'api_key', 'gpt-4o-mini'));
    });
  });

  describe('specificity confidence boundary at 0.4', () => {
    beforeEach(() => {
      specificityService.getActiveAssignments.mockResolvedValue([codingSpecificity()]);
      tierService.getTiers.mockResolvedValue([fallbackTierAssignment()]);
    });

    it('falls through when confidence is just below the gate (0.399 < 0.4)', async () => {
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.399 } as never);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('scored');
    });

    it('routes via specificity when confidence equals the gate exactly (0.4)', async () => {
      // `< 0.4` is false when value equals 0.4 — boundary is inclusive on the
      // accepting side, so this must route as specificity, not fall through.
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.4 } as never);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('specificity');
      expect(result.specificity_category).toBe('coding');
      expect(result.confidence).toBe(0.4);
    });

    it('routes via specificity when confidence is just above the gate (0.401)', async () => {
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.401 } as never);
      const result = await svc.resolve('agent-1', 'user-1', messages);
      expect(result.reason).toBe('specificity');
      expect(result.confidence).toBe(0.401);
    });
  });

  describe('logger diagnostics', () => {
    let debugSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    });

    /**
     * Assert that at least one call to the given spy passed a first-argument
     * string containing `needle`. Using mock.calls (not toHaveBeenCalledWith)
     * because NestJS Logger.debug/warn are variadic and the matcher would
     * otherwise need to model every optional param.
     */
    const expectMessageLogged = (spy: jest.SpyInstance, needle: string): void => {
      const logged = spy.mock.calls.map((call) => String(call[0]));
      const matched = logged.some((msg) => msg.includes(needle));
      expect(matched).toBe(true);
    };

    it('emits a debug log when specificity confidence is below the gate', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([codingSpecificity()]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.3 } as never);
      tierService.getTiers.mockResolvedValue([fallbackTierAssignment()]);

      await svc.resolve('agent-1', 'user-1', messages);

      expectMessageLogged(debugSpy, 'below 0.4');
      expectMessageLogged(debugSpy, 'coding');
    });

    it('emits a warn log when a specificity override points to an unavailable model', async () => {
      specificityService.getActiveAssignments.mockResolvedValue([codingSpecificity('orphaned')]);
      mockedScan.mockReturnValue({ category: 'coding', confidence: 0.9 } as never);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);
      tierService.getTiers.mockResolvedValue([fallbackTierAssignment()]);

      await svc.resolve('agent-1', 'user-1', messages);

      expectMessageLogged(warnSpy, 'Specificity override orphaned is unavailable');
    });

    it('emits a warn log when a tier override points to an unavailable model', async () => {
      tierService.getTiers.mockResolvedValue([
        {
          tier: 'standard',
          override_route: route('openai', 'api_key', 'orphaned'),
          auto_assigned_route: route('openai', 'api_key', 'auto'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      providerKeyService.isModelAvailable.mockResolvedValue(false);
      providerKeyService.isRouteAvailable.mockResolvedValue(false);

      await svc.resolve('agent-1', 'user-1', messages);

      expectMessageLogged(warnSpy, 'Override orphaned unavailable for agent=agent-1');
    });

    it('emits a debug log when a header tier matches but has no override route', async () => {
      headerTierService.list.mockResolvedValue([headerTierFixture({ override_route: null })]);
      tierService.getTiers.mockResolvedValue([fallbackTierAssignment()]);

      await svc.resolve(
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

      expectMessageLogged(debugSpy, 'Header tier "Premium" matched but has no model configured');
    });
  });
});
