import {
  CACHE_LOAD_BATCH_SIZE,
  ProviderModelRegistryService,
} from './provider-model-registry.service';

/**
 * Fake repository that honours the keyset pagination the loader performs:
 * each `createQueryBuilder()` yields a builder with its own cursor/limit, and
 * `getMany()` returns the rows after the cursor, capped at the limit.
 */
interface MockQueryBuilder {
  select: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  andWhere: jest.Mock;
  getMany: jest.Mock;
}

function makeMockRepo(providers: Array<{ provider: string; cached_models: unknown }> = []) {
  const rows = providers.map((p, i) => ({ id: `id-${String(i).padStart(5, '0')}`, ...p }));

  return {
    createQueryBuilder: jest.fn((): MockQueryBuilder => {
      let cursor: string | null = null;
      let take = rows.length;

      const qb: MockQueryBuilder = {
        select: jest.fn(() => qb),
        where: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        limit: jest.fn((n: number) => {
          take = n;
          return qb;
        }),
        andWhere: jest.fn((_sql: string, params: { cursor: string }) => {
          cursor = params.cursor;
          return qb;
        }),
        getMany: jest.fn(() =>
          Promise.resolve(rows.filter((r) => cursor === null || r.id > cursor).slice(0, take)),
        ),
      };
      return qb;
    }),
  };
}

/** Run the bootstrap hook and wait for the background load it kicks off. */
async function bootstrap(service: ProviderModelRegistryService): Promise<void> {
  service.onApplicationBootstrap();
  await service.whenLoaded();
}

describe('ProviderModelRegistryService', () => {
  describe('registerModels', () => {
    it('should register models for a provider', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('openai', ['gpt-4o', 'gpt-4-turbo']);

      const confirmed = service.getConfirmedModels('openai');
      expect(confirmed).not.toBeNull();
      expect(confirmed!.has('gpt-4o')).toBe(true);
      expect(confirmed!.has('gpt-4-turbo')).toBe(true);
    });

    it('should merge models when called multiple times for the same provider', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('openai', ['gpt-4o']);
      service.registerModels('openai', ['gpt-4-turbo']);

      const confirmed = service.getConfirmedModels('openai');
      expect(confirmed!.has('gpt-4o')).toBe(true);
      expect(confirmed!.has('gpt-4-turbo')).toBe(true);
    });

    it('should store model IDs in lowercase for case-insensitive matching', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('OpenAI', ['GPT-4o']);

      const confirmed = service.getConfirmedModels('openai');
      expect(confirmed).not.toBeNull();
      expect(confirmed!.has('gpt-4o')).toBe(true);
    });

    it('should store supported endpoint metadata for confirmed models', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('copilot', [
        {
          id: 'copilot/gpt-5.5',
          supportedEndpoints: ['/responses', 'ws:/responses'],
        },
      ]);

      expect(service.getModelMetadata('copilot', 'copilot/gpt-5.5')).toEqual({
        id: 'copilot/gpt-5.5',
        supportedEndpoints: ['/responses', 'ws:/responses'],
      });
    });

    it('should preserve existing metadata when later registering IDs only', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('copilot', [
        {
          id: 'copilot/gpt-5.5',
          supportedEndpoints: ['/responses'],
        },
      ]);
      service.registerModels('copilot', ['copilot/gpt-5.5']);

      expect(service.getModelMetadata('copilot', 'copilot/gpt-5.5')?.supportedEndpoints).toEqual([
        '/responses',
      ]);
    });
  });

  describe('getConfirmedModels', () => {
    it('should return null for unknown provider', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      expect(service.getConfirmedModels('unknown')).toBeNull();
    });

    it('should be case-insensitive on provider ID', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('Anthropic', ['claude-opus-4-6']);

      expect(service.getConfirmedModels('anthropic')).not.toBeNull();
      expect(service.getConfirmedModels('ANTHROPIC')).not.toBeNull();
    });
  });

  describe('isModelConfirmed', () => {
    it('should return true for confirmed model', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('openai', ['gpt-4o']);

      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
    });

    it('should return false for unconfirmed model', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('openai', ['gpt-4o']);

      expect(service.isModelConfirmed('openai', 'phantom-model')).toBe(false);
    });

    it('should return null for unknown provider', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);

      expect(service.isModelConfirmed('unknown', 'some-model')).toBeNull();
    });

    it('should be case-insensitive on both provider and model', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('OpenAI', ['GPT-4o']);

      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
    });

    it('should return null metadata for unknown providers or models', () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);
      service.registerModels('openai', ['gpt-4o']);

      expect(service.getModelMetadata('openai', 'unknown')).toBeNull();
      expect(service.getModelMetadata('unknown', 'gpt-4o')).toBeNull();
    });
  });

  describe('onApplicationBootstrap', () => {
    it('should load models from cached tenant_providers data', async () => {
      const providers = [
        {
          provider: 'openai',
          cached_models: [
            { id: 'gpt-4o', displayName: 'GPT-4o' },
            { id: 'gpt-4-turbo', displayName: 'GPT-4 Turbo' },
          ],
        },
        {
          provider: 'anthropic',
          cached_models: [{ id: 'claude-opus-4-6', displayName: 'Claude Opus' }],
        },
      ];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
      expect(service.isModelConfirmed('openai', 'gpt-4-turbo')).toBe(true);
      expect(service.isModelConfirmed('anthropic', 'claude-opus-4-6')).toBe(true);
    });

    it('should load supported endpoint metadata from cached tenant_providers data', async () => {
      const providers = [
        {
          provider: 'copilot',
          cached_models: [
            {
              id: 'copilot/gpt-5.5',
              displayName: 'gpt-5.5',
              supportedEndpoints: ['/responses', 'ws:/responses'],
            },
          ],
        },
      ];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.getModelMetadata('copilot', 'copilot/gpt-5.5')).toEqual({
        id: 'copilot/gpt-5.5',
        supportedEndpoints: ['/responses', 'ws:/responses'],
      });
    });

    it('should skip providers with non-array cached_models', async () => {
      const providers = [{ provider: 'openai', cached_models: 'not-an-array' }];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.getConfirmedModels('openai')).toBeNull();
    });

    it('should handle empty cached_models array', async () => {
      const providers = [{ provider: 'openai', cached_models: [] }];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.getConfirmedModels('openai')).toBeNull();
    });

    it('should filter out malformed entries with missing id', async () => {
      const providers = [
        {
          provider: 'openai',
          cached_models: [
            { id: 'gpt-4o', displayName: 'GPT-4o' },
            { displayName: 'Missing ID' },
            { id: null },
            { id: '' },
          ],
        },
      ];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
      // null, undefined, and empty string should all be filtered out
      const confirmed = service.getConfirmedModels('openai');
      expect(confirmed!.size).toBe(1);
    });

    it('should handle database errors gracefully', async () => {
      const mockRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockRejectedValue(new Error('DB down')),
        }),
      };
      const service = new ProviderModelRegistryService(mockRepo as never);

      service.onApplicationBootstrap();

      await expect(service.whenLoaded()).resolves.toBeUndefined();
      expect(service.getConfirmedModels('openai')).toBeNull();
    });

    it('should merge models from multiple providers with same provider ID', async () => {
      const providers = [
        {
          provider: 'openai',
          cached_models: [{ id: 'gpt-4o' }],
        },
        {
          provider: 'openai',
          cached_models: [{ id: 'gpt-4-turbo' }],
        },
      ];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      await bootstrap(service);

      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
      expect(service.isModelConfirmed('openai', 'gpt-4-turbo')).toBe(true);
    });

    it('should not register models when providers list is empty', async () => {
      const service = new ProviderModelRegistryService(makeMockRepo([]) as never);

      await bootstrap(service);

      expect(service.getConfirmedModels('openai')).toBeNull();
    });

    it('should not block boot on the cache load', () => {
      let resolveLoad: (rows: unknown[]) => void = () => {};
      const mockRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn(() => new Promise((resolve) => (resolveLoad = resolve))),
        }),
      };
      const service = new ProviderModelRegistryService(mockRepo as never);

      // The hook returns synchronously even though the query is still pending,
      // so Nest can open the HTTP port and answer healthchecks.
      expect(service.onApplicationBootstrap()).toBeUndefined();
      expect(service.getConfirmedModels('openai')).toBeNull();

      resolveLoad([]);
    });

    it('should resolve whenLoaded before bootstrap has run', async () => {
      const service = new ProviderModelRegistryService(makeMockRepo() as never);

      await expect(service.whenLoaded()).resolves.toBeUndefined();
    });

    it('should not expose a partially loaded provider while pages are still arriving', async () => {
      // Two pages, both carrying models for the same provider. The second is
      // held open so we can observe the registry mid-load.
      const page = (start: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `id-${String(start + i).padStart(5, '0')}`,
          provider: 'openai',
          cached_models: [{ id: `gpt-${start + i}` }],
        }));
      let releaseSecondPage!: () => void;
      let call = 0;
      const mockRepo = {
        createQueryBuilder: jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn(async () => {
            call += 1;
            if (call === 1) return page(0, CACHE_LOAD_BATCH_SIZE);
            await new Promise<void>((resolve) => (releaseSecondPage = resolve));
            return page(CACHE_LOAD_BATCH_SIZE, 1);
          }),
        })),
      };
      const service = new ProviderModelRegistryService(mockRepo as never);

      service.onApplicationBootstrap();
      // Let the first page land and be staged.
      while (call < 2) await Promise.resolve();

      // A real model from the unread page must not be reported as a phantom,
      // so the provider stays absent (null) rather than partially populated.
      expect(service.getConfirmedModels('openai')).toBeNull();
      expect(service.isModelConfirmed('openai', 'gpt-0')).toBeNull();

      releaseSecondPage();
      await service.whenLoaded();

      expect(service.isModelConfirmed('openai', 'gpt-0')).toBe(true);
      expect(service.isModelConfirmed('openai', `gpt-${CACHE_LOAD_BATCH_SIZE}`)).toBe(true);
    });

    it('should keep models registered while the load was running', async () => {
      const providers = [{ provider: 'openai', cached_models: [{ id: 'gpt-4o' }] }];
      const service = new ProviderModelRegistryService(makeMockRepo(providers) as never);

      // A provider connected mid-load writes straight to the live registry.
      service.onApplicationBootstrap();
      service.registerModels('openai', ['gpt-live']);
      await service.whenLoaded();

      // The staged cache merges into it rather than replacing it.
      expect(service.isModelConfirmed('openai', 'gpt-live')).toBe(true);
      expect(service.isModelConfirmed('openai', 'gpt-4o')).toBe(true);
    });

    it('should page through providers beyond a single batch', async () => {
      const providers = Array.from({ length: CACHE_LOAD_BATCH_SIZE + 1 }, (_, i) => ({
        provider: `provider-${i}`,
        cached_models: [{ id: `model-${i}` }],
      }));
      const repo = makeMockRepo(providers);
      const service = new ProviderModelRegistryService(repo as never);

      await bootstrap(service);

      // One full page, then a short page that ends the loop.
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(service.isModelConfirmed('provider-0', 'model-0')).toBe(true);
      expect(
        service.isModelConfirmed(
          `provider-${CACHE_LOAD_BATCH_SIZE}`,
          `model-${CACHE_LOAD_BATCH_SIZE}`,
        ),
      ).toBe(true);
    });
  });
});
