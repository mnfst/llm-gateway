import { MAX_KEYS_PER_PROVIDER, type ModelRoute } from 'manifest-shared';
import { ProviderService } from '../provider.service';
import { CredentialHealthService } from '../credential-health.service';
import { TenantProvider } from '../../../entities/tenant-provider.entity';
import { TierAssignment } from '../../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import { Agent } from '../../../entities/agent.entity';
import { HeaderTier } from '../../../entities/header-tier.entity';
import { AgentEnabledProvider } from '../../../entities/agent-enabled-provider.entity';
import { makeShortTermBedrockKey } from '../../__tests__/bedrock-fixtures';
import { In, type Repository } from 'typeorm';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { encrypt, getEncryptionSecret } from '../../../common/utils/crypto.util';

const route = (
  provider: string,
  model: string,
  authType: ModelRoute['authType'] = 'api_key',
): ModelRoute => ({
  provider,
  authType,
  model,
});

type AgentRow = string | { id: string; name?: string | null; display_name?: string | null };

const makeQueryBuilder = (agents: AgentRow[] = ['agent-1']) => ({
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  getRawMany: jest.fn().mockResolvedValue(
    agents.map((agent) =>
      typeof agent === 'string'
        ? { id: agent, name: agent, display_name: null }
        : {
            id: agent.id,
            name: agent.name ?? agent.id,
            display_name: agent.display_name ?? null,
          },
    ),
  ),
});

const makeRepo = (agents: AgentRow[] = ['agent-1']) => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  insert: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockImplementation(async (rows) => rows),
  delete: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  manager: { transaction: jest.fn(), getRepository: jest.fn() },
  createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(agents)),
});

describe('ProviderService — route-only cleanup paths', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  let providerRepo: ReturnType<typeof makeRepo>;
  let tierRepo: ReturnType<typeof makeRepo>;
  let specRepo: ReturnType<typeof makeRepo>;
  let headerTierRepo: ReturnType<typeof makeRepo>;
  let pricingCache: jest.Mocked<Pick<ModelPricingCacheService, 'getByModel'>>;
  let routingCache: {
    getProviders: jest.Mock;
    setProviders: jest.Mock;
    invalidateAgent: jest.Mock;
    invalidateTenant: jest.Mock;
  };
  let svc: ProviderService;

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    providerRepo = makeRepo();
    tierRepo = makeRepo();
    specRepo = makeRepo();
    headerTierRepo = makeRepo();
    pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    routingCache = {
      getProviders: jest.fn().mockReturnValue(null),
      setProviders: jest.fn(),
      invalidateAgent: jest.fn(),
      invalidateTenant: jest.fn(),
    };

    svc = new ProviderService(
      providerRepo as unknown as Repository<TenantProvider>,
      tierRepo as unknown as Repository<TierAssignment>,
      specRepo as unknown as Repository<SpecificityAssignment>,
      makeRepo() as unknown as Repository<Agent>,
      headerTierRepo as unknown as Repository<HeaderTier>,
      pricingCache as unknown as ModelPricingCacheService,
      routingCache as unknown as RoutingCacheService,
    );
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  describe('removeProvider — route guards', () => {
    it('blocks disconnect when a tier override uses the provider', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('OpenAI', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('blocks disconnect using model-prefix matching for routes with no explicit provider', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'custom-x',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: { provider: '', authType: 'api_key', model: 'custom-x/some' },
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'custom-x')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('blocks disconnect using pricing cache attribution for opaque model names', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      pricingCache.getByModel.mockReturnValue({ provider: 'openai' } as never);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: { provider: '', authType: 'api_key', model: 'opaque-id' },
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('blocks disconnect when specificity or header-tier fallbacks use the provider', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([]);
      specRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          category: 'coding',
          override_route: null,
          fallback_routes: [route('anthropic', 'claude-sonnet'), route('openai', 'gpt-4o-mini')],
        } as unknown as SpecificityAssignment,
      ]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('deactivates the provider when no user-controlled routes reference it', async () => {
      const row = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 0,
        is_active: true,
      } as unknown as TenantProvider;
      providerRepo.find.mockResolvedValueOnce([row]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: { provider: 'other', authType: 'api_key', model: 'custom-x/some' },
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      const result = await svc.removeProvider('agent-1', 'tenant-1', 'openai');

      expect(row.is_active).toBe(false);
      expect(providerRepo.save).toHaveBeenCalledWith([row]);
      expect(tierRepo.save).not.toHaveBeenCalled();
      expect(specRepo.save).not.toHaveBeenCalled();
      expect(result.notifications).toEqual([]);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('skips route checks when the tenant has no owned agents', async () => {
      const row = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 0,
        is_active: true,
      } as unknown as TenantProvider;
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        makeRepo([]) as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
      );
      providerRepo.find.mockResolvedValueOnce([row]);

      await expect(localSvc.removeProvider(null, 'tenant-1', 'openai')).resolves.toEqual({
        notifications: [],
      });

      expect(tierRepo.find).not.toHaveBeenCalled();
      expect(row.is_active).toBe(false);
      expect(providerRepo.save).toHaveBeenCalledWith([row]);
    });

    it('ignores inactive specificity rows and disabled header tiers', async () => {
      const row = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 0,
        is_active: true,
      } as unknown as TenantProvider;
      providerRepo.find.mockResolvedValueOnce([row]);
      tierRepo.find.mockResolvedValueOnce([]);
      specRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          category: 'coding',
          is_active: false,
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      headerTierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          name: 'Debug',
          enabled: false,
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as HeaderTier,
      ]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).resolves.toEqual({
        notifications: [],
      });

      expect(providerRepo.save).toHaveBeenCalledWith([row]);
    });

    it('ignores routes on agents where the target provider is not enabled', async () => {
      const row = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 0,
        is_active: true,
      } as unknown as TenantProvider;
      const agentRepo = makeRepo([{ id: 'agent-1', name: 'support-bot' }]);
      const enabledRepo = makeRepo();
      enabledRepo.find.mockResolvedValueOnce([]);
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        agentRepo as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
        enabledRepo as unknown as Repository<AgentEnabledProvider>,
      );
      providerRepo.find.mockResolvedValueOnce([row]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValueOnce([]);
      headerTierRepo.find.mockResolvedValueOnce([]);

      await expect(localSvc.removeProvider('agent-1', 'tenant-1', 'openai')).resolves.toEqual({
        notifications: [],
      });

      expect(providerRepo.save).toHaveBeenCalledWith([row]);
      expect(enabledRepo.delete).toHaveBeenCalledWith({ tenant_provider_id: In(['p1']) });
    });

    it('blocks routes on agents where the target provider is enabled', async () => {
      const row = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 0,
        is_active: true,
      } as unknown as TenantProvider;
      const agentRepo = makeRepo([{ id: 'agent-1', name: 'support-bot' }]);
      const enabledRepo = makeRepo();
      enabledRepo.find.mockResolvedValueOnce([
        { agent_id: 'agent-1', tenant_provider_id: 'p1' } as AgentEnabledProvider,
      ]);
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        agentRepo as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
        enabledRepo as unknown as Repository<AgentEnabledProvider>,
      );
      providerRepo.find.mockResolvedValueOnce([row]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);

      await expect(localSvc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        'Update routing first (agent "support-bot", tier standard, primary: gpt-4o).',
      );

      expect(providerRepo.save).not.toHaveBeenCalled();
      expect(enabledRepo.delete).not.toHaveBeenCalled();
    });

    it('blocks only disconnected auth-type routes when another auth type stays active', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p-sub',
          agent_id: 'agent-1',
          provider: 'anthropic',
          auth_type: 'subscription',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('anthropic', 'claude-sonnet-4-6', 'subscription'),
          fallback_routes: [route('anthropic', 'claude-haiku-4-6', 'api_key')],
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(
        svc.removeProvider('agent-1', 'tenant-1', 'anthropic', 'subscription'),
      ).rejects.toThrow(/Cannot disconnect provider/);
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when no provider record exists', async () => {
      providerRepo.findOne.mockResolvedValue(null);
      await expect(svc.removeProvider('agent-1', 'tenant-1', 'missing')).rejects.toThrow();
    });

    it('returns no notifications when no tiers/specs reference the provider', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
      });
      providerRepo.find.mockResolvedValue([]);
      tierRepo.find.mockResolvedValueOnce([]);
      tierRepo.find.mockResolvedValueOnce([]);
      specRepo.find.mockResolvedValue([]);

      const result = await svc.removeProvider('agent-1', 'tenant-1', 'openai');
      expect(result.notifications).toEqual([]);
    });
  });

  describe('upsertProvider — Bedrock region', () => {
    let originalSecret: string | undefined;

    beforeEach(() => {
      originalSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
    });

    afterEach(() => {
      if (originalSecret === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = originalSecret;
      }
    });

    it('infers the region from a short-term Bedrock API key', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'user-1',
        'bedrock',
        makeShortTermBedrockKey('eu-west-1'),
      );

      const inserted = providerRepo.insert.mock.calls[0][0] as TenantProvider;
      expect(inserted.region).toBe('eu-west-1');
    });

    it('falls back to the default region when a short-term Bedrock key uses an unsupported Mantle region', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'user-1',
        'bedrock',
        makeShortTermBedrockKey('eu-west-3'),
      );

      const inserted = providerRepo.insert.mock.calls[0][0] as TenantProvider;
      expect(inserted.region).toBe('us-east-1');
    });

    it('uses an explicitly selected Bedrock region over key inference', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'user-1',
        'bedrock',
        makeShortTermBedrockKey('eu-west-3'),
        'api_key',
        'us-west-2',
      );

      const inserted = providerRepo.insert.mock.calls[0][0] as TenantProvider;
      expect(inserted.region).toBe('us-west-2');
    });

    it('accepts raw AWS bearer token shaped Bedrock keys without region inference', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider('agent-1', 'user-1', 'bedrock', 'ABSKTWFudGxlQXBpS2V5LWV4YW1wbGU=');

      const inserted = providerRepo.insert.mock.calls[0][0] as TenantProvider;
      expect(inserted.region).toBe('us-east-1');
      expect(inserted.key_prefix).toBe('ABSKTWFu');
    });
  });

  describe('upsertProvider — credential health', () => {
    const originalSecret = process.env['BETTER_AUTH_SECRET'];
    beforeAll(() => {
      process.env['BETTER_AUTH_SECRET'] = 'a'.repeat(48);
    });
    afterAll(() => {
      if (originalSecret === undefined) delete process.env['BETTER_AUTH_SECRET'];
      else process.env['BETTER_AUTH_SECRET'] = originalSecret;
    });

    const makeSvcWithHealth = (health: CredentialHealthService) =>
      new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        makeRepo() as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
        undefined,
        health,
      );

    const existingRow = {
      id: 'p1',
      tenant_id: 'tenant-1',
      provider: 'openai',
      auth_type: 'api_key',
      label: 'Default',
      priority: 0,
      api_key_encrypted: 'enc-old',
      key_prefix: 'sk-old',
      region: null,
      is_active: true,
    };

    it('clears the tracked failure when the legacy Default row is reconnected', async () => {
      const health = new CredentialHealthService();
      health.markRejected('p1', 'sk-old', { statusCode: 401, reason: 'api_key_rejected' });
      providerRepo.findOne.mockResolvedValue({ ...existingRow });

      await makeSvcWithHealth(health).upsertProvider('agent-1', 'tenant-1', 'openai', 'sk-new');

      expect(health.getSnapshot('p1').requires_reauth).toBe(false);
    });

    it('clears the tracked failure when a labeled row is reconnected', async () => {
      const health = new CredentialHealthService();
      health.markRejected('p1', 'sk-old', { statusCode: 401, reason: 'api_key_rejected' });
      providerRepo.find.mockResolvedValue([{ ...existingRow, label: 'Work' }]);

      await makeSvcWithHealth(health).upsertProvider(
        'agent-1',
        'tenant-1',
        'openai',
        'sk-new',
        'api_key',
        undefined,
        'Work',
      );

      expect(health.getSnapshot('p1').requires_reauth).toBe(false);
    });
  });

  describe('removeProvider — removeKeyByLabel', () => {
    it('throws NotFoundException when no keys match the (provider, auth_type)', async () => {
      providerRepo.find.mockResolvedValue([]);
      await expect(
        svc.removeProvider('agent-1', 'tenant-1', 'openai', 'api_key', 'default'),
      ).rejects.toThrow('Provider not found');
    });

    it('throws NotFoundException when no key carries the requested label', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'primary',
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      await expect(
        svc.removeProvider('agent-1', 'tenant-1', 'openai', 'api_key', 'secondary'),
      ).rejects.toThrow('Provider key not found');
    });

    it('does not block removing a non-primary Default-labeled key used only by an unlabeled route', async () => {
      const target = {
        id: 'target',
        agent_id: 'agent-1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        priority: 1,
        is_active: true,
      } as unknown as TenantProvider;
      providerRepo.find.mockResolvedValue([
        target,
        {
          id: 'primary',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Work',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValue([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(
        svc.removeProvider('agent-1', 'tenant-1', 'openai', 'api_key', 'Default'),
      ).resolves.toEqual({ notifications: [] });

      expect(providerRepo.remove).toHaveBeenCalledWith(target);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('deletes exact usage history before hard-deleting an inactive labeled key', async () => {
      const messageRepo = makeRepo();
      const enabledRepo = makeRepo();
      const messages = [
        { id: 'target-1', tenant_id: 'tenant-1', tenant_provider_id: 'inactive-sub' },
        { id: 'target-2', tenant_id: 'tenant-1', tenant_provider_id: 'inactive-sub' },
        { id: 'other-tenant', tenant_id: 'tenant-2', tenant_provider_id: 'inactive-sub' },
        { id: 'other-key', tenant_id: 'tenant-1', tenant_provider_id: 'active-sub' },
        { id: 'legacy-null', tenant_id: 'tenant-1', tenant_provider_id: null },
      ];
      const target = {
        id: 'inactive-sub',
        agent_id: null,
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Old Claude',
        priority: 0,
        is_active: false,
      } as unknown as TenantProvider;
      providerRepo.find.mockImplementation(async (options?: { order?: unknown }) =>
        options?.order ? [] : [target],
      );
      messageRepo.delete.mockImplementation(async ({ tenant_id, tenant_provider_id }) => {
        const before = messages.length;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (
            message.tenant_id === tenant_id &&
            message.tenant_provider_id === tenant_provider_id
          ) {
            messages.splice(index, 1);
          }
        }
        return { affected: before - messages.length, raw: [] };
      });
      providerRepo.manager.getRepository.mockReturnValue(messageRepo);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        makeRepo() as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
        enabledRepo as unknown as Repository<AgentEnabledProvider>,
      );

      await expect(
        localSvc.removeProvider('agent-1', 'tenant-1', 'anthropic', 'subscription', 'Old Claude'),
      ).resolves.toEqual({ notifications: [] });

      expect(messageRepo.delete).toHaveBeenCalledWith({
        tenant_id: 'tenant-1',
        tenant_provider_id: 'inactive-sub',
      });
      expect(messages).toEqual([
        { id: 'other-tenant', tenant_id: 'tenant-2', tenant_provider_id: 'inactive-sub' },
        { id: 'other-key', tenant_id: 'tenant-1', tenant_provider_id: 'active-sub' },
        { id: 'legacy-null', tenant_id: 'tenant-1', tenant_provider_id: null },
      ]);
      expect(messageRepo.delete.mock.invocationCallOrder[0]).toBeLessThan(
        providerRepo.remove.mock.invocationCallOrder[0],
      );
      expect(providerRepo.remove).toHaveBeenCalledWith(target);
      expect(enabledRepo.delete).toHaveBeenCalledWith({
        tenant_provider_id: In(['inactive-sub']),
      });
      expect(providerRepo.save).not.toHaveBeenCalled();
      expect(providerRepo.findOne).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('deactivateAllProviders', () => {
    it('updates providers and invalidates cache when no routes reference them', async () => {
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await svc.deactivateAllProviders('agent-1', 'tenant-1');

      expect(providerRepo.update).toHaveBeenCalledWith(
        { tenant_id: 'tenant-1' },
        expect.objectContaining({ is_active: false }),
      );
      expect(tierRepo.update).not.toHaveBeenCalled();
      expect(headerTierRepo.update).not.toHaveBeenCalled();
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('invalidates every owned agent, not just the triggering one', async () => {
      // The deactivation is user-wide, so a sibling agent's cache must also be
      // dropped even though the request came from agent-1.
      const agentRepo = makeRepo(['agent-1', 'agent-2']);
      const cache = {
        getProviders: jest.fn().mockReturnValue(null),
        setProviders: jest.fn(),
        invalidateAgent: jest.fn(),
        invalidateTenant: jest.fn(),
      };
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        agentRepo as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        cache as unknown as RoutingCacheService,
      );
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await localSvc.deactivateAllProviders('agent-1', 'user-1');

      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(cache.invalidateAgent).toHaveBeenCalledWith('agent-2');
      expect(cache.invalidateTenant).toHaveBeenCalledWith('user-1');
    });

    it('blocks bulk disable when a route references an active provider', async () => {
      const agentRepo = makeRepo([
        { id: 'agent-1', name: 'support-bot', display_name: 'Support Bot' },
      ]);
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        agentRepo as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
      );
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          tier: 'standard',
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([]);

      await expect(localSvc.deactivateAllProviders('agent-1', 'tenant-1')).rejects.toThrow(
        'Update routing first (agent "Support Bot", tier standard, primary: gpt-4o).',
      );
      expect(providerRepo.update).not.toHaveBeenCalled();
    });

    it('checks owned-agent routes in batches and stops after the first match', async () => {
      const agentRepo = makeRepo([
        { id: 'agent-1', name: 'first-bot', display_name: 'First Bot' },
        { id: 'agent-2', name: 'second-bot', display_name: 'Second Bot' },
      ]);
      const localSvc = new ProviderService(
        providerRepo as unknown as Repository<TenantProvider>,
        tierRepo as unknown as Repository<TierAssignment>,
        specRepo as unknown as Repository<SpecificityAssignment>,
        agentRepo as unknown as Repository<Agent>,
        headerTierRepo as unknown as Repository<HeaderTier>,
        pricingCache as unknown as ModelPricingCacheService,
        routingCache as unknown as RoutingCacheService,
      );
      providerRepo.find.mockResolvedValueOnce([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValueOnce([
        {
          agent_id: 'agent-2',
          tier: 'standard',
          override_route: route('openai', 'gpt-4o'),
          fallback_routes: null,
        } as unknown as TierAssignment,
      ]);

      await expect(localSvc.deactivateAllProviders('agent-1', 'tenant-1')).rejects.toThrow(
        'Update routing first (agent "Second Bot", tier standard, primary: gpt-4o).',
      );

      expect(tierRepo.find).toHaveBeenCalledTimes(1);
      expect(specRepo.find).not.toHaveBeenCalled();
      expect(headerTierRepo.find).not.toHaveBeenCalled();
      expect(providerRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('header-tier cleanup on disconnect / rename', () => {
    const headerPin = (keyLabel: string | null) => ({
      provider: 'openai',
      authType: 'subscription' as const,
      model: 'openai/gpt-5',
      keyLabel,
    });

    it('blocks removing a labeled key while header tiers pin that key', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'target',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'subscription',
          label: 'Key 2',
          is_active: true,
        },
        {
          id: 'other',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'subscription',
          label: 'Default',
          is_active: true,
        },
      ]);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([
        {
          id: 'h1',
          agent_id: 'agent-1',
          override_route: headerPin('Key 2'),
          fallback_routes: [headerPin('Key 2'), headerPin('Default')],
        } as unknown as HeaderTier,
        // Non-matching tier (different pinned label) must be left untouched.
        {
          id: 'h2',
          agent_id: 'agent-1',
          override_route: headerPin('Default'),
          fallback_routes: null,
        } as unknown as HeaderTier,
      ]);

      await expect(
        svc.removeProvider('agent-1', 'tenant-1', 'openai', 'subscription', 'Key 2'),
      ).rejects.toThrow(/Cannot disconnect provider/);

      expect(headerTierRepo.save).not.toHaveBeenCalled();
      expect(providerRepo.remove).not.toHaveBeenCalled();
    });

    it('rewrites header-tier key pins to the new label on rename', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'target',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'subscription',
          label: 'Key 2',
          is_active: true,
        },
      ]);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([
        {
          id: 'h1',
          agent_id: 'agent-1',
          override_route: headerPin('Key 2'),
          fallback_routes: null,
        } as unknown as HeaderTier,
      ]);

      await svc.renameKey('agent-1', 'tenant-1', 'openai', 'subscription', 'Key 2', 'Renamed');

      const saved = headerTierRepo.save.mock.calls[0][0] as HeaderTier[];
      expect(saved[0].override_route?.keyLabel).toBe('Renamed');
    });

    it('relabels pinned routes on every agent of the user, not just the renaming one', async () => {
      const pin = (keyLabel: string) => ({
        provider: 'openai',
        authType: 'api_key' as const,
        model: 'gpt-4o',
        keyLabel,
      });
      providerRepo.find.mockResolvedValue([
        {
          id: 'target',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Key 2',
          is_active: true,
        },
      ]);
      tierRepo.find.mockResolvedValue([
        {
          id: 't1',
          agent_id: 'agent-1',
          override_route: pin('Key 2'),
          fallback_routes: null,
        } as unknown as TierAssignment,
        {
          id: 't2',
          agent_id: 'agent-2',
          override_route: pin('Key 2'),
          fallback_routes: [pin('Key 2')],
        } as unknown as TierAssignment,
      ]);
      specRepo.find.mockResolvedValue([
        {
          id: 's1',
          agent_id: 'agent-3',
          override_route: pin('Key 2'),
          fallback_routes: null,
        } as unknown as SpecificityAssignment,
      ]);
      headerTierRepo.find.mockResolvedValue([]);

      await svc.renameKey('agent-1', 'tenant-1', 'openai', 'api_key', 'Key 2', 'Renamed');

      // Keys are tenant-global: the rename fans out across every owned agent,
      // so tiers are fetched by agent_id IN (...owned agent ids).
      expect(tierRepo.find).toHaveBeenCalledWith({ where: { agent_id: In(['agent-1']) } });
      const savedTiers = tierRepo.save.mock.calls[0][0] as TierAssignment[];
      expect(savedTiers.map((t) => t.override_route?.keyLabel)).toEqual(['Renamed', 'Renamed']);
      expect(savedTiers[1].fallback_routes?.[0]?.keyLabel).toBe('Renamed');
      const savedSpecs = specRepo.save.mock.calls[0][0] as SpecificityAssignment[];
      expect(savedSpecs[0].override_route?.keyLabel).toBe('Renamed');
      // Per-agent tier caches must be flushed for every mutated agent.
      for (const id of ['agent-1', 'agent-2', 'agent-3']) {
        expect(routingCache.invalidateAgent).toHaveBeenCalledWith(id);
      }
    });

    it('blocks full provider disconnect while header tiers route to it', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          priority: 0,
          is_active: true,
        } as unknown as TenantProvider,
      ]);
      tierRepo.find.mockResolvedValue([]);
      specRepo.find.mockResolvedValue([]);
      headerTierRepo.find.mockResolvedValue([
        {
          id: 'h1',
          agent_id: 'agent-1',
          override_route: route('OpenAI', 'gpt-4o'),
          fallback_routes: [route('openai', 'gpt-4o-mini'), route('anthropic', 'claude')],
        } as unknown as HeaderTier,
        // Belongs to another provider — must survive.
        {
          id: 'h2',
          agent_id: 'agent-1',
          override_route: route('anthropic', 'claude'),
          fallback_routes: null,
        } as unknown as HeaderTier,
      ]);

      await expect(svc.removeProvider('agent-1', 'tenant-1', 'openai')).rejects.toThrow(
        /Cannot disconnect provider/,
      );

      expect(headerTierRepo.save).not.toHaveBeenCalled();
      expect(providerRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('cleanupUnsupportedSubscriptionProviders (via getProviders)', () => {
    it('no-ops when no unsupported subscription rows exist', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
        },
      ]);
      const result = await svc.getProviders('tenant-1');
      expect(result).toHaveLength(1);
      expect(providerRepo.save).not.toHaveBeenCalled();
      expect(routingCache.invalidateTenant).not.toHaveBeenCalled();
    });

    it('keeps supported subscription rows that use provider aliases', async () => {
      const googleSubscription = {
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'google',
        auth_type: 'subscription',
        is_active: true,
      } as TenantProvider;
      providerRepo.find.mockResolvedValue([googleSubscription]);

      const result = await svc.getProviders('agent-1');

      expect(result).toEqual([googleSubscription]);
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('deactivates unsupported subscription rows and triggers cleanup when no usable sibling remains', async () => {
      // Pretend 'foobar' is an unsupported subscription provider — neither
      // anthropic nor any usable sibling stays for the same provider.
      providerRepo.find
        .mockResolvedValueOnce([
          {
            id: 'p1',
            agent_id: 'agent-1',
            provider: 'foobar',
            auth_type: 'subscription',
            is_active: true,
          },
        ])
        // After cleanupProviderReferences runs.
        .mockResolvedValueOnce([]);
      tierRepo.find.mockResolvedValue([
        {
          id: 'p1',
          agent_id: 'agent-1',
          provider: 'foobar',
          auth_type: 'subscription',
          is_active: true,
        },
      ]);

      const result = await svc.getProviders('tenant-1');
      // The unsupported row was deactivated.
      expect(providerRepo.save).toHaveBeenCalled();
      // After filter only usable providers are returned (none in this case).
      expect(result).toEqual([]);
    });

    it('reads from cache when present', async () => {
      const cached = [
        { id: 'p1', provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
      ];
      routingCache.getProviders.mockReturnValue(cached);
      const result = await svc.getProviders('tenant-1');
      expect(result).toBe(cached);
      expect(providerRepo.find).not.toHaveBeenCalled();
    });

    it('filters legacy built-in local providers from cloud routing', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      providerRepo.find.mockResolvedValue([
        { id: 'p1', provider: 'ollama', auth_type: 'local', is_active: true },
        { id: 'p2', provider: 'custom:runtime-id', auth_type: 'local', is_active: true },
      ]);

      const result = await svc.getProviders('tenant-1');

      expect(result.map((provider) => provider.provider)).toEqual(['custom:runtime-id']);
      expect(routingCache.setProviders).toHaveBeenCalledWith('tenant-1', result);
    });
  });

  describe('registerSubscriptionProvider', () => {
    it('registers keyless subscription providers that use provider aliases', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      const result = await svc.registerSubscriptionProvider('agent-1', 'tenant-1', 'google');

      expect(result).toEqual({ isNew: true });
      expect(providerRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant-1',
          agent_id: undefined,
          provider: 'google',
          auth_type: 'subscription',
          label: 'Default',
          priority: 0,
          api_key_encrypted: null,
          key_prefix: null,
          is_active: true,
        }),
      );
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
    });

    it('still ignores unsupported keyless subscription providers', async () => {
      const result = await svc.registerSubscriptionProvider('agent-1', 'tenant-1', 'deepseek');

      expect(result).toEqual({ isNew: false });
      expect(providerRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('upsertProvider — MiniMax subscription region', () => {
    // upsertProvider encrypts the apiKey, which requires an encryption secret —
    // the rest of this suite mocks repos but never hits the encrypt path, so
    // there's no global setup. Keep the secret scoped to this describe.
    let originalSecret: string | undefined;
    beforeAll(() => {
      originalSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
    });
    afterAll(() => {
      if (originalSecret === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = originalSecret;
      }
    });

    it('persists region=cn on a new MiniMax subscription row', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'minimax',
        'sk-cp-token-from-cn',
        'subscription',
        'cn',
      );

      expect(providerRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'minimax',
          auth_type: 'subscription',
          region: 'cn',
        }),
      );
    });

    it('updates region on an existing MiniMax subscription row', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'minimax',
        auth_type: 'subscription',
        label: 'Default',
        region: 'global',
        is_active: true,
      });

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'minimax',
        'sk-cp-new-token',
        'subscription',
        'cn',
      );

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'cn',
        }),
      );
    });

    it('preserves existing MiniMax subscription region when caller omits it', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'minimax',
        auth_type: 'subscription',
        label: 'Default',
        region: 'cn',
        is_active: true,
      });

      await svc.upsertProvider('agent-1', 'tenant-1', 'minimax', 'sk-cp-rotated', 'subscription');

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'cn',
        }),
      );
    });

    it('rejects unsupported MiniMax subscription region', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await expect(
        svc.upsertProvider('agent-1', 'tenant-1', 'minimax', 'sk-cp-token', 'subscription', 'eu'),
      ).rejects.toThrow('MiniMax subscription region must be one of: global, cn');
    });
  });

  describe('upsertProvider — Z.ai subscription region', () => {
    let originalSecret: string | undefined;
    beforeAll(() => {
      originalSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
    });
    afterAll(() => {
      if (originalSecret === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = originalSecret;
      }
    });

    it('persists region=global on a new Z.ai subscription row', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'zai',
        'zai-sub-key',
        'subscription',
        'global',
      );

      expect(providerRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'zai',
          auth_type: 'subscription',
          region: 'global',
        }),
      );
    });

    it('updates region on an existing Z.ai subscription row', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'zai',
        auth_type: 'subscription',
        label: 'Default',
        region: 'cn',
        is_active: true,
      });

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'zai',
        'zai-new-key',
        'subscription',
        'global',
      );

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'global',
        }),
      );
    });

    it('preserves existing Z.ai subscription region when caller omits it', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'zai',
        auth_type: 'subscription',
        label: 'Default',
        region: 'cn',
        is_active: true,
      });

      await svc.upsertProvider('agent-1', 'tenant-1', 'zai', 'zai-rotated', 'subscription');

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'cn',
        }),
      );
    });

    it('preserves existing dotted Z.ai alias subscription region when caller omits it', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'z.ai',
        auth_type: 'subscription',
        label: 'Default',
        region: 'cn',
        is_active: true,
      });

      await svc.upsertProvider('agent-1', 'tenant-1', 'z.ai', 'zai-rotated', 'subscription');

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'z.ai',
          region: 'cn',
        }),
      );
    });

    it('rejects unsupported Z.ai subscription region', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await expect(
        svc.upsertProvider('agent-1', 'tenant-1', 'zai', 'zai-sub-key', 'subscription', 'eu'),
      ).rejects.toThrow('Z.ai subscription region must be one of: global, cn');
    });
  });

  describe('upsertProvider — Xiaomi MiMo Token Plan region', () => {
    let originalSecret: string | undefined;
    beforeAll(() => {
      originalSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
    });
    afterAll(() => {
      if (originalSecret === undefined) {
        delete process.env.BETTER_AUTH_SECRET;
      } else {
        process.env.BETTER_AUTH_SECRET = originalSecret;
      }
    });

    it('persists region=ams on a new Xiaomi subscription row', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'xiaomi',
        'tp-mimo-token',
        'subscription',
        'ams',
      );

      expect(providerRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'xiaomi',
          auth_type: 'subscription',
          region: 'ams',
        }),
      );
    });

    it('updates region on an existing Xiaomi subscription row', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'xiaomi',
        auth_type: 'subscription',
        label: 'Default',
        region: 'cn',
        is_active: true,
      });

      await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'xiaomi',
        'tp-mimo-new-token',
        'subscription',
        'sgp',
      );

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'sgp',
        }),
      );
    });

    it('preserves existing Xiaomi subscription region when caller omits it', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'xiaomi',
        auth_type: 'subscription',
        label: 'Default',
        region: 'ams',
        is_active: true,
      });

      await svc.upsertProvider('agent-1', 'tenant-1', 'xiaomi', 'tp-mimo-rotated', 'subscription');

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'ams',
        }),
      );
    });

    it('preserves existing Xiaomi alias subscription region when caller omits it', async () => {
      providerRepo.findOne.mockResolvedValue({
        id: 'p1',
        agent_id: 'agent-1',
        provider: 'mimo',
        auth_type: 'subscription',
        label: 'Default',
        region: 'ams',
        is_active: true,
      });

      await svc.upsertProvider('agent-1', 'tenant-1', 'mimo', 'tp-mimo-rotated', 'subscription');

      expect(providerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'mimo',
          region: 'ams',
        }),
      );
    });

    it('rejects unsupported Xiaomi subscription region', async () => {
      providerRepo.findOne.mockResolvedValue(null);

      await expect(
        svc.upsertProvider('agent-1', 'tenant-1', 'xiaomi', 'tp-mimo-token', 'subscription', 'eu'),
      ).rejects.toThrow('Xiaomi MiMo Token Plan region must be one of: cn, sgp, ams');
    });
  });

  describe('nextOAuthLabel', () => {
    it('returns undefined when no subscription rows exist', async () => {
      providerRepo.find.mockResolvedValue([]);
      const label = await svc.nextOAuthLabel('tenant-1', 'openai');
      expect(label).toBeUndefined();
    });

    it('returns "Key 2" when one subscription row exists', async () => {
      providerRepo.find.mockResolvedValue([{ label: 'Default', is_active: true }]);
      const label = await svc.nextOAuthLabel('tenant-1', 'openai');
      expect(label).toBe('Key 2');
    });

    it('skips existing labels', async () => {
      providerRepo.find.mockResolvedValue([
        { label: 'Default', is_active: true },
        { label: 'Key 2', is_active: true },
      ]);
      const label = await svc.nextOAuthLabel('tenant-1', 'openai');
      expect(label).toBe('Key 3');
    });

    it('is case-insensitive when checking existing labels', async () => {
      providerRepo.find.mockResolvedValue([
        { label: 'Default', is_active: true },
        { label: 'key 2', is_active: true },
      ]);
      const label = await svc.nextOAuthLabel('tenant-1', 'openai');
      expect(label).toBe('Key 3');
    });
  });
});

describe('ProviderService — symmetric provider↔agent auto-connect', () => {
  const PREV_SECRET = process.env.BETTER_AUTH_SECRET;

  // A query-builder mock whose insert chain records the enabled (agent, provider)
  // pairs so the symmetric auto-enable tests can assert exactly which pairs were enabled.
  const makeEnabledProviderRepo = (enabled: Array<{ agent: string; provider: string }>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertChain: any = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((v: { agent_id: string; tenant_provider_id: string }) => {
        enabled.push({ agent: v.agent_id, provider: v.tenant_provider_id });
        return insertChain;
      }),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(insertChain),
      delete: jest.fn().mockResolvedValue(undefined),
    };
  };

  const build = (agentIds: string[], enabled: Array<{ agent: string; provider: string }>) => {
    const providerRepo = makeRepo();
    const agentRepo = makeRepo(agentIds);
    const routingCache = {
      getProviders: jest.fn().mockReturnValue(null),
      setProviders: jest.fn(),
      invalidateAgent: jest.fn(),
      invalidateTenant: jest.fn(),
    };
    const enabledProviderRepo = makeEnabledProviderRepo(enabled);
    const svc = new ProviderService(
      providerRepo as unknown as Repository<TenantProvider>,
      makeRepo() as unknown as Repository<TierAssignment>,
      makeRepo() as unknown as Repository<SpecificityAssignment>,
      agentRepo as unknown as Repository<Agent>,
      makeRepo() as unknown as Repository<HeaderTier>,
      { getByModel: jest.fn() } as unknown as ModelPricingCacheService,
      routingCache as unknown as RoutingCacheService,
      enabledProviderRepo as unknown as Repository<AgentEnabledProvider>,
    );
    return { svc, providerRepo, routingCache };
  };

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
  });
  afterAll(() => {
    if (PREV_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = PREV_SECRET;
  });

  describe('enableAllProvidersForAgent', () => {
    it('enables every usable provider for the agent and invalidates that agent', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo, routingCache } = build(['agent-x'], enabled);
      providerRepo.find.mockResolvedValue([
        { id: 'p1', provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
        {
          id: 'p2',
          provider: 'anthropic',
          auth_type: 'api_key',
          is_active: true,
        } as TenantProvider,
      ]);

      await svc.enableAllProvidersForAgent('new-agent', 'tenant-1');

      expect(enabled).toEqual([
        { agent: 'new-agent', provider: 'p1' },
        { agent: 'new-agent', provider: 'p2' },
      ]);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('new-agent');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('is a no-op when the user has no usable providers', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo, routingCache } = build(['agent-x'], enabled);
      providerRepo.find.mockResolvedValue([]);

      await expect(
        svc.enableAllProvidersForAgent('new-agent', 'tenant-1'),
      ).resolves.toBeUndefined();
      expect(enabled).toEqual([]);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('new-agent');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('enableProviderForAllAgents', () => {
    it('enables the new provider for every owned agent and invalidates their caches', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, routingCache } = build(['agent-1', 'agent-2'], enabled);

      await svc.enableProviderForAllAgents('tenant-1', 'new-provider');

      expect(enabled).toEqual([
        { agent: 'agent-1', provider: 'new-provider' },
        { agent: 'agent-2', provider: 'new-provider' },
      ]);
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-1');
      expect(routingCache.invalidateAgent).toHaveBeenCalledWith('agent-2');
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('is a no-op when the user owns no agents', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, routingCache } = build([], enabled);

      await expect(
        svc.enableProviderForAllAgents('tenant-1', 'new-provider'),
      ).resolves.toBeUndefined();
      expect(enabled).toEqual([]);
      expect(routingCache.invalidateAgent).not.toHaveBeenCalled();
      expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('upsertProvider — new provider connect fans out to all agents', () => {
    it('enables a brand-new api_key provider for every owned agent (Default label path)', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      // No existing row → new-row branch.
      providerRepo.findOne.mockResolvedValue(null);

      const { isNew, provider } = await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'openai',
        'sk-new-key',
        'api_key',
      );

      expect(isNew).toBe(true);
      // Every owned agent (not just the connecting one) gets the provider enabled.
      expect(enabled).toEqual([
        { agent: 'agent-1', provider: provider.id },
        { agent: 'agent-2', provider: provider.id },
      ]);
    });

    it('enables a brand-new labeled provider for every owned agent', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      // upsertProviderWithLabel: no existing rows → new-row branch.
      providerRepo.find.mockResolvedValue([]);

      const { isNew, provider } = await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'openai',
        'sk-labeled-key',
        'api_key',
        undefined,
        'Work',
      );

      expect(isNew).toBe(true);
      expect(enabled).toEqual([
        { agent: 'agent-1', provider: provider.id },
        { agent: 'agent-2', provider: provider.id },
      ]);
    });

    it('rejects a new credential only at the 50-key safety ceiling', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1'], enabled);
      providerRepo.find.mockResolvedValue(
        Array.from({ length: MAX_KEYS_PER_PROVIDER }, (_, index) => ({
          id: `provider-${index}`,
          provider: 'openai',
          auth_type: 'api_key',
          label: `Key ${index + 1}`,
          priority: index,
          is_active: true,
        })) as TenantProvider[],
      );

      await expect(
        svc.upsertProvider(
          'agent-1',
          'tenant-1',
          'openai',
          'sk-overflow',
          'api_key',
          undefined,
          'Overflow',
        ),
      ).rejects.toThrow(`at most ${MAX_KEYS_PER_PROVIDER}`);
      expect(providerRepo.insert).not.toHaveBeenCalled();
    });

    it('enables a brand-new tokenless subscription provider for every owned agent', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      // registerSubscriptionProvider new-row branch: no existing sub/api_key row.
      providerRepo.findOne.mockResolvedValue(null);

      const { isNew } = await svc.registerSubscriptionProvider('agent-1', 'tenant-1', 'anthropic');

      expect(isNew).toBe(true);
      expect(enabled.map((g) => g.agent)).toEqual(['agent-1', 'agent-2']);
    });
  });

  describe('reconnect of a DISCONNECTED provider fans back out to all agents', () => {
    it('re-enables every owned agent when reconnecting an inactive Default-label row', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      // removeProvider left this row is_active=false; reconnecting must restore
      // the global ON-by-default invariant for EVERY agent.
      providerRepo.findOne.mockResolvedValue({
        id: 'p-dead',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        is_active: false,
      });

      const { isNew } = await svc.upsertProvider('agent-1', 'user-1', 'openai', 'sk-reconnect');

      expect(isNew).toBe(false);
      // Fan-out IS taken on reactivation of a disconnected row.
      expect(enableSpy).toHaveBeenCalledWith('user-1', 'p-dead', undefined);
      expect(enabled.some((g) => g.agent === 'agent-1' && g.provider === 'p-dead')).toBe(true);
      expect(enabled.some((g) => g.agent === 'agent-2' && g.provider === 'p-dead')).toBe(true);
    });

    it('re-enables every owned agent when reconnecting an inactive same-key row', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      const sameKeyEncrypted = encrypt('sk-same-key', getEncryptionSecret());
      providerRepo.find.mockResolvedValue([
        {
          id: 'p-same-dead',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          api_key_encrypted: sameKeyEncrypted,
          is_active: false,
          priority: 0,
        } as unknown as TenantProvider,
      ]);

      const { isNew } = await svc.upsertProvider(
        'agent-1',
        'user-1',
        'openai',
        'sk-same-key',
        'api_key',
        undefined,
        'Key 2',
      );

      expect(isNew).toBe(false);
      expect(enableSpy).toHaveBeenCalledWith('user-1', 'p-same-dead', undefined);
      expect(enabled.some((g) => g.agent === 'agent-2' && g.provider === 'p-same-dead')).toBe(true);
    });

    it('does NOT resurrect a user-removed (inactive) subscription on background re-registration', async () => {
      // Unlike the user-driven upsert reconnect, registerSubscriptionProvider is
      // the agent's automatic capability report. A subscription the user
      // explicitly removed must stay inactive — it must not be reactivated nor
      // fanned out to other agents by a background re-registration.
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      const dead = {
        id: 'p-sub-dead',
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Default',
        is_active: false,
      };
      providerRepo.findOne.mockResolvedValue(dead);

      const { isNew } = await svc.registerSubscriptionProvider('agent-1', 'user-1', 'anthropic');

      expect(isNew).toBe(false);
      // Row left untouched (still inactive, never saved) and no user-wide fan-out.
      expect(dead.is_active).toBe(false);
      expect(providerRepo.save).not.toHaveBeenCalled();
      expect(enableSpy).not.toHaveBeenCalled();
      expect(enabled.some((g) => g.agent === 'agent-2' && g.provider === 'p-sub-dead')).toBe(false);
    });

    it('does not reactivate an already-active subscription row (no fan-out)', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      providerRepo.findOne.mockResolvedValue({
        id: 'p-sub-live',
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Default',
        is_active: true,
      });

      const { isNew } = await svc.registerSubscriptionProvider('agent-1', 'user-1', 'anthropic');

      expect(isNew).toBe(false);
      // Active row: only the connecting agent is touched via afterProviderChange.
      expect(enableSpy).not.toHaveBeenCalled();
      expect(enabled.some((g) => g.agent === 'agent-2')).toBe(false);
    });
  });

  describe('reconnect of an EXISTING provider does NOT re-enable (per-agent disables preserved)', () => {
    it('does not enable other agents when an existing Default-label row is updated', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      // Existing row → update-in-place branch (afterProviderChange path).
      providerRepo.findOne.mockResolvedValue({
        id: 'p-existing',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Default',
        is_active: true,
      });

      const { isNew } = await svc.upsertProvider('agent-1', 'tenant-1', 'openai', 'sk-rotated');

      expect(isNew).toBe(false);
      // The fan-out-to-all-agents path is NOT taken on reconnect.
      expect(enableSpy).not.toHaveBeenCalled();
      // Only the connecting agent is (re)enabled via afterProviderChange —
      // sibling agent-2 keeps whatever per-agent disable state it had.
      expect(enabled).toEqual([{ agent: 'agent-1', provider: 'p-existing' }]);
      expect(enabled.some((g) => g.agent === 'agent-2')).toBe(false);
    });

    it('does not re-enable when reconnecting the same key under a new label (sameKey path)', async () => {
      const enabled: Array<{ agent: string; provider: string }> = [];
      const { svc, providerRepo } = build(['agent-1', 'agent-2'], enabled);
      const enableSpy = jest.spyOn(svc, 'enableProviderForAllAgents');
      const sameKeyEncrypted = encrypt('sk-same-key', getEncryptionSecret());
      // upsertProviderWithLabel: a row with the SAME decrypted key already
      // exists under a different label → sameKey reactivation branch.
      providerRepo.find.mockResolvedValue([
        {
          id: 'p-same',
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          api_key_encrypted: sameKeyEncrypted,
          is_active: true,
          priority: 0,
        } as unknown as TenantProvider,
      ]);

      const { isNew } = await svc.upsertProvider(
        'agent-1',
        'tenant-1',
        'openai',
        'sk-same-key',
        'api_key',
        undefined,
        'Key 2',
      );

      expect(isNew).toBe(false);
      // The fan-out-to-all-agents path is NOT taken on a same-key reconnect.
      expect(enableSpy).not.toHaveBeenCalled();
      // Only the connecting agent is (re)enabled via afterProviderChange —
      // sibling agent-2 keeps whatever per-agent disable state it had.
      expect(enabled).toEqual([{ agent: 'agent-1', provider: 'p-same' }]);
      expect(enabled.some((g) => g.agent === 'agent-2')).toBe(false);
    });
  });
});

describe('ProviderService — getFreshSubscriptionCredential', () => {
  const PREV_KEY = process.env.MANIFEST_ENCRYPTION_KEY;
  let providerRepo: ReturnType<typeof makeRepo>;
  let svc: ProviderService;

  beforeAll(() => {
    process.env.MANIFEST_ENCRYPTION_KEY = 'unit-test-encryption-key-1234567890';
  });
  afterAll(() => {
    if (PREV_KEY === undefined) delete process.env.MANIFEST_ENCRYPTION_KEY;
    else process.env.MANIFEST_ENCRYPTION_KEY = PREV_KEY;
  });

  beforeEach(() => {
    providerRepo = makeRepo();
    svc = new ProviderService(
      providerRepo as unknown as Repository<TenantProvider>,
      makeRepo() as unknown as Repository<TierAssignment>,
      makeRepo() as unknown as Repository<SpecificityAssignment>,
      makeRepo() as unknown as Repository<Agent>,
      makeRepo() as unknown as Repository<HeaderTier>,
      { getByModel: jest.fn() } as unknown as ModelPricingCacheService,
      {
        getProviders: jest.fn(),
        setProviders: jest.fn(),
        invalidateAgent: jest.fn(),
        invalidateTenant: jest.fn(),
      } as unknown as RoutingCacheService,
    );
  });

  it('returns the decrypted raw credential, scanning subscription rows for the agent/provider', async () => {
    const raw = JSON.stringify({ t: 'access', r: 'refresh', e: 123 });
    providerRepo.find.mockResolvedValue([
      { label: 'Work', api_key_encrypted: encrypt(raw, getEncryptionSecret()) },
    ]);

    const out = await svc.getFreshSubscriptionCredential('tenant-1', 'openai', 'Work');

    expect(out).toBe(raw);
    expect(providerRepo.find).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', provider: 'openai', auth_type: 'subscription' },
    });
  });

  it('matches the label case-insensitively', async () => {
    const raw = JSON.stringify({ t: 'a', r: 'r', e: 1 });
    providerRepo.find.mockResolvedValue([
      { label: 'Other', api_key_encrypted: encrypt('nope', getEncryptionSecret()) },
      { label: 'work', api_key_encrypted: encrypt(raw, getEncryptionSecret()) },
    ]);

    // Stored row is "work"; the pinned route asks for "WORK".
    const out = await svc.getFreshSubscriptionCredential('tenant-1', 'openai', 'WORK');

    expect(out).toBe(raw);
  });

  it('defaults the label to Default when none is provided', async () => {
    const raw = JSON.stringify({ t: 'a', r: 'r', e: 1 });
    providerRepo.find.mockResolvedValue([
      { label: 'Default', api_key_encrypted: encrypt(raw, getEncryptionSecret()) },
    ]);

    expect(await svc.getFreshSubscriptionCredential('tenant-1', 'anthropic')).toBe(raw);
  });

  it('returns null when no row matches the label', async () => {
    providerRepo.find.mockResolvedValue([
      { label: 'Something else', api_key_encrypted: encrypt('x', getEncryptionSecret()) },
    ]);
    expect(await svc.getFreshSubscriptionCredential('tenant-1', 'openai')).toBeNull();
  });

  it('returns null when there are no subscription rows', async () => {
    providerRepo.find.mockResolvedValue([]);
    expect(await svc.getFreshSubscriptionCredential('tenant-1', 'openai')).toBeNull();
  });

  it('returns null when the matched row has no stored credential', async () => {
    providerRepo.find.mockResolvedValue([{ label: 'Default', api_key_encrypted: null }]);
    expect(await svc.getFreshSubscriptionCredential('tenant-1', 'openai')).toBeNull();
  });

  it('returns null when the stored credential cannot be decrypted', async () => {
    providerRepo.find.mockResolvedValue([
      { label: 'Default', api_key_encrypted: 'not-a-valid-ciphertext' },
    ]);
    expect(await svc.getFreshSubscriptionCredential('tenant-1', 'openai')).toBeNull();
  });
});
