import { ModelController } from './model.controller';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { CustomProviderService } from './custom-provider/custom-provider.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { ProviderParamSpecService } from './routing-core/provider-param-spec.service';
import { RoutingCacheService } from './routing-core/routing-cache.service';
import { DiscoveredModel } from '../model-discovery/model-fetcher';
import { Agent } from '../entities/agent.entity';

const mockCtx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
const mockAgentName = { agentName: 'test-agent' } as never;
const TEST_AGENT_ID = 'agent-001';
const TEST_TENANT_ID = 'tenant-1';

function makeDiscovered(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: 0.0000025,
    outputPricePerToken: 0.00001,
    capabilityReasoning: false,
    capabilityCode: true,
    qualityScore: 3,
    ...overrides,
  };
}

describe('ModelController', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  let controller: ModelController;
  let mockDiscoveryService: Record<string, jest.Mock>;
  let mockOllamaSync: Record<string, jest.Mock>;
  let mockResolveAgent: Record<string, jest.Mock>;
  let mockCustomProviderService: Record<string, jest.Mock>;
  let mockPricingSync: Record<string, jest.Mock>;
  let mockProviderParamSpecs: Record<string, jest.Mock>;
  let mockModelsDevSync: Record<string, jest.Mock>;
  let mockOpencodeGoCatalog: Record<string, jest.Mock>;
  let routingCache: RoutingCacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['MANIFEST_MODE'] = 'selfhosted';
    mockDiscoveryService = {
      getModelsForAgent: jest.fn().mockResolvedValue([]),
      discoverAllForAgent: jest.fn().mockResolvedValue(undefined),
      refreshProvider: jest.fn().mockResolvedValue({
        ok: true,
        model_count: 0,
        last_fetched_at: null,
        error: null,
      }),
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
    mockCustomProviderService = {
      list: jest.fn().mockResolvedValue([]),
    };
    mockPricingSync = {
      getAll: jest.fn().mockReturnValue(new Map([['gpt-4o', {}]])),
      getLastFetchedAt: jest.fn().mockReturnValue(new Date('2026-04-13T00:00:00Z')),
      refreshCache: jest.fn().mockResolvedValue(42),
    };
    mockProviderParamSpecs = {
      getCapabilities: jest.fn().mockResolvedValue(null),
    };
    mockModelsDevSync = {
      lookupModelCapabilities: jest.fn().mockReturnValue(null),
      getModelsForProvider: jest.fn().mockReturnValue([]),
    };
    mockOpencodeGoCatalog = {
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    };
    routingCache = new RoutingCacheService();

    controller = new ModelController(
      mockDiscoveryService as unknown as ModelDiscoveryService,
      mockOllamaSync as unknown as OllamaSyncService,
      mockResolveAgent as unknown as ResolveAgentService,
      mockCustomProviderService as unknown as CustomProviderService,
      mockPricingSync as unknown as PricingSyncService,
      mockProviderParamSpecs as unknown as ProviderParamSpecService,
      mockModelsDevSync as unknown as ModelsDevSyncService,
      mockOpencodeGoCatalog as unknown as OpencodeGoCatalogService,
      routingCache,
    );
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  /* ── pricingHealth ── */

  describe('pricingHealth', () => {
    it('returns cache size and last fetch timestamp', () => {
      mockPricingSync.getAll.mockReturnValue(
        new Map([
          ['a', {}],
          ['b', {}],
        ]),
      );
      mockPricingSync.getLastFetchedAt.mockReturnValue(new Date('2026-04-12T10:00:00Z'));

      const result = controller.pricingHealth();

      expect(result).toEqual({
        model_count: 2,
        last_fetched_at: '2026-04-12T10:00:00.000Z',
      });
    });

    it('returns null last_fetched_at when cache was never populated', () => {
      mockPricingSync.getAll.mockReturnValue(new Map());
      mockPricingSync.getLastFetchedAt.mockReturnValue(null);

      const result = controller.pricingHealth();

      expect(result).toEqual({ model_count: 0, last_fetched_at: null });
    });
  });

  /* ── refreshPricing ── */

  describe('refreshPricing', () => {
    it('triggers a cache refresh and reports the new count', async () => {
      mockPricingSync.refreshCache.mockResolvedValue(150);
      mockPricingSync.getLastFetchedAt.mockReturnValue(new Date('2026-04-13T12:00:00Z'));

      const result = await controller.refreshPricing();

      expect(mockPricingSync.refreshCache).toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        model_count: 150,
        last_fetched_at: '2026-04-13T12:00:00.000Z',
      });
    });

    it('returns ok=false when refresh yields zero models', async () => {
      mockPricingSync.refreshCache.mockResolvedValue(0);
      mockPricingSync.getLastFetchedAt.mockReturnValue(null);

      const result = await controller.refreshPricing();

      expect(result).toEqual({ ok: false, model_count: 0, last_fetched_at: null });
    });
  });

  /* ── syncOllama ── */

  describe('syncOllama', () => {
    it('should delegate to ollamaSync service', async () => {
      const result = await controller.syncOllama();
      expect(mockOllamaSync.sync).toHaveBeenCalled();
      expect(result).toEqual({ count: 0 });
    });

    it('rejects Ollama sync in cloud without dialing localhost', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      await expect(controller.syncOllama()).rejects.toThrow(
        'Built-in local providers are only available in self-hosted Manifest',
      );
      expect(mockOllamaSync.sync).not.toHaveBeenCalled();
    });
  });

  /* ── refreshModels ── */

  describe('refreshModels', () => {
    it('forces provider catalogs to refresh and returns ok', async () => {
      const result = await controller.refreshModels(mockCtx, mockAgentName);

      expect(mockResolveAgent.resolve).toHaveBeenCalledWith('tenant-1', 'test-agent');
      expect(mockDiscoveryService.discoverAllForAgent).toHaveBeenCalledWith('tenant-1', {
        forceRefresh: true,
      });
      expect(result).toEqual({ ok: true });
    });

    it('clears agent and tenant caches after refreshing all providers', async () => {
      routingCache.setModelParams(TEST_AGENT_ID, []);
      routingCache.setProviders(TEST_TENANT_ID, []);

      await controller.refreshModels(mockCtx, mockAgentName);

      expect(routingCache.getModelParams(TEST_AGENT_ID)).toBeNull();
      expect(routingCache.getProviders(TEST_TENANT_ID)).toBeNull();
    });
  });

  /* ── refreshProviderModels ── */

  describe('refreshProviderModels', () => {
    const mockParams = { agentName: 'test-agent', provider: 'anthropic' } as never;

    it('returns the discovery result without changing routes when ok', async () => {
      mockDiscoveryService.refreshProvider.mockResolvedValue({
        ok: true,
        model_count: 7,
        last_fetched_at: '2026-04-12T12:00:00.000Z',
        error: null,
      });

      const result = await controller.refreshProviderModels(mockCtx, mockParams, {});

      expect(mockDiscoveryService.refreshProvider).toHaveBeenCalledWith(
        'tenant-1',
        'anthropic',
        undefined,
      );
      expect(result).toEqual({
        ok: true,
        model_count: 7,
        last_fetched_at: '2026-04-12T12:00:00.000Z',
        error: null,
      });
    });

    it('forwards the optional authType query param', async () => {
      await controller.refreshProviderModels(mockCtx, mockParams, { authType: 'subscription' });
      expect(mockDiscoveryService.refreshProvider).toHaveBeenCalledWith(
        'tenant-1',
        'anthropic',
        'subscription',
      );
    });

    it('returns the refresh error when refresh failed', async () => {
      mockDiscoveryService.refreshProvider.mockResolvedValue({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: 'Provider returned no models',
      });

      const result = await controller.refreshProviderModels(mockCtx, mockParams, {});

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Provider returned no models');
    });

    it('clears agent and tenant caches after refreshing one provider', async () => {
      mockDiscoveryService.refreshProvider.mockResolvedValue({
        ok: true,
        model_count: 3,
        last_fetched_at: '2026-04-12T12:00:00.000Z',
        error: null,
      });
      routingCache.setModelParams(TEST_AGENT_ID, []);
      routingCache.setProviders(TEST_TENANT_ID, []);

      await controller.refreshProviderModels(mockCtx, mockParams, {});

      expect(routingCache.getModelParams(TEST_AGENT_ID)).toBeNull();
      expect(routingCache.getProviders(TEST_TENANT_ID)).toBeNull();
    });
  });

  /* ── getAvailableModels ── */

  describe('getAvailableModels', () => {
    it('should return models from discovery service', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(mockDiscoveryService.getModelsForAgent).toHaveBeenCalledWith(
        'tenant-1',
        TEST_AGENT_ID,
      );
      expect(result).toHaveLength(1);
      expect(result[0].model_name).toBe('gpt-4o');
      expect(result[0].provider).toBe('openai');
    });

    it('should return empty array when no models discovered', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);
      expect(result).toEqual([]);
    });

    it('should map DiscoveredModel fields to response format', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'gpt-4o',
          provider: 'openai',
          displayName: 'GPT-4o',
          inputPricePerToken: 0.0000025,
          outputPricePerToken: 0.00001,
          contextWindow: 128000,
          capabilityReasoning: false,
          capabilityCode: true,
          qualityScore: 3,
        }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0]).toEqual({
        model_name: 'gpt-4o',
        provider: 'openai',
        auth_type: 'api_key',
        input_price_per_token: 0.0000025,
        input_modalities: ['text'],
        output_price_per_token: 0.00001,
        output_modalities: ['text'],
        context_window: 128000,
        capability_reasoning: false,
        capability_code: true,
        capabilities: ['stream'],
        quality_score: 3,
        display_name: 'GPT-4o',
      });
    });

    it('surfaces curated known modalities in the picker payload when discovery has none', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-5.4-mini', provider: 'openai', authType: 'subscription' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0].input_modalities).toEqual(['text', 'image']);
    });

    it('includes the per-request cost for OpenCode Go subscription models', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/glm-5.1',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);
      mockOpencodeGoCatalog.resolveCostPerRequest.mockResolvedValue(0.013636);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(mockOpencodeGoCatalog.resolveCostPerRequest).toHaveBeenCalledWith(
        'opencode-go/glm-5.1',
      );
      expect(result[0].cost_per_request).toBe(0.013636);
    });

    it('omits cost_per_request when OpenCode Go has no published limit', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/mimo-v25',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);
      mockOpencodeGoCatalog.resolveCostPerRequest.mockResolvedValue(null);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0]).not.toHaveProperty('cost_per_request');
    });

    it('hides an unpublished OpenCode Go id a published one already stands for', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/deepseek-v4.1-flash',
          displayName: 'DeepSeek V4.1 Flash',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
        // DeepSeek's native alias for the same model. OpenCode serves it but
        // documents neither it nor a quota for it, and it resolves to the very
        // same name, so the picker would offer one model twice.
        makeDiscovered({
          id: 'opencode-go/deepseek-flash',
          displayName: 'DeepSeek V4.1 Flash',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);
      mockOpencodeGoCatalog.list.mockResolvedValue([{ id: 'deepseek-v4.1-flash' }]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result.map((m) => m.model_name)).toEqual(['opencode-go/deepseek-v4.1-flash']);
    });

    it('keeps an unpublished OpenCode Go model that nothing shadows', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/hy3',
          displayName: 'Hy3',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
        // Its own model, not an alias of hy3 — OpenCode serves it and it has a
        // name of its own, so it stays selectable.
        makeDiscovered({
          id: 'opencode-go/hy3-preview',
          displayName: 'Hy3 Preview',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);
      mockOpencodeGoCatalog.list.mockResolvedValue([{ id: 'hy3' }]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result.map((m) => m.model_name)).toEqual([
        'opencode-go/hy3',
        'opencode-go/hy3-preview',
      ]);
    });

    it('does not query OpenCode Go cost for non-gateway providers', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(mockOpencodeGoCatalog.resolveCostPerRequest).not.toHaveBeenCalled();
      expect(result[0]).not.toHaveProperty('cost_per_request');
    });

    it('should return only whitelisted fields for non-custom models', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(Object.keys(result[0]).sort()).toEqual([
        'auth_type',
        'capabilities',
        'capability_code',
        'capability_reasoning',
        'context_window',
        'display_name',
        'input_modalities',
        'input_price_per_token',
        'model_name',
        'output_modalities',
        'output_price_per_token',
        'provider',
        'quality_score',
      ]);
    });

    it('should include model-scoped capabilities from models.dev metadata', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai' }),
      ]);
      mockModelsDevSync.lookupModelCapabilities.mockReturnValue({
        capabilities: ['text', 'image', 'tools', 'stream'],
        inputModalities: ['text', 'image'],
        outputModalities: ['text', 'image'],
      });

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0].capabilities).toEqual(['text', 'image', 'tools', 'stream']);
      expect(result[0].input_modalities).toEqual(['text', 'image']);
      expect(result[0].output_modalities).toEqual(['text']);
    });

    it('resolves gateway models to the underlying provider for capability metadata', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/glm-5.1',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);
      mockModelsDevSync.lookupModelCapabilities.mockReturnValue({
        capabilities: ['text', 'tools', 'stream'],
      });

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      // The gateway prefix is stripped and the provider inferred from the
      // underlying id, so models.dev is queried as the real provider.
      expect(mockModelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith('zai', 'glm-5.1');
      expect(result[0].capabilities).toEqual(['text', 'tools', 'stream']);
    });

    it('falls back to the gateway provider when the underlying id is unknown', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'opencode-go/unknown-route-model',
          provider: 'opencode-go',
          authType: 'subscription',
        }),
      ]);

      await controller.getAvailableModels(mockCtx, mockAgentName);

      // Unknown underlying ids keep the gateway provider rather than passing
      // `undefined`.
      expect(mockModelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith(
        'opencode-go',
        'unknown-route-model',
      );
    });

    it('should use null for display_name when displayName is empty', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'some-model', provider: 'openai', displayName: '' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0].display_name).toBeNull();
    });

    it('uses underlying models.dev names for cached Bedrock raw ids', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'mistral.magistral-small-2509',
          provider: 'bedrock',
          displayName: 'mistral.magistral-small-2509',
        }),
      ]);
      mockModelsDevSync.lookupModelCapabilities.mockReturnValue({
        name: 'Magistral Small',
      });

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(mockModelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith(
        'mistral',
        'magistral-small-2509',
      );
      expect(result[0].model_name).toBe('mistral.magistral-small-2509');
      expect(result[0].display_name).toBe('Magistral Small');
    });

    it('formats Bedrock raw ids when no metadata name is available', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'us.anthropic.claude-opus-4.6',
          provider: 'bedrock',
          displayName: 'us.anthropic.claude-opus-4.6',
        }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0].model_name).toBe('us.anthropic.claude-opus-4.6');
      expect(result[0].display_name).toBe('Claude Opus 4.6');
    });

    it('should include models from multiple providers', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai' }),
        makeDiscovered({ id: 'grok-3', provider: 'xai' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result).toHaveLength(2);
      expect(result.map((m) => m.model_name).sort()).toEqual(['gpt-4o', 'grok-3']);
    });

    it('should include display_name and provider_display_name for custom provider models', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'custom:cp-uuid/llama-3.1-70b',
          provider: 'custom:cp-uuid',
          displayName: 'llama-3.1-70b',
        }),
      ]);
      mockCustomProviderService.list.mockResolvedValue([{ id: 'cp-uuid', name: 'Groq' }]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result).toHaveLength(1);
      expect(result[0].display_name).toBe('llama-3.1-70b');
      expect(result[0].provider_display_name).toBe('Groq');
    });

    it('should fall back to provider key when custom provider name not in map', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({
          id: 'custom:cp-orphan/model-x',
          provider: 'custom:cp-orphan',
          displayName: 'model-x',
        }),
      ]);
      mockCustomProviderService.list.mockResolvedValue([]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result).toHaveLength(1);
      expect(result[0].display_name).toBe('model-x');
      expect(result[0].provider_display_name).toBe('custom:cp-orphan');
    });

    it('should not include provider_display_name for non-custom providers', async () => {
      mockDiscoveryService.getModelsForAgent.mockResolvedValue([
        makeDiscovered({ id: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o' }),
      ]);

      const result = await controller.getAvailableModels(mockCtx, mockAgentName);

      expect(result[0].display_name).toBe('GPT-4o');
      expect(result[0]).not.toHaveProperty('provider_display_name');
    });
  });
});
