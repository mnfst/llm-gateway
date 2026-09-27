import type { Repository } from 'typeorm';
import { ProviderKeyService } from '../provider-key.service';
import { TenantProvider } from '../../../entities/tenant-provider.entity';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import type { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ProviderService } from '../provider.service';

// Mock the crypto util so tests can drive decrypt success/failure deterministically.
jest.mock('../../../common/utils/crypto.util', () => ({
  decrypt: jest.fn(),
  encrypt: jest.fn(),
  getEncryptionSecret: jest.fn(() => 'a'.repeat(64)),
  getDecryptionSecrets: jest.fn(() => ['test-secret-32-chars-long-enough!!']),
  decryptWithAny: jest.fn((ciphertext: string, secrets: string[]) => {
    const mod = jest.requireMock('../../../common/utils/crypto.util') as {
      decrypt: (c: string, s: string) => string;
    };
    return { plaintext: mod.decrypt(ciphertext, secrets[0]), secretIndex: 0 };
  }),
}));

import { decrypt } from '../../../common/utils/crypto.util';
const mockedDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;

describe('ProviderKeyService', () => {
  let providerRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let pricingCache: jest.Mocked<Pick<ModelPricingCacheService, 'getByModel'>>;
  let discoveryService: jest.Mocked<
    Pick<ModelDiscoveryService, 'getModelForAgent' | 'getModelsForAgent'>
  >;
  let routingCache: {
    getApiKey: jest.Mock;
    setApiKey: jest.Mock;
    getProviderKeys: jest.Mock;
    setProviderKeys: jest.Mock;
  };
  let providerService: jest.Mocked<Pick<ProviderService, 'getProviders'>>;
  let svc: ProviderKeyService;

  beforeEach(() => {
    jest.clearAllMocks();
    providerRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    discoveryService = {
      getModelForAgent: jest.fn().mockResolvedValue(undefined),
      getModelsForAgent: jest.fn().mockResolvedValue([]),
    };
    routingCache = {
      getApiKey: jest.fn().mockReturnValue(undefined),
      setApiKey: jest.fn(),
      getProviderKeys: jest.fn().mockReturnValue(undefined),
      setProviderKeys: jest.fn(),
    };
    providerService = { getProviders: jest.fn().mockResolvedValue([]) };

    svc = new ProviderKeyService(
      providerRepo as unknown as Repository<TenantProvider>,
      pricingCache as unknown as ModelPricingCacheService,
      discoveryService as unknown as ModelDiscoveryService,
      routingCache as unknown as RoutingCacheService,
      providerService as unknown as ProviderService,
    );
  });

  describe('getProviderApiKey', () => {
    it('returns empty string for ollama without consulting cache or repo', async () => {
      const result = await svc.getProviderApiKey('agent-1', 'ollama');
      expect(result).toBe('');
      expect(routingCache.getProviderKeys).not.toHaveBeenCalled();
    });

    it('returns the cached value when present', async () => {
      routingCache.getProviderKeys.mockReturnValue([
        { id: 'p1', label: 'Default', priority: 0, apiKey: 'cached-key', region: null },
      ]);
      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBe('cached-key');
      expect(providerRepo.find).not.toHaveBeenCalled();
    });

    it('caches the resolved key after lookup', async () => {
      routingCache.getProviderKeys.mockReturnValue(undefined);
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'enc',
          is_active: true,
          label: 'Default',
          priority: 0,
        },
      ]);
      mockedDecrypt.mockReturnValue('plaintext-key');

      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBe('plaintext-key');
      expect(routingCache.setProviderKeys).toHaveBeenCalledWith(
        'agent-1',
        'openai',
        expect.arrayContaining([expect.objectContaining({ apiKey: 'plaintext-key' })]),
        undefined,
        undefined,
      );
    });

    it('caches agent-scoped lookups under the agent segment and reads them back', async () => {
      // Miss → resolve → set with the agentId threaded through to the cache.
      routingCache.getProviderKeys.mockReturnValue(undefined);
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'enc',
          is_active: true,
          label: 'Default',
          priority: 0,
        },
      ]);
      mockedDecrypt.mockReturnValue('scoped-key');

      const result = await svc.getProviderApiKey(
        'user-1',
        'openai',
        undefined,
        undefined,
        'agent-7',
      );
      expect(result).toBe('scoped-key');
      // The cache read and write are both agent-qualified.
      expect(routingCache.getProviderKeys).toHaveBeenCalledWith(
        'user-1',
        'openai',
        undefined,
        'agent-7',
      );
      expect(routingCache.setProviderKeys).toHaveBeenCalledWith(
        'user-1',
        'openai',
        expect.arrayContaining([expect.objectContaining({ apiKey: 'scoped-key' })]),
        undefined,
        'agent-7',
      );
    });

    it('returns the agent-scoped cached chain without hitting the repo', async () => {
      routingCache.getProviderKeys.mockReturnValue([
        { id: 'p1', label: 'Default', priority: 0, apiKey: 'scoped-cached', region: null },
      ]);
      const result = await svc.getProviderApiKey(
        'user-1',
        'openai',
        undefined,
        undefined,
        'agent-7',
      );
      expect(result).toBe('scoped-cached');
      expect(providerRepo.find).not.toHaveBeenCalled();
      expect(routingCache.getProviderKeys).toHaveBeenCalledWith(
        'user-1',
        'openai',
        undefined,
        'agent-7',
      );
    });
  });

  describe('resolveProviderApiKey via getProviderApiKey', () => {
    it('returns null for a missing custom provider', async () => {
      providerRepo.find.mockResolvedValue([]);
      const result = await svc.getProviderApiKey('agent-1', 'custom:abc');
      expect(result).toBeNull();
    });

    it('returns empty string for a custom provider without an encrypted key', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'custom:abc',
          api_key_encrypted: null,
          label: 'Default',
          priority: 0,
        },
      ]);
      const result = await svc.getProviderApiKey('agent-1', 'custom:abc');
      expect(result).toBe('');
    });

    it('decrypts a custom provider key', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'custom:abc',
          api_key_encrypted: 'enc',
          label: 'Default',
          priority: 0,
        },
      ]);
      mockedDecrypt.mockReturnValue('decrypted');
      const result = await svc.getProviderApiKey('agent-1', 'custom:abc');
      expect(result).toBe('decrypted');
    });

    it('returns null when custom provider key fails to decrypt', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'custom:abc',
          api_key_encrypted: 'enc',
          label: 'Default',
          priority: 0,
        },
      ]);
      mockedDecrypt.mockImplementation(() => {
        throw new Error('bad cipher');
      });
      const result = await svc.getProviderApiKey('agent-1', 'custom:abc');
      expect(result).toBeNull();
    });

    it('returns null when no provider records match', async () => {
      providerRepo.find.mockResolvedValue([]);
      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBeNull();
    });

    it('prefers api_key over subscription when no preferred auth type given', async () => {
      providerRepo.find.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'enc-sub',
          is_active: true,
        },
        {
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'enc-key',
          is_active: true,
        },
      ]);
      mockedDecrypt.mockImplementation((cipher) =>
        cipher === 'enc-key' ? 'plaintext-key' : 'plaintext-sub',
      );

      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBe('plaintext-key');
    });

    it('honors a preferred auth type filter', async () => {
      providerRepo.find.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'enc-sub',
          is_active: true,
        },
        {
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'enc-key',
          is_active: true,
        },
      ]);
      mockedDecrypt.mockImplementation((cipher) =>
        cipher === 'enc-key' ? 'plaintext-key' : 'plaintext-sub',
      );

      const result = await svc.getProviderApiKey('agent-1', 'openai', 'subscription');
      expect(result).toBe('plaintext-sub');
    });

    it('skips records without an encrypted key', async () => {
      providerRepo.find.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: null,
          is_active: true,
        },
      ]);

      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBeNull();
    });

    it('moves to the next record when a key fails to decrypt', async () => {
      providerRepo.find.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'broken',
          is_active: true,
        },
        {
          provider: 'openai',
          auth_type: 'subscription',
          api_key_encrypted: 'good',
          is_active: true,
        },
      ]);
      mockedDecrypt.mockImplementation((cipher) => {
        if (cipher === 'broken') throw new Error('bad cipher');
        return 'real-key';
      });

      const result = await svc.getProviderApiKey('agent-1', 'openai');
      expect(result).toBe('real-key');
    });
  });

  describe('getAuthType', () => {
    it('returns "local" when a local record matches', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'local',
          is_active: true,
          api_key_encrypted: null,
        } as TenantProvider,
      ]);
      expect(await svc.getAuthType('agent-1', 'openai')).toBe('local');
    });

    it('returns "subscription" when a subscription record with key exists', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'subscription',
          is_active: true,
          api_key_encrypted: 'enc',
        } as TenantProvider,
        {
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          api_key_encrypted: 'enc-2',
        } as TenantProvider,
      ]);
      expect(await svc.getAuthType('agent-1', 'openai')).toBe('subscription');
    });

    it('falls back to api_key when subscription has no key', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'subscription',
          is_active: true,
          api_key_encrypted: null,
        } as TenantProvider,
        {
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          api_key_encrypted: 'enc',
        } as TenantProvider,
      ]);
      expect(await svc.getAuthType('agent-1', 'openai')).toBe('api_key');
    });

    it('returns the first record auth_type when none have keys', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'subscription',
          is_active: true,
          api_key_encrypted: null,
        } as TenantProvider,
      ]);
      expect(await svc.getAuthType('agent-1', 'openai')).toBe('subscription');
    });

    it('defaults to api_key when no records match', async () => {
      providerService.getProviders.mockResolvedValue([]);
      expect(await svc.getAuthType('agent-1', 'openai')).toBe('api_key');
    });

    it('honors excludeAuthTypes when alternate matches exist', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          api_key_encrypted: 'enc-key',
        } as TenantProvider,
        {
          provider: 'openai',
          auth_type: 'subscription',
          is_active: true,
          api_key_encrypted: 'enc-sub',
        } as TenantProvider,
      ]);
      const excluded = new Set(['api_key']);
      expect(await svc.getAuthType('agent-1', 'openai', excluded)).toBe('subscription');
    });

    it('ignores excludeAuthTypes when filtering would leave no records', async () => {
      providerService.getProviders.mockResolvedValue([
        {
          provider: 'openai',
          auth_type: 'api_key',
          is_active: true,
          api_key_encrypted: 'enc-key',
        } as TenantProvider,
      ]);
      const excluded = new Set(['api_key']);
      expect(await svc.getAuthType('agent-1', 'openai', excluded)).toBe('api_key');
    });
  });

  describe('hasActiveProvider', () => {
    it('returns true when an active provider record matches', async () => {
      providerService.getProviders.mockResolvedValue([
        { provider: 'openai', is_active: true } as TenantProvider,
      ]);
      expect(await svc.hasActiveProvider('agent-1', 'openai')).toBe(true);
    });

    it('returns false when no record is active', async () => {
      providerService.getProviders.mockResolvedValue([]);
      expect(await svc.hasActiveProvider('agent-1', 'openai')).toBe(false);
    });
  });

  describe('getProviderRegion', () => {
    it('returns the region of the matched record', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'qwen',
          auth_type: 'api_key',
          is_active: true,
          region: 'singapore',
          api_key_encrypted: 'enc',
          label: 'Default',
          priority: 0,
        } as TenantProvider,
      ]);
      mockedDecrypt.mockReturnValue('plaintext');
      expect(await svc.getProviderRegion('agent-1', 'qwen', 'api_key')).toBe('singapore');
    });

    it('returns the first record when no auth type filter is given', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'p1',
          provider: 'qwen',
          auth_type: 'api_key',
          is_active: true,
          region: 'us',
          api_key_encrypted: 'enc',
          label: 'Default',
          priority: 0,
        } as TenantProvider,
      ]);
      mockedDecrypt.mockReturnValue('plaintext');
      expect(await svc.getProviderRegion('agent-1', 'qwen')).toBe('us');
    });

    it('returns null when no match', async () => {
      providerRepo.find.mockResolvedValue([]);
      expect(await svc.getProviderRegion('agent-1', 'qwen')).toBeNull();
    });
  });

  describe('findProviderForModel', () => {
    it('returns the provider whose cached_models contain the model', async () => {
      providerService.getProviders.mockResolvedValue([
        { provider: 'openai', cached_models: [{ id: 'gpt-4o' }] } as unknown as TenantProvider,
        { provider: 'anthropic', cached_models: [{ id: 'claude' }] } as unknown as TenantProvider,
      ]);
      expect(await svc.findProviderForModel('agent-1', 'claude')).toBe('anthropic');
    });

    it('returns undefined when no provider lists the model', async () => {
      providerService.getProviders.mockResolvedValue([
        { provider: 'openai', cached_models: [{ id: 'gpt-4o' }] } as unknown as TenantProvider,
      ]);
      expect(await svc.findProviderForModel('agent-1', 'missing')).toBeUndefined();
    });

    it('skips providers without cached_models', async () => {
      providerService.getProviders.mockResolvedValue([
        { provider: 'no-cache', cached_models: null } as unknown as TenantProvider,
      ]);
      expect(await svc.findProviderForModel('agent-1', 'anything')).toBeUndefined();
    });
  });

  describe('isModelAvailable', () => {
    it('returns true when the model is in the discovered cache', async () => {
      discoveryService.getModelForAgent.mockResolvedValue({ id: 'gpt-4o' } as never);
      expect(await svc.isModelAvailable('agent-1', 'gpt-4o')).toBe(true);
    });

    it('returns true when pricing maps to a connected provider', async () => {
      pricingCache.getByModel.mockReturnValue({
        provider: 'openai',
        model_name: 'gpt-4o',
      } as never);
      providerRepo.find.mockResolvedValue([
        { provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(await svc.isModelAvailable('agent-1', 'gpt-4o')).toBe(true);
    });

    it('returns true when the prefix matches a connected provider', async () => {
      providerRepo.find.mockResolvedValue([
        { provider: 'anthropic', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(await svc.isModelAvailable('agent-1', 'anthropic/claude')).toBe(true);
    });

    it('always returns false for qwen models without native discovery', async () => {
      pricingCache.getByModel.mockReturnValue({
        provider: 'qwen',
        model_name: 'qwen-max',
      } as never);
      providerRepo.find.mockResolvedValue([
        { provider: 'qwen', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(await svc.isModelAvailable('agent-1', 'qwen-max')).toBe(false);
    });

    it('returns false when nothing matches', async () => {
      providerRepo.find.mockResolvedValue([]);
      expect(await svc.isModelAvailable('agent-1', 'mystery-model')).toBe(false);
    });

    it('returns true when canonical prefix maps to a connected provider', async () => {
      pricingCache.getByModel.mockReturnValue({
        provider: 'OpenRouter',
        model_name: 'openai/gpt-4o',
      } as never);
      providerRepo.find.mockResolvedValue([
        { provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(await svc.isModelAvailable('agent-1', 'gpt-4o')).toBe(true);
    });
  });

  describe('isRouteAvailable', () => {
    const discovered = (provider: string, id: string, authType?: string) =>
      ({ id, provider, authType }) as never;

    it('resolves an ambiguous model id through the pinned provider/authType', async () => {
      // Two connections expose the same model id — the name-only lookup
      // (getModelForAgent) refuses to answer, which used to disable the tier.
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('openai', 'gpt-5.5', 'api_key'),
        discovered('openai', 'gpt-5.5', 'subscription'),
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
        }),
      ).toBe(true);
    });

    it('returns false when the pinned provider does not expose the model and has no record', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('openai', 'gpt-5.5', 'api_key'),
      ]);
      providerRepo.find.mockResolvedValue([]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'anthropic',
          authType: 'api_key',
          model: 'gpt-5.5',
        }),
      ).toBe(false);
    });

    it('does not accept an active provider record when discovery has other models for the pin', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('openai', 'gpt-4o', 'api_key'),
      ]);
      providerRepo.find.mockResolvedValue([
        { provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'openai',
          authType: 'api_key',
          model: 'retired-model',
        }),
      ).toBe(false);
    });

    it('falls back to an active provider record when discovery is cold', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([]);
      providerRepo.find.mockResolvedValue([
        { provider: 'openai', auth_type: 'subscription', is_active: true } as TenantProvider,
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
        }),
      ).toBe(true);
    });

    it('respects the authType pin against provider records', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([]);
      providerRepo.find.mockResolvedValue([
        { provider: 'openai', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
        }),
      ).toBe(false);
    });

    it('requires native discovery for pinned Qwen routes', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([]);
      providerRepo.find.mockResolvedValue([
        { provider: 'qwen', auth_type: 'api_key', is_active: true } as TenantProvider,
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'qwen',
          authType: 'api_key',
          model: 'qwen-max',
        }),
      ).toBe(false);
    });

    it('treats discovered models without an authType as compatible with any pin', async () => {
      discoveryService.getModelsForAgent.mockResolvedValue([
        discovered('openai', 'gpt-5.5', undefined),
      ]);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
        }),
      ).toBe(true);
    });

    it('delegates to isModelAvailable when the route has no provider pin', async () => {
      discoveryService.getModelForAgent.mockResolvedValue({ id: 'gpt-4o' } as never);
      expect(
        await svc.isRouteAvailable('tenant-1', {
          provider: '',
          authType: 'api_key',
          model: 'gpt-4o',
        }),
      ).toBe(true);
      expect(discoveryService.getModelForAgent).toHaveBeenCalledWith(
        'tenant-1',
        'gpt-4o',
        undefined,
      );
    });
  });

  describe('hasRouteCredentials', () => {
    it('reuses the provider-key lookup for a pinned route', async () => {
      const getProviderKeys = jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([
        {
          id: 'provider-key-1',
          label: 'Default',
          priority: 0,
          apiKey: 'decrypted',
          region: null,
        },
      ]);
      const pinned = {
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-4o',
      } as const;

      await expect(svc.hasRouteCredentials('tenant-1', pinned, 'agent-1')).resolves.toBe(true);
      expect(getProviderKeys).toHaveBeenCalledWith('tenant-1', 'openai', 'api_key', 'agent-1');
    });

    it('rejects routes whose provider-key chain is empty', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([]);

      await expect(
        svc.hasRouteCredentials(
          'tenant-1',
          { provider: 'opencode-go', authType: 'api_key', model: 'glm-5.2' },
          'agent-1',
        ),
      ).resolves.toBe(false);
    });
  });

  describe('resolveProviderKeys ordering and local keys', () => {
    it('orders same-auth-type matches by priority when no auth type is preferred', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'b',
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'encB',
          is_active: true,
          label: 'B',
          priority: 1,
        },
        {
          id: 'a',
          provider: 'openai',
          auth_type: 'api_key',
          api_key_encrypted: 'encA',
          is_active: true,
          label: 'A',
          priority: 0,
        },
      ]);
      mockedDecrypt.mockImplementation((v) => (v === 'encA' ? 'key-a' : 'key-b'));
      const keys = await svc.getProviderKeys('tenant-1', 'openai');
      expect(keys.map((k) => k.apiKey)).toEqual(['key-a', 'key-b']);
    });

    it('returns an empty-string key for local providers with no stored credential', async () => {
      providerRepo.find.mockResolvedValue([
        {
          id: 'l',
          provider: 'lmstudio',
          auth_type: 'local',
          api_key_encrypted: null,
          is_active: true,
          label: 'Default',
          priority: 0,
        },
      ]);
      const keys = await svc.getProviderKeys('tenant-1', 'lmstudio');
      expect(keys[0].apiKey).toBe('');
    });
  });
});
