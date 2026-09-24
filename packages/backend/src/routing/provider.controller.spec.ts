import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProviderController } from './provider.controller';
import { ProviderService } from './routing-core/provider.service';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { TierService } from './routing-core/tier.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { Agent } from '../entities/agent.entity';

const mockCtx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
const mockAgentName = { agentName: 'test-agent' } as never;
const TEST_AGENT_ID = 'agent-001';
const TEST_TENANT_ID = 'tenant-1';

describe('ProviderController', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  let controller: ProviderController;
  let mockProviderService: Record<string, jest.Mock>;
  let mockDiscoveryService: Record<string, jest.Mock>;
  let mockOllamaSync: Record<string, jest.Mock>;
  let mockResolveAgent: Record<string, jest.Mock>;
  let mockTierService: Record<string, jest.Mock>;
  let mockPricingSync: Record<string, jest.Mock>;
  let mockCacheManager: { clear: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['MANIFEST_MODE'] = 'selfhosted';
    mockProviderService = {
      getProviders: jest.fn().mockResolvedValue([]),
      upsertProvider: jest.fn().mockResolvedValue({ provider: {}, isNew: false }),
      removeProvider: jest.fn().mockResolvedValue({ notifications: 0 }),
      renameKey: jest.fn(),
      reorderKeys: jest.fn(),
      deactivateAllProviders: jest.fn().mockResolvedValue(undefined),
      recalculateTiers: jest.fn().mockResolvedValue(undefined),
      recalculateTiersForTenant: jest.fn().mockResolvedValue(undefined),
    };
    mockDiscoveryService = {
      discoverModels: jest.fn().mockResolvedValue([]),
    };
    mockOllamaSync = {
      sync: jest.fn().mockResolvedValue({ count: 0 }),
    };
    mockResolveAgent = {
      resolve: jest.fn().mockResolvedValue({
        id: TEST_AGENT_ID,
        name: 'test-agent',
        tenant_id: TEST_TENANT_ID,
      } as Agent),
    };
    mockTierService = {
      hasRoutableTier: jest.fn().mockResolvedValue(true),
    };
    mockPricingSync = {
      getAll: jest.fn().mockReturnValue(new Map([['model-1', {}]])),
    };
    mockCacheManager = {
      clear: jest.fn().mockResolvedValue(true),
    };

    controller = new ProviderController(
      mockProviderService as unknown as ProviderService,
      mockDiscoveryService as unknown as ModelDiscoveryService,
      mockOllamaSync as unknown as OllamaSyncService,
      mockResolveAgent as unknown as ResolveAgentService,
      mockTierService as unknown as TierService,
      mockPricingSync as unknown as PricingSyncService,
      mockCacheManager as never,
    );
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  describe('upsertProvider region validation', () => {
    it('rejects an invalid Qwen region on connect', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'qwen',
          authType: 'api_key',
          region: 'mars',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes a Qwen baseUrl through the region slot for storage', async () => {
      mockProviderService.upsertProvider.mockResolvedValueOnce({
        provider: {
          id: 'p1',
          provider: 'qwen',
          auth_type: 'api_key',
          is_active: true,
          label: 'Default',
          priority: 0,
          region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
        },
        isNew: false,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'qwen',
        authType: 'api_key',
        apiKey: 'sk-qwen',
        baseUrl: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      } as never);

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        TEST_TENANT_ID,
        'qwen',
        'sk-qwen',
        'api_key',
        'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
        undefined,
        'user-1',
      );
    });

    it('rejects Qwen requests that send both region and baseUrl', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'qwen',
          authType: 'api_key',
          region: 'auto',
          baseUrl: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects baseUrl for non-Qwen providers', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'openai',
          authType: 'api_key',
          baseUrl: 'https://api.openai.com/v1',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts snake-case Qwen base_url on connect', async () => {
      mockProviderService.upsertProvider.mockResolvedValueOnce({
        provider: {
          id: 'p1',
          provider: 'qwen',
          auth_type: 'api_key',
          is_active: true,
          label: 'Default',
          priority: 0,
          region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
        },
        isNew: false,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'qwen',
        authType: 'api_key',
        apiKey: 'sk-qwen',
        base_url: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      } as never);

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        TEST_TENANT_ID,
        'qwen',
        'sk-qwen',
        'api_key',
        'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
        undefined,
        'user-1',
      );
    });
  });

  /* ── getStatus ── */

  describe('getStatus', () => {
    it('returns enabled true when a provider is active and a tier is routable', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        { id: 'p1', provider: 'openai', is_active: true },
      ]);
      mockTierService.hasRoutableTier.mockResolvedValue(true);

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: true, reason: null });
    });

    it('returns no_provider when no providers are active', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        { id: 'p1', provider: 'openai', is_active: false },
      ]);

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: false, reason: 'no_provider' });
      expect(mockTierService.hasRoutableTier).not.toHaveBeenCalled();
    });

    it('returns no_provider when no providers exist', async () => {
      mockProviderService.getProviders.mockResolvedValue([]);

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: false, reason: 'no_provider' });
    });

    it('considers mixed active/inactive providers as having an active one', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        { id: 'p1', provider: 'openai', is_active: false },
        { id: 'p2', provider: 'anthropic', is_active: true },
      ]);
      mockTierService.hasRoutableTier.mockResolvedValue(true);

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: true, reason: null });
    });

    it('returns no_routable_models when provider is active but no tier resolves', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        { id: 'p1', provider: 'openai', is_active: true },
      ]);
      mockTierService.hasRoutableTier.mockResolvedValue(false);
      mockPricingSync.getAll.mockReturnValue(new Map([['gpt-4', {}]]));

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: false, reason: 'no_routable_models' });
    });

    it('returns pricing_cache_empty when tiers are empty and pricing cache is empty', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        { id: 'p1', provider: 'openai', is_active: true },
      ]);
      mockTierService.hasRoutableTier.mockResolvedValue(false);
      mockPricingSync.getAll.mockReturnValue(new Map());

      const result = await controller.getStatus(mockCtx, mockAgentName);
      expect(result).toEqual({ enabled: false, reason: 'pricing_cache_empty' });
    });
  });

  /* ── getProviders ── */

  describe('getProviders', () => {
    it('should return mapped provider list', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        {
          id: 'p1',
          provider: 'openai',
          is_active: true,
          connected_at: '2025-01-01',
          api_key_encrypted: 'enc',
          key_prefix: 'sk-proj-',
          models_fetched_at: '2026-04-01T10:00:00.000Z',
          cached_models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        },
      ]);

      const result = await controller.getProviders(mockCtx, mockAgentName);

      expect(mockProviderService.getProviders).toHaveBeenCalledWith('tenant-1');
      expect(result).toEqual([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          has_api_key: true,
          key_prefix: 'sk-proj-',
          region: null,
          connected_at: '2025-01-01',
          models_fetched_at: '2026-04-01T10:00:00.000Z',
          cached_model_count: 2,
        },
      ]);
    });

    it('returns null models_fetched_at and zero cached_model_count when never discovered', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        {
          id: 'p1',
          provider: 'anthropic',
          is_active: true,
          connected_at: '2025-01-01',
          api_key_encrypted: 'enc',
          key_prefix: 'sk-ant-',
        },
      ]);

      const result = await controller.getProviders(mockCtx, mockAgentName);
      expect(result[0].models_fetched_at).toBeNull();
      expect(result[0].cached_model_count).toBe(0);
    });

    it('should strip internal fields from response', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        {
          id: 'p1',
          provider: 'openai',
          is_active: true,
          connected_at: '2025-01-01',
          api_key_encrypted: 'secret',
          key_prefix: 'sk-proj-',
          agent_id: 'a1',
        },
      ]);

      const result = await controller.getProviders(mockCtx, mockAgentName);

      expect(result[0]).not.toHaveProperty('api_key_encrypted');
      expect(result[0]).not.toHaveProperty('agent_id');
      expect(result[0]).toHaveProperty('has_api_key', true);
      expect(result[0]).toHaveProperty('key_prefix', 'sk-proj-');
    });

    it('should return null key_prefix when provider has no key_prefix', async () => {
      mockProviderService.getProviders.mockResolvedValue([
        {
          id: 'p2',
          provider: 'anthropic',
          is_active: true,
          connected_at: '2025-02-01',
          api_key_encrypted: null,
        },
      ]);

      const result = await controller.getProviders(mockCtx, mockAgentName);
      expect(result[0].key_prefix).toBeNull();
      expect(result[0].has_api_key).toBe(false);
    });

    it('should return empty array when no providers', async () => {
      const result = await controller.getProviders(mockCtx, mockAgentName);
      expect(result).toEqual([]);
    });
  });

  /* ── upsertProvider ── */

  describe('upsertProvider', () => {
    it('should call service and return mapped result (with apiKey)', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: { id: 'p1', provider: 'anthropic', is_active: true, api_key_encrypted: 'enc' },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'anthropic',
        'sk-ant-test',
        undefined,
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({
        id: 'p1',
        provider: 'anthropic',
        auth_type: 'api_key',
        is_active: true,
        label: undefined,
        priority: undefined,
        region: null,
      });
    });

    it('should call service without apiKey', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: { id: 'p1', provider: 'openai', is_active: true, api_key_encrypted: null },
        isNew: false,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'openai',
        undefined,
        undefined,
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        label: undefined,
        priority: undefined,
        region: null,
      });
    });

    it('should trigger discoveryService.discoverModels in background', async () => {
      const providerResult = { id: 'p1', provider: 'openai', is_active: true };
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: providerResult,
        isNew: false,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(mockDiscoveryService.discoverModels).toHaveBeenCalledWith(providerResult);
    });

    it('discovers models without routing agents when the provider is new', async () => {
      // A brand-new provider is global + ON for every owned agent, but routes
      // remain user-controlled after discovery.
      const providerResult = { id: 'p1', provider: 'openai', is_active: true };
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: providerResult,
        isNew: true,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(mockDiscoveryService.discoverModels).toHaveBeenCalledWith(providerResult);
      expect(mockProviderService.recalculateTiersForTenant).not.toHaveBeenCalled();
      expect(mockProviderService.recalculateTiers).not.toHaveBeenCalled();
    });

    it('discovers models without routing agents on an existing-row reconnect', async () => {
      // Reconnecting an existing provider row still preserves each sibling
      // agent's per-agent disable state.
      const providerResult = { id: 'p1', provider: 'openai', is_active: true };
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: providerResult,
        isNew: false,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(mockDiscoveryService.discoverModels).toHaveBeenCalledWith(providerResult);
      expect(mockProviderService.recalculateTiers).not.toHaveBeenCalled();
      expect(mockProviderService.recalculateTiersForTenant).not.toHaveBeenCalled();
    });

    it('should swallow discovery errors silently', async () => {
      const providerResult = { id: 'p1', provider: 'openai', is_active: true };
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: providerResult,
        isNew: false,
      });
      mockDiscoveryService.discoverModels.mockRejectedValue(new Error('fetch failed'));

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(result).toEqual({
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        region: null,
      });
    });

    it('should not expose api_key_encrypted in response', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'openai',
          is_active: true,
          api_key_encrypted: 'secret-encrypted-value',
          agent_id: 'a1',
          connected_at: '2025-01-01',
          updated_at: '2025-01-01',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(result).toEqual({
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        is_active: true,
        region: null,
      });
      expect(result).not.toHaveProperty('api_key_encrypted');
      expect(result).not.toHaveProperty('agent_id');
    });

    it('should sync ollama models before connecting', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: { id: 'p1', provider: 'ollama', is_active: true },
        isNew: true,
      });

      await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'ollama',
        authType: 'local',
      });

      expect(mockOllamaSync.sync).toHaveBeenCalled();
      expect(mockProviderService.upsertProvider).toHaveBeenCalled();
    });

    it('rejects built-in local providers in cloud before contacting localhost', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'ollama',
          authType: 'local',
        }),
      ).rejects.toThrow('Built-in local providers are only available in self-hosted Manifest');

      expect(mockOllamaSync.sync).not.toHaveBeenCalled();
      expect(mockProviderService.upsertProvider).not.toHaveBeenCalled();
    });

    it('rejects local auth on a non-local built-in provider in cloud', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'openai',
          authType: 'local',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should accept region=cn for MiniMax subscription', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'minimax',
          is_active: true,
          auth_type: 'subscription',
          region: 'cn',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'minimax',
        apiKey: 'sk-cp-abc123',
        authType: 'subscription',
        region: 'cn',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'minimax',
        'sk-cp-abc123',
        'subscription',
        'cn',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('cn');
    });

    it('should reject invalid MiniMax subscription region', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'minimax',
          apiKey: 'sk-cp-abc',
          authType: 'subscription',
          region: 'us-east',
        }),
      ).rejects.toThrow('MiniMax subscription region must be one of: global, cn');
    });

    it('should accept region=ams for Xiaomi MiMo Token Plan subscription', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'xiaomi',
          is_active: true,
          auth_type: 'subscription',
          region: 'ams',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'xiaomi',
        apiKey: 'tp-mimo-token',
        authType: 'subscription',
        region: 'ams',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'xiaomi',
        'tp-mimo-token',
        'subscription',
        'ams',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('ams');
    });

    it('should reject invalid Xiaomi MiMo Token Plan subscription region', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'xiaomi',
          apiKey: 'tp-mimo-token',
          authType: 'subscription',
          region: 'global',
        }),
      ).rejects.toThrow('Xiaomi MiMo Token Plan region must be one of: cn, sgp, ams');
    });

    it('should accept region=cn for Z.ai subscription', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'zai',
          is_active: true,
          auth_type: 'subscription',
          region: 'cn',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'zai',
        apiKey: 'zai-sub-key',
        authType: 'subscription',
        region: 'cn',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'zai',
        'zai-sub-key',
        'subscription',
        'cn',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('cn');
    });

    it('should accept region=cn for dotted Z.ai subscription alias', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'z.ai',
          is_active: true,
          auth_type: 'subscription',
          region: 'cn',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'z.ai',
        apiKey: 'zai-sub-key',
        authType: 'subscription',
        region: 'cn',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'z.ai',
        'zai-sub-key',
        'subscription',
        'cn',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('cn');
    });

    it('should reject invalid Z.ai subscription region', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'zai',
          apiKey: 'zai-sub-key',
          authType: 'subscription',
          region: 'eu',
        }),
      ).rejects.toThrow('Z.ai subscription region must be one of: global, cn');
    });

    it('should accept a valid AWS Bedrock region for API-key auth', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'bedrock',
          is_active: true,
          auth_type: 'api_key',
          region: 'eu-west-1',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        authType: 'api_key',
        region: 'eu-west-1',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'bedrock',
        'bedrock-api-key-test',
        'api_key',
        'eu-west-1',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('eu-west-1');
    });

    it('should reject invalid AWS Bedrock regions', async () => {
      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'bedrock',
          apiKey: 'bedrock-api-key-test',
          authType: 'api_key',
          region: 'global',
        }),
      ).rejects.toThrow('AWS Bedrock region must be a valid AWS region code');
    });

    it('should accept region=cn for MiniMax API-key auth', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: {
          id: 'p1',
          provider: 'minimax',
          is_active: true,
          auth_type: 'api_key',
          region: 'cn',
        },
        isNew: true,
      });

      const result = await controller.upsertProvider(mockCtx, mockAgentName, {
        provider: 'minimax',
        apiKey: 'sk-test',
        authType: 'api_key',
        region: 'cn',
      });

      expect(mockProviderService.upsertProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'minimax',
        'sk-test',
        'api_key',
        'cn',
        undefined,
        'user-1',
      );
      expect(result.region).toBe('cn');
    });
  });

  /* ── deactivateAllProviders ── */

  describe('deactivateAllProviders', () => {
    it('should return ok after deactivating all', async () => {
      const result = await controller.deactivateAllProviders(mockCtx, mockAgentName);

      expect(mockProviderService.deactivateAllProviders).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
      );
      expect(result).toEqual({ ok: true });
    });
  });

  /* ── removeProvider ── */

  describe('removeProvider', () => {
    it('should return ok with notification count', async () => {
      mockProviderService.removeProvider.mockResolvedValue({ notifications: 3 });

      const result = await controller.removeProvider(
        mockCtx,
        { agentName: 'test-agent', provider: 'openai' } as never,
        {} as never,
      );

      expect(mockProviderService.removeProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'openai',
        undefined,
        undefined,
      );
      expect(result).toEqual({ ok: true, notifications: 3 });
      expect(mockCacheManager.clear).toHaveBeenCalled();
    });

    it('should return zero notifications when none cleared', async () => {
      mockProviderService.removeProvider.mockResolvedValue({ notifications: 0 });

      const result = await controller.removeProvider(
        mockCtx,
        { agentName: 'test-agent', provider: 'deepseek' } as never,
        {} as never,
      );
      expect(result).toEqual({ ok: true, notifications: 0 });
    });

    it('should pass authType to service when provided', async () => {
      mockProviderService.removeProvider.mockResolvedValue({ notifications: [] });

      await controller.removeProvider(
        mockCtx,
        { agentName: 'test-agent', provider: 'anthropic' } as never,
        { authType: 'subscription' } as never,
      );

      expect(mockProviderService.removeProvider).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'anthropic',
        'subscription',
        undefined,
      );
    });
  });

  /* ── resolveAgent ── */

  describe('resolveAgent', () => {
    it('should throw NotFoundException when tenant is not found', async () => {
      mockResolveAgent.resolve.mockRejectedValue(new NotFoundException('Tenant not found'));

      await expect(controller.getStatus(mockCtx, mockAgentName)).rejects.toThrow(NotFoundException);
      expect(mockResolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'test-agent');
    });

    it('should throw NotFoundException when agent is not found', async () => {
      mockResolveAgent.resolve.mockRejectedValue(
        new NotFoundException('Agent "nonexistent" not found'),
      );

      await expect(
        controller.getProviders(mockCtx, { agentName: 'nonexistent' } as never),
      ).rejects.toThrow(NotFoundException);
      // getProviders passes { allowPlayground: true } so the Playground agent can be
      // read; the NotFoundException originates from the service mock, not the
      // is_playground check.
      expect(mockResolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'nonexistent', {
        allowPlayground: true,
      });
    });

    it('should resolve agent and pass its id to service methods', async () => {
      mockResolveAgent.resolve.mockResolvedValue({
        id: 'agent-xyz',
        name: 'my-agent',
        tenant_id: TEST_TENANT_ID,
      });
      mockProviderService.getProviders.mockResolvedValue([]);

      await controller.getStatus(mockCtx, { agentName: 'my-agent' } as never);

      expect(mockResolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'my-agent');
      expect(mockProviderService.getProviders).toHaveBeenCalledWith('tenant-1');
    });

    it('should propagate NotFoundException through upsertProvider', async () => {
      mockResolveAgent.resolve.mockRejectedValue(new NotFoundException('Tenant not found'));

      await expect(
        controller.upsertProvider(mockCtx, mockAgentName, {
          provider: 'openai',
          apiKey: 'sk-test',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('upsertProvider passes { allowPlayground: true } so the Playground agent can connect providers', async () => {
      mockProviderService.upsertProvider.mockResolvedValue({
        provider: { id: 'p1', provider: 'openai', is_active: true },
        isNew: false,
      });

      await controller.upsertProvider(mockCtx, { agentName: 'Playground' } as never, {
        provider: 'openai',
        apiKey: 'sk-test',
      });

      expect(mockResolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'Playground', {
        allowPlayground: true,
      });
    });

    it('should propagate NotFoundException through removeProvider', async () => {
      mockResolveAgent.resolve.mockRejectedValue(
        new NotFoundException('Agent "missing-agent" not found'),
      );

      await expect(
        controller.removeProvider(
          mockCtx,
          { agentName: 'missing-agent', provider: 'openai' } as never,
          {} as never,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /* ── multi-key endpoints ── */

  describe('renameProviderKey', () => {
    it('forwards label rename to service and returns mapped row', async () => {
      mockProviderService.renameKey.mockResolvedValue({
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Work',
        priority: 1,
      });

      const result = await controller.renameProviderKey(
        mockCtx,
        { agentName: 'test-agent', provider: 'openai', label: 'Personal' } as never,
        { newLabel: 'Work' } as never,
      );

      expect(mockProviderService.renameKey).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'openai',
        'api_key',
        'Personal',
        'Work',
      );
      expect(result).toEqual({
        id: 'p1',
        provider: 'openai',
        auth_type: 'api_key',
        label: 'Work',
        priority: 1,
      });
    });

    it('honors explicit authType in body', async () => {
      mockProviderService.renameKey.mockResolvedValue({
        id: 'p1',
        provider: 'anthropic',
        auth_type: 'subscription',
        label: 'Renamed',
        priority: 0,
      });

      await controller.renameProviderKey(
        mockCtx,
        { agentName: 'test-agent', provider: 'anthropic', label: 'Default' } as never,
        { newLabel: 'Renamed', authType: 'subscription' } as never,
      );

      expect(mockProviderService.renameKey).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'anthropic',
        'subscription',
        'Default',
        'Renamed',
      );
    });
  });

  describe('reorderProviderKeys', () => {
    it('passes ordered labels to service and returns rows sorted by priority', async () => {
      mockProviderService.reorderKeys.mockResolvedValue([
        { id: 'p1', label: 'Personal', priority: 1 },
        { id: 'p2', label: 'Work', priority: 0 },
      ]);

      const result = await controller.reorderProviderKeys(
        mockCtx,
        { agentName: 'test-agent', provider: 'openai' } as never,
        { labels: ['Work', 'Personal'] } as never,
      );

      expect(mockProviderService.reorderKeys).toHaveBeenCalledWith(
        TEST_AGENT_ID,
        'tenant-1',
        'openai',
        'api_key',
        ['Work', 'Personal'],
      );
      expect(result).toEqual([
        { id: 'p2', label: 'Work', priority: 0 },
        { id: 'p1', label: 'Personal', priority: 1 },
      ]);
    });
  });
});
