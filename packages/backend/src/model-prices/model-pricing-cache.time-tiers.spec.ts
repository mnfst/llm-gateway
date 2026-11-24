import { ModelPricingCacheService } from './model-pricing-cache.service';
import { PricingSyncService, OpenRouterPricingEntry } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { ProviderModelRegistryService } from '../model-discovery/provider-model-registry.service';

/**
 * Tests for time-of-day pricing tiers flowing from the models.dev sync into
 * `PricingEntry.time_tiers` (peak/off-peak providers like DeepSeek V4).
 *
 * The transport rule is pinned here too: the OpenRouter-prefixed key means
 * the request rode through OpenRouter, which bills its own flat rate, so the
 * prefixed copy of the entry must NOT carry the lab's peak-hour schedule.
 */

const DEEPSEEK_TIME_TIER = {
  windows: ['01:00-04:00', '06:00-10:00'],
  days: [1, 2, 3, 4, 5],
  inputPricePerToken: 0.44 / 1_000_000,
  outputPricePerToken: 1.32 / 1_000_000,
  cacheReadPricePerToken: 0.014 / 1_000_000,
  cacheWritePricePerToken: null,
};

describe('ModelPricingCacheService — time-of-day pricing tiers', () => {
  let service: ModelPricingCacheService;
  let mockGetAll: jest.Mock;
  let mockModelsDevSync: {
    lookupModel: jest.Mock;
    getModelsForProvider: jest.Mock;
    isProviderSupported: jest.Mock;
    whenInitialized: jest.Mock;
  };

  beforeEach(() => {
    mockGetAll = jest.fn().mockReturnValue(new Map<string, OpenRouterPricingEntry>());
    const mockPricingSync = {
      getAll: mockGetAll,
      whenInitialized: jest.fn().mockResolvedValue(undefined),
    };
    mockModelsDevSync = {
      lookupModel: jest.fn().mockReturnValue(null),
      getModelsForProvider: jest.fn().mockImplementation((providerId: string) => {
        if (providerId !== 'deepseek') return [];
        return [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            inputPricePerToken: 0.22 / 1_000_000,
            outputPricePerToken: 0.66 / 1_000_000,
            cacheReadPricePerToken: 0.007 / 1_000_000,
            timeTiers: [DEEPSEEK_TIME_TIER],
          },
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            inputPricePerToken: 0.14 / 1_000_000,
            outputPricePerToken: 0.28 / 1_000_000,
          },
        ];
      }),
      isProviderSupported: jest.fn().mockReturnValue(false),
      whenInitialized: jest.fn().mockResolvedValue(undefined),
    };
    const mockRegistry = {
      isModelConfirmed: jest.fn().mockReturnValue(null),
      getConfirmedModels: jest.fn().mockReturnValue(null),
      registerModels: jest.fn(),
    };
    service = new ModelPricingCacheService(
      mockPricingSync as unknown as PricingSyncService,
      mockModelsDevSync as unknown as ModelsDevSyncService,
      mockRegistry as unknown as ProviderModelRegistryService,
    );
  });

  it('maps models.dev time tiers onto the bare-key pricing entry', async () => {
    await service.reload();

    const entry = service.getByModel('deepseek-v4-flash');
    expect(entry).toBeDefined();
    expect(entry!.time_tiers).toEqual([
      {
        windows: ['01:00-04:00', '06:00-10:00'],
        days: [1, 2, 3, 4, 5],
        input_price_per_token: 0.44 / 1_000_000,
        output_price_per_token: 1.32 / 1_000_000,
        cache_read_price_per_token: 0.014 / 1_000_000,
        cache_write_price_per_token: null,
      },
    ]);
    expect(entry!.input_price_per_token).toBe(0.22 / 1_000_000);
  });

  it('leaves time_tiers undefined for models without a schedule', async () => {
    await service.reload();

    expect(service.getByModel('deepseek-chat')!.time_tiers).toBeUndefined();
  });

  it('carries a schedule with no weekdays through as null, meaning every day', async () => {
    // `days` is optional upstream and an absent list means the windows apply
    // on all seven days. That has to survive the mapping as an explicit null
    // rather than vanishing, because the cost calculator reads the field to
    // decide whether to narrow the window at all.
    mockModelsDevSync.getModelsForProvider.mockImplementation((providerId: string) =>
      providerId === 'deepseek'
        ? [
            {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              inputPricePerToken: 0.22 / 1_000_000,
              outputPricePerToken: 0.66 / 1_000_000,
              cacheReadPricePerToken: 0.007 / 1_000_000,
              timeTiers: [{ ...DEEPSEEK_TIME_TIER, days: null }],
            },
          ]
        : [],
    );

    await service.reload();

    expect(service.getByModel('deepseek-v4-flash')!.time_tiers![0].days).toBeNull();
  });

  it('keeps the OpenRouter entry on the prefixed key and only drops the tiers', async () => {
    // OpenRouter also lists the model, so the prefixed key pre-exists. Pricing
    // follows transport: the OR entry keeps OR's own flat rate — the overlay
    // must not replace it with the lab's prices, only guarantee no tiers.
    mockGetAll.mockReturnValue(
      new Map<string, OpenRouterPricingEntry>([
        ['deepseek/deepseek-v4-flash', { input: 0.3 / 1_000_000, output: 0.9 / 1_000_000 }],
      ]),
    );

    await service.reload();

    const prefixed = service.getByModel('deepseek/deepseek-v4-flash');
    expect(prefixed).toBeDefined();
    expect(prefixed!.time_tiers).toBeNull();
    // OpenRouter's flat rate survives the models.dev overlay.
    expect(prefixed!.input_price_per_token).toBe(0.3 / 1_000_000);
    expect(prefixed!.output_price_per_token).toBe(0.9 / 1_000_000);
    // The bare key still carries the schedule for direct-API traffic.
    expect(service.getByModel('deepseek-v4-flash')!.time_tiers).toHaveLength(1);
  });
});
