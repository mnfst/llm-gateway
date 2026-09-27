import { Test, TestingModule } from '@nestjs/testing';
import { CachedProviderKey, RoutingCacheService } from './routing-core/routing-cache.service';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';

const providerKey = (label: string, apiKey: string | null = 'sk-test'): CachedProviderKey => ({
  id: label,
  label,
  priority: 0,
  apiKey,
  region: null,
});

describe('RoutingCacheService', () => {
  let service: RoutingCacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RoutingCacheService],
    }).compile();

    service = module.get<RoutingCacheService>(RoutingCacheService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getTiers', () => {
    it('returns null when not cached', () => {
      expect(service.getTiers('agent-1')).toBeNull();
    });

    it('returns cached data within TTL', () => {
      const tiers = [{ id: 'ta-1', tier: 'fast' }] as TierAssignment[];
      service.setTiers('agent-1', tiers);

      const result = service.getTiers('agent-1');
      expect(result).toEqual(tiers);
    });

    it('returns null after TTL expires', () => {
      jest.useFakeTimers();
      const tiers = [{ id: 'ta-1', tier: 'fast' }] as TierAssignment[];
      service.setTiers('agent-1', tiers);

      jest.advanceTimersByTime(120_001);

      expect(service.getTiers('agent-1')).toBeNull();
    });
  });

  describe('setTiers', () => {
    it('stores data that can be retrieved', () => {
      const tiers = [
        { id: 'ta-1', tier: 'fast' },
        { id: 'ta-2', tier: 'cheap' },
      ] as TierAssignment[];

      service.setTiers('agent-1', tiers);

      expect(service.getTiers('agent-1')).toEqual(tiers);
    });
  });

  describe('getProviders', () => {
    it('returns null when not cached', () => {
      expect(service.getProviders('agent-1')).toBeNull();
    });

    it('returns cached data within TTL', () => {
      const providers = [{ id: 'up-1', provider: 'openai' }] as TenantProvider[];
      service.setProviders('agent-1', providers);

      const result = service.getProviders('agent-1');
      expect(result).toEqual(providers);
    });

    it('returns null after TTL expires', () => {
      jest.useFakeTimers();
      const providers = [{ id: 'up-1', provider: 'openai' }] as TenantProvider[];
      service.setProviders('agent-1', providers);

      jest.advanceTimersByTime(120_001);

      expect(service.getProviders('agent-1')).toBeNull();
    });
  });

  describe('setProviders', () => {
    it('stores data that can be retrieved', () => {
      const providers = [
        { id: 'up-1', provider: 'openai' },
        { id: 'up-2', provider: 'anthropic' },
      ] as TenantProvider[];

      service.setProviders('agent-1', providers);

      expect(service.getProviders('agent-1')).toEqual(providers);
    });
  });

  describe('getCustomProviders', () => {
    it('returns null when not cached', () => {
      expect(service.getCustomProviders('agent-1')).toBeNull();
    });

    it('returns cached data within TTL', () => {
      const cps = [{ id: 'cp-1', name: 'Groq' }] as CustomProvider[];
      service.setCustomProviders('agent-1', cps);

      expect(service.getCustomProviders('agent-1')).toEqual(cps);
    });

    it('returns null after TTL expires', () => {
      jest.useFakeTimers();
      const cps = [{ id: 'cp-1', name: 'Groq' }] as CustomProvider[];
      service.setCustomProviders('agent-1', cps);

      jest.advanceTimersByTime(120_001);

      expect(service.getCustomProviders('agent-1')).toBeNull();
    });
  });

  describe('setCustomProviders', () => {
    it('stores data that can be retrieved', () => {
      const cps = [
        { id: 'cp-1', name: 'Groq' },
        { id: 'cp-2', name: 'Together' },
      ] as CustomProvider[];

      service.setCustomProviders('agent-1', cps);

      expect(service.getCustomProviders('agent-1')).toEqual(cps);
    });
  });

  describe('setWithEviction', () => {
    it('evicts oldest entry when cache reaches MAX_ENTRIES', () => {
      const tiersMap = (service as unknown as { tiers: Map<string, unknown> }).tiers;
      for (let i = 0; i < 5_000; i++) {
        tiersMap.set(`agent-${i}`, { data: [], expiresAt: Date.now() + 120_000 });
      }
      expect(tiersMap.size).toBe(5_000);

      service.setTiers('new-agent', [{ id: 'ta-new' }] as TierAssignment[]);

      expect(tiersMap.size).toBe(5_000);
      expect(tiersMap.has('agent-0')).toBe(false);
    });

    it('does not evict when updating an existing key at capacity', () => {
      const tiersMap = (service as unknown as { tiers: Map<string, unknown> }).tiers;
      for (let i = 0; i < 5_000; i++) {
        tiersMap.set(`agent-${i}`, { data: [], expiresAt: Date.now() + 120_000 });
      }

      service.setTiers('agent-0', [{ id: 'ta-updated' }] as TierAssignment[]);

      expect(tiersMap.size).toBe(5_000);
      expect(tiersMap.has('agent-0')).toBe(true);
      expect(tiersMap.has('agent-1')).toBe(true);
    });
  });

  describe('getProviderKeys', () => {
    it('returns undefined when not cached', () => {
      expect(service.getProviderKeys('user-1', 'openai')).toBeUndefined();
    });

    it('returns cached chain within TTL', () => {
      const chain = [providerKey('Default', 'sk-test-123')];
      service.setProviderKeys('user-1', 'openai', chain);

      expect(service.getProviderKeys('user-1', 'openai')).toBe(chain);
    });

    it('returns cached empty array within TTL', () => {
      service.setProviderKeys('user-1', 'openai', []);

      expect(service.getProviderKeys('user-1', 'openai')).toEqual([]);
    });

    it('returns undefined after TTL expires', () => {
      jest.useFakeTimers();
      service.setProviderKeys('user-1', 'openai', [providerKey('Default', 'sk-test-123')]);

      jest.advanceTimersByTime(120_001);

      expect(service.getProviderKeys('user-1', 'openai')).toBeUndefined();
    });

    it('isolates chains by provider', () => {
      service.setProviderKeys('user-1', 'openai', [providerKey('Default', 'sk-openai')]);
      service.setProviderKeys('user-1', 'anthropic', [providerKey('Default', 'sk-ant')]);

      expect(service.getProviderKeys('user-1', 'openai')?.[0].apiKey).toBe('sk-openai');
      expect(service.getProviderKeys('user-1', 'anthropic')?.[0].apiKey).toBe('sk-ant');
    });

    it('isolates chains by authType', () => {
      service.setProviderKeys('user-1', 'anthropic', [providerKey('Default', 'sk-key')], 'api_key');
      service.setProviderKeys(
        'user-1',
        'anthropic',
        [providerKey('Default', 'tok-sub')],
        'subscription',
      );

      expect(service.getProviderKeys('user-1', 'anthropic', 'api_key')?.[0].apiKey).toBe('sk-key');
      expect(service.getProviderKeys('user-1', 'anthropic', 'subscription')?.[0].apiKey).toBe(
        'tok-sub',
      );
    });

    it('isolates agent-scoped chains from the user-global chain', () => {
      // Same user + provider + authType, but the agent-scoped entry lives under
      // a separate key (the trailing agentId segment), so the two never collide.
      service.setProviderKeys('user-1', 'openai', [providerKey('Default', 'sk-global')]);
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-agent')],
        undefined,
        'agent-1',
      );

      expect(service.getProviderKeys('user-1', 'openai')?.[0].apiKey).toBe('sk-global');
      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')?.[0].apiKey).toBe(
        'sk-agent',
      );
    });
  });

  describe('invalidateAgent', () => {
    it('clears tiers and provider key chains for agent; providers remain user-scoped', () => {
      const tiers = [{ id: 'ta-1', tier: 'fast' }] as TierAssignment[];
      // Providers and customProviders are user-scoped — stored under userId 'user-1', not agentId 'agent-1'.
      const providers = [{ id: 'up-1', provider: 'openai' }] as TenantProvider[];
      const cps = [{ id: 'cp-1', name: 'Groq' }] as CustomProvider[];

      service.setTiers('agent-1', tiers);
      service.setProviders('user-1', providers);
      service.setCustomProviders('user-1', cps);
      // Agent-scoped key chain — keyed with the trailing agentId segment.
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-test')],
        undefined,
        'agent-1',
      );

      expect(service.getTiers('agent-1')).toEqual(tiers);
      expect(service.getProviders('user-1')).toEqual(providers);
      expect(service.getCustomProviders('user-1')).toEqual(cps);
      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')?.[0].apiKey).toBe(
        'sk-test',
      );

      service.invalidateAgent('agent-1');

      // Agent-scoped caches cleared
      expect(service.getTiers('agent-1')).toBeNull();
      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')).toBeUndefined();

      // User-scoped provider caches NOT cleared by invalidateAgent
      expect(service.getProviders('user-1')).not.toBeNull();
      expect(service.getCustomProviders('user-1')).not.toBeNull();
    });

    it('does not clear provider key chains for other agents', () => {
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-1')],
        undefined,
        'agent-1',
      );
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-2')],
        undefined,
        'agent-2',
      );

      service.invalidateAgent('agent-1');

      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')).toBeUndefined();
      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-2')?.[0].apiKey).toBe(
        'sk-2',
      );
    });

    it('leaves the user-global key chain intact (only agent-scoped entries cleared)', () => {
      service.setProviderKeys('user-1', 'openai', [providerKey('Default', 'sk-global')]);
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-agent')],
        undefined,
        'agent-1',
      );

      service.invalidateAgent('agent-1');

      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')).toBeUndefined();
      expect(service.getProviderKeys('user-1', 'openai')?.[0].apiKey).toBe('sk-global');
    });

    it('is a no-op for unknown agent', () => {
      // Should not throw when called with an agent that has no cached data
      expect(() => service.invalidateAgent('nonexistent-agent')).not.toThrow();
    });

    it('clears specificity cache for agent', () => {
      const assignments = [{ id: 'sa-1', category: 'coding' }] as SpecificityAssignment[];
      service.setSpecificity('agent-1', assignments);
      expect(service.getSpecificity('agent-1')).toEqual(assignments);

      service.invalidateAgent('agent-1');

      expect(service.getSpecificity('agent-1')).toBeNull();
    });
  });

  describe('invalidateTenant', () => {
    it('clears providers, custom providers, and every key chain for the tenant', () => {
      const providers = [{ id: 'up-1', provider: 'openai' }] as TenantProvider[];
      const cps = [{ id: 'cp-1', name: 'Groq' }] as CustomProvider[];
      service.setProviders('user-1', providers);
      service.setCustomProviders('user-1', cps);
      // Both a tenant-global and an agent-scoped chain for the same tenant.
      service.setProviderKeys('user-1', 'openai', [providerKey('Default', 'sk-global')]);
      service.setProviderKeys(
        'user-1',
        'openai',
        [providerKey('Default', 'sk-agent')],
        undefined,
        'agent-1',
      );
      // A different tenant's chain must survive.
      service.setProviderKeys('user-2', 'openai', [providerKey('Default', 'sk-other')]);

      service.invalidateTenant('user-1');

      expect(service.getProviders('user-1')).toBeNull();
      expect(service.getCustomProviders('user-1')).toBeNull();
      expect(service.getProviderKeys('user-1', 'openai')).toBeUndefined();
      expect(service.getProviderKeys('user-1', 'openai', undefined, 'agent-1')).toBeUndefined();
      // Other user untouched.
      expect(service.getProviderKeys('user-2', 'openai')?.[0].apiKey).toBe('sk-other');
    });
  });

  describe('getSpecificity', () => {
    it('returns null when not cached', () => {
      expect(service.getSpecificity('agent-1')).toBeNull();
    });

    it('returns cached data within TTL', () => {
      const assignments = [
        { id: 'sa-1', category: 'coding' },
        { id: 'sa-2', category: 'web_browsing' },
      ] as SpecificityAssignment[];
      service.setSpecificity('agent-1', assignments);

      expect(service.getSpecificity('agent-1')).toEqual(assignments);
    });

    it('returns null after TTL expires', () => {
      jest.useFakeTimers();
      const assignments = [{ id: 'sa-1', category: 'coding' }] as SpecificityAssignment[];
      service.setSpecificity('agent-1', assignments);

      jest.advanceTimersByTime(120_001);

      expect(service.getSpecificity('agent-1')).toBeNull();
    });
  });

  describe('setSpecificity', () => {
    it('stores data that can be retrieved', () => {
      const assignments = [
        { id: 'sa-1', category: 'coding' },
        { id: 'sa-2', category: 'data_analysis' },
      ] as SpecificityAssignment[];

      service.setSpecificity('agent-1', assignments);

      expect(service.getSpecificity('agent-1')).toEqual(assignments);
    });
  });

  describe('invalidation listeners', () => {
    it('fires registered listeners with the agentId on invalidateAgent', () => {
      const listener = jest.fn();
      service.addInvalidationListener(listener);

      service.invalidateAgent('agent-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('agent-1');
    });

    it('fires every registered listener', () => {
      const a = jest.fn();
      const b = jest.fn();
      service.addInvalidationListener(a);
      service.addInvalidationListener(b);

      service.invalidateAgent('agent-2');

      expect(a).toHaveBeenCalledWith('agent-2');
      expect(b).toHaveBeenCalledWith('agent-2');
    });

    it('does not fire listeners when none are registered', () => {
      // Pure smoke check that invalidateAgent stays a no-op-safe path.
      expect(() => service.invalidateAgent('agent-3')).not.toThrow();
    });
  });

  describe('tenant invalidation listeners', () => {
    it('fires registered listeners with the tenantId on invalidateTenant', () => {
      const listener = jest.fn();
      service.addTenantInvalidationListener(listener);

      service.invalidateTenant('tenant-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('tenant-1');
    });

    it('keeps invalidating and reaches later listeners when one throws', () => {
      const failing = jest.fn(() => {
        throw new Error('boom');
      });
      const next = jest.fn();
      service.addTenantInvalidationListener(failing);
      service.addTenantInvalidationListener(next);

      expect(() => service.invalidateTenant('tenant-2')).not.toThrow();
      expect(next).toHaveBeenCalledWith('tenant-2');
    });

    it('does not fire agent listeners on a tenant invalidation', () => {
      const agentListener = jest.fn();
      service.addInvalidationListener(agentListener);

      service.invalidateTenant('tenant-3');

      expect(agentListener).not.toHaveBeenCalled();
    });
  });
});
