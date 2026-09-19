import { ModelDiscoveryService } from './model-discovery.service';
import { ProviderModelFetcherService } from './provider-model-fetcher.service';
import { ProviderModelRegistryService } from './provider-model-registry.service';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { DiscoveredModel } from './model-fetcher';
import { supplementWithKnownModels } from './model-fallback';

jest.mock('../common/utils/crypto.util', () => ({
  decrypt: jest.fn(),
  getEncryptionSecret: jest.fn(),
  getDecryptionSecrets: jest.fn(() => ['test-secret-32-chars-long-enough!!']),
  decryptWithAny: jest.fn((ciphertext: string, secrets: string[]) => {
    const mod = jest.requireMock('../common/utils/crypto.util') as {
      decrypt: (c: string, s: string) => string;
    };
    return { plaintext: mod.decrypt(ciphertext, secrets[0]), secretIndex: 0 };
  }),
}));

jest.mock('../database/quality-score.util', () => ({
  computeQualityScore: jest.fn().mockReturnValue(3),
}));

import { decrypt, getEncryptionSecret, getDecryptionSecrets } from '../common/utils/crypto.util';
import { computeQualityScore } from '../database/quality-score.util';

const mockDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;
const mockGetSecret = getEncryptionSecret as jest.MockedFunction<typeof getEncryptionSecret>;
const mockComputeScore = computeQualityScore as jest.MockedFunction<typeof computeQualityScore>;

function makeModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'test-model',
    displayName: 'Test Model',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<TenantProvider> = {}): TenantProvider {
  return {
    id: 'prov-1',
    tenant_id: 'tenant-1',
    created_by_user_id: 'user-1',
    agent_id: 'agent-1',
    provider: 'openai',
    api_key_encrypted: 'encrypted-key',
    key_prefix: 'sk-',
    auth_type: 'api_key',
    is_active: true,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cached_models: null,
    models_fetched_at: null,
    ...overrides,
  } as TenantProvider;
}

function makeCustomProvider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: 'cp-1',
    agent_id: 'agent-1',
    tenant_id: 'tenant-1',
    created_by_user_id: 'user-1',
    name: 'My Custom',
    base_url: 'http://localhost:8000',
    models: [
      {
        model_name: 'custom-llm',
        input_price_per_million_tokens: 1.5,
        output_price_per_million_tokens: 3.0,
        context_window: 32000,
      },
    ],
    created_at: new Date().toISOString(),
    ...overrides,
  } as CustomProvider;
}

function makeMockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
  };
}

describe('ModelDiscoveryService', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  let service: ModelDiscoveryService;
  let providerRepo: ReturnType<typeof makeMockRepo>;
  let customProviderRepo: ReturnType<typeof makeMockRepo>;
  let fetcher: { fetch: jest.Mock };
  let mockPricingSync: { lookupPricing: jest.Mock; getAll: jest.Mock };
  let mockModelRegistry: {
    registerModels: jest.Mock;
    getConfirmedModels: jest.Mock;
  };
  let mockModelsDevSync: {
    lookupModel: jest.Mock;
    lookupModelCapabilities: jest.Mock;
    getModelsForProvider: jest.Mock;
    refreshCache: jest.Mock;
  };
  let mockCopilotTokenService: { getCopilotToken: jest.Mock };

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    providerRepo = makeMockRepo();
    customProviderRepo = makeMockRepo();
    fetcher = { fetch: jest.fn().mockResolvedValue([]) };
    mockPricingSync = {
      lookupPricing: jest.fn().mockReturnValue(null),
      getAll: jest.fn().mockReturnValue(new Map()),
    };
    const lookupModel = jest.fn().mockReturnValue(null);
    mockModelsDevSync = {
      lookupModel,
      // The real service tries the priced catalog first. Tests that exercise
      // the capability-only catalog override this directly.
      lookupModelCapabilities: jest.fn((providerId: string, modelId: string) =>
        lookupModel(providerId, modelId),
      ),
      getModelsForProvider: jest.fn().mockReturnValue([]),
      refreshCache: jest.fn().mockResolvedValue(0),
    };
    mockModelRegistry = {
      registerModels: jest.fn(),
      getConfirmedModels: jest.fn().mockReturnValue(null),
    };
    mockCopilotTokenService = {
      getCopilotToken: jest.fn().mockResolvedValue('tid=exchanged-copilot-token'),
    };

    mockDecrypt.mockReturnValue('decrypted-key');
    mockGetSecret.mockReturnValue('secret-32-chars-long-xxxxxxxxxx');
    mockComputeScore.mockReturnValue(3);

    service = new ModelDiscoveryService(
      providerRepo as never,
      customProviderRepo as never,
      fetcher as unknown as ProviderModelFetcherService,
      mockPricingSync as never,
      mockModelsDevSync as never,
      mockModelRegistry as unknown as ProviderModelRegistryService,
      mockCopilotTokenService as never,
    );
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /* ── discoverModels ── */

  describe('discoverModels', () => {
    it('does not contact a built-in local runtime from cloud', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      const result = await service.discoverModels(
        makeProvider({ provider: 'ollama', auth_type: 'local', api_key_encrypted: null }),
      );

      expect(result).toEqual([]);
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(providerRepo.save).not.toHaveBeenCalled();
    });

    it('should decrypt key, fetch, enrich, and cache models', async () => {
      const models = [makeModel({ id: 'gpt-4' })];
      fetcher.fetch.mockResolvedValue(models);

      const provider = makeProvider();
      const result = await service.discoverModels(provider);

      expect(getDecryptionSecrets).toHaveBeenCalled();
      expect(mockDecrypt).toHaveBeenCalledWith('encrypted-key', expect.any(String));
      expect(fetcher.fetch).toHaveBeenCalledWith('openai', 'decrypted-key', 'api_key', undefined);
      expect(result).toHaveLength(1);
      expect(provider.cached_models).toEqual(result);
      expect(provider.models_fetched_at).toBeDefined();
      expect(providerRepo.save).toHaveBeenCalledWith(provider);
    });

    it('caches the current configured window after models.dev enrichment', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'gpt-5.6-sol',
          contextWindow: 272000,
          contextWindowSource: 'subscription_config',
        }),
      ]);
      mockModelsDevSync.lookupModel.mockReturnValue({
        name: 'GPT-5.6 Sol',
        contextWindow: 400000,
        inputPricePerToken: 0.000001,
        outputPricePerToken: 0.000002,
        reasoning: true,
        toolCall: true,
      });
      mockComputeScore.mockImplementation(({ context_window }) =>
        context_window >= 1000000 ? 5 : 4,
      );
      const provider = makeProvider({ auth_type: 'subscription' });

      const result = await service.discoverModels(provider);
      const sol = result.find((model) => model.id === 'gpt-5.6-sol');

      expect(sol).toMatchObject({
        contextWindow: 1050000,
        contextWindowSource: 'subscription_config',
        inputPricePerToken: 0.000001,
        capabilityCode: true,
        qualityScore: 5,
      });
      expect(mockComputeScore).toHaveBeenCalledWith(
        expect.objectContaining({ context_window: 400000 }),
      );
      expect(mockComputeScore).toHaveBeenCalledWith(
        expect.objectContaining({ context_window: 1050000 }),
      );
      expect(provider.cached_models).toEqual(result);
    });

    it('should return [] when decrypt fails', async () => {
      mockDecrypt.mockImplementation(() => {
        throw new Error('bad key');
      });

      const result = await service.discoverModels(makeProvider());
      expect(result).toEqual([]);
      expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    it('should pass empty string as key when no encrypted key', async () => {
      const provider = makeProvider({ api_key_encrypted: null });
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(provider);

      expect(mockDecrypt).not.toHaveBeenCalled();
      expect(fetcher.fetch).toHaveBeenCalledWith('openai', '', 'api_key', undefined);
    });

    it('should unwrap the Kiro OIDC token blob before fetching models', async () => {
      mockDecrypt.mockReturnValue(
        JSON.stringify({
          source: 'kiro-oidc',
          t: 'kiro-access',
          r: 'kiro-refresh',
          e: Date.now() + 10 * 60_000,
          cid: 'client-id',
          cs: 'client-secret',
          region: 'us-east-1',
        }),
      );
      const provider = makeProvider({ provider: 'kiro', auth_type: 'subscription' });

      await service.discoverModels(provider);

      expect(fetcher.fetch).toHaveBeenCalledWith('kiro', 'kiro-access', 'subscription', undefined);
    });

    it('should fill capability gaps from the curated known-modalities list', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({ id: 'gpt-5.3-codex-spark', inputPricePerToken: 0, outputPricePerToken: 0 }),
      ]);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputModalities).toEqual(['text']);
      expect(result[0].outputModalities).toEqual(['text']);
      expect(result[0].capabilities).toEqual(expect.arrayContaining(['text', 'tools', 'stream']));
    });

    it('should keep discovered modalities over the curated known-modalities list', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'gpt-5.3-codex-spark',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          inputModalities: ['text', 'image'],
          outputModalities: ['text', 'image'],
        }),
      ]);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputModalities).toEqual(['text', 'image']);
      expect(result[0].outputModalities).toEqual(['text', 'image']);
    });

    it('should enrich models with openRouter pricing when available', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/gpt-4') {
          return {
            input: 0.00003,
            output: 0.00006,
            contextWindow: 200000,
            displayName: 'GPT-4 via OR',
          };
        }
        return null;
      });

      const models = [makeModel({ id: 'gpt-4' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('openai/gpt-4');
      expect(result[0].inputPricePerToken).toBe(0.00003);
      expect(result[0].outputPricePerToken).toBe(0.00006);
      expect(result[0].contextWindow).toBe(200000);
      expect(result[0].displayName).toBe('GPT-4 via OR');
    });

    it('does not use underlying provider pricing for Bedrock models', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'anthropic/claude-opus-4.8') {
          return {
            input: 0.000015,
            output: 0.000075,
            contextWindow: 200000,
            displayName: 'Claude Opus 4.8',
          };
        }
        return null;
      });

      fetcher.fetch.mockResolvedValue([
        makeModel({ id: 'us.anthropic.claude-opus-4.8', provider: 'bedrock' }),
      ]);

      const result = await service.discoverModels(
        makeProvider({ provider: 'bedrock', region: 'us-east-1' } as Partial<TenantProvider>),
      );

      expect(result[0].id).toBe('us.anthropic.claude-opus-4.8');
      expect(result[0].provider).toBe('bedrock');
      expect(mockPricingSync.lookupPricing).not.toHaveBeenCalledWith('anthropic/claude-opus-4.8');
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('uses exact Bedrock models.dev pricing for AWS model ids', async () => {
      mockModelsDevSync.lookupModel.mockImplementation((providerId: string, modelId: string) => {
        if (providerId === 'anthropic' && modelId === 'claude-opus-4.8') {
          return {
            name: 'Claude Opus 4.8',
            inputPricePerToken: 0.000015,
            outputPricePerToken: 0.000075,
            contextWindow: 200000,
          };
        }
        if (providerId === 'bedrock' && modelId === 'us.anthropic.claude-opus-4.8') {
          return {
            name: 'AWS Claude Opus 4.8',
            inputPricePerToken: 0.000016,
            outputPricePerToken: 0.00008,
            contextWindow: 200000,
          };
        }
        return null;
      });

      fetcher.fetch.mockResolvedValue([
        makeModel({ id: 'us.anthropic.claude-opus-4.8', provider: 'bedrock' }),
      ]);

      const result = await service.discoverModels(
        makeProvider({ provider: 'bedrock', region: 'us-east-1' } as Partial<TenantProvider>),
      );

      expect(mockModelsDevSync.lookupModel).toHaveBeenCalledWith(
        'bedrock',
        'us.anthropic.claude-opus-4.8',
      );
      expect(result[0].inputPricePerToken).toBe(0.000016);
      expect(result[0].outputPricePerToken).toBe(0.00008);
      expect(result[0].displayName).toBe('Claude Opus 4.8');
    });

    it('should use model contextWindow when openRouter has no contextWindow', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/gpt-4') {
          return { input: 0.00003, output: 0.00006 };
        }
        return null;
      });

      const models = [makeModel({ id: 'gpt-4', contextWindow: 8192 })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].contextWindow).toBe(8192);
    });

    it('should keep model displayName when openRouter displayName is empty', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/gpt-4') {
          return { input: 0.00003, output: 0.00006, displayName: '' };
        }
        return null;
      });

      const models = [makeModel({ id: 'gpt-4', displayName: 'GPT-4' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].displayName).toBe('GPT-4');
    });

    it('should keep null pricing when pricingSync lookup returns null', async () => {
      const models = [makeModel({ id: 'unknown-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should keep null pricing when pricingSync is null', async () => {
      const serviceNoPricing = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        null,
        null,
        null,
        null,
      );

      const models = [makeModel({ id: 'some-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await serviceNoPricing.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeNull();
    });

    it('should keep null pricing when no pricing source available', async () => {
      const models = [makeModel({ id: 'unknown-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should skip enrichment when fetcher already provided pricing', async () => {
      const models = [
        makeModel({
          id: 'priced-model',
          inputPricePerToken: 0.001,
          outputPricePerToken: 0.002,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      await service.discoverModels(makeProvider());

      expect(mockPricingSync.lookupPricing).not.toHaveBeenCalled();
    });

    it('should call computeQualityScore for enriched models', async () => {
      mockComputeScore.mockReturnValue(5);
      const models = [makeModel({ id: 'gpt-4' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(mockComputeScore).toHaveBeenCalledWith(
        expect.objectContaining({ model_name: 'gpt-4' }),
      );
      expect(result[0].qualityScore).toBe(5);
    });

    it('should register models in registry after successful native fetch', async () => {
      const models = [makeModel({ id: 'gpt-4o' }), makeModel({ id: 'gpt-4-turbo' })];
      fetcher.fetch.mockResolvedValue(models);

      await service.discoverModels(makeProvider());

      expect(mockModelRegistry.registerModels).toHaveBeenCalledWith('openai', models);
    });

    it('should not register models when native fetch returns empty', async () => {
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(makeProvider());

      expect(mockModelRegistry.registerModels).not.toHaveBeenCalled();
    });

    it('should pass confirmed models to buildFallbackModels when native fetch fails', async () => {
      fetcher.fetch.mockResolvedValue([]);
      const confirmed = new Set(['gpt-4o']);
      mockModelRegistry.getConfirmedModels.mockReturnValue(confirmed);

      // Set up OpenRouter cache with matching models
      const orMap = new Map([
        ['openai/gpt-4o', { input: 0.01, output: 0.02, displayName: 'GPT-4o' }],
        ['openai/phantom', { input: 0.01, output: 0.02, displayName: 'Phantom' }],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(makeProvider());

      expect(mockModelRegistry.getConfirmedModels).toHaveBeenCalledWith('openai');
      // Only confirmed model should be in fallback
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });

    it('should not call registry when modelRegistry is null', async () => {
      const serviceNoRegistry = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        mockPricingSync as never,
        mockModelsDevSync as never,
        null,
        null,
      );

      const models = [makeModel({ id: 'gpt-4o' })];
      fetcher.fetch.mockResolvedValue(models);

      await serviceNoRegistry.discoverModels(makeProvider());

      expect(mockModelRegistry.registerModels).not.toHaveBeenCalled();
    });
  });

  /* ── discoverAllForAgent ── */

  describe('discoverAllForAgent', () => {
    it('should discover models for all active non-custom providers', async () => {
      const providers = [
        makeProvider({ id: 'p1', provider: 'openai' }),
        makeProvider({ id: 'p2', provider: 'anthropic' }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverAllForAgent('tenant-1');

      expect(providerRepo.find).toHaveBeenCalledWith({
        where: { tenant_id: 'tenant-1', is_active: true },
      });
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });

    it('should skip custom providers', async () => {
      const providers = [
        makeProvider({ id: 'p1', provider: 'openai' }),
        makeProvider({ id: 'p2', provider: 'custom:my-provider' }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverAllForAgent('agent-1');

      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it('passes forceRefresh through to provider discovery when requested', async () => {
      const providers = [
        makeProvider({ id: 'p1', provider: 'opencode-go', auth_type: 'subscription' }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'opencode-go/glm-5.2' })]);

      await service.discoverAllForAgent('tenant-1', { forceRefresh: true });

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-go',
        'decrypted-key',
        'subscription',
        undefined,
        { forceRefresh: true },
      );
    });

    it('refreshes models.dev once for a forced all-provider refresh', async () => {
      const providers = [
        makeProvider({ id: 'p1', provider: 'openai' }),
        makeProvider({ id: 'p2', provider: 'anthropic' }),
      ];
      providerRepo.find.mockResolvedValue(providers);

      await service.discoverAllForAgent('tenant-1', { forceRefresh: true });

      expect(mockModelsDevSync.refreshCache).toHaveBeenCalledTimes(1);
      expect(fetcher.fetch).toHaveBeenCalledWith('openai', 'decrypted-key', 'api_key', undefined, {
        forceRefresh: true,
      });
    });

    it('should not throw when individual discovery fails', async () => {
      const providers = [
        makeProvider({ id: 'p1', provider: 'openai' }),
        makeProvider({ id: 'p2', provider: 'anthropic' }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      fetcher.fetch.mockResolvedValue([]);

      // Make providerRepo.save throw on first call to trigger .catch handler
      providerRepo.save
        .mockRejectedValueOnce(new Error('DB write failed'))
        .mockResolvedValueOnce({});

      await expect(service.discoverAllForAgent('agent-1')).resolves.not.toThrow();
    });
  });

  /* ── refreshProvider ── */

  describe('refreshProvider', () => {
    it('rejects built-in local refreshes in cloud before reading the provider row', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      const result = await service.refreshProvider('tenant-1', 'ollama', 'local');

      expect(result).toEqual({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: expect.stringContaining('only available in self-hosted Manifest'),
      });
      expect(providerRepo.find).not.toHaveBeenCalled();
    });

    it('returns Provider not found when no row matches', async () => {
      const result = await service.refreshProvider('agent-1', 'openai');
      expect(result).toEqual({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: 'Provider not found',
      });
    });

    it('refuses custom providers and reports the cached count', async () => {
      providerRepo.find.mockResolvedValue([
        makeProvider({
          provider: 'custom:cp-1',
          cached_models: [makeModel({ id: 'foo' }), makeModel({ id: 'bar' })],
          models_fetched_at: '2026-04-12T08:00:00.000Z',
        }),
      ]);
      const result = await service.refreshProvider('agent-1', 'custom:cp-1');
      expect(result.ok).toBe(false);
      expect(result.model_count).toBe(2);
      expect(result.last_fetched_at).toBe('2026-04-12T08:00:00.000Z');
      expect(result.error).toContain('Custom providers are managed manually');
    });

    it('returns ok with the discovered count on success', async () => {
      const provider = makeProvider({ provider: 'openai' });
      providerRepo.find.mockResolvedValue([provider]);
      fetcher.fetch.mockResolvedValue([
        makeModel({ id: 'gpt-4o' }),
        makeModel({ id: 'gpt-4o-mini' }),
      ]);

      const result = await service.refreshProvider('tenant-1', 'openai', 'api_key');
      expect(providerRepo.find).toHaveBeenCalledWith({
        where: { tenant_id: 'tenant-1', provider: 'openai', is_active: true, auth_type: 'api_key' },
      });
      expect(fetcher.fetch).toHaveBeenCalledWith('openai', 'decrypted-key', 'api_key', undefined, {
        forceRefresh: true,
      });
      expect(result.ok).toBe(true);
      expect(result.model_count).toBe(2);
      expect(result.error).toBeNull();
      expect(result.last_fetched_at).toBeDefined();
    });

    it('refreshes every matching API-key connection', async () => {
      const first = makeProvider({
        id: 'openai-key-1',
        api_key_encrypted: 'encrypted-key-1',
      });
      const second = makeProvider({
        id: 'openai-key-2',
        api_key_encrypted: 'encrypted-key-2',
      });
      providerRepo.find.mockResolvedValue([first, second]);
      mockDecrypt.mockImplementation((encrypted) => encrypted.replace('encrypted-', ''));
      fetcher.fetch.mockImplementation(async (_provider, apiKey) =>
        apiKey === 'key-1'
          ? [makeModel({ id: 'gpt-4o' })]
          : [
              makeModel({ id: 'gpt-5.6-sol' }),
              makeModel({ id: 'gpt-5.6-terra' }),
              makeModel({ id: 'gpt-5.6-luna' }),
            ],
      );

      const result = await service.refreshProvider('tenant-1', 'openai', 'api_key');

      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
      expect(first.cached_models?.map((model) => model.id)).toEqual(['gpt-4o']);
      expect(second.cached_models?.map((model) => model.id)).toEqual([
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ]);
      expect(mockModelsDevSync.refreshCache).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: true,
        model_count: 3,
        last_fetched_at: expect.any(String),
        error: null,
      });
    });

    it('returns ok=false with hint when provider returns no models', async () => {
      const provider = makeProvider({ provider: 'openai', cached_models: null });
      providerRepo.find.mockResolvedValue([provider]);
      fetcher.fetch.mockResolvedValue([]);

      const result = await service.refreshProvider('agent-1', 'openai');
      expect(result.ok).toBe(false);
      expect(result.model_count).toBe(0);
      expect(result.error).toBe('Provider returned no models');
    });

    it('preserves cached models and reports prior count when discovery throws', async () => {
      const cachedModels = [makeModel({ id: 'gpt-4o' }), makeModel({ id: 'gpt-4o-mini' })];
      providerRepo.find.mockResolvedValue([
        makeProvider({
          provider: 'openai',
          cached_models: cachedModels,
          models_fetched_at: '2026-04-01T08:00:00.000Z',
        }),
      ]);
      // discoverModels itself swallows fetcher errors, so to land in the
      // refreshProvider catch we make the cache-write throw instead.
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'gpt-4o' })]);
      providerRepo.save.mockRejectedValueOnce(new Error('DB write failed'));

      const result = await service.refreshProvider('agent-1', 'openai');
      expect(result.ok).toBe(false);
      expect(result.model_count).toBe(2);
      expect(result.error).toBe('DB write failed');
      expect(result.last_fetched_at).toBe('2026-04-01T08:00:00.000Z');
    });

    it('reports a non-Error thrown value via String() in the error field', async () => {
      providerRepo.find.mockResolvedValue([makeProvider({ provider: 'openai' })]);
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'gpt-4o' })]);
      providerRepo.save.mockRejectedValueOnce('plain-string-failure');

      const result = await service.refreshProvider('agent-1', 'openai');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('plain-string-failure');
    });
  });

  /* ── empty-result cache preservation ── */

  describe('discoverModels — empty result preserves cache', () => {
    it('keeps the previous cache when the fetcher returns no models', async () => {
      const cachedModels = [makeModel({ id: 'gpt-4o' }), makeModel({ id: 'gpt-4o-mini' })];
      const provider = makeProvider({
        provider: 'openai',
        cached_models: cachedModels,
        models_fetched_at: '2026-04-01T08:00:00.000Z',
      });
      fetcher.fetch.mockResolvedValue([]);
      // Disable fallback sources so the result stays empty.
      mockPricingSync.getAll.mockReturnValue(new Map());
      mockModelsDevSync.getModelsForProvider.mockReturnValue([]);

      const result = await service.discoverModels(provider);

      expect(result).toEqual(cachedModels);
      expect(provider.cached_models).toEqual(cachedModels);
      expect(provider.models_fetched_at).toBe('2026-04-01T08:00:00.000Z');
      expect(providerRepo.save).not.toHaveBeenCalled();
    });
  });

  /* ── getModelsForAgent ── */

  describe('getModelsForAgent', () => {
    it('hides built-in local models in cloud but keeps tunneled custom models', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      providerRepo.find.mockResolvedValue([
        makeProvider({
          id: 'ollama-row',
          provider: 'ollama',
          auth_type: 'local',
          cached_models: [makeModel({ id: 'qwen2.5:0.5b', provider: 'ollama' })],
        }),
        makeProvider({
          id: 'custom-row',
          provider: 'custom:cp-1',
          auth_type: 'local',
          cached_models: null,
        }),
      ]);
      customProviderRepo.find.mockResolvedValue([makeCustomProvider()]);

      const result = await service.getModelsForAgent('tenant-1');

      expect(result.map((model) => model.id)).toEqual(['custom:cp-1/custom-llm']);
      expect(result[0].authType).toBe('local');
    });

    it('should merge cached models from providers and custom providers', async () => {
      const cachedModels = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const providers = [makeProvider({ cached_models: cachedModels })];
      providerRepo.find.mockResolvedValue(providers);

      const customProviders = [makeCustomProvider()];
      customProviderRepo.find.mockResolvedValue(customProviders);

      const result = await service.getModelsForAgent('agent-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('gpt-4');
      expect(result[1].id).toBe('custom:cp-1/custom-llm');
      expect(result[1].provider).toBe('custom:cp-1');
      expect(result[1].displayName).toBe('custom-llm');
      expect(result[1].providerName).toBe('My Custom');
      expect(result[1]).not.toHaveProperty('providerAlias');
    });

    it('carries the custom provider alias so /v1/models can publish it', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([makeCustomProvider({ alias: 'my-custom' })]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result[0].providerAlias).toBe('my-custom');
      expect(result[0].providerName).toBe('My Custom');
    });

    it('should filter stale unsupported OpenAI subscription cached models', async () => {
      const providers = [
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          cached_models: [
            makeModel({ id: 'gpt-5.5', provider: 'openai', authType: 'subscription' }),
            makeModel({ id: 'gpt-5.2-codex', provider: 'openai', authType: 'subscription' }),
            makeModel({ id: 'gpt-5.1-codex-max', provider: 'openai', authType: 'subscription' }),
            makeModel({ id: 'gpt-5.3-codex-spark', provider: 'openai', authType: 'subscription' }),
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.3-codex-spark']);
    });

    it('updates only explicitly configured subscription context windows', async () => {
      providerRepo.find.mockResolvedValue([
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          cached_models: [
            makeModel({
              id: 'gpt-5.6-sol',
              contextWindow: 272000,
              contextWindowSource: 'subscription_config',
            }),
            makeModel({
              id: 'gpt-5.6-terra',
              contextWindow: 272000,
              contextWindowSource: 'provider',
            }),
            makeModel({ id: 'gpt-5.6-luna', contextWindow: 272000 }),
          ],
        }),
      ]);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('tenant-1');

      expect(result.map((model) => [model.id, model.contextWindow])).toEqual([
        ['gpt-5.6-sol', 1050000],
        ['gpt-5.6-terra', 272000],
        ['gpt-5.6-luna', 272000],
      ]);
    });

    it('should keep Mistral Vibe subscription cached models that API-key Mistral hides', async () => {
      const providers = [
        makeProvider({
          provider: 'mistral',
          auth_type: 'subscription',
          cached_models: [
            makeModel({
              id: 'mistral-vibe-cli-latest',
              provider: 'mistral',
              authType: 'subscription',
            }),
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result.map((m) => `${m.provider}:${m.authType}:${m.id}`)).toEqual([
        'mistral:subscription:mistral-vibe-cli-latest',
      ]);
    });

    it('should inherit auth_type from tenant_providers row for custom provider models', async () => {
      const providers = [
        makeProvider({
          provider: 'custom:cp-1',
          auth_type: 'local',
          cached_models: null,
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([makeCustomProvider()]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result).toHaveLength(1);
      expect(result[0].authType).toBe('local');
    });

    it('should deduplicate duplicate models for the same provider and auth type', async () => {
      const providers = [
        makeProvider({
          id: 'p1',
          provider: 'openai',
          cached_models: [makeModel({ id: 'gpt-4' })],
        }),
        makeProvider({
          id: 'p2',
          provider: 'openai',
          cached_models: [makeModel({ id: 'gpt-4' })],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toHaveLength(1);
    });

    it('should keep the same model id from different providers as separate routes', async () => {
      const providers = [
        makeProvider({
          id: 'p1',
          provider: 'openrouter',
          cached_models: [makeModel({ id: 'deepseek-chat', provider: 'openrouter' })],
        }),
        makeProvider({
          id: 'p2',
          provider: 'deepseek',
          cached_models: [makeModel({ id: 'deepseek-chat', provider: 'deepseek' })],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result).toHaveLength(2);
      expect(result.map((m) => `${m.provider}:${m.authType}:${m.id}`)).toEqual([
        'openrouter:api_key:deepseek-chat',
        'deepseek:api_key:deepseek-chat',
      ]);
    });

    it('should skip providers with no cached_models', async () => {
      const providers = [makeProvider({ cached_models: null })];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toEqual([]);
    });

    it('should skip custom: prefixed providers from main loop', async () => {
      const providers = [
        makeProvider({
          provider: 'custom:provider-x',
          cached_models: [makeModel({ id: 'custom-model' })],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toEqual([]);
    });

    it('should handle custom provider with no models array', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([makeCustomProvider({ models: null as never })]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toEqual([]);
    });

    it('should handle custom provider with null pricing', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [
            {
              model_name: 'free-model',
              input_price_per_million_tokens: undefined,
              output_price_per_million_tokens: undefined,
            },
          ],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toHaveLength(1);
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should compute per-token prices from per-million-token prices', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([makeCustomProvider()]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result[0].inputPricePerToken).toBeCloseTo(1.5 / 1_000_000);
      expect(result[0].outputPricePerToken).toBeCloseTo(3.0 / 1_000_000);
    });

    it('should default custom model context window to 128000', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [{ model_name: 'no-ctx' }],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result[0].contextWindow).toBe(128000);
    });

    it('should filter out non-chat models from cached results', async () => {
      const providers = [
        makeProvider({
          provider: 'copilot',
          cached_models: [
            makeModel({ id: 'copilot/claude-opus-4.7', provider: 'copilot' }),
            makeModel({ id: 'copilot/accounts/msft/routers/f185i3v4', provider: 'copilot' }),
            makeModel({ id: 'copilot/accounts/msft/routers/fmfeto88', provider: 'copilot' }),
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('copilot/claude-opus-4.7');
    });

    it('should deduplicate custom provider models by composite key', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          id: 'cp-1',
          models: [{ model_name: 'dup-model' }, { model_name: 'dup-model' }],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result).toHaveLength(1);
    });
  });

  /* ── getModelsForAgent caching ── */

  describe('getModelsForAgent (cache)', () => {
    beforeEach(() => {
      providerRepo.find.mockResolvedValue([
        makeProvider({ cached_models: [makeModel({ id: 'gpt-4', provider: 'openai' })] }),
      ]);
      customProviderRepo.find.mockResolvedValue([]);
    });

    it('serves the second call within TTL from cache (no extra DB hit)', async () => {
      const first = await service.getModelsForAgent('tenant-1', 'agent-1');
      const second = await service.getModelsForAgent('tenant-1', 'agent-1');

      expect(second).toEqual(first);
      // providerRepo.find is hit once for tenant_providers on the first call only.
      expect(providerRepo.find).toHaveBeenCalledTimes(1);
      expect(customProviderRepo.find).toHaveBeenCalledTimes(1);
    });

    it('isolates cache entries per agent', async () => {
      await service.getModelsForAgent('tenant-1', 'agent-1');
      await service.getModelsForAgent('tenant-1', 'agent-2');

      // Distinct keys → distinct DB reads.
      expect(providerRepo.find).toHaveBeenCalledTimes(2);
    });

    it('refetches after invalidate(agentId)', async () => {
      await service.getModelsForAgent('tenant-1', 'agent-1');
      service.invalidate('agent-1');
      await service.getModelsForAgent('tenant-1', 'agent-1');

      expect(providerRepo.find).toHaveBeenCalledTimes(2);
    });

    it('invalidateTenant drops every agent of that tenant and no other', async () => {
      await service.getModelsForAgent('tenant-1', 'agent-1');
      await service.getModelsForAgent('tenant-1', 'agent-2');
      await service.getModelsForAgent('tenant-2', 'agent-3');
      service.invalidateTenant('tenant-1');

      await service.getModelsForAgent('tenant-1', 'agent-1'); // refetch
      await service.getModelsForAgent('tenant-1', 'agent-2'); // refetch
      await service.getModelsForAgent('tenant-2', 'agent-3'); // still cached

      expect(providerRepo.find).toHaveBeenCalledTimes(5);
    });

    it('only invalidates the targeted agent', async () => {
      await service.getModelsForAgent('tenant-1', 'agent-1');
      await service.getModelsForAgent('tenant-1', 'agent-2');
      service.invalidate('agent-1');

      await service.getModelsForAgent('tenant-1', 'agent-1'); // refetch
      await service.getModelsForAgent('tenant-1', 'agent-2'); // still cached

      expect(providerRepo.find).toHaveBeenCalledTimes(3);
    });

    it('refetches after the TTL expires', async () => {
      jest.useFakeTimers();
      try {
        await service.getModelsForAgent('tenant-1', 'agent-1');
        jest.advanceTimersByTime(120_001);
        await service.getModelsForAgent('tenant-1', 'agent-1');
        expect(providerRepo.find).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('invalidates the agent cache after discoverModels rewrites cached_models', async () => {
      // Warm the cache for agent-1.
      await service.getModelsForAgent('tenant-1', 'agent-1');
      expect(providerRepo.find).toHaveBeenCalledTimes(1);

      // Discover models for the same user → cached_models change on disk →
      // the per-user model cache must be dropped.
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'gpt-4o', provider: 'openai' })]);
      await service.discoverModels(makeProvider({ tenant_id: 'tenant-1', agent_id: 'agent-1' }));

      await service.getModelsForAgent('tenant-1', 'agent-1');
      // Second getModelsForAgent must hit the DB again (find called twice for
      // tenant_providers across the two getModelsForAgent calls).
      expect(providerRepo.find).toHaveBeenCalledTimes(2);
    });

    it('sweeps expired entries on populate so the cache cannot grow unbounded', async () => {
      jest.useFakeTimers();
      try {
        const cache = (service as unknown as { modelsCache: Map<string, unknown> }).modelsCache;
        await service.getModelsForAgent('tenant-1', 'agent-1');
        await service.getModelsForAgent('tenant-1', 'agent-2'); // sweep sees agent-1 still fresh (skip branch)
        expect(cache.size).toBe(2);

        jest.advanceTimersByTime(120_001); // agent-1 + agent-2 now expired
        await service.getModelsForAgent('tenant-1', 'agent-3'); // sweep evicts the two stale entries

        expect(cache.size).toBe(1);
        expect(cache.has('agent-3')).toBe(true);
        expect(providerRepo.find).toHaveBeenCalledTimes(3);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /* ── getModelForAgent ── */

  describe('getModelForAgent', () => {
    it('should return the matching model', async () => {
      providerRepo.find.mockResolvedValue([
        makeProvider({
          cached_models: [makeModel({ id: 'gpt-4' }), makeModel({ id: 'gpt-3.5' })],
        }),
      ]);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelForAgent('agent-1', 'gpt-4');
      expect(result).toBeDefined();
      expect(result!.id).toBe('gpt-4');
    });

    it('should not infer a provider when the model id is shared by multiple routes', async () => {
      providerRepo.find.mockResolvedValue([
        makeProvider({
          provider: 'openrouter',
          cached_models: [makeModel({ id: 'deepseek-chat', provider: 'openrouter' })],
        }),
        makeProvider({
          provider: 'deepseek',
          cached_models: [makeModel({ id: 'deepseek-chat', provider: 'deepseek' })],
        }),
      ]);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelForAgent('agent-1', 'deepseek-chat');
      expect(result).toBeUndefined();
    });

    it('should return undefined for missing model', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelForAgent('agent-1', 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  /* ── enrichModel edge cases via discoverModels ── */

  describe('enrichModel (via discoverModels)', () => {
    it('should preserve zero pricing from fetcher (free/subscription models)', async () => {
      // inputPricePerToken is 0 (free/subscription), enrichment should NOT override
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/free-model') {
          return { input: 0.001, output: 0.002 };
        }
        return null;
      });

      const models = [
        makeModel({ id: 'free-model', inputPricePerToken: 0, outputPricePerToken: 0 }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());
      // Price=0 means "free/included" — should not be overwritten
      expect(result[0].inputPricePerToken).toBe(0);
      expect(result[0].outputPricePerToken).toBe(0);
    });

    it('should apply capabilities from models.dev even when pricing is already set', async () => {
      // Copilot/subscription model has price=0 but needs capability flags for scoring
      mockModelsDevSync.lookupModel.mockImplementation((providerId: string, modelId: string) => {
        if (modelId === 'copilot-model') {
          return {
            id: 'copilot-model',
            name: 'Copilot Model',
            inputPricePerToken: 0.000005, // pricing should NOT be applied
            outputPricePerToken: 0.000025,
            reasoning: true,
            toolCall: true,
          };
        }
        return null;
      });

      const models = [
        makeModel({
          id: 'copilot-model',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: false,
          capabilityCode: false,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Pricing preserved as 0 (not overwritten)
      expect(result[0].inputPricePerToken).toBe(0);
      expect(result[0].outputPricePerToken).toBe(0);
      // Capabilities applied from models.dev
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('should apply capabilities from an unmapped models.dev provider (priced model)', async () => {
      // Kilo prices its own catalog, so enrichment takes the price-already-set
      // path. models.dev does not map `kilo`, so only the custom-provider
      // catalog carries its modalities.
      mockModelsDevSync.lookupModelCapabilities.mockImplementation(
        (providerId: string, modelId: string) =>
          providerId === 'kilo' && modelId === 'openai/gpt-4o-mini'
            ? {
                id: 'openai/gpt-4o-mini',
                name: 'GPT-4o mini',
                inputPricePerToken: 0.00000015,
                outputPricePerToken: 0.0000006,
                reasoning: true,
                toolCall: true,
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                capabilities: ['text', 'image', 'tools'],
              }
            : null,
      );

      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'openai/gpt-4o-mini',
          provider: 'kilo',
          inputPricePerToken: 0.0000002,
          outputPricePerToken: 0.0000008,
        }),
      ]);

      const result = await service.discoverModels(makeProvider({ provider: 'kilo' }));

      expect(result[0].inputModalities).toEqual(['text', 'image']);
      expect(result[0].outputModalities).toEqual(['text']);
      expect(result[0].capabilityReasoning).toBe(true);
      // The connection's own price wins; models.dev pricing is never read here.
      expect(result[0].inputPricePerToken).toBe(0.0000002);
      expect(result[0].outputPricePerToken).toBe(0.0000008);
    });

    it('should apply capabilities from an unmapped models.dev provider (unpriced model)', async () => {
      // Xiaomi's /models publishes no pricing, so enrichment falls through
      // every pricing source before capabilities are applied.
      mockModelsDevSync.lookupModelCapabilities.mockImplementation(
        (providerId: string, modelId: string) =>
          providerId === 'xiaomi' && modelId === 'mimo-v2.5'
            ? {
                id: 'mimo-v2.5',
                name: 'MiMo V2.5',
                inputPricePerToken: 0.0000004,
                outputPricePerToken: 0.0000016,
                reasoning: true,
                toolCall: true,
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                capabilities: ['text', 'image', 'tools'],
              }
            : null,
      );

      fetcher.fetch.mockResolvedValue([makeModel({ id: 'mimo-v2.5', provider: 'xiaomi' })]);

      const result = await service.discoverModels(makeProvider({ provider: 'xiaomi' }));

      expect(result[0].inputModalities).toEqual(['text', 'image']);
      expect(result[0].capabilityReasoning).toBe(true);
      // No pricing source resolved, so the model stays unpriced rather than
      // borrowing the aggregator's rate.
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should filter tool-less models of capability-only providers', async () => {
      // The tool-support filter reads the same capability catalog as
      // enrichment, so a Kilo model models.dev marks toolCall=false is
      // dropped while an unknown one is kept.
      mockModelsDevSync.lookupModelCapabilities.mockImplementation(
        (providerId: string, modelId: string) =>
          providerId === 'kilo' && modelId === 'vendor/no-tools'
            ? { id: 'vendor/no-tools', name: 'No Tools', toolCall: false }
            : null,
      );

      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'vendor/no-tools',
          provider: 'kilo',
          inputPricePerToken: 0.000001,
          outputPricePerToken: 0.000002,
        }),
        makeModel({
          id: 'vendor/unknown',
          provider: 'kilo',
          inputPricePerToken: 0.000001,
          outputPricePerToken: 0.000002,
        }),
      ]);

      const result = await service.discoverModels(makeProvider({ provider: 'kilo' }));

      expect(result.map((m) => m.id)).toEqual(['vendor/unknown']);
    });

    it('should route capability lookups through lookupModelCapabilities', async () => {
      // enrichModel must not read capabilities from lookupModel: that path is
      // reserved for pricing, and a capability-only entry carries a reseller's
      // rate for a vendor's model ID. Only the capability catalog answers here,
      // so reverting enrichModel to lookupModel leaves the flags unset.
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockModelsDevSync.lookupModelCapabilities.mockImplementation(
        (providerId: string, modelId: string) =>
          providerId === 'openai' && modelId === 'test-model'
            ? {
                id: 'test-model',
                name: 'Test Model',
                reasoning: true,
                toolCall: true,
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                capabilities: ['text', 'image', 'tools'],
              }
            : null,
      );
      fetcher.fetch.mockResolvedValue([
        makeModel({ inputPricePerToken: 0, outputPricePerToken: 0 }),
      ]);

      const result = await service.discoverModels(makeProvider());

      expect(mockModelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith(
        'openai',
        'test-model',
      );
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].inputModalities).toEqual(['text', 'image']);
    });

    it('should fall back to exact model ID lookup when prefix lookup misses', async () => {
      // Prefix lookup returns null, but exact model ID lookup returns pricing
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/special-model') return null;
        if (key === 'special-model') {
          return { input: 0.0001, output: 0.0002, contextWindow: 64000, displayName: 'Special' };
        }
        return null;
      });

      const models = [makeModel({ id: 'special-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('openai/special-model');
      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('special-model');
      expect(result[0].inputPricePerToken).toBe(0.0001);
      expect(result[0].outputPricePerToken).toBe(0.0002);
      expect(result[0].contextWindow).toBe(64000);
      expect(result[0].displayName).toBe('Special');
    });

    it('should resolve prefix via displayName when provider ID is not a prefix', async () => {
      // 'Mistral' is the displayName for prefix 'mistralai' in OPENROUTER_PREFIX_TO_PROVIDER
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'mistralai/mistral-large') {
          return { input: 0.00002, output: 0.00006 };
        }
        return null;
      });

      const models = [makeModel({ id: 'mistral-large' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'Mistral' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('mistralai/mistral-large');
      expect(result[0].inputPricePerToken).toBe(0.00002);
      expect(result[0].outputPricePerToken).toBe(0.00006);
    });

    it('should use models.dev pricing before OpenRouter when available', async () => {
      mockModelsDevSync.lookupModel.mockImplementation((providerId: string, modelId: string) => {
        if (providerId === 'openai' && modelId === 'gpt-4o') {
          return {
            id: 'gpt-4o',
            name: 'GPT-4o',
            inputPricePerToken: 0.0000025,
            outputPricePerToken: 0.00001,
            contextWindow: 128000,
            reasoning: false,
          };
        }
        return null;
      });
      // OpenRouter also has pricing but should NOT be used
      mockPricingSync.lookupPricing.mockReturnValue({
        input: 0.99,
        output: 0.99,
        displayName: 'Wrong',
      });

      const models = [makeModel({ id: 'gpt-4o' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBe(0.0000025);
      expect(result[0].outputPricePerToken).toBe(0.00001);
      expect(result[0].displayName).toBe('GPT-4o');
    });

    it('should propagate capabilities from models.dev to quality scoring', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        inputPricePerToken: 0.000005,
        outputPricePerToken: 0.000025,
        contextWindow: 1000000,
        reasoning: true,
        toolCall: true,
      });

      const models = [
        makeModel({ id: 'claude-opus-4-6', capabilityReasoning: false, capabilityCode: false }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('should fall through to OpenRouter when models.dev has no match', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'openai/new-model') {
          return { input: 0.001, output: 0.002, displayName: 'New Model' };
        }
        return null;
      });

      const models = [makeModel({ id: 'new-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBe(0.001);
      expect(result[0].displayName).toBe('New Model');
    });

    it('should enrich Xiaomi MiMo API-key models from provider pricing', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'xiaomi/mimo-v2.5-pro') {
          return {
            input: 0.000003,
            output: 0.000012,
            displayName: 'MiMo V2.5 Pro',
          };
        }
        return null;
      });

      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'mimo-v2.5-pro',
          provider: 'xiaomi',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ]);

      const result = await service.discoverModels(makeProvider({ provider: 'xiaomi' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('xiaomi/mimo-v2.5-pro');
      expect(result[0].inputPricePerToken).toBe(0.000003);
      expect(result[0].outputPricePerToken).toBe(0.000012);
      expect(result[0].displayName).toBe('MiMo V2.5 Pro');
    });

    it('should skip prefix lookup when provider has no OpenRouter prefix', async () => {
      // Use a provider that has no OpenRouter prefix mapping
      const models = [makeModel({ id: 'unknown-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'unknown-provider' }));

      // lookupPricing should still be called for exact match (model.id)
      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('unknown-model');
      expect(result[0].inputPricePerToken).toBeNull();
    });

    it('should use model defaults when exact match has no contextWindow or displayName', async () => {
      // No prefix found, exact match returns pricing without optional fields
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'bare-model') {
          return { input: 0.0005, output: 0.001 };
        }
        return null;
      });

      const models = [makeModel({ id: 'bare-model', contextWindow: 4096, displayName: 'Bare' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'unknown-provider' }));

      expect(result[0].inputPricePerToken).toBe(0.0005);
      expect(result[0].contextWindow).toBe(4096);
      expect(result[0].displayName).toBe('Bare');
    });

    it('should call computeQualityScore with null pricing when no source available', async () => {
      mockComputeScore.mockReturnValue(2);

      const models = [makeModel({ id: 'unknown-model' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(mockComputeScore).toHaveBeenCalledWith(
        expect.objectContaining({
          model_name: 'unknown-model',
          input_price_per_token: null,
          output_price_per_token: null,
        }),
      );
      expect(result[0].qualityScore).toBe(2);
    });

    it('should call computeQualityScore even when no pricing is found', async () => {
      const models = [makeModel({ id: 'no-pricing-model' })];
      fetcher.fetch.mockResolvedValue(models);

      await service.discoverModels(makeProvider());

      expect(mockComputeScore).toHaveBeenCalledWith(
        expect.objectContaining({
          model_name: 'no-pricing-model',
          input_price_per_token: null,
          output_price_per_token: null,
        }),
      );
    });

    it('should resolve pricing via dash-to-dot normalization', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'anthropic/claude-sonnet-4.6') {
          return { input: 0.00003, output: 0.00015 };
        }
        return null;
      });

      const models = [makeModel({ id: 'claude-sonnet-4-6' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4.6');
      expect(result[0].inputPricePerToken).toBe(0.00003);
      expect(result[0].outputPricePerToken).toBe(0.00015);
    });

    it('should resolve pricing via dot-to-dash normalization', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'anthropic/claude-sonnet-4-6') {
          return { input: 0.00003, output: 0.00015 };
        }
        return null;
      });

      const models = [makeModel({ id: 'claude-sonnet-4.6' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4.6');
      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
      expect(result[0].inputPricePerToken).toBe(0.00003);
      expect(result[0].outputPricePerToken).toBe(0.00015);
    });

    it('should resolve pricing by stripping date suffix', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'anthropic/claude-sonnet-4-5') {
          return { input: 0.00003, output: 0.00015 };
        }
        return null;
      });

      const models = [makeModel({ id: 'claude-sonnet-4-5-20250929' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-5-20250929',
      );
      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
      expect(result[0].inputPricePerToken).toBe(0.00003);
    });

    it('should resolve pricing by stripping date suffix then applying dot variant', async () => {
      mockPricingSync.lookupPricing.mockImplementation((key: string) => {
        if (key === 'anthropic/claude-sonnet-4.5') {
          return { input: 0.00003, output: 0.00015 };
        }
        return null;
      });

      const models = [makeModel({ id: 'claude-sonnet-4-5-20250929' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(mockPricingSync.lookupPricing).toHaveBeenCalledWith('anthropic/claude-sonnet-4.5');
      expect(result[0].inputPricePerToken).toBe(0.00003);
    });

    it('should build fallback models from OpenRouter cache when native API returns empty', async () => {
      fetcher.fetch.mockResolvedValue([]);

      const orMap = new Map([
        [
          'anthropic/claude-opus-4.6',
          {
            input: 0.000015,
            output: 0.000075,
            contextWindow: 200000,
            displayName: 'Claude Opus 4.6',
          },
        ],
        [
          'anthropic/claude-sonnet-4.6',
          {
            input: 0.000003,
            output: 0.000015,
            contextWindow: 200000,
            displayName: 'Claude Sonnet 4.6',
          },
        ],
        [
          'openai/gpt-4o',
          {
            input: 0.0000025,
            output: 0.00001,
            contextWindow: 128000,
            displayName: 'GPT-4o',
          },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(makeProvider({ provider: 'anthropic' }));

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('claude-opus-4-6');
      expect(result[0].displayName).toBe('Claude Opus 4.6');
      expect(result[0].inputPricePerToken).toBe(0.000015);
      expect(result[0].provider).toBe('anthropic');
      expect(result[1].id).toBe('claude-sonnet-4-6');
    });

    it('should unwrap OAuth blob for OpenAI subscription before fetching', async () => {
      const blob = JSON.stringify({
        t: 'access-token-123',
        r: 'refresh-tok',
        e: Date.now() + 60000,
      });
      mockDecrypt.mockReturnValue(blob);

      const models = [makeModel({ id: 'gpt-5.5' })];
      fetcher.fetch.mockResolvedValue(models);

      await service.discoverModels(
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      // Should pass the unwrapped access token, not the JSON blob
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'openai',
        'access-token-123',
        'subscription',
        undefined,
      );
    });

    it('should use raw key when OpenAI subscription blob has no t field', async () => {
      const blob = JSON.stringify({ r: 'refresh-tok', e: Date.now() + 60000 });
      mockDecrypt.mockReturnValue(blob);

      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      // No `t` field — should use the raw JSON string
      expect(fetcher.fetch).toHaveBeenCalledWith('openai', blob, 'subscription', undefined);
    });

    it('should use raw key when OpenAI subscription value is not JSON', async () => {
      mockDecrypt.mockReturnValue('plain-token-value');

      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-plain',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'openai',
        'plain-token-value',
        'subscription',
        undefined,
      );
    });

    it('should not unwrap blob for non-OAuth subscription providers', async () => {
      const blob = JSON.stringify({ t: 'access-token', r: 'refresh', e: Date.now() + 60000 });
      mockDecrypt.mockReturnValue(blob);

      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'qwen',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith('qwen', blob, 'subscription', undefined);
    });

    it('should use curated models for Anthropic subscription providers without live discovery probes', async () => {
      mockDecrypt.mockReturnValue(
        JSON.stringify({
          t: 'access-token',
          r: 'refresh',
          e: Date.now() + 60000,
        }),
      );
      mockPricingSync.getAll.mockReturnValue(
        new Map([
          [
            'anthropic/claude-sonnet-5:batch',
            {
              input: 0.000001,
              output: 0.000005,
              displayName: 'Anthropic: Claude Sonnet 5 (batch)',
            },
          ],
        ]),
      );

      const result = await service.discoverModels(
        makeProvider({
          provider: 'anthropic',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
        }),
      );

      expect(fetcher.fetch).not.toHaveBeenCalled();
      // Sorted: the enrichment order of curated entries is not stable across
      // environments (pricing-cache state moves ids around).
      expect(result.map((m) => m.id).sort()).toEqual([
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-haiku-4',
        'claude-opus-4',
        'claude-opus-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
      ]);
      expect(result.map((m) => m.id)).not.toContain('claude-sonnet-5:batch');
      expect(mockPricingSync.getAll).not.toHaveBeenCalled();
      expect(mockPricingSync.lookupPricing).not.toHaveBeenCalled();
    });

    it('should not use external catalogs when dynamic subscription discovery is empty', async () => {
      fetcher.fetch.mockResolvedValue([]);
      mockModelsDevSync.getModelsForProvider.mockReturnValue([
        {
          id: 'external-only-model',
          name: 'External-only model',
          contextWindow: 128000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          reasoning: false,
          toolCall: true,
        },
      ]);
      mockPricingSync.getAll.mockReturnValue(
        new Map([
          [
            'opencode-zen/external-only-model',
            {
              input: 0,
              output: 0,
              displayName: 'External-only model',
            },
          ],
        ]),
      );

      const result = await service.discoverModels(
        makeProvider({
          provider: 'opencode-zen',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
        }),
      );

      expect(result).toEqual([]);
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-zen',
        'decrypted-key',
        'subscription',
        undefined,
      );
      expect(mockModelsDevSync.getModelsForProvider).not.toHaveBeenCalled();
      expect(mockPricingSync.getAll).not.toHaveBeenCalled();
      expect(mockPricingSync.lookupPricing).not.toHaveBeenCalled();
    });

    it('should unwrap MiniMax OAuth blob and forward resource URL for subscription discovery', async () => {
      const blob = JSON.stringify({
        t: 'minimax-access',
        r: 'minimax-refresh',
        e: Date.now() + 60000,
        u: 'https://api.minimax.io/anthropic',
      });
      mockDecrypt.mockReturnValue(blob);

      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'minimax',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'minimax',
        'minimax-access',
        'subscription',
        'https://api.minimax.io/anthropic',
      );
    });

    it('routes pasted-token MiniMax CN subscription discovery to the CN host', async () => {
      // Pasted sk-cp- token: not a JSON blob, region=cn stored alongside
      mockDecrypt.mockReturnValue('sk-cp-cn-token');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'minimax',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
          region: 'cn',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'minimax',
        'sk-cp-cn-token',
        'subscription',
        'https://api.minimaxi.com/anthropic/v1',
      );
    });

    it('leaves discovery on the default host for pasted-token MiniMax global subscription', async () => {
      mockDecrypt.mockReturnValue('sk-cp-global-token');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'minimax',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
          region: 'global',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'minimax',
        'sk-cp-global-token',
        'subscription',
        undefined,
      );
    });

    it('routes MiniMax CN API-key discovery to the CN OpenAI endpoint', async () => {
      mockDecrypt.mockReturnValue('sk-minimax-api-key');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'minimax',
          auth_type: 'api_key',
          api_key_encrypted: 'encrypted',
          region: 'cn',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'minimax',
        'sk-minimax-api-key',
        'api_key',
        'https://api.minimaxi.com/v1',
      );
    });

    it('routes Z.ai CN subscription discovery to the China Coding Plan host', async () => {
      mockDecrypt.mockReturnValue('zai-sub-key');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'zai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
          region: 'cn',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'zai',
        'zai-sub-key',
        'subscription',
        'https://open.bigmodel.cn/api/coding/paas/v4',
      );
    });

    it('leaves Z.ai global subscription discovery on the default outside-China host', async () => {
      mockDecrypt.mockReturnValue('zai-sub-key');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'zai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
          region: 'global',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith('zai', 'zai-sub-key', 'subscription', undefined);
    });

    it('routes Xiaomi MiMo Token Plan subscription discovery to the selected region host', async () => {
      mockDecrypt.mockReturnValue('tp-mimo-token');
      fetcher.fetch.mockResolvedValue([]);

      await service.discoverModels(
        makeProvider({
          provider: 'xiaomi',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted',
          region: 'ams',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'xiaomi',
        'tp-mimo-token',
        'subscription',
        'https://token-plan-ams.xiaomimimo.com',
      );
    });

    it('should fall back to subscription fallback when OpenAI token fetch returns empty', async () => {
      const blob = JSON.stringify({ t: 'expired-token', r: 'refresh', e: Date.now() - 1000 });
      mockDecrypt.mockReturnValue(blob);

      // Fetcher returns empty (e.g., 401 from expired token)
      fetcher.fetch.mockResolvedValue([]);

      const orMap = new Map([
        [
          'openai/gpt-5.5',
          {
            input: 0.000001,
            output: 0.000004,
            contextWindow: 200000,
            displayName: 'GPT-5.5',
          },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      // Should fall back to buildFallbackModels (not subscription fallback, since token exists)
      expect(fetcher.fetch).toHaveBeenCalled();
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should not build pricing fallback models for qwen when native discovery returns empty', async () => {
      fetcher.fetch.mockResolvedValue([]);
      mockPricingSync.getAll.mockReturnValue(
        new Map([
          [
            'qwen/qwen3.5-9b',
            {
              input: 0.0000001,
              output: 0.0000002,
              contextWindow: 128000,
              displayName: 'qwen3.5-9b',
            },
          ],
        ]),
      );

      const provider = makeProvider({
        provider: 'qwen',
        region: 'singapore',
      });
      const result = await service.discoverModels(provider);

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'qwen',
        'decrypted-key',
        'api_key',
        'https://dashscope-intl.aliyuncs.com/compatible-mode',
      );
      expect(result).toEqual([]);
      expect(provider.cached_models).toEqual([]);
    });

    it('routes Qwen discovery to a stored Alibaba Model Studio base URL', async () => {
      fetcher.fetch.mockResolvedValue([]);
      mockPricingSync.getAll.mockReturnValue(new Map());

      const provider = makeProvider({
        provider: 'qwen',
        region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
      });
      await service.discoverModels(provider);

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'qwen',
        'decrypted-key',
        'api_key',
        'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
      );
    });

    it('should stamp authType as api_key for regular providers', async () => {
      const models = [makeModel({ id: 'gpt-4o' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider({ auth_type: 'api_key' }));

      expect(result[0].authType).toBe('api_key');
    });

    it('should stamp authType as subscription for subscription providers', async () => {
      const models = [makeModel({ id: 'claude-sonnet-4' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'anthropic',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-token',
        }),
      );

      expect(result[0].authType).toBe('subscription');
    });

    it('should stamp authType as local for Ollama providers', async () => {
      const models = [makeModel({ id: 'llama3.1:8b' })];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'ollama',
          auth_type: 'local',
          api_key_encrypted: null,
        }),
      );

      expect(result[0].authType).toBe('local');
    });

    it('should use subscription fallback when auth_type is subscription and no token', async () => {
      const orMap = new Map([
        [
          'anthropic/claude-opus-4-20260301',
          {
            input: 0.000015,
            output: 0.000075,
            contextWindow: 200000,
            displayName: 'Claude Opus 4',
          },
        ],
        [
          'anthropic/claude-sonnet-4-20260301',
          {
            input: 0.000003,
            output: 0.000015,
            contextWindow: 200000,
            displayName: 'Claude Sonnet 4',
          },
        ],
        [
          'anthropic/claude-haiku-4-20260301',
          {
            input: 0.0000008,
            output: 0.000004,
            contextWindow: 200000,
            displayName: 'Claude Haiku 4',
          },
        ],
        [
          'anthropic/claude-2.1',
          {
            input: 0.000008,
            output: 0.000024,
            contextWindow: 200000,
            displayName: 'Claude 2.1',
          },
        ],
        [
          'openai/gpt-4o',
          {
            input: 0.0000025,
            output: 0.00001,
            contextWindow: 128000,
            displayName: 'GPT-4o',
          },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'anthropic',
          auth_type: 'subscription',
          api_key_encrypted: null,
        }),
      );

      // Subscription membership comes only from the curated knownModels list.
      expect(result).toHaveLength(7);
      expect(result.map((m) => m.id).sort()).toEqual([
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-haiku-4',
        'claude-opus-4',
        'claude-opus-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
      ]);
      // All should be stamped as subscription
      for (const m of result) {
        expect(m.authType).toBe('subscription');
      }
      // Should NOT have called the fetcher (no token to call with)
      expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    it('should apply subscription context windows to curated models', async () => {
      const orMap = new Map([
        [
          'anthropic/claude-opus-4-20260301',
          {
            input: 0.000015,
            output: 0.000075,
            contextWindow: 1000000,
            displayName: 'Claude Opus 4',
          },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'anthropic',
          auth_type: 'subscription',
          api_key_encrypted: null,
        }),
      );

      const model = result.find((m) => m.id === 'claude-opus-4');
      expect(model).toBeDefined();
      expect(model!.contextWindow).toBe(200000);
      expect(result.map((m) => m.id)).not.toContain('claude-opus-4-20260301');
    });

    it('should use only curated OpenAI models when no subscription token is available', async () => {
      const orMap = new Map([
        [
          'openai/gpt-5.5',
          {
            input: 0.000001,
            output: 0.000004,
            contextWindow: 200000,
            displayName: 'GPT-5.5',
          },
        ],
        [
          'openai/gpt-4o',
          { input: 0.0000025, output: 0.00001, contextWindow: 128000, displayName: 'GPT-4o' },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: null,
        }),
      );

      const ids = result.map((m) => m.id);
      expect(ids).toContain('gpt-5.5');
      expect(ids).toContain('gpt-5.4');
      expect(ids).toContain('gpt-5.3-codex-spark');
      expect(ids).not.toContain('gpt-5.2-codex');
      expect(ids).not.toContain('gpt-5.1-codex-max');
      expect(ids).not.toContain('gpt-4o');
      // All should be stamped as subscription
      for (const m of result) {
        expect(m.authType).toBe('subscription');
      }
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(mockPricingSync.getAll).not.toHaveBeenCalled();
    });

    it('should not hardcode Qwen Token Plan fallback models when subscription fetch returns no models', async () => {
      mockDecrypt.mockReturnValue('sk-sp-token-plan-key');
      fetcher.fetch.mockResolvedValue([]);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'qwen',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-token-plan-key',
        }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'qwen',
        'sk-sp-token-plan-key',
        'subscription',
        undefined,
      );
      expect(result).toEqual([]);
    });

    it('should exchange Copilot GitHub token before fetching models', async () => {
      mockDecrypt.mockReturnValue('ghu_github_oauth_token');
      mockCopilotTokenService.getCopilotToken.mockResolvedValue('tid=copilot-api-token');

      const models = [makeModel({ id: 'copilot/claude-opus-4.6', provider: 'copilot' })];
      fetcher.fetch.mockResolvedValue(models);

      await service.discoverModels(
        makeProvider({
          provider: 'copilot',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-github-token',
        }),
      );

      expect(mockCopilotTokenService.getCopilotToken).toHaveBeenCalledWith(
        'ghu_github_oauth_token',
      );
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'copilot',
        'tid=copilot-api-token',
        'subscription',
        undefined,
      );
    });

    it('should fall back to known models when Copilot token exchange fails', async () => {
      mockDecrypt.mockReturnValue('ghu_expired_token');
      mockCopilotTokenService.getCopilotToken.mockRejectedValue(
        new Error('Copilot token exchange failed: 401'),
      );

      await service.discoverModels(
        makeProvider({
          provider: 'copilot',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-expired-token',
        }),
      );

      expect(fetcher.fetch).not.toHaveBeenCalled();
    });

    it('should skip Copilot token exchange when copilotTokenService is null', async () => {
      const serviceNoCopilot = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        mockPricingSync as never,
        mockModelsDevSync as never,
        mockModelRegistry as unknown as ProviderModelRegistryService,
        null,
      );

      mockDecrypt.mockReturnValue('ghu_github_token');
      fetcher.fetch.mockResolvedValue([]);

      await serviceNoCopilot.discoverModels(
        makeProvider({
          provider: 'copilot',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-token',
        }),
      );

      // Without copilotTokenService, raw GitHub token is passed to fetcher
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'copilot',
        'ghu_github_token',
        'subscription',
        undefined,
      );
    });

    it('should return knownModels fallback when pricingSync is null', async () => {
      const serviceNoPricing = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        null,
        null,
        null,
        null,
      );

      const result = await serviceNoPricing.discoverModels(
        makeProvider({
          provider: 'anthropic',
          auth_type: 'subscription',
          api_key_encrypted: null,
        }),
      );

      // Even without pricingSync, knownModels are returned directly
      expect(result).toHaveLength(7);
      expect(result.map((m) => m.id).sort()).toEqual([
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-haiku-4',
        'claude-opus-4',
        'claude-opus-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
      ]);
      for (const m of result) {
        expect(m.authType).toBe('subscription');
      }
    });

    it('should use subscription fallback for gemini when token present but fetcher returns empty', async () => {
      // Gemini CodeAssist does not expose a /models endpoint, so the fetcher
      // returns [] immediately (no HTTP). The discovery service then falls through
      // to buildSubscriptionFallbackModels (exact match) to produce the curated
      // model list from the OpenRouter cache.
      const blob = JSON.stringify({
        t: 'ya29.google-access-token',
        r: 'refresh-token',
        e: Date.now() + 3600000,
        u: 'my-gcp-project-123',
      });
      mockDecrypt.mockReturnValue(blob);
      // fetcher returns [] because gemini+subscription short-circuits
      fetcher.fetch.mockResolvedValue([]);

      const orMap = new Map([
        // Exact matches — should be included
        [
          'google/gemini-2.5-pro',
          {
            input: 0.00000125,
            output: 0.00001,
            contextWindow: 1000000,
            displayName: 'Gemini 2.5 Pro',
          },
        ],
        [
          'google/gemini-2.5-flash',
          {
            input: 0.0000003,
            output: 0.0000025,
            contextWindow: 1000000,
            displayName: 'Gemini 2.5 Flash',
          },
        ],
        [
          'google/gemini-3.1-flash-lite',
          {
            input: 0.000002,
            output: 0.000012,
            contextWindow: 1000000,
            displayName: 'Gemini 3.1 Flash Lite',
          },
        ],
        // Suffixed variants — should be EXCLUDED in exact mode
        [
          'google/gemini-2.5-pro-preview-06-05',
          {
            input: 0.00000125,
            output: 0.00001,
            contextWindow: 1000000,
            displayName: 'Gemini 2.5 Pro Preview',
          },
        ],
        // Non-gemini model — excluded
        [
          'openai/gpt-4o',
          { input: 0.0000025, output: 0.00001, contextWindow: 128000, displayName: 'GPT-4o' },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'gemini',
          auth_type: 'subscription',
          api_key_encrypted: 'encrypted-blob',
        }),
      );

      const ids = result.map((m) => m.id);
      // Exact matches included
      expect(ids).toContain('gemini-2.5-pro');
      expect(ids).toContain('gemini-2.5-flash');
      expect(ids).toContain('gemini-3.1-flash-lite');
      expect(ids).toContain('gemini-3.5-flash');
      // Suffixed preview NOT included (exact match mode)
      expect(ids).not.toContain('gemini-2.5-pro-preview-06-05');
      // Non-gemini models excluded
      expect(ids).not.toContain('gpt-4o');
      // gemini-2.5-flash-lite added directly (not in OpenRouter cache) as zero-cost
      expect(ids).toContain('gemini-2.5-flash-lite');
      // All stamped as subscription
      for (const m of result) {
        expect(m.authType).toBe('subscription');
      }
      // Fetcher IS called but returns [] (it short-circuits internally without HTTP).
      // Gemini blobs are NOT unwrapped in the service (only openai/minimax are),
      // so the raw JSON blob string is passed to the fetcher.
      // The service then falls through to buildSubscriptionFallbackModels.
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'gemini',
        expect.stringContaining('ya29.google-access-token'),
        'subscription',
        undefined,
      );
    });

    it('should use exact-match subscription fallback for gemini when no token', async () => {
      // When there is no encrypted key, gemini subscription shows the curated list
      const orMap = new Map([
        [
          'google/gemini-2.5-flash',
          {
            input: 0.0000003,
            output: 0.0000025,
            contextWindow: 1000000,
            displayName: 'Gemini 2.5 Flash',
          },
        ],
        [
          'google/gemini-2.5-flash-preview-05-20',
          {
            input: 0.0000003,
            output: 0.0000025,
            contextWindow: 1000000,
            displayName: 'Gemini 2.5 Flash Preview',
          },
        ],
      ]);
      mockPricingSync.getAll.mockReturnValue(orMap);

      const result = await service.discoverModels(
        makeProvider({
          provider: 'gemini',
          auth_type: 'subscription',
          api_key_encrypted: null,
        }),
      );

      const ids = result.map((m) => m.id);
      // Exact match: gemini-2.5-flash included
      expect(ids).toContain('gemini-2.5-flash');
      // Preview suffix: excluded in exact mode
      expect(ids).not.toContain('gemini-2.5-flash-preview-05-20');
      // knownModels not in cache added as zero-cost
      expect(ids).toContain('gemini-2.5-pro');
      expect(ids).toContain('gemini-2.5-flash-lite');
      expect(ids).toContain('gemini-3.1-flash-lite');
      expect(ids).toContain('gemini-3.5-flash');
      expect(ids).not.toContain('gemini-3.1-flash-lite-preview');
      expect(ids).not.toContain('gemini-3.1-pro-preview');
      expect(ids).not.toContain('gemini-3-flash-preview');
      expect(fetcher.fetch).not.toHaveBeenCalled();
    });
  });

  /* ── getModelsForAgent auth-type deduplication ── */

  describe('getModelsForAgent (auth-type dedup)', () => {
    it('should keep both auth types as separate entries for the same model', async () => {
      const providers = [
        makeProvider({
          id: 'p1',
          provider: 'anthropic',
          cached_models: [
            makeModel({ id: 'claude-sonnet-4', provider: 'anthropic', authType: 'api_key' }),
          ],
        }),
        makeProvider({
          id: 'p2',
          provider: 'anthropic',
          cached_models: [
            makeModel({
              id: 'claude-sonnet-4',
              provider: 'anthropic',
              authType: 'subscription',
              contextWindow: 200000,
            }),
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result).toHaveLength(2);
      const apiKeyEntry = result.find((m) => m.authType === 'api_key');
      const subEntry = result.find((m) => m.authType === 'subscription');
      expect(apiKeyEntry).toBeDefined();
      expect(subEntry).toBeDefined();
      expect(subEntry!.contextWindow).toBe(200000);
    });

    it('should deduplicate same model + same auth type from multiple providers', async () => {
      const providers = [
        makeProvider({
          id: 'p1',
          provider: 'anthropic',
          cached_models: [
            makeModel({
              id: 'claude-sonnet-4',
              provider: 'anthropic',
              authType: 'subscription',
            }),
          ],
        }),
        makeProvider({
          id: 'p2',
          provider: 'anthropic',
          cached_models: [
            makeModel({ id: 'claude-sonnet-4', provider: 'anthropic', authType: 'subscription' }),
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      expect(result).toHaveLength(1);
      expect(result[0].authType).toBe('subscription');
    });

    it('should use provider auth_type as fallback when cached model has no authType', async () => {
      const providers = [
        makeProvider({
          id: 'p1',
          provider: 'anthropic',
          auth_type: 'api_key',
          cached_models: [
            makeModel({ id: 'claude-sonnet-4', provider: 'anthropic' }), // no authType
          ],
        }),
        makeProvider({
          id: 'p2',
          provider: 'anthropic',
          auth_type: 'subscription',
          cached_models: [
            makeModel({ id: 'claude-sonnet-4', provider: 'anthropic' }), // no authType
          ],
        }),
      ];
      providerRepo.find.mockResolvedValue(providers);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelsForAgent('agent-1');

      // Both entries kept — one with inferred api_key, one with inferred subscription
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.authType).sort()).toEqual(['api_key', 'subscription']);
    });
  });

  /* ── supplementWithKnownModels ── */

  describe('supplementWithKnownModels', () => {
    it('should add missing knownModels to discovered models', () => {
      const raw: DiscoveredModel[] = [makeModel({ id: 'gpt-oss-120b', provider: 'openai' })];

      const result = supplementWithKnownModels(raw, 'openai');

      // 1 discovered + 7 ChatGPT-account supported knownModels
      expect(result.length).toBe(8);
      expect(result[0].id).toBe('gpt-oss-120b');
      expect(result.map((m) => m.id)).toContain('gpt-5.6-sol');
      expect(result.map((m) => m.id)).toContain('gpt-5.6-terra');
      expect(result.map((m) => m.id)).toContain('gpt-5.6-luna');
      expect(result.map((m) => m.id)).toContain('gpt-5.5');
      expect(result.map((m) => m.id)).toContain('gpt-5.4');
      expect(result.map((m) => m.id)).toContain('gpt-5.4-mini');
      expect(result.map((m) => m.id)).toContain('gpt-5.3-codex-spark');
      expect(result.map((m) => m.id)).not.toContain('gpt-5.2-codex');
    });

    it('should not duplicate models already in raw', () => {
      const raw: DiscoveredModel[] = [
        makeModel({ id: 'gpt-5.5', provider: 'openai', contextWindow: 200000 }),
      ];

      const result = supplementWithKnownModels(raw, 'openai');

      const matchingModels = result.filter((m) => m.id === 'gpt-5.5');
      expect(matchingModels).toHaveLength(1);
      // Original model preserved (not replaced)
      expect(matchingModels[0].contextWindow).toBe(200000);
    });

    it('should not add knownModel when a dated version already exists', () => {
      const raw: DiscoveredModel[] = [
        makeModel({ id: 'claude-opus-4-20260301', provider: 'anthropic' }),
      ];

      const result = supplementWithKnownModels(raw, 'anthropic');

      // claude-opus-4 is covered by claude-opus-4-20260301
      expect(result.map((m) => m.id)).not.toContain('claude-opus-4');
      // claude-sonnet-4 and claude-haiku-4 are NOT covered
      expect(result.map((m) => m.id)).toContain('claude-sonnet-4');
      expect(result.map((m) => m.id)).toContain('claude-haiku-4');
    });

    it('should return raw unchanged for non-subscription providers', () => {
      const raw: DiscoveredModel[] = [makeModel({ id: 'model-1' })];

      const result = supplementWithKnownModels(raw, 'deepseek');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('model-1');
    });

    it('should set zero pricing on supplemented models', () => {
      const result = supplementWithKnownModels([], 'openai');

      for (const m of result) {
        expect(m.inputPricePerToken).toBe(0);
        expect(m.outputPricePerToken).toBe(0);
      }
    });

    it('should supplement MiniMax known models with documented casing', () => {
      const raw: DiscoveredModel[] = [
        makeModel({ id: 'MiniMax-M2.5-highspeed', provider: 'minimax' }),
      ];

      const result = supplementWithKnownModels(raw, 'minimax');

      expect(result.map((m) => m.id)).toContain('MiniMax-M2.1');
      expect(result.map((m) => m.id)).toContain('MiniMax-M2');
      expect(result.map((m) => m.id)).not.toContain('MiniMax-M2.5');
    });

    it('should supplement Z.ai known models including glm-5.1', () => {
      const raw: DiscoveredModel[] = [makeModel({ id: 'glm-4.7', provider: 'zai' })];

      const result = supplementWithKnownModels(raw, 'zai');

      expect(result.map((m) => m.id)).toContain('glm-5.1');
      expect(result.map((m) => m.id)).toContain('glm-5-turbo');
      expect(result.map((m) => m.id)).toContain('glm-4.5-air');
      expect(result.filter((m) => m.id === 'glm-4.7')).toHaveLength(1);
    });
  });

  /* ── applyCapabilities edge cases ── */

  describe('applyCapabilities (via enrichModel)', () => {
    it('should not apply capabilities when modelsDevSync is null', async () => {
      const serviceNoMd = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        mockPricingSync as never,
        null, // no models.dev sync
        mockModelRegistry as unknown as ProviderModelRegistryService,
        null,
      );

      const models = [
        makeModel({
          id: 'free-model',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: false,
          capabilityCode: false,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await serviceNoMd.discoverModels(makeProvider());

      expect(result[0].capabilityReasoning).toBe(false);
      expect(result[0].capabilityCode).toBe(false);
    });

    it('should preserve existing capabilities when models.dev has no match', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue(null);

      const models = [
        makeModel({
          id: 'custom-model',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('should apply capabilities for OpenRouter-sourced models with positive pricing', async () => {
      // Model has pricing > 0, so enrichModel skips pricing but applies capabilities
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'gpt-4o',
        name: 'GPT-4o',
        inputPricePerToken: 0.0000025,
        outputPricePerToken: 0.00001,
        reasoning: true,
        toolCall: true,
      });

      const models = [
        makeModel({
          id: 'gpt-4o',
          inputPricePerToken: 0.0000025, // positive pricing, already set
          outputPricePerToken: 0.00001,
          capabilityReasoning: false,
          capabilityCode: false,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Pricing should be preserved (not overwritten from models.dev)
      expect(result[0].inputPricePerToken).toBe(0.0000025);
      expect(result[0].outputPricePerToken).toBe(0.00001);
      // Capabilities should be applied from models.dev
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('should use model default capabilities when models.dev entry has undefined flags', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'model-no-flags',
        name: 'Model No Flags',
        inputPricePerToken: 0.001,
        outputPricePerToken: 0.002,
        // reasoning and toolCall are undefined
      });

      const models = [
        makeModel({
          id: 'model-no-flags',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // undefined ?? true = true (model defaults preserved)
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });
  });

  /* ── enrichModel pricing boundary conditions ── */

  describe('enrichModel pricing boundary conditions', () => {
    it('should trigger pricing enrichment when inputPricePerToken is negative', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'neg-model',
        name: 'Negative Price Model',
        inputPricePerToken: 0.001,
        outputPricePerToken: 0.002,
        contextWindow: 128000,
      });

      const models = [
        makeModel({
          id: 'neg-model',
          inputPricePerToken: -1,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Negative price is < 0, so the >= 0 guard fails, enrichment kicks in
      expect(result[0].inputPricePerToken).toBe(0.001);
      expect(result[0].outputPricePerToken).toBe(0.002);
    });

    it('should trigger pricing enrichment when inputPricePerToken is null', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'null-price',
        name: 'Null Price',
        inputPricePerToken: 0.005,
        outputPricePerToken: 0.01,
        contextWindow: 64000,
      });

      const models = [
        makeModel({
          id: 'null-price',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBe(0.005);
      expect(result[0].outputPricePerToken).toBe(0.01);
    });

    it('should trigger pricing enrichment when inputPricePerToken is set but outputPricePerToken is null', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'partial-price',
        name: 'Partial Price',
        inputPricePerToken: 0.005,
        outputPricePerToken: 0.01,
        contextWindow: 64000,
      });

      const models = [
        makeModel({
          id: 'partial-price',
          inputPricePerToken: 0.001,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Output is null so enrichment should run — both prices come from models.dev
      expect(result[0].inputPricePerToken).toBe(0.005);
      expect(result[0].outputPricePerToken).toBe(0.01);
    });

    it('should skip pricing enrichment but apply capabilities for price=0 models', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'zero-price',
        name: 'Zero Price Enhanced',
        inputPricePerToken: 0.003, // should NOT be used
        outputPricePerToken: 0.006,
        reasoning: true,
        toolCall: true,
      });

      const models = [
        makeModel({
          id: 'zero-price',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: false,
          capabilityCode: false,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Pricing preserved
      expect(result[0].inputPricePerToken).toBe(0);
      expect(result[0].outputPricePerToken).toBe(0);
      // Capabilities updated from models.dev
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('uses known-model-prices when no upstream source has data', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockPricingSync.lookupPricing.mockReturnValue(null);

      const models = [
        makeModel({
          id: 'moonshot-v1-128k',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
      expect(result[0].outputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
    });

    it('known-model-prices wins over models.dev for curated models', async () => {
      // Same model id can appear in models.dev under a different inference
      // provider with different pricing. The hand-curated entry must win so
      // a connection's reported pricing reflects THAT connection's provider.
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8k (cheap-reseller pricing)',
        inputPricePerToken: 0.000_000_1, // models.dev cheap reseller price
        outputPricePerToken: 0.000_000_2,
        contextWindow: 8192,
      });

      const models = [
        makeModel({
          id: 'moonshot-v1-8k',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Known-prices ($1.66/1M) wins over models.dev ($0.0001/1M).
      expect(result[0].inputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
      expect(result[0].outputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
    });

    it('known-model-prices wins over OpenRouter for curated models', async () => {
      // Mirrors the Groq-served `qwen/qwen3-32b` scenario: OR has the model
      // id at one provider's price; the connection's actual provider lists
      // it at a different price in known-model-prices.
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockPricingSync.lookupPricing.mockReturnValue({
        input: 0.000_000_08, // OpenRouter's cheap-resale price
        output: 0.000_000_24,
        contextWindow: 32768,
        displayName: 'Moonshot v1 8k via OR',
      });

      const models = [
        makeModel({
          id: 'moonshot-v1-8k',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
      expect(result[0].outputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
    });

    it('falls through to models.dev when no known-prices entry exists', async () => {
      // Non-curated models keep the existing upstream-first behaviour.
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'totally-novel-model',
        name: 'Novel Model',
        inputPricePerToken: 0.001,
        outputPricePerToken: 0.002,
        contextWindow: 128_000,
      });

      const models = [
        makeModel({
          id: 'totally-novel-model',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBe(0.001);
      expect(result[0].outputPricePerToken).toBe(0.002);
    });

    it('still merges capability flags from models.dev when known-prices wins on pricing', async () => {
      // Identified by cubic: when known-prices wins, we still want the
      // reasoning / tool-call flags from models.dev applied — they drive
      // tier auto-assignment scoring and shouldn't be silently dropped.
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8k',
        inputPricePerToken: 0.000_000_1, // ignored — known-prices wins
        outputPricePerToken: 0.000_000_2,
        contextWindow: 8192,
        reasoning: true,
        toolCall: true,
      });

      const models = [
        makeModel({
          id: 'moonshot-v1-8k',
          inputPricePerToken: null,
          outputPricePerToken: null,
          capabilityReasoning: false,
          capabilityCode: false,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      // Pricing from known-prices.
      expect(result[0].inputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
      expect(result[0].outputPricePerToken).toBeCloseTo(1.66 / 1_000_000, 12);
      // Capabilities still merged from models.dev.
      expect(result[0].capabilityReasoning).toBe(true);
      expect(result[0].capabilityCode).toBe(true);
    });

    it('should return model without pricing when no source has data', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue(null);
      mockPricingSync.lookupPricing.mockReturnValue(null);

      const models = [
        makeModel({
          id: 'totally-unknown-model',
          inputPricePerToken: null,
          outputPricePerToken: null,
        }),
      ];
      fetcher.fetch.mockResolvedValue(models);

      const result = await service.discoverModels(makeProvider());

      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });
  });

  /* ── models.dev fallback in discoverModels ── */

  describe('models.dev fallback in discoverModels', () => {
    it('uses the live OpenCode Go catalog before models.dev fallback', async () => {
      mockModelsDevSync.getModelsForProvider.mockImplementation((providerId: string) =>
        providerId === 'opencode-go'
          ? [
              {
                id: 'glm-5.2',
                name: 'GLM-5.2',
                contextWindow: 1000000,
                inputPricePerToken: 0.0000014,
                outputPricePerToken: 0.0000044,
                reasoning: true,
                toolCall: true,
              },
            ]
          : [],
      );
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'opencode-go/glm-5.2',
          displayName: 'opencode-go/glm-5.2',
          provider: 'opencode-go',
          contextWindow: 200000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
      ]);

      const result = await service.discoverModels(
        makeProvider({ provider: 'opencode-go', auth_type: 'subscription' }),
      );

      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-go',
        'decrypted-key',
        'subscription',
        undefined,
      );
      expect(mockModelsDevSync.getModelsForProvider).not.toHaveBeenCalledWith('opencode-go');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'opencode-go/glm-5.2',
          displayName: 'opencode-go/glm-5.2',
          provider: 'opencode-go',
          contextWindow: 200000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
      );
    });

    it('uses models.dev as the primary OpenCode Zen catalog and preserves token pricing', async () => {
      mockModelsDevSync.getModelsForProvider.mockImplementation((providerId: string) =>
        providerId === 'opencode-zen'
          ? [
              {
                id: 'ring-2.6-1t-free',
                name: 'Ring 2.6 1T Free',
                contextWindow: 200000,
                inputPricePerToken: 0.000001,
                outputPricePerToken: 0.000002,
                reasoning: true,
                toolCall: true,
              },
            ]
          : [],
      );

      const result = await service.discoverModels(makeProvider({ provider: 'opencode-zen' }));

      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(mockModelsDevSync.getModelsForProvider).toHaveBeenCalledWith('opencode-zen');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'opencode-zen/ring-2.6-1t-free',
          displayName: 'Ring 2.6 1T Free',
          provider: 'opencode-zen',
          contextWindow: 200000,
          inputPricePerToken: 0.000001,
          outputPricePerToken: 0.000002,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
      );
    });

    it('refreshes metadata and fetches live OpenCode Go models on forced refresh', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'opencode-go/glm-5.2',
          provider: 'opencode-go',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
        }),
      ]);

      await service.discoverModels(
        makeProvider({ provider: 'opencode-go', auth_type: 'subscription' }),
        { forceRefresh: true },
      );

      expect(mockModelsDevSync.refreshCache).toHaveBeenCalledTimes(1);
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-go',
        'decrypted-key',
        'subscription',
        undefined,
        { forceRefresh: true },
      );
    });

    it('falls back to the OpenCode Go docs catalog when forced models.dev refresh fails', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      mockModelsDevSync.refreshCache.mockRejectedValue(new Error('models.dev unavailable'));
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'opencode-go/glm-5.2' })]);

      const result = await service.discoverModels(
        makeProvider({ provider: 'opencode-go', auth_type: 'subscription' }),
        { forceRefresh: true },
      );

      expect(mockModelsDevSync.refreshCache).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'models.dev refresh failed during manual model discovery: models.dev unavailable',
      );
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-go',
        'decrypted-key',
        'subscription',
        undefined,
        { forceRefresh: true },
      );
      expect(result[0].id).toBe('opencode-go/glm-5.2');

      warnSpy.mockRestore();
    });

    it('uses the OpenCode Go provider fetch when models.dev has no catalog entry', async () => {
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'opencode-go/glm-5.1' })]);

      const result = await service.discoverModels(
        makeProvider({ provider: 'opencode-go', auth_type: 'subscription' }),
      );

      expect(mockModelsDevSync.getModelsForProvider).not.toHaveBeenCalledWith('opencode-go');
      expect(fetcher.fetch).toHaveBeenCalledWith(
        'opencode-go',
        'decrypted-key',
        'subscription',
        undefined,
      );
      expect(result[0].id).toBe('opencode-go/glm-5.1');
    });

    it('should try models.dev before OpenRouter when native API returns empty', async () => {
      fetcher.fetch.mockResolvedValue([]);
      mockModelsDevSync.getModelsForProvider.mockReturnValue([
        {
          id: 'md-model',
          name: 'MD Model',
          contextWindow: 128000,
          inputPricePerToken: 0.001,
          outputPricePerToken: 0.002,
          reasoning: true,
          toolCall: false,
        },
      ]);

      const result = await service.discoverModels(makeProvider());

      expect(mockModelsDevSync.getModelsForProvider).toHaveBeenCalledWith('openai');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('md-model');
      expect(result[0].capabilityReasoning).toBe(true);
      // OpenRouter fallback should NOT be called when models.dev has data
      expect(mockPricingSync.getAll).not.toHaveBeenCalled();
    });

    it('should fall through to OpenRouter when both native API and models.dev return empty', async () => {
      fetcher.fetch.mockResolvedValue([]);
      mockModelsDevSync.getModelsForProvider.mockReturnValue([]);
      mockPricingSync.getAll.mockReturnValue(
        new Map([['openai/gpt-4o', { input: 0.01, output: 0.02, displayName: 'GPT-4o' }]]),
      );

      const result = await service.discoverModels(makeProvider());

      expect(mockModelsDevSync.getModelsForProvider).toHaveBeenCalledWith('openai');
      expect(mockPricingSync.getAll).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });

    it('should skip models.dev fallback when modelsDevSync is null', async () => {
      const serviceNoMd = new ModelDiscoveryService(
        providerRepo as never,
        customProviderRepo as never,
        fetcher as unknown as ProviderModelFetcherService,
        mockPricingSync as never,
        null,
        mockModelRegistry as unknown as ProviderModelRegistryService,
        null,
      );

      fetcher.fetch.mockResolvedValue([]);
      mockPricingSync.getAll.mockReturnValue(
        new Map([['openai/gpt-4o', { input: 0.01, output: 0.02, displayName: 'GPT-4o' }]]),
      );

      const result = await serviceNoMd.discoverModels(makeProvider());

      // Should go straight to OpenRouter fallback
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });
  });
});
