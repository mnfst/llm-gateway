import type { ModelRoute } from 'manifest-shared';
import { ProviderService } from '../provider.service';
import { TenantProvider } from '../../../entities/tenant-provider.entity';
import { TierAssignment } from '../../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import { Agent } from '../../../entities/agent.entity';
import { HeaderTier } from '../../../entities/header-tier.entity';
import type { Repository } from 'typeorm';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';

const route = (provider: string, model: string): ModelRoute =>
  ({ provider, authType: 'api_key', model }) as ModelRoute;

const makeQueryBuilder = () => ({
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue([{ id: 'agent-1' }]),
});
const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  insert: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockImplementation(async (rows) => rows),
  delete: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  manager: { transaction: jest.fn() },
  createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder()),
});

const provRow = (over: Partial<TenantProvider>): TenantProvider =>
  ({
    id: 'p',
    agent_id: 'agent-1',
    tenant_id: 'tenant-1',
    provider: 'openai',
    auth_type: 'api_key',
    label: 'Default',
    priority: 0,
    is_active: true,
    ...over,
  }) as unknown as TenantProvider;

describe('ProviderService — coverage completion', () => {
  let providerRepo: ReturnType<typeof makeRepo>;
  let tierRepo: ReturnType<typeof makeRepo>;
  let specRepo: ReturnType<typeof makeRepo>;
  let headerTierRepo: ReturnType<typeof makeRepo>;
  let routingCache: {
    invalidateAgent: jest.Mock;
    invalidateTenant: jest.Mock;
    getProviders: jest.Mock;
    setProviders: jest.Mock;
  };
  let svc: ProviderService;
  const priv = () => svc as unknown as Record<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    providerRepo = makeRepo();
    tierRepo = makeRepo();
    specRepo = makeRepo();
    headerTierRepo = makeRepo();
    routingCache = {
      invalidateAgent: jest.fn(),
      invalidateTenant: jest.fn(),
      getProviders: jest.fn().mockReturnValue(null),
      setProviders: jest.fn(),
    };
    svc = new ProviderService(
      providerRepo as unknown as Repository<TenantProvider>,
      tierRepo as unknown as Repository<TierAssignment>,
      specRepo as unknown as Repository<SpecificityAssignment>,
      makeRepo() as unknown as Repository<Agent>,
      headerTierRepo as unknown as Repository<HeaderTier>,
      { getByModel: jest.fn().mockReturnValue(undefined) } as unknown as ModelPricingCacheService,
      routingCache as unknown as RoutingCacheService,
    );
  });

  describe('reorderKeys', () => {
    it('throws when no active rows exist', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({ is_active: false })]);
      await expect(svc.reorderKeys('a', 't', 'openai', 'api_key', [])).rejects.toThrow(
        'Provider not found',
      );
    });
    it('throws when the label count does not match', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({ label: 'A' }), provRow({ label: 'B' })]);
      await expect(svc.reorderKeys('a', 't', 'openai', 'api_key', ['A'])).rejects.toThrow(
        'exactly 2 labels',
      );
    });
    it('throws on a duplicate label', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({ label: 'A' }), provRow({ label: 'B' })]);
      await expect(svc.reorderKeys('a', 't', 'openai', 'api_key', ['A', 'A'])).rejects.toThrow(
        'Duplicate label "A"',
      );
    });
    it('throws on an unknown label', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({ label: 'A' }), provRow({ label: 'B' })]);
      await expect(svc.reorderKeys('a', 't', 'openai', 'api_key', ['A', 'C'])).rejects.toThrow(
        'Unknown label "C"',
      );
    });
    it('reorders rows and assigns priorities by position', async () => {
      providerRepo.find.mockResolvedValueOnce([
        provRow({ label: 'A', priority: 0 }),
        provRow({ label: 'B', priority: 1 }),
      ]);
      const out = await svc.reorderKeys('agent-1', 'tenant-1', 'openai', 'api_key', ['B', 'A']);
      expect(out.map((r) => [r.label, r.priority])).toEqual([
        ['B', 0],
        ['A', 1],
      ]);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('renameKey', () => {
    it('rejects a name that collides with another key', async () => {
      providerRepo.find.mockResolvedValueOnce([
        provRow({ id: 't', label: 'Old' }),
        provRow({ id: 'o', label: 'Taken' }),
      ]);
      await expect(
        svc.renameKey('a', 'tenant-1', 'openai', 'api_key', 'Old', 'Taken'),
      ).rejects.toThrow('already exists');
    });
    it('rewrites pinned fallback routes on specificity and header tiers', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({ id: 't', label: 'Old' })]);
      const match = { ...route('openai', 'gpt-4o'), keyLabel: 'Old' };
      specRepo.find.mockResolvedValueOnce([
        { agent_id: 'agent-1', override_route: null, fallback_routes: [match] },
      ]);
      headerTierRepo.find.mockResolvedValueOnce([
        { agent_id: 'agent-1', override_route: null, fallback_routes: [match] },
      ]);
      await svc.renameKey('agent-1', 'tenant-1', 'openai', 'api_key', 'Old', 'New');
      expect(specRepo.save).toHaveBeenCalled();
      expect(headerTierRepo.save).toHaveBeenCalled();
    });
  });

  describe('retagAuthType', () => {
    it('removes a colliding row, flips auth_type, and invalidates caches', async () => {
      const txRepo = makeRepo();
      txRepo.find.mockResolvedValueOnce([
        provRow({ id: 'src', auth_type: 'local', label: 'Default' }),
        provRow({ id: 'dst', auth_type: 'api_key', label: 'Default' }),
      ]);
      providerRepo.manager.transaction.mockImplementation(
        async (cb: (m: { getRepository: () => unknown }) => unknown) =>
          cb({ getRepository: () => txRepo }),
      );
      await svc.retagAuthType('agent-1', 'tenant-1', 'lmstudio', 'api_key');
      expect(txRepo.remove).toHaveBeenCalled();
      expect(txRepo.save).toHaveBeenCalled();
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });
    it('is a no-op when there is no row to retag', async () => {
      const txRepo = makeRepo();
      txRepo.find.mockResolvedValueOnce([provRow({ auth_type: 'api_key' })]);
      providerRepo.manager.transaction.mockImplementation(
        async (cb: (m: { getRepository: () => unknown }) => unknown) =>
          cb({ getRepository: () => txRepo }),
      );
      await svc.retagAuthType(null, 'tenant-1', 'lmstudio', 'api_key');
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateTenant).not.toHaveBeenCalled();
    });
  });

  describe('removeProvider route guards', () => {
    it('blocks disconnect when a tier fallback route pins the provider', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({})]);
      tierRepo.find.mockResolvedValueOnce([
        { tier: 'standard', override_route: null, fallback_routes: [route('OpenAI', 'gpt-4o')] },
      ]);
      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
    });
    it('blocks disconnect when a specificity override route pins the provider', async () => {
      providerRepo.find.mockResolvedValueOnce([provRow({})]);
      specRepo.find.mockResolvedValueOnce([
        { category: 'coding', override_route: route('OpenAI', 'gpt-4o'), fallback_routes: null },
      ]);
      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
    });
  });

  it('routeBelongsToProviderRows matches a route against a row by cached model id', () => {
    const row = provRow({
      provider: 'openrouter',
      cached_models: [{ id: 'Foo-Model' }] as unknown as TenantProvider['cached_models'],
      priority: 0,
    });
    expect(
      priv().routeBelongsToProviderRows({ authType: 'api_key', model: 'foo-model' }, [row]),
    ).toBe(true);
  });

  it('routeBelongsToProviderRows rejects providerless routes for the wrong key', () => {
    const row = provRow({
      provider: 'openrouter',
      auth_type: 'subscription',
      cached_models: [{ id: 'Foo-Model' }] as unknown as TenantProvider['cached_models'],
      priority: 0,
    });
    expect(
      priv().routeBelongsToProviderRows({ authType: 'api_key', model: 'foo-model' }, [row]),
    ).toBe(false);

    const secondary = provRow({
      provider: 'openrouter',
      cached_models: [{ id: 'Foo-Model' }] as unknown as TenantProvider['cached_models'],
      priority: 1,
    });
    expect(
      priv().routeBelongsToProviderRows({ authType: 'api_key', model: 'foo-model' }, [secondary]),
    ).toBe(false);
  });

  it('normalizeLabel rejects empty and local custom labels', () => {
    expect(() => priv().normalizeLabel('   ', 'api_key')).toThrow('must not be empty');
    expect(() => priv().normalizeLabel('Custom', 'local')).toThrow('not supported for local');
  });

  it('assertLabelLooksValid rejects empty and overly long labels', () => {
    expect(() => priv().assertLabelLooksValid('')).toThrow('must not be empty');
    expect(() => priv().assertLabelLooksValid('x'.repeat(300))).toThrow('at most');
  });

  it('decryptOrNull returns null for ciphertext that cannot be decrypted', () => {
    expect(priv().decryptOrNull('not-real-ciphertext')).toBeNull();
  });

  it('nextOAuthLabel falls back to Key N+1 when the candidate range is exhausted', async () => {
    const rows = Array.from({ length: 99 }, (_, i) =>
      provRow({ id: `k${i}`, label: `Key ${i + 1}` }),
    );
    providerRepo.find.mockResolvedValueOnce(rows);
    expect(await svc.nextOAuthLabel('tenant-1', 'anthropic')).toBe('Key 100');
  });

  it('cleanupUnsupportedSubscriptionProviders deactivates unusable subscription rows', async () => {
    providerRepo.find.mockResolvedValueOnce([
      provRow({ id: 'sub', provider: 'somecustomsub', auth_type: 'subscription' }),
      provRow({ id: 'key', provider: 'openai', auth_type: 'api_key' }),
    ]);
    await priv().cleanupUnsupportedSubscriptionProviders('tenant-1');
    expect(providerRepo.save).toHaveBeenCalled();
    expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
  });
});
