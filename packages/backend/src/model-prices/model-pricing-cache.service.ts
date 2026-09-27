import { Injectable, Logger, OnApplicationBootstrap, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { buildAliasMap, resolveModelName, stripProviderPrefix } from './model-name-normalizer';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import {
  OPENROUTER_PREFIX_TO_PROVIDER,
  PROVIDER_BY_ID,
  PROVIDER_BY_ID_OR_ALIAS,
} from '../common/constants/providers';
import { normalizeProviderName } from 'manifest-shared';
import { ProviderModelRegistryService } from '../model-discovery/provider-model-registry.service';
import { CustomProvider } from '../entities/custom-provider.entity';

const CUSTOM_PROVIDER_LABEL = 'Custom';

/**
 * Lightweight pricing entry used for cost calculation and provider detection.
 * Reads from models.dev (preferred), OpenRouter cache (fallback), and the
 * `custom_providers` table (user-defined OpenAI-compatible endpoints).
 */
/**
 * Time-of-day pricing band. The tier's rates replace the base rates for
 * requests whose billing time falls inside `windows` (UTC "HH:MM-HH:MM",
 * start inclusive / end exclusive, an end before its start wraps past
 * midnight). Mirrors models.dev `cost.tiers[].tier.type = "time"`.
 */
export interface PricingTimeTier {
  windows: readonly string[];
  /**
   * ISO weekdays (1 = Monday … 7 = Sunday) the windows apply on. Absent or
   * empty means every day. DeepSeek's peak hours are Monday through Friday.
   */
  days?: readonly number[] | null;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  cache_read_price_per_token?: number | null;
  cache_write_price_per_token?: number | null;
}

export interface PricingEntry {
  model_name: string;
  provider: string;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  cache_read_price_per_token?: number | null;
  cache_write_price_per_token?: number | null;
  /** Peak-hour price bands (e.g. DeepSeek V4); base prices apply outside them. */
  time_tiers?: readonly PricingTimeTier[] | null;
  display_name: string | null;
  /** True if confirmed via provider-native API, false if unverified, undefined if no data. */
  validated?: boolean;
  /** Data source: models.dev (curated), openrouter (broad), or custom (user-defined). */
  source?: 'models.dev' | 'openrouter' | 'custom';
}

@Injectable()
export class ModelPricingCacheService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelPricingCacheService.name);
  private readonly cache = new Map<string, PricingEntry>();
  /**
   * Price per (provider, model), which is what a bill actually depends on.
   *
   * `cache` is keyed by model name alone, so every provider that sells a model
   * writes to the same key and only the last one survives — 24 providers list
   * `deepseek-v4-pro`, and DeepSeek is not the one that wins. That is fine for
   * a display catalogue and wrong for costing a request, because the seller is
   * exactly what sets the price. Callers that know who served the request pass
   * the provider and get its own rates, including any peak-hour schedule that
   * belongs to that seller and to no other.
   */
  private readonly providerScoped = new Map<string, PricingEntry>();
  private aliasMap = new Map<string, string>();

  /** Key for `providerScoped`. `::` cannot collide with the `vendor/model` keys in `cache`. */
  private static scopedKey(providerId: string, modelName: string): string {
    return `${providerId}::${modelName}`;
  }

  /**
   * Display name → registry id, for callers holding a `PricingEntry.provider`
   * rather than an id. Seven of them ("OpenCode Zen", "Google Vertex AI",
   * "GitHub Copilot"…) match neither the id nor any alias, so without this they
   * would silently fall back to the shared entry — the exact mispricing the
   * scoped map exists to prevent.
   *
   * Indexed under the plain lowercase form and the `normalizeProviderName`
   * form, so a caller's punctuation ("OpenCode-Zen", "opencode.zen") resolves
   * the same way it does everywhere else in the backend. First writer wins:
   * a collision must never silently repoint one provider's name at another.
   */
  private static readonly PROVIDER_BY_DISPLAY_NAME: ReadonlyMap<string, string> = (() => {
    const index = new Map<string, string>();
    for (const [id, entry] of PROVIDER_BY_ID) {
      const lower = entry.displayName.toLowerCase();
      for (const key of [lower, normalizeProviderName(lower)]) {
        if (!index.has(key)) index.set(key, id);
      }
    }
    return index;
  })();

  /**
   * Registry id for an id, alias, or display name; undefined if none matches.
   *
   * Free-form provider strings reach this from the playground and from
   * recorded telemetry, so it matches the rest of the backend and compares on
   * `normalizeProviderName` as well as the raw lowercase form. A name that
   * fails to resolve here does not error — it quietly falls back to the shared
   * catalogue entry, i.e. another seller's price.
   */
  private static resolveProviderId(provider: string): string | undefined {
    const lower = provider.trim().toLowerCase();
    const normalized = normalizeProviderName(lower);
    return (
      PROVIDER_BY_ID_OR_ALIAS.get(lower)?.id ??
      PROVIDER_BY_ID_OR_ALIAS.get(normalized)?.id ??
      ModelPricingCacheService.PROVIDER_BY_DISPLAY_NAME.get(lower) ??
      ModelPricingCacheService.PROVIDER_BY_DISPLAY_NAME.get(normalized)
    );
  }

  constructor(
    private readonly pricingSync: PricingSyncService,
    @Optional()
    @Inject(ModelsDevSyncService)
    private readonly modelsDevSync: ModelsDevSyncService | null,
    @Optional()
    @Inject(ProviderModelRegistryService)
    private readonly modelRegistry: ProviderModelRegistryService | null,
    @Optional()
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider> | null = null,
  ) {}

  onApplicationBootstrap(): void {
    // Warm up the pricing cache in the background. The OpenRouter / models.dev
    // syncs it reads from are now fire-and-forget (see #1894), so awaiting
    // reload() here would just re-introduce the slow-boot problem. Wait for
    // those syncs' initial fetch to settle, then build the cache — all off the
    // app.listen() critical path.
    void this.warmup();
  }

  private async warmup(): Promise<void> {
    try {
      await Promise.allSettled([
        this.pricingSync.whenInitialized(),
        this.modelsDevSync?.whenInitialized() ?? Promise.resolve(),
      ]);
      await this.reload();
    } catch (err) {
      this.logger.error(`Pricing cache warmup failed: ${err}`);
    }
  }

  /** Rebuild the pricing cache after sync services refresh their data. */
  @Cron('0 5 * * *')
  async scheduledReload(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    this.cache.clear();
    this.providerScoped.clear();

    // Load OpenRouter data first (broad coverage, will be overridden by models.dev)
    const orCache = this.pricingSync.getAll();
    for (const [fullId, entry] of orCache) {
      const { provider, canonical, providerId } = this.resolveProviderAndName(fullId);

      const pricingEntry: PricingEntry = {
        model_name: fullId,
        provider,
        input_price_per_token: entry.input,
        output_price_per_token: entry.output,
        display_name: entry.displayName ?? null,
        validated: this.resolveValidated(providerId, canonical),
        source: 'openrouter',
      };

      // Store under full OpenRouter ID (e.g. "anthropic/claude-opus-4-6")
      this.cache.set(fullId, pricingEntry);

      // OpenRouter's own rate, scoped to OpenRouter: a request that rode
      // through the gateway is billed by the gateway, never by the lab.
      this.providerScoped.set(
        ModelPricingCacheService.scopedKey('openrouter', fullId),
        pricingEntry,
      );
      // Mirror the shared map's first-writer-wins rule on the bare key: two
      // recognised vendor prefixes can reduce to the same bare name, and the
      // two maps disagreeing about which variant won helps nobody.
      const bareKey = ModelPricingCacheService.scopedKey('openrouter', canonical);
      if (canonical !== fullId && !this.providerScoped.has(bareKey)) {
        this.providerScoped.set(bareKey, pricingEntry);
      }

      // For supported providers, also store under canonical name (e.g. "claude-opus-4-6")
      // so cost lookups work when ingested messages use bare model names
      if (canonical !== fullId && !this.cache.has(canonical)) {
        this.cache.set(canonical, pricingEntry);
      }
    }

    // Overlay models.dev entries (curated, native IDs — preferred source)
    this.loadModelsDevEntries();

    // Overlay user-defined custom provider pricing (from the custom_providers
    // table). Keyed by `custom:<uuid>/<model_name>` — the same identifier
    // written to agent_messages.model, so cost lookups hit.
    await this.loadCustomProviderEntries();

    this.aliasMap = buildAliasMap([...this.cache.keys()]);
    this.logger.log(`Loaded ${this.cache.size} pricing entries`);
  }

  /**
   * Pricing for a model, preferring the rates of the provider that served the
   * request when the caller knows it.
   *
   * Without `provider` this answers "some seller's price for this model",
   * which is all a catalogue view needs. Cost recording must pass the
   * provider: the same model carries a different price per seller, and the
   * unscoped key holds whichever seller the registry wrote last.
   *
   * When a provider is named but has no price of its own, the shared key is
   * still used rather than returning nothing — a missing cost reads as "free"
   * on every dashboard, which is a worse answer than an approximate one.
   */
  getByModel(modelName: string, provider?: string | null): PricingEntry | undefined {
    if (provider) {
      const scoped = this.getProviderScoped(modelName, provider);
      if (scoped) return scoped;
      this.logger.debug(
        `No ${provider} price for ${modelName}; falling back to the shared catalogue entry`,
      );
    }

    const exact = this.cache.get(modelName);
    if (exact) return exact;

    const resolved = resolveModelName(modelName, this.aliasMap);
    if (resolved) return this.cache.get(resolved);

    return undefined;
  }

  /** The named provider's own price for a model, or undefined if it publishes none. */
  private getProviderScoped(modelName: string, provider: string): PricingEntry | undefined {
    const providerId = ModelPricingCacheService.resolveProviderId(provider);
    if (!providerId) return undefined;

    // The same model reaches us under several names: bare, vendor-qualified
    // (`anthropic/claude-opus-4-6`, which an agent may send while routing
    // straight to Anthropic), or carrying a date suffix. The scoped map is
    // keyed on the catalogue's own id, so try each form the name reduces to.
    // Stripping the vendor prefix matters most: OpenRouter publishes that exact
    // key too, so a prefixed name that fails here lands on the gateway's entry
    // — which still shows the lab's display name, and so reads as correctly
    // attributed while holding the wrong seller's price.
    const bare = stripProviderPrefix(modelName);
    const candidates = [
      modelName,
      bare,
      resolveModelName(modelName, this.aliasMap),
      resolveModelName(bare, this.aliasMap),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const hit = this.providerScoped.get(
        ModelPricingCacheService.scopedKey(providerId, candidate),
      );
      if (hit) return hit;
    }
    return undefined;
  }

  getAll(): PricingEntry[] {
    // Deduplicate: canonical aliases point to the same model_name,
    // so filter to unique model_name values.
    //
    // Custom provider entries (keyed by `custom:<uuid>/...`) are excluded
    // here because the public /api/v1/model-prices endpoint is not scoped
    // by user — returning them would leak one tenant's custom providers
    // to every other tenant.
    const seen = new Set<string>();
    const result: PricingEntry[] = [];
    for (const entry of this.cache.values()) {
      if (entry.source === 'custom') continue;
      if (!seen.has(entry.model_name)) {
        seen.add(entry.model_name);
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * For supported routing providers (OpenAI, Anthropic, etc.), extract
   * the provider display name and canonical model name from the OpenRouter ID.
   * All other vendors stay under "OpenRouter" with the full ID as canonical.
   * Also returns the raw prefix as `providerId` for registry lookups.
   */
  private resolveProviderAndName(openRouterId: string): {
    provider: string;
    canonical: string;
    providerId: string | null;
  } {
    if (openRouterId.startsWith('openrouter/')) {
      return { provider: 'OpenRouter', canonical: openRouterId, providerId: null };
    }

    const slashIdx = openRouterId.indexOf('/');
    if (slashIdx <= 0) {
      return { provider: 'OpenRouter', canonical: openRouterId, providerId: null };
    }

    const prefix = openRouterId.substring(0, slashIdx);
    const providerDisplayName = OPENROUTER_PREFIX_TO_PROVIDER.get(prefix);
    if (providerDisplayName) {
      return {
        provider: providerDisplayName,
        canonical: openRouterId.substring(slashIdx + 1),
        providerId: prefix,
      };
    }

    return { provider: 'OpenRouter', canonical: openRouterId, providerId: null };
  }

  /**
   * Load models.dev entries into the cache, overriding OpenRouter entries
   * for the same model. models.dev uses native provider IDs so bare model
   * names match directly without prefix stripping.
   */
  private loadModelsDevEntries(): void {
    if (!this.modelsDevSync) return;

    let count = 0;
    for (const [providerId, registryEntry] of PROVIDER_BY_ID) {
      const models = this.modelsDevSync.getModelsForProvider(providerId);
      for (const model of models) {
        if (model.inputPricePerToken === null) continue;

        const pricingEntry: PricingEntry = {
          model_name: model.id,
          provider: registryEntry.displayName,
          input_price_per_token: model.inputPricePerToken,
          output_price_per_token: model.outputPricePerToken,
          cache_read_price_per_token: model.cacheReadPricePerToken ?? null,
          cache_write_price_per_token: model.cacheWritePricePerToken ?? null,
          time_tiers: model.timeTiers?.map((tier) => ({
            windows: tier.windows,
            days: tier.days ?? null,
            input_price_per_token: tier.inputPricePerToken,
            output_price_per_token: tier.outputPricePerToken,
            cache_read_price_per_token: tier.cacheReadPricePerToken,
            cache_write_price_per_token: tier.cacheWritePricePerToken,
          })),
          display_name: model.name || null,
          validated: this.resolveValidatedForModelsDev(providerId, model.id),
          source: 'models.dev',
        };

        // The seller's own price, always recorded — the zero-pricing guard
        // below protects the shared bare key, but a provider that really does
        // charge nothing for a model (Copilot on a subscription) is telling
        // the truth about itself and must keep that under its own key.
        this.providerScoped.set(
          ModelPricingCacheService.scopedKey(providerId, model.id),
          pricingEntry,
        );

        // Override both bare and prefixed keys so getAll() dedup works.
        // Don't overwrite real pricing with zero-pricing entries (e.g. Copilot
        // lists models like gemini-2.5-pro as free, which would erase Google's
        // actual pricing that was set by an earlier provider in the loop).
        const existing = this.cache.get(model.id);
        const hasRealPricing = existing && (existing.input_price_per_token ?? 0) > 0;
        const isZeroPricing =
          (model.inputPricePerToken ?? 0) === 0 && (model.outputPricePerToken ?? 0) === 0;
        if (!hasRealPricing || !isZeroPricing) {
          this.cache.set(model.id, pricingEntry);
        }
        // The OpenRouter-prefixed key keeps OpenRouter's own entry: pricing
        // follows transport, and OpenRouter bills its flat rate regardless of
        // the lab's peak-hour schedule — so only make sure no time tiers ride
        // along, never overwrite the OR prices with the lab's.
        for (const prefix of registryEntry.openRouterPrefixes) {
          const prefixedKey = `${prefix}/${model.id}`;
          const orEntry = this.cache.get(prefixedKey);
          if (orEntry) {
            this.cache.set(prefixedKey, { ...orEntry, time_tiers: null });
          }
        }
        count++;
      }
    }

    if (count > 0) {
      this.logger.log(`Overlaid ${count} models.dev pricing entries`);
    }
  }

  /**
   * Load user-defined pricing for custom (OpenAI-compatible) providers.
   *
   * The proxy writes `custom:<uuid>/<model_name>` to agent_messages.model
   * and the cost recorder calls getByModel() with that exact string — so we
   * index custom pricing under the same key. UUIDs are globally unique
   * (randomUUID), so cross-tenant collisions are impossible.
   *
   * Prices are stored per million tokens in the entity; divide by 1e6 to
   * match PricingEntry's per-token contract.
   */
  private async loadCustomProviderEntries(): Promise<void> {
    if (!this.customProviderRepo) return;

    let rows: CustomProvider[];
    try {
      rows = await this.customProviderRepo.find();
    } catch (err) {
      this.logger.warn(`Failed to load custom provider pricing: ${(err as Error).message}`);
      return;
    }

    let count = 0;
    for (const cp of rows) {
      if (!Array.isArray(cp.models)) continue;
      for (const model of cp.models) {
        if (!model.model_name) continue;
        const inputPerToken =
          model.input_price_per_million_tokens != null
            ? model.input_price_per_million_tokens / 1_000_000
            : null;
        const outputPerToken =
          model.output_price_per_million_tokens != null
            ? model.output_price_per_million_tokens / 1_000_000
            : null;
        // Skip entries without any pricing — nothing to compute from.
        if (inputPerToken === null && outputPerToken === null) continue;

        const key = `custom:${cp.id}/${model.model_name}`;
        this.cache.set(key, {
          model_name: key,
          provider: CUSTOM_PROVIDER_LABEL,
          input_price_per_token: inputPerToken,
          output_price_per_token: outputPerToken,
          display_name: model.model_name,
          source: 'custom',
        });
        count++;
      }
    }

    if (count > 0) {
      this.logger.log(`Loaded ${count} custom provider pricing entries`);
    }
  }

  private resolveValidated(providerId: string | null, canonical: string): boolean | undefined {
    if (!this.modelRegistry || !providerId) return undefined;
    // Resolve OpenRouter prefix to canonical provider ID (e.g., "google" → "gemini")
    const entry = PROVIDER_BY_ID_OR_ALIAS.get(providerId);
    const canonicalProviderId = entry?.id ?? providerId;
    const result = this.modelRegistry.isModelConfirmed(canonicalProviderId, canonical);
    return result ?? undefined;
  }

  private resolveValidatedForModelsDev(providerId: string, modelId: string): boolean | undefined {
    if (!this.modelRegistry) return undefined;
    const result = this.modelRegistry.isModelConfirmed(providerId, modelId);
    return result ?? undefined;
  }
}
