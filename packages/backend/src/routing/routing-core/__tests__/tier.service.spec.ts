import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { ModelRoute } from 'manifest-shared';
import { TIER_SLOTS } from 'manifest-shared';
import { TierService } from '../tier.service';
import { TierAssignment } from '../../../entities/tier-assignment.entity';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ProviderService } from '../provider.service';
import type { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';

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
    inputPricePerToken: 0,
    outputPricePerToken: 0,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
    authType,
  }) as DiscoveredModel;

interface RepoMock<T> {
  find: jest.Mock;
  findOne: jest.Mock;
  insert: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
}

const makeRepo = <T>(): RepoMock<T> => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  insert: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockImplementation(async (row) => row),
  update: jest.fn().mockResolvedValue(undefined),
});

describe('TierService', () => {
  let tierRepo: RepoMock<TierAssignment>;
  let routingCache: {
    getTiers: jest.Mock;
    setTiers: jest.Mock;
    invalidateAgent: jest.Mock;
  };
  let providerService: jest.Mocked<Pick<ProviderService, 'getProviders'>>;
  let discoveryService: jest.Mocked<Pick<ModelDiscoveryService, 'getModelsForAgent'>>;
  let svc: TierService;

  beforeEach(() => {
    tierRepo = makeRepo<TierAssignment>();
    routingCache = {
      getTiers: jest.fn().mockReturnValue(null),
      setTiers: jest.fn(),
      invalidateAgent: jest.fn(),
    };
    providerService = { getProviders: jest.fn().mockResolvedValue([]) };
    discoveryService = { getModelsForAgent: jest.fn().mockResolvedValue([]) };

    svc = new TierService(
      tierRepo as unknown as Repository<TierAssignment>,
      routingCache as unknown as RoutingCacheService,
      providerService as unknown as ProviderService,
      discoveryService as unknown as ModelDiscoveryService,
    );
  });

  describe('setResponseMode', () => {
    it('creates a new tier row when none exists yet', async () => {
      const out = await svc.setResponseMode('agent-1', 'standard', 'buffered');
      expect(tierRepo.insert).toHaveBeenCalledTimes(1);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(out.tier).toBe('standard');
      expect(out.response_mode).toBe('buffered');
    });
  });

  describe('hasRoutableTier', () => {
    it('returns true when any tier has an override route', async () => {
      tierRepo.find.mockResolvedValue([
        { tier: 'simple', override_route: route('openai', 'api_key', 'gpt-4o-mini') },
      ]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(true);
    });

    it('returns true when a tier only has an auto-assigned route (legacy upgrade path)', async () => {
      // ResolveService honors auto_assigned_route when override is empty, so
      // the status endpoint must not claim "no_routable_models" while the
      // proxy actively routes these installs.
      tierRepo.find.mockResolvedValue([
        {
          tier: 'standard',
          override_route: null,
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
        },
      ]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(true);
    });

    it('prefers override over auto-assigned when both are present', async () => {
      tierRepo.find.mockResolvedValue([
        {
          tier: 'standard',
          override_route: route('anthropic', 'api_key', 'claude'),
          auto_assigned_route: route('openai', 'api_key', 'gpt-4o'),
        },
      ]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(true);
    });

    it('ignores a malformed auto-assigned blob', async () => {
      tierRepo.find.mockResolvedValue([
        { tier: 'standard', override_route: null, auto_assigned_route: { foo: 'bar' } },
      ]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(false);
    });

    it('returns false when every tier is empty', async () => {
      tierRepo.find.mockResolvedValue([
        { tier: 'simple', override_route: null, auto_assigned_route: null },
      ]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(false);
    });

    it('returns false when no rows exist', async () => {
      tierRepo.find.mockResolvedValue([]);
      expect(await svc.hasRoutableTier('agent-1')).toBe(false);
    });
  });

  describe('getTiers', () => {
    it('returns the cached value when present without touching repos', async () => {
      const cached = [{ tier: 'simple' }] as TierAssignment[];
      routingCache.getTiers.mockReturnValue(cached);
      const result = await svc.getTiers('agent-1');
      expect(result).toBe(cached);
      expect(tierRepo.find).not.toHaveBeenCalled();
      expect(providerService.getProviders).not.toHaveBeenCalled();
    });

    it('returns existing rows and caches them when every slot is present', async () => {
      const existing = TIER_SLOTS.map(
        (slot) =>
          ({ tier: slot, override_route: null, auto_assigned_route: null }) as TierAssignment,
      );
      tierRepo.find.mockResolvedValue(existing);
      const result = await svc.getTiers('agent-1');
      expect(result).toEqual(existing);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', existing);
    });

    it('inserts the missing slots when some are absent', async () => {
      tierRepo.find.mockResolvedValueOnce([
        { tier: 'simple', override_route: null, auto_assigned_route: null } as TierAssignment,
      ]);
      const result = await svc.getTiers('agent-1', 'tenant-1');
      expect(tierRepo.insert).toHaveBeenCalledTimes(1);
      const inserted = tierRepo.insert.mock.calls[0][0] as TierAssignment[];
      const insertedSlots = inserted.map((r) => r.tier).sort();
      expect(insertedSlots).toEqual(['complex', 'default', 'reasoning', 'standard']);
      // inserted rows are agent-scoped only
      expect(inserted.every((r) => r.agent_id === 'agent-1')).toBe(true);
      // passing a tenantId triggers the provider cleanup pass
      expect(providerService.getProviders).toHaveBeenCalledWith('tenant-1');
      // result merges existing + created
      expect(result).toHaveLength(TIER_SLOTS.length);
    });

    it('skips the provider cleanup pass when no tenantId is passed', async () => {
      tierRepo.find.mockResolvedValueOnce([]);
      await svc.getTiers('agent-1');
      const inserted = tierRepo.insert.mock.calls[0][0] as TierAssignment[];
      expect(inserted.every((r) => r.agent_id === 'agent-1')).toBe(true);
      expect(providerService.getProviders).not.toHaveBeenCalled();
    });

    it('falls back to existing rows on a unique-index race during insert', async () => {
      tierRepo.find.mockResolvedValueOnce([]);
      tierRepo.insert.mockRejectedValueOnce(new Error('duplicate key'));
      const racedRows = TIER_SLOTS.map((slot) => ({ tier: slot }) as TierAssignment);
      tierRepo.find.mockResolvedValueOnce(racedRows);

      const result = await svc.getTiers('agent-1');
      expect(result).toBe(racedRows);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', racedRows);
    });

    it('rethrows when insert fails and no rows exist on retry', async () => {
      tierRepo.find.mockResolvedValueOnce([]);
      const err = new Error('FK violation');
      tierRepo.insert.mockRejectedValueOnce(err);
      tierRepo.find.mockResolvedValueOnce([]);
      await expect(svc.getTiers('agent-1')).rejects.toThrow(err);
    });

    it('fills missing slots without auto-assigning even when a usable provider exists', async () => {
      tierRepo.find.mockResolvedValueOnce([]);
      providerService.getProviders.mockResolvedValue([
        { tenant_id: 'tenant-1', is_active: true, provider: 'openai', auth_type: 'api_key' },
      ] as never);

      const result = await svc.getTiers('agent-1', 'tenant-1');
      expect(providerService.getProviders).toHaveBeenCalledWith('tenant-1');
      expect(tierRepo.insert).toHaveBeenCalledTimes(1);
      expect(routingCache.setTiers).toHaveBeenCalledWith('agent-1', result);
      expect(result).toHaveLength(TIER_SLOTS.length);
    });
  });

  describe('setOverride', () => {
    it('throws when the model is not in the discovered list', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      await expect(
        svc.setOverride('agent-1', 'tenant-1', 'standard', 'unknown-model'),
      ).rejects.toThrow(BadRequestException);
    });

    it('truncates the available list in the error message at 20 entries', async () => {
      const list: DiscoveredModel[] = [];
      for (let i = 0; i < 25; i++) list.push(discovered(`m-${i}`, 'openai', 'api_key'));
      discoveryService.getModelsForAgent.mockResolvedValue(list);
      try {
        await svc.setOverride('agent-1', 'u', 'standard', 'unknown', 'openai');
        throw new Error('expected throw');
      } catch (err) {
        const msg = (err as BadRequestException).message;
        expect(msg).toContain('provider: openai');
        expect(msg).toMatch(/, …$/);
      }
    });

    it('routes a custom model named bare next to its provider (issue #2962)', async () => {
      const custom = 'custom:6f1c2b9e-0000-4000-8000-000000000001';
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('llama-3.3-70b', 'groq', 'api_key'),
        discovered(`${custom}/deepseek-v4-pro`, custom, 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue(null);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'default',
        'deepseek-v4-pro',
        custom,
        'api_key',
      );

      expect(result.override_route).toEqual(route(custom, 'api_key', `${custom}/deepseek-v4-pro`));
    });

    it("lists the named provider's models when its model is unknown", async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('llama-3.3-70b', 'groq', 'api_key'),
        discovered('deepseek/deepseek-chat-v3.1:free', 'openrouter', 'api_key'),
      ]);

      await expect(
        svc.setOverride('agent-1', 'tenant-1', 'default', 'deepseek-v9', 'openrouter'),
      ).rejects.toThrow('choose from: openrouter/deepseek/deepseek-chat-v3.1:free');
    });

    it('throws when the provider does not offer the model', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      await expect(
        svc.setOverride('agent-1', 'tenant-1', 'standard', 'gpt-4o', 'anthropic'),
      ).rejects.toThrow('not offered by provider');
    });

    it('throws when ambiguous and no explicit triple is passed', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
      ]);
      await expect(svc.setOverride('agent-1', 'tenant-1', 'standard', 'gpt-4o')).rejects.toThrow(
        /multiple providers/,
      );
    });

    it('updates an existing tier and clears the matching fallback tuple', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      const existing = {
        agent_id: 'agent-1',
        tier: 'standard',
        override_route: null,
        fallback_routes: [
          route('openai', 'api_key', 'gpt-4o'),
          route('anthropic', 'api_key', 'claude'),
        ],
      } as unknown as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'standard',
        'gpt-4o',
        'openai',
        'api_key',
      );
      expect(result.override_route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      // The matching tuple is filtered out, leaving only claude.
      expect(result.fallback_routes).toEqual([route('anthropic', 'api_key', 'claude')]);
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('nulls fallback_routes when filtering the matched tuple leaves zero entries', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      const existing = {
        agent_id: 'agent-1',
        tier: 'standard',
        override_route: null,
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
      } as unknown as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'standard',
        'gpt-4o',
        'openai',
        'api_key',
      );
      expect(result.fallback_routes).toBeNull();
    });

    it('inserts a new row when no existing tier exists', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue(null);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'standard',
        'gpt-4o',
        'openai',
        'api_key',
      );
      expect(tierRepo.insert).toHaveBeenCalledTimes(1);
      expect(result.override_route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('retries on a unique-index conflict and returns the persisted row', async () => {
      // Conflict path: the concurrent row already exists on re-read, so the
      // service adopts it (recursing into the existing-row branch) and returns
      // the persisted override rather than throwing.
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne
        .mockResolvedValueOnce(null) // initial check
        .mockResolvedValueOnce({
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: null,
        } as TierAssignment) // retry probe sees existing
        .mockResolvedValueOnce({
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: null,
        } as TierAssignment); // recursive setOverride re-finds it
      tierRepo.insert.mockRejectedValueOnce(new Error('duplicate'));

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'standard',
        'gpt-4o',
        'openai',
        'api_key',
      );
      expect(result.override_route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(tierRepo.save).toHaveBeenCalled();
      // The existing-row branch invalidates the routing cache; assert that side effect.
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('rethrows when insert fails and no row exists on retry (no phantom success)', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const err = new Error('FK violation');
      tierRepo.insert.mockRejectedValueOnce(err);

      // A non-conflict DB error with no conflicting row on re-read must
      // propagate — the row was never persisted, so reporting success would
      // strand the caller with a phantom record and a stale cache.
      await expect(
        svc.setOverride('agent-1', 'tenant-1', 'standard', 'gpt-4o', 'openai', 'api_key'),
      ).rejects.toThrow(err);
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
    });
  });

  describe('clearOverride', () => {
    it('no-ops when no row exists', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      await svc.clearOverride('agent-1', 'standard');
      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
    });

    it('clears override_route and saves when a row exists', async () => {
      const existing = {
        agent_id: 'agent-1',
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-4o'),
      } as unknown as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);
      await svc.clearOverride('agent-1', 'standard');
      expect(existing.override_route).toBeNull();
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('resetAllOverrides', () => {
    it('clears override_route and fallback_routes for every tier of an agent', async () => {
      await svc.resetAllOverrides('agent-1');
      expect(tierRepo.update).toHaveBeenCalledWith(
        { agent_id: 'agent-1' },
        expect.objectContaining({ override_route: null, fallback_routes: null }),
      );
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('getFallbacks', () => {
    it('returns the existing fallback_routes when present', async () => {
      const fr = [route('openai', 'api_key', 'gpt-4o')];
      tierRepo.findOne.mockResolvedValue({ fallback_routes: fr } as TierAssignment);
      expect(await svc.getFallbacks('agent-1', 'standard')).toEqual(fr);
    });

    it('returns [] when row is missing', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      expect(await svc.getFallbacks('agent-1', 'standard')).toEqual([]);
    });

    it('returns [] when fallback_routes is null', async () => {
      tierRepo.findOne.mockResolvedValue({ fallback_routes: null } as TierAssignment);
      expect(await svc.getFallbacks('agent-1', 'standard')).toEqual([]);
    });
  });

  describe('setFallbacks', () => {
    it('returns [] when no tier row exists', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      expect(await svc.setFallbacks('agent-1', 'tenant-1', 'standard', ['gpt-4o'])).toEqual([]);
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('saves explicit caller routes when they validate', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: null,
      } as TierAssignment);

      const provided = [route('openai', 'api_key', 'gpt-4o')];
      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'standard',
        ['gpt-4o'],
        provided,
      );
      expect(result).toEqual(provided);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('falls back to discovery when caller route alignment fails', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: null,
      } as TierAssignment);

      // Provided route's model name doesn't align with the names array — should
      // ignore the explicit routes and resolve from discovery instead.
      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'standard',
        ['gpt-4o'],
        [route('openai', 'api_key', 'different-model')],
      );
      expect(result).toEqual([route('openai', 'api_key', 'gpt-4o')]);
    });

    it('resolves a fallback given by its public /v1/models id', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('deepseek/deepseek-chat-v3.1:free', 'openrouter', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'default',
        fallback_routes: null,
      } as TierAssignment);

      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'default', [
        'openrouter/deepseek/deepseek-chat-v3.1:free',
      ]);

      expect(result).toEqual([route('openrouter', 'api_key', 'deepseek/deepseek-chat-v3.1:free')]);
    });

    it('falls back to discovery when caller routes do not exist in available list', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: null,
      } as TierAssignment);
      // Aligned by name but provider doesn't match available list.
      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'standard',
        ['gpt-4o'],
        [route('different-provider', 'api_key', 'gpt-4o')],
      );
      expect(result).toEqual([route('openai', 'api_key', 'gpt-4o')]);
    });

    it('returns [] when models is empty (buildFallbackRoutes returns null)', async () => {
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: null,
      } as TierAssignment);

      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'standard', []);
      expect(result).toEqual([]);
    });

    it('throws when a model cannot be unambiguously resolved', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: null,
      } as TierAssignment);

      await expect(svc.setFallbacks('agent-1', 'tenant-1', 'standard', ['gpt-4o'])).rejects.toThrow(
        /Cannot resolve fallback model "gpt-4o"/,
      );
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    // Regression: issue #1790. Adding a new fallback whose (provider, authType,
    // model) tuple isn't in the discovered list used to fall through to
    // unambiguousRoute() for every model and return null on the first
    // ambiguous one — wiping the previously-saved fallbacks. The fix throws
    // before save, so the existing row is left untouched.
    it('preserves existing fallbacks when an unresolvable model is added (issue #1790)', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('anthropic', 'api_key', 'claude-3-5-sonnet'),
      ];
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
        discovered('claude-3-5-sonnet', 'anthropic', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: existing,
      } as TierAssignment);

      // Caller sends the existing two routes plus a new one whose tuple
      // doesn't match any discovered model — validation fails, then
      // unambiguousRoute hits gpt-4o which has two entries.
      await expect(
        svc.setFallbacks(
          'agent-1',
          'tenant-1',
          'standard',
          ['gpt-4o', 'claude-3-5-sonnet', 'minmax-27'],
          [...existing, route('minimax', 'api_key', 'minmax-27')],
        ),
      ).rejects.toThrow(/Cannot resolve fallback model/);
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    // Regression: removing a fallback is a PUT of the surviving entries, so a
    // survivor whose provider disconnected or whose model was de-listed (e.g.
    // upstream removed it from the subscription catalog) made every removal
    // fail with "Cannot resolve fallback model". Surviving entries are
    // matched to the persisted row by identity instead of being re-resolved
    // against live discovery.
    it('removes an entry when a surviving route no longer resolves (routes sent)', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('qwen', 'subscription', 'qwen3.8-max-preview'),
      ];
      // qwen3.8-max-preview is gone from discovery entirely.
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: existing,
      } as TierAssignment);

      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'standard',
        ['qwen3.8-max-preview'],
        [existing[1]],
      );
      expect(result).toEqual([existing[1]]);
      expect(tierRepo.save).toHaveBeenCalled();
    });

    it('reuses the stored route for a surviving bare-name entry that no longer resolves', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('qwen', 'subscription', 'qwen3.8-max-preview'),
      ];
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: existing,
      } as TierAssignment);

      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'standard', [
        'qwen3.8-max-preview',
      ]);
      expect(result).toEqual([existing[1]]);
      expect(tierRepo.save).toHaveBeenCalled();
    });

    it('still throws when adding a new model that cannot be resolved', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      tierRepo.findOne.mockResolvedValue({
        agent_id: 'agent-1',
        tier: 'standard',
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
      } as TierAssignment);

      await expect(
        svc.setFallbacks('agent-1', 'tenant-1', 'standard', ['gpt-4o', 'minmax-27']),
      ).rejects.toThrow(/Cannot resolve fallback model "minmax-27"/);
      expect(tierRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('clearFallbacks', () => {
    it('no-ops when no row exists', async () => {
      tierRepo.findOne.mockResolvedValue(null);
      await svc.clearFallbacks('agent-1', 'standard');
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('clears fallback_routes and saves when row exists', async () => {
      const existing = {
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
      } as unknown as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);

      await svc.clearFallbacks('agent-1', 'standard');
      expect(existing.fallback_routes).toBeNull();
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('rejects clearing the only stream-capable route while stream mode is active', async () => {
      tierRepo.findOne.mockResolvedValue({
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-image-1'),
        auto_assigned_route: null,
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
        response_mode: 'stream',
      } as TierAssignment);

      await expect(svc.clearFallbacks('agent-1', 'standard')).rejects.toThrow(
        /add at least one stream-capable model/,
      );
      expect(tierRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('stream response mode enforcement', () => {
    it('rejects stream mode when the route chain has no stream-capable model', async () => {
      tierRepo.findOne.mockResolvedValue({
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-image-1'),
        auto_assigned_route: null,
        fallback_routes: null,
      } as TierAssignment);

      await expect(svc.setResponseMode('agent-1', 'standard', 'stream')).rejects.toThrow(
        /add at least one stream-capable model/,
      );
      expect(tierRepo.save).not.toHaveBeenCalled();
    });

    it('allows stream mode when only the primary route is stream-capable', async () => {
      const existing = {
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        auto_assigned_route: null,
        fallback_routes: [route('openai', 'api_key', 'gpt-image-1')],
      } as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await svc.setResponseMode('agent-1', 'standard', 'stream');

      expect(result.response_mode).toBe('stream');
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
    });

    it('allows stream mode when the active route chain supports streaming', async () => {
      const existing = {
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        auto_assigned_route: null,
        fallback_routes: [route('anthropic', 'api_key', 'claude-3-5-sonnet')],
        response_mode: 'buffered',
      } as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);

      const result = await svc.setResponseMode('agent-1', 'standard', 'stream');

      expect(result.response_mode).toBe('stream');
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
    });

    it('allows adding a non-stream fallback while tier stream mode is active when the primary streams', async () => {
      const existing = {
        tier: 'standard',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        response_mode: 'stream',
      } as TierAssignment;
      tierRepo.findOne.mockResolvedValue(existing);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-image-1', 'openai', 'api_key'),
      ]);

      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'standard',
        ['gpt-image-1'],
        [route('openai', 'api_key', 'gpt-image-1')],
      );

      expect(result).toEqual([route('openai', 'api_key', 'gpt-image-1')]);
      expect(tierRepo.save).toHaveBeenCalledWith(existing);
    });
  });
});
