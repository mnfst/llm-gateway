import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { ModelRoute, TierColor } from 'manifest-shared';
import { HeaderTierService, RESERVED_HEADER_KEYS } from '../header-tier.service';
import { HeaderTier } from '../../../entities/header-tier.entity';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';
import type { RoutingCacheService } from '../../routing-core/routing-cache.service';
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

const validInput = (overrides: Partial<Parameters<HeaderTierService['create']>[2]> = {}) => ({
  name: 'Premium',
  header_key: 'x-tier',
  header_value: 'premium',
  badge_color: 'red' as TierColor,
  ...overrides,
});

const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  insert: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockImplementation(async (row) => row),
  delete: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
});

describe('HeaderTierService', () => {
  let repo: ReturnType<typeof makeRepo>;
  let routingCache: {
    getHeaderTiers: jest.Mock;
    setHeaderTiers: jest.Mock;
    invalidateAgent: jest.Mock;
  };
  let discoveryService: jest.Mocked<Pick<ModelDiscoveryService, 'getModelsForAgent'>>;
  let svc: HeaderTierService;

  beforeEach(() => {
    repo = makeRepo();
    routingCache = {
      getHeaderTiers: jest.fn().mockReturnValue(null),
      setHeaderTiers: jest.fn(),
      invalidateAgent: jest.fn(),
    };
    discoveryService = { getModelsForAgent: jest.fn().mockResolvedValue([]) };
    svc = new HeaderTierService(
      repo as unknown as Repository<HeaderTier>,
      routingCache as unknown as RoutingCacheService,
      discoveryService as unknown as ModelDiscoveryService,
    );
  });

  describe('list', () => {
    it('returns the cached value when present', async () => {
      const cached = [{ id: 'h1' }] as HeaderTier[];
      routingCache.getHeaderTiers.mockReturnValue(cached);
      expect(await svc.list('agent-1')).toBe(cached);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('reads sorted by sort_order and caches', async () => {
      const rows = [{ id: 'h1' }] as HeaderTier[];
      repo.find.mockResolvedValue(rows);
      const result = await svc.list('agent-1');
      expect(result).toBe(rows);
      expect(repo.find).toHaveBeenCalledWith({
        where: { agent_id: 'agent-1' },
        order: { sort_order: 'ASC' },
      });
      expect(routingCache.setHeaderTiers).toHaveBeenCalledWith('agent-1', rows);
    });
  });

  describe('create', () => {
    it('creates a header tier with sort_order 0 when no siblings exist', async () => {
      repo.find.mockResolvedValue([]);
      const result = await svc.create('agent-1', 'tenant-1', validInput());
      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(result.sort_order).toBe(0);
      expect(result.name).toBe('Premium');
      expect(result.header_key).toBe('x-tier');
      expect(result.header_value).toBe('premium');
      expect(result.badge_color).toBe('red');
      expect(result.tenant_id).toBe('tenant-1');
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('appends after the highest existing sort_order', async () => {
      repo.find.mockResolvedValue([
        { id: 'a', sort_order: 0, name: 'A', header_key: 'x', header_value: 'a' } as HeaderTier,
        { id: 'b', sort_order: 4, name: 'B', header_key: 'x', header_value: 'b' } as HeaderTier,
      ]);
      const result = await svc.create('agent-1', 'tenant-1', validInput());
      expect(result.sort_order).toBe(5);
    });

    it('rejects empty names', async () => {
      await expect(svc.create('agent-1', 'tenant-1', validInput({ name: '   ' }))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects oversized names', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ name: 'a'.repeat(33) })),
      ).rejects.toThrow(/32 characters/);
    });

    it('rejects header keys with disallowed characters', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ header_key: 'X-Bad_Key' })),
      ).rejects.toThrow(/lowercase letters/);
    });

    it('rejects empty header keys', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ header_key: '' })),
      ).rejects.toThrow(/Header key is required/);
    });

    it('rejects all reserved header keys', async () => {
      for (const key of RESERVED_HEADER_KEYS) {
        await expect(
          svc.create('agent-1', 'tenant-1', validInput({ header_key: key })),
        ).rejects.toThrow(/stripped for security/);
      }
    });

    it('rejects reserved header keys with mixed case and whitespace', async () => {
      for (const key of RESERVED_HEADER_KEYS) {
        const mutated = `  ${key.toUpperCase()}  `;
        await expect(
          svc.create('agent-1', 'tenant-1', validInput({ header_key: mutated })),
        ).rejects.toThrow(/stripped for security/);
      }
    });

    it('rejects empty header values', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ header_value: '' })),
      ).rejects.toThrow(/Header value is required/);
    });

    it('rejects oversized header values', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ header_value: 'x'.repeat(129) })),
      ).rejects.toThrow(/128 characters/);
    });

    it('rejects invalid colors', async () => {
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ badge_color: 'rainbow' as TierColor })),
      ).rejects.toThrow(/badge color/);
    });

    it('rejects duplicate names case-insensitively', async () => {
      repo.find.mockResolvedValue([
        {
          id: 'h1',
          name: 'PREMIUM',
          header_key: 'x',
          header_value: 'a',
          sort_order: 0,
        } as HeaderTier,
      ]);
      await expect(
        svc.create('agent-1', 'tenant-1', validInput({ name: 'premium' })),
      ).rejects.toThrow(/already exists/);
    });

    it('rejects duplicate (header_key, header_value) pairs', async () => {
      repo.find.mockResolvedValue([
        {
          id: 'h1',
          name: 'Other',
          header_key: 'x-tier',
          header_value: 'premium',
          sort_order: 0,
        } as HeaderTier,
      ]);
      await expect(svc.create('agent-1', 'tenant-1', validInput())).rejects.toThrow(
        /already matches/,
      );
    });
  });

  describe('update', () => {
    it('throws NotFound when row does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.update('agent-1', 'h1', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('updates only provided fields', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        name: 'Old',
        header_key: 'x-tier',
        header_value: 'old',
        badge_color: 'red' as TierColor,
        sort_order: 0,
      } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      repo.find.mockResolvedValue([row]);

      const result = await svc.update('agent-1', 'h1', { name: 'New' });
      expect(result.name).toBe('New');
      expect(result.header_key).toBe('x-tier');
      expect(result.header_value).toBe('old');
      expect(repo.save).toHaveBeenCalledWith(row);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('updates header_key, header_value and badge_color when supplied', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        name: 'A',
        header_key: 'x-tier',
        header_value: 'old',
        badge_color: 'red' as TierColor,
      } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      repo.find.mockResolvedValue([row]);

      const result = await svc.update('agent-1', 'h1', {
        header_key: 'x-band',
        header_value: 'gold',
        badge_color: 'blue' as TierColor,
      });
      expect(result.header_key).toBe('x-band');
      expect(result.header_value).toBe('gold');
      expect(result.badge_color).toBe('blue');
    });

    it('rejects renaming to a sibling name', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', name: 'A' } as HeaderTier;
      const sibling = {
        id: 'h2',
        agent_id: 'agent-1',
        name: 'B',
        header_key: 'x',
        header_value: '1',
      } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      repo.find.mockResolvedValue([row, sibling]);
      await expect(svc.update('agent-1', 'h1', { name: 'B' })).rejects.toThrow(/already exists/);
    });

    it('rejects updates that collide with a sibling rule', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        name: 'A',
        header_key: 'x-tier',
        header_value: 'a',
      } as HeaderTier;
      const sibling = {
        id: 'h2',
        agent_id: 'agent-1',
        name: 'B',
        header_key: 'x-tier',
        header_value: 'b',
      } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      repo.find.mockResolvedValue([row, sibling]);
      await expect(svc.update('agent-1', 'h1', { header_value: 'b' })).rejects.toThrow(
        /already matches/,
      );
    });

    it('rejects reserved header keys when updating header_key field', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        name: 'A',
        header_key: 'x-tier',
        header_value: 'v',
      } as HeaderTier;
      for (const key of RESERVED_HEADER_KEYS) {
        repo.findOne.mockResolvedValue(row);
        repo.find.mockResolvedValue([row]);
        await expect(svc.update('agent-1', 'h1', { header_key: key })).rejects.toThrow(
          /stripped for security/,
        );
      }
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('setEnabled', () => {
    it('flips the enabled flag and saves', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', enabled: false } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      const result = await svc.setEnabled('agent-1', 'h1', true);
      expect(result.enabled).toBe(true);
      expect(repo.save).toHaveBeenCalledWith(row);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('throws NotFound when missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.setEnabled('agent-1', 'h1', true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes when row exists', async () => {
      const row = { id: 'h1', agent_id: 'agent-1' } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      await svc.delete('agent-1', 'h1');
      expect(repo.delete).toHaveBeenCalledWith({ id: 'h1' });
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('throws NotFound when row missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.delete('agent-1', 'h1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reorder', () => {
    it('rejects non-array input', async () => {
      await expect(svc.reorder('agent-1', 'not-array' as unknown as string[])).rejects.toThrow(
        /array/,
      );
    });

    it('rejects when length mismatches the existing tier count', async () => {
      repo.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as HeaderTier[]);
      await expect(svc.reorder('agent-1', ['a'])).rejects.toThrow(/include every existing tier/);
    });

    it('rejects when ids contain duplicates', async () => {
      repo.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as HeaderTier[]);
      await expect(svc.reorder('agent-1', ['a', 'a'])).rejects.toThrow(/duplicate ids/);
    });

    it('rejects when ids reference unknown rows', async () => {
      repo.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as HeaderTier[]);
      await expect(svc.reorder('agent-1', ['a', 'unknown'])).rejects.toThrow(
        /include every existing tier/,
      );
    });

    it('updates sort_order in place and saves the batch', async () => {
      const rows = [
        { id: 'a', sort_order: 0 } as HeaderTier,
        { id: 'b', sort_order: 1 } as HeaderTier,
      ];
      repo.find.mockResolvedValue(rows);
      await svc.reorder('agent-1', ['b', 'a']);
      expect(rows[0].sort_order).toBe(1);
      expect(rows[1].sort_order).toBe(0);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('setOverride', () => {
    it('keeps an explicit triple that discovery does not know', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', override_route: null } as HeaderTier;
      repo.findOne.mockResolvedValue(row);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'h1',
        'gpt-4o',
        'openai',
        'api_key',
      );
      expect(result.override_route).toEqual(route('openai', 'api_key', 'gpt-4o'));
      expect(repo.save).toHaveBeenCalledWith(row);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('persists keyLabel on explicit header-tier overrides', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', override_route: null } as HeaderTier;
      repo.findOne.mockResolvedValue(row);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'h1',
        'gpt-4o',
        'openai',
        'subscription',
        'Personal',
      );

      expect(result.override_route).toEqual({
        provider: 'openai',
        authType: 'subscription',
        model: 'gpt-4o',
        keyLabel: 'Personal',
      });
    });

    it('stores the canonical route for a public model id', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', override_route: null } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('deepseek/deepseek-chat-v3.1:free', 'openrouter', 'api_key'),
      ]);

      const result = await svc.setOverride(
        'agent-1',
        'tenant-1',
        'h1',
        'openrouter/deepseek/deepseek-chat-v3.1:free',
        'openrouter',
        'api_key',
      );

      expect(result.override_route).toEqual(
        route('openrouter', 'api_key', 'deepseek/deepseek-chat-v3.1:free'),
      );
    });

    it('resolves via discovery when only the model is given', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', override_route: null } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      const result = await svc.setOverride('agent-1', 'tenant-1', 'h1', 'gpt-4o');
      expect(result.override_route).toEqual(route('openai', 'api_key', 'gpt-4o'));
    });

    it('persists null when discovery cannot resolve unambiguously', async () => {
      const row = { id: 'h1', agent_id: 'agent-1', override_route: null } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      discoveryService.getModelsForAgent.mockResolvedValue([]);
      const result = await svc.setOverride('agent-1', 'tenant-1', 'h1', 'gpt-4o');
      expect(result.override_route).toBeNull();
    });

    it('throws NotFound when row missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.setOverride('agent-1', 'tenant-1', 'h1', 'gpt-4o')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('clearOverride', () => {
    it('clears override and fallbacks', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude')],
      } as unknown as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      await svc.clearOverride('agent-1', 'h1');
      expect(row.override_route).toBeNull();
      expect(row.fallback_routes).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(row);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('setFallbacks', () => {
    it('saves caller-provided routes when they validate', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: null,
      } as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);

      const provided = [route('openai', 'api_key', 'gpt-4o')];
      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'h1', ['gpt-4o'], provided);
      expect(result).toEqual(provided);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('returns [] when models is empty', async () => {
      repo.findOne.mockResolvedValue({ id: 'h1', agent_id: 'agent-1' } as HeaderTier);
      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'h1', []);
      expect(result).toEqual([]);
    });

    it('throws when discovery cannot disambiguate', async () => {
      repo.findOne.mockResolvedValue({ id: 'h1', agent_id: 'agent-1' } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
      ]);
      await expect(svc.setFallbacks('agent-1', 'tenant-1', 'h1', ['gpt-4o'])).rejects.toThrow(
        /Cannot resolve fallback model "gpt-4o"/,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    // Regression: issue #1790. See tier.service.spec for the full rationale.
    it('preserves existing fallbacks when an unresolvable model is added (issue #1790)', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('anthropic', 'api_key', 'claude-3-5-sonnet'),
      ];
      repo.findOne.mockResolvedValue({
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: existing,
      } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
        discovered('gpt-4o', 'openai', 'subscription'),
        discovered('claude-3-5-sonnet', 'anthropic', 'api_key'),
      ]);
      await expect(
        svc.setFallbacks(
          'agent-1',
          'tenant-1',
          'h1',
          ['gpt-4o', 'claude-3-5-sonnet', 'minmax-27'],
          [...existing, route('minimax', 'api_key', 'minmax-27')],
        ),
      ).rejects.toThrow(/Cannot resolve fallback model/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('falls back to discovery when provided routes do not align', async () => {
      repo.findOne.mockResolvedValue({
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: null,
      } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);
      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'h1',
        ['gpt-4o'],
        [route('different', 'api_key', 'gpt-4o')],
      );
      expect(result).toEqual([route('openai', 'api_key', 'gpt-4o')]);
    });

    it('throws NotFound when row missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.setFallbacks('agent-1', 'tenant-1', 'h1', ['gpt-4o'])).rejects.toThrow(
        NotFoundException,
      );
    });

    // Regression: see tier.service.spec — surviving entries are matched to the
    // persisted row by identity so a stale entry never blocks a removal.
    it('removes an entry when a surviving route no longer resolves (routes sent)', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('qwen', 'subscription', 'qwen3.8-max-preview'),
      ];
      repo.findOne.mockResolvedValue({
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: existing,
      } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);

      const result = await svc.setFallbacks(
        'agent-1',
        'tenant-1',
        'h1',
        ['qwen3.8-max-preview'],
        [existing[1]],
      );
      expect(result).toEqual([existing[1]]);
      expect(repo.save).toHaveBeenCalled();
    });

    it('reuses the stored route for a surviving bare-name entry that no longer resolves', async () => {
      const existing = [
        route('openai', 'api_key', 'gpt-4o'),
        route('qwen', 'subscription', 'qwen3.8-max-preview'),
      ];
      repo.findOne.mockResolvedValue({
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: existing,
      } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);

      const result = await svc.setFallbacks('agent-1', 'tenant-1', 'h1', ['qwen3.8-max-preview']);
      expect(result).toEqual([existing[1]]);
      expect(repo.save).toHaveBeenCalled();
    });

    it('still throws when adding a new model that cannot be resolved', async () => {
      repo.findOne.mockResolvedValue({
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
      } as HeaderTier);
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('gpt-4o', 'openai', 'api_key'),
      ]);

      await expect(
        svc.setFallbacks('agent-1', 'tenant-1', 'h1', ['gpt-4o', 'minmax-27']),
      ).rejects.toThrow(/Cannot resolve fallback model "minmax-27"/);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('clearFallbacks', () => {
    it('clears fallback_routes when row exists', async () => {
      const row = {
        id: 'h1',
        agent_id: 'agent-1',
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
      } as unknown as HeaderTier;
      repo.findOne.mockResolvedValue(row);
      await svc.clearFallbacks('agent-1', 'h1');
      expect(row.fallback_routes).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(row);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('rejects clearing the only stream-capable route while stream mode is active', async () => {
      repo.findOne.mockResolvedValue({
        id: 'h1',
        name: 'Premium',
        agent_id: 'agent-1',
        override_route: route('openai', 'api_key', 'gpt-image-1'),
        fallback_routes: [route('openai', 'api_key', 'gpt-4o')],
        response_mode: 'stream',
      } as HeaderTier);

      await expect(svc.clearFallbacks('agent-1', 'h1')).rejects.toThrow(
        /add at least one stream-capable model/,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws NotFound when row missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(svc.clearFallbacks('agent-1', 'h1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('stream response mode enforcement', () => {
    it('rejects stream mode when the custom tier has no primary route', async () => {
      repo.findOne.mockResolvedValue({
        id: 'h1',
        name: 'Premium',
        agent_id: 'agent-1',
        override_route: null,
        fallback_routes: null,
      } as HeaderTier);

      await expect(svc.setResponseMode('agent-1', 'h1', 'stream')).rejects.toThrow(
        /add at least one stream-capable model/,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('allows stream mode when only the custom tier primary is stream-capable', async () => {
      const existing = {
        id: 'h1',
        name: 'Premium',
        agent_id: 'agent-1',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('openai', 'api_key', 'gpt-image-1')],
      } as HeaderTier;
      repo.findOne.mockResolvedValue(existing);

      const result = await svc.setResponseMode('agent-1', 'h1', 'stream');

      expect(result.response_mode).toBe('stream');
      expect(repo.save).toHaveBeenCalledWith(existing);
    });

    it('rejects assigning a non-stream model while custom tier stream mode is active with no stream fallback', async () => {
      repo.findOne.mockResolvedValue({
        id: 'h1',
        name: 'Premium',
        agent_id: 'agent-1',
        override_route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        response_mode: 'stream',
      } as HeaderTier);

      await expect(
        svc.setOverride('agent-1', 'tenant-1', 'h1', 'gpt-image-1', 'openai', 'api_key'),
      ).rejects.toThrow(/add at least one stream-capable model/);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
