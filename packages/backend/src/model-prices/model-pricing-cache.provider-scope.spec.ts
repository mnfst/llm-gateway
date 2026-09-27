import { ModelPricingCacheService } from './model-pricing-cache.service';
import { PricingSyncService, OpenRouterPricingEntry } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { ProviderModelRegistryService } from '../model-discovery/provider-model-registry.service';
import { PROVIDER_BY_ID } from '../common/constants/providers';
import { normalizeProviderName } from 'manifest-shared';

/**
 * A price belongs to a (provider, model) pair, not to a model.
 *
 * 24 providers publish a `deepseek-v4-pro` record. The shared cache is keyed by
 * model name alone, so they all write to one key and the last one — OpenCode
 * Zen, which sits far later in the registry than DeepSeek — is the one that
 * survives. Costing a DeepSeek request off that entry charges the user a
 * reseller's rate and drops DeepSeek's peak-hour schedule with it.
 */

const DEEPSEEK_TIME_TIER = {
  windows: ['01:00-04:00', '06:00-10:00'],
  days: [1, 2, 3, 4, 5],
  inputPricePerToken: 1.32 / 1_000_000,
  outputPricePerToken: 3.96 / 1_000_000,
  cacheReadPricePerToken: 0.044 / 1_000_000,
  cacheWritePricePerToken: null,
};

/** DeepSeek's own rates: real off-peak base plus the weekday peak band. */
const DEEPSEEK_OWN = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  inputPricePerToken: 0.66 / 1_000_000,
  outputPricePerToken: 1.98 / 1_000_000,
  cacheReadPricePerToken: 0.022 / 1_000_000,
  timeTiers: [DEEPSEEK_TIME_TIER],
};

/** The reseller's rate for the same model: higher, flat, no schedule. */
const ZEN_RESALE = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  inputPricePerToken: 1.74 / 1_000_000,
  outputPricePerToken: 3.84 / 1_000_000,
  cacheReadPricePerToken: 0.145 / 1_000_000,
};

/** A second reseller, with a multi-word display name and its own rate. */
const GO_RESALE = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro',
  inputPricePerToken: 0.9 / 1_000_000,
  outputPricePerToken: 2.4 / 1_000_000,
};

/** Catalogued under a bare id; agents often send it with a date suffix. */
const ANTHROPIC_DATED = {
  id: 'claude-opus-4-6',
  name: 'Claude Opus 4.6',
  inputPricePerToken: 5 / 1_000_000,
  outputPricePerToken: 25 / 1_000_000,
};

describe('ModelPricingCacheService — pricing scoped to the provider that served the request', () => {
  let service: ModelPricingCacheService;

  const build = (orCache = new Map<string, OpenRouterPricingEntry>()) => {
    const mockPricingSync = {
      getAll: jest.fn().mockReturnValue(orCache),
      whenInitialized: jest.fn().mockResolvedValue(undefined),
    };
    const mockModelsDevSync = {
      lookupModel: jest.fn().mockReturnValue(null),
      getModelsForProvider: jest.fn().mockImplementation((providerId: string) => {
        if (providerId === 'deepseek') return [DEEPSEEK_OWN];
        if (providerId === 'opencode-zen') return [ZEN_RESALE];
        if (providerId === 'anthropic') return [ANTHROPIC_DATED];
        if (providerId === 'opencode-go') return [GO_RESALE];
        return [];
      }),
      isProviderSupported: jest.fn().mockReturnValue(false),
      whenInitialized: jest.fn().mockResolvedValue(undefined),
    };
    const mockRegistry = {
      isModelConfirmed: jest.fn().mockReturnValue(null),
      getConfirmedModels: jest.fn().mockReturnValue(null),
      registerModels: jest.fn(),
    };
    return new ModelPricingCacheService(
      mockPricingSync as unknown as PricingSyncService,
      mockModelsDevSync as unknown as ModelsDevSyncService,
      mockRegistry as unknown as ProviderModelRegistryService,
    );
  };

  beforeEach(() => {
    service = build();
  });

  it('returns the reseller entry when no provider is named', async () => {
    await service.reload();

    // Unscoped lookup is last-writer-wins. OpenCode Zen is registered after
    // DeepSeek, so this is the pre-existing behaviour, pinned deliberately.
    const entry = service.getByModel('deepseek-v4-pro');
    expect(entry!.provider).toBe('OpenCode Zen');
    expect(entry!.input_price_per_token).toBe(1.74 / 1_000_000);
  });

  it("returns DeepSeek's own rates when the request was served by DeepSeek", async () => {
    await service.reload();

    const entry = service.getByModel('deepseek-v4-pro', 'deepseek');
    expect(entry!.provider).toBe('DeepSeek');
    expect(entry!.input_price_per_token).toBe(0.66 / 1_000_000);
    expect(entry!.output_price_per_token).toBe(1.98 / 1_000_000);
  });

  it("carries DeepSeek's weekday peak schedule on the scoped entry", async () => {
    await service.reload();

    const tiers = service.getByModel('deepseek-v4-pro', 'deepseek')!.time_tiers;
    expect(tiers).toHaveLength(1);
    expect(tiers![0].days).toEqual([1, 2, 3, 4, 5]);
    expect(tiers![0].input_price_per_token).toBe(1.32 / 1_000_000);
  });

  it('gives the reseller its own flat rate with no borrowed schedule', async () => {
    await service.reload();

    // OpenCode Zen bills a flat rate. DeepSeek's peak hours are not theirs.
    const entry = service.getByModel('deepseek-v4-pro', 'opencode-zen');
    expect(entry!.provider).toBe('OpenCode Zen');
    expect(entry!.input_price_per_token).toBe(1.74 / 1_000_000);
    expect(entry!.time_tiers).toBeUndefined();
  });

  it('accepts a provider alias as well as its canonical id', async () => {
    await service.reload();

    expect(service.getByModel('deepseek-v4-pro', 'DeepSeek')!.provider).toBe('DeepSeek');
  });

  it('falls back to the shared entry when the named provider publishes no price', async () => {
    await service.reload();

    // A missing cost reads as "free" on every dashboard, so an approximate
    // number beats no number at all.
    const entry = service.getByModel('deepseek-v4-pro', 'huggingface');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('OpenCode Zen');
  });

  it('falls back to the shared entry when the provider is not in the registry', async () => {
    await service.reload();

    expect(service.getByModel('deepseek-v4-pro', 'not-a-provider')!.provider).toBe('OpenCode Zen');
  });

  it('scopes OpenRouter entries to OpenRouter, never to the lab', async () => {
    const orCache = new Map<string, OpenRouterPricingEntry>([
      [
        'deepseek/deepseek-v4-pro',
        {
          input: 0.9 / 1_000_000,
          output: 2.4 / 1_000_000,
          displayName: 'DeepSeek V4 Pro',
        } as OpenRouterPricingEntry,
      ],
    ]);
    service = build(orCache);
    await service.reload();

    // Pricing follows transport: a request through the gateway is billed by
    // the gateway, at the gateway's rate.
    const viaGateway = service.getByModel('deepseek/deepseek-v4-pro', 'openrouter');
    expect(viaGateway!.input_price_per_token).toBe(0.9 / 1_000_000);
    // …and asking for OpenRouter's price must never hand back DeepSeek's.
    expect(service.getByModel('deepseek-v4-pro', 'openrouter')!.input_price_per_token).toBe(
      0.9 / 1_000_000,
    );
    expect(service.getByModel('deepseek-v4-pro', 'deepseek')!.input_price_per_token).toBe(
      0.66 / 1_000_000,
    );
  });

  it('resolves a dated model id to the provider-scoped catalogue entry', async () => {
    await service.reload();

    // Agents send `claude-opus-4-6-20260101`; the catalogue holds the bare id.
    // The scoped lookup has to normalise too, or every dated name would fall
    // through to the shared key and lose the provider it was asked about.
    const entry = service.getByModel('claude-opus-4-6-20260101', 'anthropic');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('Anthropic');
    expect(entry!.input_price_per_token).toBe(5 / 1_000_000);
  });

  it("bills a vendor-qualified id at the lab's rate, not the gateway's", async () => {
    // An agent may send `anthropic/claude-opus-4-6` and route straight to
    // Anthropic. OpenRouter also publishes that exact key, so a lookup that
    // cannot reduce the prefixed name falls through to the gateway's entry —
    // which still carries the lab's display name, so the row looks correctly
    // attributed while holding the wrong seller's price.
    const orCache = new Map<string, OpenRouterPricingEntry>([
      [
        'anthropic/claude-opus-4-6',
        { input: 9 / 1_000_000, output: 45 / 1_000_000, displayName: 'Claude Opus 4.6' },
      ],
    ]);
    service = build(orCache as never);
    await service.reload();

    const entry = service.getByModel('anthropic/claude-opus-4-6', 'anthropic');
    expect(entry!.input_price_per_token).toBe(5 / 1_000_000);
    expect(entry!.source).toBe('models.dev');
  });

  it('accepts a provider display name, including multi-word ones', async () => {
    await service.reload();

    // Callers that hold a `PricingEntry.provider` have the display name, not
    // the registry id. `OpenCode Zen` and friends do not resolve by
    // lowercasing alone.
    // `OpenCode Go` is not the shared winner, so only a real display-name
    // resolution can return its rate rather than OpenCode Zen's.
    expect(service.getByModel('deepseek-v4-pro', 'OpenCode Go')!.input_price_per_token).toBe(
      0.9 / 1_000_000,
    );
    expect(service.getByModel('deepseek-v4-pro', 'DeepSeek')!.input_price_per_token).toBe(
      0.66 / 1_000_000,
    );
  });

  it.each([['OpenCode-Go'], ['opencode.go'], ['  OpenCode Go  '], ['opencodego'], ['OPENCODE GO']])(
    'resolves the punctuation variant %s to the same provider',
    async (written) => {
      // Free-form provider strings reach this from the playground and from
      // recorded telemetry. The rest of the backend matches them through
      // normalizeProviderName; a form that resolves everywhere else must not
      // quietly fall back to another seller's price here.
      //
      // OpenCode Go is deliberately not the shared-key winner, so this can
      // only pass through real resolution — asking for the winner would pass
      // even when resolution fails.
      await service.reload();

      const entry = service.getByModel('deepseek-v4-pro', written);
      expect(entry!.provider).toBe('OpenCode Go');
      expect(entry!.input_price_per_token).toBe(0.9 / 1_000_000);
    },
  );

  it('never points two providers at the same normalized display name', async () => {
    // The display-name index is first-writer-wins, so a collision would
    // silently resolve one provider's name to a different provider's price.
    const seen = new Map<string, string>();
    for (const [id, entry] of PROVIDER_BY_ID) {
      for (const key of [
        entry.displayName.toLowerCase(),
        normalizeProviderName(entry.displayName.toLowerCase()),
      ]) {
        const prior = seen.get(key);
        expect(prior === undefined || prior === id).toBe(true);
        seen.set(key, id);
      }
    }
  });

  it('drops a scoped entry when the provider stops listing the model', async () => {
    // reload() rebuilds from scratch. Without clearing the scoped map, a model
    // a provider has delisted would keep being priced from a stale rate.
    const models = new Map<string, unknown[]>([
      ['deepseek', [DEEPSEEK_OWN]],
      ['opencode-zen', [ZEN_RESALE]],
    ]);
    const mockModelsDevSync = {
      lookupModel: jest.fn().mockReturnValue(null),
      getModelsForProvider: jest.fn((providerId: string) => models.get(providerId) ?? []),
      isProviderSupported: jest.fn().mockReturnValue(false),
      whenInitialized: jest.fn().mockResolvedValue(undefined),
    };
    service = new ModelPricingCacheService(
      {
        getAll: jest.fn().mockReturnValue(new Map()),
        whenInitialized: jest.fn().mockResolvedValue(undefined),
      } as unknown as PricingSyncService,
      mockModelsDevSync as unknown as ModelsDevSyncService,
      {
        isModelConfirmed: jest.fn().mockReturnValue(null),
        getConfirmedModels: jest.fn().mockReturnValue(null),
        registerModels: jest.fn(),
      } as unknown as ProviderModelRegistryService,
    );

    await service.reload();
    expect(service.getByModel('deepseek-v4-pro', 'deepseek')!.provider).toBe('DeepSeek');

    models.set('deepseek', []);
    await service.reload();

    // DeepSeek no longer sells it, so the scoped hit is gone and the shared
    // entry answers instead.
    expect(service.getByModel('deepseek-v4-pro', 'deepseek')!.provider).toBe('OpenCode Zen');
  });
});
