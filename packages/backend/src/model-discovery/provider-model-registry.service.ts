import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantProvider } from '../entities/tenant-provider.entity';
import type { DiscoveredModel } from './model-fetcher';

export interface ProviderModelRegistryEntry {
  id: string;
  supportedEndpoints?: readonly string[];
}

type ProviderModelRegistration = string | Pick<DiscoveredModel, 'id' | 'supportedEndpoints'>;
type CachedProviderModelRegistration = Pick<DiscoveredModel, 'id' | 'supportedEndpoints'>;

/**
 * Rows per keyset page. The full scan is ~9k rows / ~30 MB of JSON across all
 * tenants, which as a single statement can hold a pooled connection for
 * minutes on a loaded database.
 */
export const CACHE_LOAD_BATCH_SIZE = 500;

/**
 * Maintains an in-memory registry of model IDs confirmed to exist
 * via provider-native APIs. Populated opportunistically when users
 * connect providers and on startup from cached data.
 *
 * Used to filter out phantom models from OpenRouter fallback lists.
 */
@Injectable()
export class ProviderModelRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProviderModelRegistryService.name);
  private readonly registry = new Map<string, Map<string, ProviderModelRegistryEntry>>();
  private cacheLoad: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
  ) {}

  /**
   * Nest runs bootstrap hooks inside `app.init()`, before the HTTP server
   * starts listening. Awaiting the cache load here means a slow database keeps
   * the port closed and the platform healthcheck hanging, so the load runs in
   * the background instead. Until it finishes the registry is simply empty,
   * which every caller already handles as "no native data recorded" — the same
   * path a fresh install takes.
   */
  onApplicationBootstrap(): void {
    this.cacheLoad = this.loadFromCache();
  }

  /** Resolves once the startup cache load has settled. For tests and probes. */
  whenLoaded(): Promise<void> {
    return this.cacheLoad;
  }

  /**
   * Register model IDs confirmed via a provider's native API.
   * Merges with any existing confirmed models for that provider.
   */
  registerModels(providerId: string, models: ProviderModelRegistration[]): void {
    this.registerInto(this.registry, providerId, models);
  }

  private registerInto(
    target: Map<string, Map<string, ProviderModelRegistryEntry>>,
    providerId: string,
    models: ProviderModelRegistration[],
  ): void {
    const key = providerId.toLowerCase();
    const existing = target.get(key) ?? new Map<string, ProviderModelRegistryEntry>();
    for (const model of models) {
      const entry = this.toRegistryEntry(model);
      if (!entry) continue;

      const previous = existing.get(entry.id);
      existing.set(entry.id, {
        ...previous,
        ...entry,
        supportedEndpoints: entry.supportedEndpoints ?? previous?.supportedEndpoints,
      });
    }
    if (existing.size > 0) target.set(key, existing);
  }

  /**
   * Get the set of confirmed model IDs for a provider.
   * Returns null if no native data has ever been recorded for this provider.
   */
  getConfirmedModels(providerId: string): ReadonlySet<string> | null {
    const models = this.registry.get(providerId.toLowerCase());
    return models ? new Set(models.keys()) : null;
  }

  /**
   * Check whether a specific model is confirmed for a provider.
   * Returns true if confirmed, false if not, or null if no data exists.
   */
  isModelConfirmed(providerId: string, modelId: string): boolean | null {
    const confirmed = this.registry.get(providerId.toLowerCase());
    if (!confirmed) return null;
    return confirmed.has(modelId.toLowerCase());
  }

  getModelMetadata(providerId: string, modelId: string): ProviderModelRegistryEntry | null {
    return this.registry.get(providerId.toLowerCase())?.get(modelId.toLowerCase()) ?? null;
  }

  /**
   * Populate the registry from existing tenant_providers.cached_models
   * data that was previously fetched from native APIs.
   */
  private async loadFromCache(): Promise<void> {
    try {
      // Pages are ordered by primary key, so one provider's rows are scattered
      // across them. Registering page-by-page would expose a half-built set for
      // a provider, and a partial set is worse than none: `isModelConfirmed`
      // answers `false` for a model that simply has not been read yet, and the
      // caller filters that real model out as a phantom. An absent provider
      // answers `null` instead, which callers treat as "no data, don't filter".
      // So stage the whole load and publish it once, at the end.
      const staged = new Map<string, Map<string, ProviderModelRegistryEntry>>();
      let totalModels = 0;
      let cursor: string | null = null;

      for (;;) {
        const page: TenantProvider[] = await this.fetchPage(cursor);
        if (page.length === 0) break;

        for (const p of page) {
          if (!Array.isArray(p.cached_models)) continue;
          const cachedModels = p.cached_models as unknown[];
          const models = cachedModels.filter(
            (m): m is CachedProviderModelRegistration =>
              typeof m === 'object' &&
              m !== null &&
              'id' in m &&
              typeof (m as { id?: unknown }).id === 'string' &&
              (m as { id?: string }).id!.length > 0,
          );
          if (models.length > 0) {
            this.registerInto(staged, p.provider, models);
            totalModels += models.length;
          }
        }

        if (page.length < CACHE_LOAD_BATCH_SIZE) break;
        cursor = page[page.length - 1].id;
      }

      // Merge rather than swap: a provider connected while the load was running
      // registered straight into the live registry, and must survive.
      for (const [provider, models] of staged) {
        this.registerModels(provider, Array.from(models.values()));
      }

      const providerCount = this.registry.size;
      if (providerCount > 0) {
        this.logger.log(
          `Provider model registry loaded: ${providerCount} providers, ${totalModels} model entries`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to load provider model registry from cache: ${err}`);
    }
  }

  /** One keyset page, ordered by the `id` primary key. */
  private fetchPage(cursor: string | null): Promise<TenantProvider[]> {
    const qb = this.providerRepo
      .createQueryBuilder('p')
      .select(['p.id', 'p.provider', 'p.cached_models'])
      .where('p.cached_models IS NOT NULL')
      .orderBy('p.id', 'ASC')
      .limit(CACHE_LOAD_BATCH_SIZE);

    if (cursor !== null) qb.andWhere('p.id > :cursor', { cursor });

    return qb.getMany();
  }

  private toRegistryEntry(model: ProviderModelRegistration): ProviderModelRegistryEntry | null {
    const id = typeof model === 'string' ? model : model.id;
    if (typeof id !== 'string' || id.length === 0) return null;

    const supportedEndpoints = typeof model === 'string' ? undefined : model.supportedEndpoints;
    const endpoints =
      Array.isArray(supportedEndpoints) && supportedEndpoints.length > 0
        ? Array.from(
            new Set(
              supportedEndpoints.filter(
                (endpoint): endpoint is string =>
                  typeof endpoint === 'string' && endpoint.length > 0,
              ),
            ),
          )
        : undefined;

    return {
      id: id.toLowerCase(),
      ...(endpoints && endpoints.length > 0 ? { supportedEndpoints: endpoints } : {}),
    };
  }
}
