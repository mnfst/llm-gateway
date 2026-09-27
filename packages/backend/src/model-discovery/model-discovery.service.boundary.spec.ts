import { ModelDiscoveryService } from './model-discovery.service';
import { ProviderModelFetcherService } from './provider-model-fetcher.service';
import { ProviderModelRegistryService } from './provider-model-registry.service';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { DiscoveredModel } from './model-fetcher';

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

import { decrypt, getEncryptionSecret } from '../common/utils/crypto.util';
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
    connected_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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
    models: [{ model_name: 'custom-llm' }],
    created_at: '2026-01-01T00:00:00.000Z',
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

describe('ModelDiscoveryService — boundary conditions', () => {
  let service: ModelDiscoveryService;
  let providerRepo: ReturnType<typeof makeMockRepo>;
  let customProviderRepo: ReturnType<typeof makeMockRepo>;
  let fetcher: { fetch: jest.Mock };
  let mockPricingSync: { lookupPricing: jest.Mock; getAll: jest.Mock };
  let mockModelRegistry: { registerModels: jest.Mock; getConfirmedModels: jest.Mock };
  let mockModelsDevSync: {
    lookupModel: jest.Mock;
    lookupModelCapabilities: jest.Mock;
    getModelsForProvider: jest.Mock;
    refreshCache: jest.Mock;
  };
  let mockCopilotTokenService: { getCopilotToken: jest.Mock };

  beforeEach(() => {
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
    mockCopilotTokenService = { getCopilotToken: jest.fn().mockResolvedValue('tid=x') };
    mockDecrypt.mockReturnValue('decrypted-key');
    mockGetSecret.mockReturnValue('secret-32-chars-long-xxxxxxxxxx');
    // Explicit reset — jest.clearAllMocks() in afterEach clears call data but
    // NOT mockReturnValue, so without this re-assignment a prior test's
    // mockReturnValue(5) would bleed into this one and cause order-dependent
    // failures.
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  /* ── pricing boundary conditions ── */

  describe('enrichModel pricing boundary conditions', () => {
    it('triggers enrichment when outputPricePerToken is negative', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'neg-out',
        name: 'Neg Out',
        inputPricePerToken: 0.001,
        outputPricePerToken: 0.002,
        contextWindow: 128000,
      });
      fetcher.fetch.mockResolvedValue([
        makeModel({ id: 'neg-out', inputPricePerToken: 0.0001, outputPricePerToken: -0.5 }),
      ]);

      const result = await service.discoverModels(makeProvider());
      // Output is < 0 → >= 0 guard fails → re-priced from models.dev.
      expect(result[0].inputPricePerToken).toBe(0.001);
      expect(result[0].outputPricePerToken).toBe(0.002);
    });

    it('produces a finite quality score for zero-price models', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'zero-price',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityCode: true,
        }),
      ]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].qualityScore).toBeDefined();
      expect(Number.isFinite(result[0].qualityScore)).toBe(true);
      expect(result[0].qualityScore).toBeGreaterThanOrEqual(1);
      expect(result[0].qualityScore).toBeLessThanOrEqual(5);
    });

    it('produces a finite quality score for near-zero (epsilon) pricing', async () => {
      fetcher.fetch.mockResolvedValue([
        makeModel({
          id: 'tiny-price',
          inputPricePerToken: 1e-10,
          outputPricePerToken: 1e-10,
          capabilityReasoning: true,
        }),
      ]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].qualityScore).toBeDefined();
      expect(Number.isFinite(result[0].qualityScore)).toBe(true);
      expect(result[0].qualityScore).toBeGreaterThanOrEqual(1);
      expect(result[0].qualityScore).toBeLessThanOrEqual(5);
    });
  });

  /* ── custom provider tenant isolation ── */

  describe('getModelsForAgent — custom provider tenant isolation', () => {
    it('namespaces custom provider model ids by provider UUID', async () => {
      // Same model_name under two different agents must map to two distinct
      // ids (the provider UUID is embedded in the dedupe key + model id), so
      // cross-tenant deduplication cannot bleed routes across users.
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValueOnce([
        makeCustomProvider({
          id: 'cp-agent-a',
          models: [{ model_name: 'shared' }],
        }),
      ]);
      const resultA = await service.getModelsForAgent('agent-a');

      customProviderRepo.find.mockResolvedValueOnce([
        makeCustomProvider({
          id: 'cp-agent-b',
          models: [{ model_name: 'shared' }],
        }),
      ]);
      const resultB = await service.getModelsForAgent('agent-b');

      expect(resultA[0].id).toBe('custom:cp-agent-a/shared');
      expect(resultA[0].provider).toBe('custom:cp-agent-a');
      expect(resultB[0].id).toBe('custom:cp-agent-b/shared');
      expect(resultB[0].provider).toBe('custom:cp-agent-b');
      expect(resultA[0].id).not.toBe(resultB[0].id);
    });

    it('scopes the custom provider repository query by tenant_id', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([]);

      await service.getModelsForAgent('tenant-isolated');

      expect(customProviderRepo.find).toHaveBeenCalledWith({
        where: { tenant_id: 'tenant-isolated' },
      });
    });
  });

  describe('getModelForAgent — custom provider tenant isolation', () => {
    it('returns undefined for a custom model id that belongs to a different tenant', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([]);

      const result = await service.getModelForAgent(
        'tenant-b',
        'custom:cp-tenant-a/exclusive-model',
      );
      expect(result).toBeUndefined();
      expect(customProviderRepo.find).toHaveBeenCalledWith({
        where: { tenant_id: 'tenant-b' },
      });
    });
  });

  /* ── custom provider price arithmetic on degenerate inputs ── */

  describe('getModelsForAgent — custom provider price division edge cases', () => {
    it('passes NaN through (current behavior — division applied to non-null value)', async () => {
      // `NaN != null` is true, so the source divides NaN by 1_000_000 → NaN.
      // Documents current behavior; entity-layer validation is a separate
      // hardening task.
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [
            {
              model_name: 'nan-priced',
              input_price_per_million_tokens: Number.NaN,
              output_price_per_million_tokens: Number.NaN,
            },
          ],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(Number.isNaN(result[0].inputPricePerToken as number)).toBe(true);
      expect(Number.isNaN(result[0].outputPricePerToken as number)).toBe(true);
    });

    it('passes Infinity through (current behavior)', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [
            {
              model_name: 'inf-priced',
              input_price_per_million_tokens: Number.POSITIVE_INFINITY,
              output_price_per_million_tokens: Number.POSITIVE_INFINITY,
            },
          ],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result[0].inputPricePerToken).toBe(Number.POSITIVE_INFINITY);
      expect(result[0].outputPricePerToken).toBe(Number.POSITIVE_INFINITY);
    });

    it('produces NaN when a string slips through the entity layer (current behavior)', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [
            {
              model_name: 'string-priced',
              input_price_per_million_tokens: 'not-a-number' as unknown as number,
              output_price_per_million_tokens: 'also-not' as unknown as number,
            },
          ],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(Number.isNaN(result[0].inputPricePerToken as number)).toBe(true);
      expect(Number.isNaN(result[0].outputPricePerToken as number)).toBe(true);
    });

    it('returns null when both per-million prices are null (no division)', async () => {
      providerRepo.find.mockResolvedValue([]);
      customProviderRepo.find.mockResolvedValue([
        makeCustomProvider({
          models: [
            {
              model_name: 'null-priced',
              input_price_per_million_tokens: null as unknown as undefined,
              output_price_per_million_tokens: null as unknown as undefined,
            },
          ],
        }),
      ]);

      const result = await service.getModelsForAgent('agent-1');
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });
  });

  /* ── contextWindow boundary handling ── */

  describe('enrichModel — contextWindow boundary inputs', () => {
    // The source uses `mdEntry.contextWindow ?? model.contextWindow` (nullish
    // coalescing), which only short-circuits on null/undefined. Zero, NaN,
    // and Infinity all pass through. These tests document the current
    // behavior — a future sanitization PR should clamp to a safe range and
    // flip the `.toBe(...)` assertions to `.toBe(128_000)` / `.toBe(32_000_000)`.

    it('passes a zero contextWindow from models.dev through (current behavior)', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'zero-ctx',
        name: 'Zero',
        inputPricePerToken: 0.0001,
        outputPricePerToken: 0.0001,
        contextWindow: 0,
      });
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'zero-ctx' })]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].contextWindow).toBe(0);
    });

    it('falls back to model.contextWindow when models.dev contextWindow is undefined', async () => {
      mockModelsDevSync.lookupModel.mockReturnValue({
        id: 'no-ctx',
        name: 'No Ctx',
        inputPricePerToken: 0.0001,
        outputPricePerToken: 0.0001,
      });
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'no-ctx', contextWindow: 64000 })]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].contextWindow).toBe(64000);
    });

    it('passes Infinity contextWindow from OpenRouter through (current behavior)', async () => {
      mockPricingSync.lookupPricing.mockReturnValue({
        input: 0.0001,
        output: 0.0001,
        contextWindow: Number.POSITIVE_INFINITY,
      });
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'inf-ctx' })]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].contextWindow).toBe(Number.POSITIVE_INFINITY);
    });

    it('passes NaN contextWindow from OpenRouter through (current behavior)', async () => {
      mockPricingSync.lookupPricing.mockReturnValue({
        input: 0.0001,
        output: 0.0001,
        contextWindow: Number.NaN,
      });
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'nan-ctx' })]);

      const result = await service.discoverModels(makeProvider());
      expect(Number.isNaN(result[0].contextWindow)).toBe(true);
    });

    it('preserves a sane contextWindow value from OpenRouter', async () => {
      mockPricingSync.lookupPricing.mockReturnValue({
        input: 0.0001,
        output: 0.0001,
        contextWindow: 256000,
      });
      fetcher.fetch.mockResolvedValue([makeModel({ id: 'sane-ctx' })]);

      const result = await service.discoverModels(makeProvider());
      expect(result[0].contextWindow).toBe(256000);
    });
  });
});
