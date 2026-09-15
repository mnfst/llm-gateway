import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveProviderMetadataIdentity, type AuthType } from 'manifest-shared';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import {
  ProviderModelFetcherService,
  PROVIDER_BLOCKLIST,
  PROVIDER_NON_CHAT,
  filterNonChatModels,
} from './provider-model-fetcher.service';
import { ProviderModelRegistryService } from './provider-model-registry.service';
import { DiscoveredModel, DEFAULT_CONTEXT_WINDOW } from './model-fetcher';
import { decryptWithAny, getDecryptionSecrets } from '../common/utils/crypto.util';
import { computeQualityScore } from '../database/quality-score.util';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { parseOAuthTokenBlob } from '../routing/oauth/core';
import { getQwenCompatibleBaseUrl, isQwenResolvedEndpoint } from '../routing/qwen-region';
import {
  getBedrockMantleBaseUrl,
  isBedrockProvider,
  isBedrockRegion,
} from '../routing/bedrock-region';
import { MINIMAX_BASE_URLS } from '../routing/oauth/minimax/minimax-oauth-helpers';
import {
  getXiaomiTokenPlanBaseUrl,
  isXiaomiProviderId,
  isXiaomiTokenPlanRegion,
} from '../routing/xiaomi-region';
import { getZaiCodingPlanBaseUrl } from '../routing/zai-region';
import { CopilotTokenService } from '../routing/proxy/copilot-token.service';
import {
  findOpenRouterPrefix,
  lookupWithVariants,
  buildFallbackModels,
  buildModelsDevFallback,
  buildSubscriptionFallbackModels,
  reconcileCachedSubscriptionContextWindow,
  supplementWithKnownModels,
} from './model-fallback';
import { lookupKnownPrice } from './known-model-prices';
import { lookupKnownModalities } from './known-model-modalities';
import { mergeModelCapabilities, modelSupportsStreaming } from './model-capabilities';
import {
  CLOUD_LOCAL_PROVIDER_MESSAGE,
  filterProvidersForDeployment,
  isProviderAvailableForDeployment,
} from '../common/utils/provider-availability';
// Import static helpers directly to avoid circular dependency with RoutingModule
const customProviderKey = (id: string) => `custom:${id}`;
const customModelKey = (id: string, modelName: string) => `custom:${id}/${modelName}`;

function isQwenProvider(providerId: string): boolean {
  const lower = providerId.toLowerCase();
  return lower === 'qwen' || lower === 'alibaba';
}

function modelsDevModelIdPrefix(providerId: string): string | undefined {
  const lower = providerId.toLowerCase();
  return lower === 'opencode-go' || lower === 'opencode-zen' ? lower : undefined;
}

function prefersModelsDevCatalog(providerId: string): boolean {
  const lower = providerId.toLowerCase();
  return lower === 'opencode-zen';
}

function nonChatFilterKey(providerId: string, authType: AuthType): string {
  const normalizedProvider = providerId.toLowerCase();
  if (authType !== 'subscription') return normalizedProvider;

  const subscriptionKey = `${normalizedProvider}-subscription`;
  if (PROVIDER_NON_CHAT[subscriptionKey] || PROVIDER_BLOCKLIST[subscriptionKey]) {
    return subscriptionKey;
  }
  return normalizedProvider;
}

/** 2-minute TTL for the per-agent discovered-model list, matching RoutingCacheService. */
const MODELS_CACHE_TTL_MS = 120_000;

interface ModelsCacheEntry {
  tenantId: string;
  data: DiscoveredModel[];
  expiresAt: number;
}

interface DiscoverModelsOptions {
  forceRefresh?: boolean;
  skipModelsDevRefresh?: boolean;
}

@Injectable()
export class ModelDiscoveryService {
  private readonly logger = new Logger(ModelDiscoveryService.name);

  // Per-agent cache for getModelsForAgent(). This is the hottest uncached DB
  // hit on the routing decision path (every override/specificity request calls
  // it via isModelAvailable / getModelForAgent). The cache lives here rather
  // than in RoutingCacheService to avoid a module-level circular dependency:
  // RoutingCoreModule already imports ModelDiscoveryModule, so the reverse edge
  // would form a cycle. Invalidation is driven by the discovery write path
  // (below) and by ResolveService bridging RoutingCacheService.invalidateAgent
  // to invalidate() — see ResolveService for the wiring.
  private readonly modelsCache = new Map<string, ModelsCacheEntry>();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly fetcher: ProviderModelFetcherService,
    @Optional()
    @Inject(PricingSyncService)
    private readonly pricingSync: PricingSyncService | null,
    @Optional()
    @Inject(ModelsDevSyncService)
    private readonly modelsDevSync: ModelsDevSyncService | null,
    @Optional()
    @Inject(ProviderModelRegistryService)
    private readonly modelRegistry: ProviderModelRegistryService | null,
    @Optional()
    @Inject(CopilotTokenService)
    private readonly copilotTokenService: CopilotTokenService | null,
    @Optional()
    @InjectRepository(AgentEnabledProvider)
    private readonly enabledProviderRepo: Repository<AgentEnabledProvider> | null = null,
  ) {}

  async discoverModels(
    provider: TenantProvider,
    options: DiscoverModelsOptions = {},
  ): Promise<DiscoveredModel[]> {
    if (!isProviderAvailableForDeployment(provider.provider)) return [];
    let apiKey = '';
    let endpointOverride: string | undefined;
    const lowerProvider = provider.provider.toLowerCase();
    if (provider.api_key_encrypted) {
      try {
        apiKey = decryptWithAny(provider.api_key_encrypted, getDecryptionSecrets()).plaintext;
      } catch {
        this.logger.warn(`Failed to decrypt key for provider ${provider.provider}`);
        return [];
      }
    }

    // OAuth-backed subscription providers store an encrypted token blob.
    // Unwrap it so model discovery can call the provider-native /models endpoint.
    if (provider.auth_type === 'subscription' && apiKey) {
      if (
        lowerProvider === 'openai' ||
        lowerProvider === 'anthropic' ||
        lowerProvider === 'minimax' ||
        lowerProvider === 'kiro' ||
        lowerProvider === 'xai'
      ) {
        // Kiro's token blob is an OAuthTokenBlob superset (source 'kiro-oidc',
        // plus client credentials), so the generic unwrap reads its access
        // token too. Refresh-on-expiry happens in the provider OAuth services;
        // discovery just uses the stored token.
        const blob = parseOAuthTokenBlob(apiKey);
        if (blob?.t) {
          apiKey = blob.t;
          if (lowerProvider === 'minimax' && blob.u) {
            endpointOverride = blob.u;
          }
        }
        // Pasted MiniMax Coding Plan tokens (sk-cp-) have no OAuth blob, so
        // discovery has no resource URL to use. Fall back to the persisted
        // region column so CN tokens discover models against the CN host
        // instead of incorrectly probing api.minimax.io.
        if (lowerProvider === 'minimax' && !endpointOverride && provider.region === 'cn') {
          endpointOverride = `${MINIMAX_BASE_URLS.cn}/anthropic/v1`;
        }
      } else if (lowerProvider === 'copilot' && this.copilotTokenService) {
        try {
          apiKey = await this.copilotTokenService.getCopilotToken(apiKey);
        } catch {
          this.logger.warn(
            'Copilot token exchange failed for model discovery — falling back to known models',
          );
          apiKey = '';
        }
      }
    }
    if (
      lowerProvider === 'minimax' &&
      provider.auth_type === 'api_key' &&
      provider.region === 'cn'
    ) {
      endpointOverride = `${MINIMAX_BASE_URLS.cn}/v1`;
    }
    if (isQwenProvider(provider.provider) && isQwenResolvedEndpoint(provider.region)) {
      endpointOverride = getQwenCompatibleBaseUrl(provider.region);
    }
    if (isBedrockProvider(provider.provider) && isBedrockRegion(provider.region)) {
      endpointOverride = getBedrockMantleBaseUrl(provider.region);
    }
    if (
      provider.provider.toLowerCase() === 'zai' &&
      provider.auth_type === 'subscription' &&
      provider.region === 'cn'
    ) {
      endpointOverride = getZaiCodingPlanBaseUrl('cn');
    }
    if (
      isXiaomiProviderId(provider.provider) &&
      provider.auth_type === 'subscription' &&
      isXiaomiTokenPlanRegion(provider.region)
    ) {
      endpointOverride = getXiaomiTokenPlanBaseUrl(provider.region);
    }

    if (options.forceRefresh && !options.skipModelsDevRefresh) {
      await this.refreshModelsDevCache();
    }

    let raw: DiscoveredModel[];

    const useCuratedSubscriptionModels =
      provider.auth_type === 'subscription' && (!apiKey || lowerProvider === 'anthropic');

    const fetchProviderModels = () =>
      options.forceRefresh
        ? this.fetcher.fetch(provider.provider, apiKey, provider.auth_type, endpointOverride, {
            forceRefresh: true,
          })
        : this.fetcher.fetch(provider.provider, apiKey, provider.auth_type, endpointOverride);

    const buildModelsDevModels = () => {
      const models = buildModelsDevFallback(this.modelsDevSync, provider.provider, {
        idPrefix: modelsDevModelIdPrefix(provider.provider),
      });
      if (lowerProvider !== 'opencode-go') return models;
      // OpenCode Go is surfaced as a subscription gateway with per-request
      // quota cost from the docs catalog, not token pricing from models.dev.
      return models.map((model) => ({
        ...model,
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      }));
    };

    // Subscription providers without a token use curated fallback. Anthropic
    // subscription discovery is also static so connecting Claude Code does
    // not spend live /models or /messages calls before the first real request.
    if (useCuratedSubscriptionModels) {
      raw = buildSubscriptionFallbackModels(provider.provider);
      if (raw.length > 0) {
        this.logger.log(
          `Subscription provider ${provider.provider} — using ${raw.length} curated models`,
        );
      }
    } else if (
      provider.auth_type !== 'subscription' &&
      prefersModelsDevCatalog(provider.provider)
    ) {
      raw = buildModelsDevModels();
      if (raw.length > 0) {
        this.logger.log(`Using ${raw.length} models from models.dev for ${provider.provider}`);
      } else {
        raw = await fetchProviderModels();
      }
    } else {
      raw = await fetchProviderModels();

      // Register confirmed model IDs from native API for future fallback filtering
      if (raw.length > 0 && this.modelRegistry) {
        this.modelRegistry.registerModels(provider.provider, raw);
      }

      // Subscription providers whose `/models` endpoint either does not
      // exist (CodeAssist) or returns more than the subscription tier
      // actually grants must use the curated `knownModels` list — otherwise
      // the routing UI offers models that 404 at chat time.
      if (raw.length === 0 && provider.auth_type === 'subscription') {
        raw = buildSubscriptionFallbackModels(provider.provider);
        if (raw.length > 0) {
          this.logger.log(
            `Subscription provider ${provider.provider} — using ${raw.length} curated models`,
          );
        }
      }

      // External catalogs may enrich provider-discovered models, but they must
      // never determine which models a subscription can access.
      if (raw.length === 0 && provider.auth_type !== 'subscription') {
        raw = buildModelsDevModels();
        if (raw.length > 0) {
          this.logger.log(
            `Native API returned 0 models for ${provider.provider} — using ${raw.length} models from models.dev`,
          );
        }
      }
      // If models.dev also had nothing, fall back to OpenRouter filtered by confirmed models.
      // Qwen is excluded because OpenRouter/pricing ids can diverge from DashScope ids.
      if (
        raw.length === 0 &&
        provider.auth_type !== 'subscription' &&
        !isQwenProvider(provider.provider)
      ) {
        const confirmed = this.modelRegistry?.getConfirmedModels(provider.provider) ?? null;
        raw = buildFallbackModels(this.pricingSync, provider.provider, confirmed);
        if (raw.length > 0) {
          this.logger.log(
            `No models.dev data for ${provider.provider} — using ${raw.length} models from OpenRouter`,
          );
        }
      }
    }

    // For subscription providers, supplement live discovery with the explicit
    // curated list so users can always select known supported models.
    if (provider.auth_type === 'subscription') {
      raw = supplementWithKnownModels(raw, provider.provider);
    }

    // Preserve the full AuthType union (api_key / subscription / local) —
    // narrowing to the two legacy values would drop the 'local' tag that the
    // frontend uses to render the house badge and the Local tab.
    const authType: AuthType = provider.auth_type;
    const enriched = raw.map((model) => ({
      ...this.enrichModel(model, provider.provider),
      authType,
    }));
    const reconciled =
      provider.auth_type === 'subscription'
        ? enriched.map((model) => {
            const current = reconcileCachedSubscriptionContextWindow(model, provider.provider);
            return current === model ? model : this.computeScore(current);
          })
        : enriched;

    // Filter out models confirmed to lack tool support (models.dev toolCall === false).
    // AI agents (OpenClaw, Hermes, SDK-based agents) almost always
    // include tools in every request, so models without tool calling are
    // unusable. Only filter when models.dev has data — if no entry exists we
    // keep the model (we don't know its capabilities).
    const filtered = reconciled.filter((model) => {
      const metadata = resolveProviderMetadataIdentity(provider.provider, model.id);
      const metadataProvider = metadata.provider ?? provider.provider;
      const mdEntry = this.modelsDevSync?.lookupModelCapabilities(metadataProvider, metadata.model);
      if (mdEntry && mdEntry.toolCall === false) return false;
      return true;
    });

    const previousCachedCount = Array.isArray(provider.cached_models)
      ? provider.cached_models.length
      : 0;

    if (filtered.length === 0 && previousCachedCount > 0) {
      this.logger.warn(
        `Discovery returned 0 models for ${provider.provider} (tenant ${provider.tenant_id}); kept ${previousCachedCount} cached models`,
      );
      return provider.cached_models ?? [];
    }

    provider.cached_models = filtered;
    provider.models_fetched_at = new Date().toISOString();
    await this.providerRepo.save(provider);
    await this.invalidateProviderAccess(provider);

    this.logger.log(
      `Discovered ${filtered.length} models for provider ${provider.provider} (tenant ${provider.tenant_id})`,
    );
    return filtered;
  }

  async discoverAllForAgent(tenantId: string, options: DiscoverModelsOptions = {}): Promise<void> {
    if (options.forceRefresh) {
      await this.refreshModelsDevCache();
    }
    const discoveryOptions = options.forceRefresh
      ? { ...options, skipModelsDevRefresh: true }
      : options;
    const providers = filterProvidersForDeployment(
      await this.providerRepo.find({
        where: { tenant_id: tenantId, is_active: true },
      }),
    );
    await Promise.all(
      providers
        .filter((p) => !p.provider.startsWith('custom:'))
        .map((p) =>
          this.discoverModels(p, discoveryOptions).catch((err) => {
            this.logger.warn(`Discovery failed for ${p.provider}: ${err}`);
          }),
        ),
    );
  }

  private async refreshModelsDevCache(): Promise<void> {
    if (!this.modelsDevSync) return;
    try {
      await this.modelsDevSync.refreshCache();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`models.dev refresh failed during manual model discovery: ${message}`);
    }
  }

  async refreshProvider(
    tenantId: string,
    providerId: string,
    authType?: AuthType,
  ): Promise<{
    ok: boolean;
    model_count: number;
    last_fetched_at: string | null;
    error: string | null;
  }> {
    if (!isProviderAvailableForDeployment(providerId)) {
      return {
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: CLOUD_LOCAL_PROVIDER_MESSAGE,
      };
    }
    const where: { tenant_id: string; provider: string; is_active: true; auth_type?: AuthType } = {
      tenant_id: tenantId,
      provider: providerId,
      is_active: true,
    };
    if (authType) where.auth_type = authType;
    // A tenant can connect multiple keys for the same provider/auth type. The
    // picker reads whichever rows are enabled for the agent, so refresh all of
    // them instead of leaving an arbitrary `findOne` row's siblings stale.
    const providers = await this.providerRepo.find({ where });
    if (providers.length === 0) {
      return { ok: false, model_count: 0, last_fetched_at: null, error: 'Provider not found' };
    }

    if (providers[0].provider.startsWith('custom:')) {
      const previousCount = Math.max(
        ...providers.map((provider) =>
          Array.isArray(provider.cached_models) ? provider.cached_models.length : 0,
        ),
      );
      const previousFetchedAt = providers
        .map((provider) => provider.models_fetched_at)
        .filter((value): value is string => value !== null)
        .sort()
        .pop();
      return {
        ok: false,
        model_count: previousCount,
        last_fetched_at: previousFetchedAt ?? null,
        error: 'Custom providers are managed manually — edit the provider to update its model list',
      };
    }

    await this.refreshModelsDevCache();
    const results = await Promise.all(
      providers.map(async (provider) => {
        const previousCount = Array.isArray(provider.cached_models)
          ? provider.cached_models.length
          : 0;
        const previousFetchedAt = provider.models_fetched_at;
        try {
          const models = await this.discoverModels(provider, {
            forceRefresh: true,
            skipModelsDevRefresh: true,
          });
          return {
            ok: models.length > 0,
            modelCount: models.length,
            lastFetchedAt: provider.models_fetched_at,
            error: models.length === 0 ? 'Provider returned no models' : null,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Per-provider refresh failed for ${provider.provider} (tenant ${tenantId}): ${message}`,
          );
          return {
            ok: false,
            modelCount: previousCount,
            lastFetchedAt: previousFetchedAt,
            error: message,
          };
        }
      }),
    );

    const failed = results.find((result) => !result.ok);
    const lastFetchedAt = results
      .map((result) => result.lastFetchedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .pop();
    return {
      ok: failed === undefined,
      model_count: Math.max(...results.map((result) => result.modelCount)),
      last_fetched_at: lastFetchedAt ?? null,
      error: failed?.error ?? null,
    };
  }

  /**
   * Cached view of an agent's discovered models (2-minute TTL). Returns the
   * cached list when warm, otherwise runs the full DB-backed assembly and
   * caches the result. Invalidated on any provider mutation (see invalidate()).
   */
  async getModelsForAgent(tenantId: string, agentId?: string): Promise<DiscoveredModel[]> {
    if (!agentId) return this.fetchModelsForAgent(tenantId);

    const cached = this.modelsCache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    if (cached) this.modelsCache.delete(agentId);

    const models = await this.fetchModelsForAgent(tenantId, agentId);
    const now = Date.now();
    // Sweep expired entries on populate so the cache can't grow unbounded as
    // agents come and go (entries are otherwise only dropped on miss/invalidate).
    for (const [key, entry] of this.modelsCache) {
      if (entry.expiresAt <= now) this.modelsCache.delete(key);
    }
    this.modelsCache.set(agentId, {
      tenantId,
      data: models,
      expiresAt: now + MODELS_CACHE_TTL_MS,
    });
    return models;
  }

  /**
   * Drop the cached model list for an agent. Called whenever the agent's
   * provider set or cached_models change so callers never see a stale list.
   */
  invalidate(agentId: string): void {
    this.modelsCache.delete(agentId);
  }

  /**
   * Drop the cached model list of every agent in a tenant. Custom providers
   * are tenant-global, so their alias, name or model-list edits change what
   * every agent publishes at once (bridged from RoutingCacheService).
   */
  invalidateTenant(tenantId: string): void {
    for (const [agentId, entry] of this.modelsCache) {
      if (entry.tenantId === tenantId) this.modelsCache.delete(agentId);
    }
  }

  private async invalidateProviderAccess(provider: TenantProvider): Promise<void> {
    if (provider.agent_id) this.invalidate(provider.agent_id);
    if (!this.enabledProviderRepo) return;

    const rows = await this.enabledProviderRepo.find({
      where: { tenant_provider_id: provider.id },
    });
    for (const row of rows) {
      this.invalidate(row.agent_id);
    }
  }

  private async fetchModelsForAgent(
    tenantId: string,
    agentId?: string,
  ): Promise<DiscoveredModel[]> {
    const allProviders = filterProvidersForDeployment(
      await this.providerRepo.find({
        where: { tenant_id: tenantId, is_active: true },
      }),
    );
    const providers = await this.filterProvidersForAgent(allProviders, agentId);

    const models: DiscoveredModel[] = [];
    const seen = new Map<string, number>();

    for (const p of providers) {
      if (p.provider.startsWith('custom:')) continue;
      const rawCached = p.cached_models;
      if (!Array.isArray(rawCached)) continue;
      const providerAuthType: AuthType = p.auth_type;
      const providerId = p.provider.toLowerCase();
      const filterKey = nonChatFilterKey(providerId, providerAuthType);
      const cached = filterNonChatModels(rawCached, filterKey);
      for (const cachedModel of cached) {
        const m =
          providerAuthType === 'subscription'
            ? reconcileCachedSubscriptionContextWindow(cachedModel, p.provider)
            : cachedModel;
        const effectiveAuthType = m.authType ?? providerAuthType;
        // Deduplicate by the routable tuple, not just model ID. Multiple
        // providers can expose the same native model name, and the picker must
        // keep each provider-specific route selectable.
        const dedupeKey = `${providerId}::${effectiveAuthType}::${m.id}`;
        if (!seen.has(dedupeKey)) {
          seen.set(dedupeKey, models.length);
          models.push({ ...m, provider: p.provider, authType: effectiveAuthType });
        }
      }
    }

    // Build auth_type lookup for custom providers from their tenant_providers rows
    const customAuthTypes = new Map<string, AuthType>();
    for (const p of providers) {
      if (p.provider.startsWith('custom:')) {
        customAuthTypes.set(p.provider, p.auth_type);
      }
    }

    // With an agent context, only custom providers attached through their
    // backing tenant_provider row are visible. Tenant-wide lookups keep all custom
    // providers for global provider pages and background refreshes.
    const customProviders: CustomProvider[] = await this.customProviderRepo.find({
      where: { tenant_id: tenantId },
    });
    for (const cp of customProviders) {
      if (!Array.isArray(cp.models)) continue;
      const cpKey = customProviderKey(cp.id);
      if (agentId && !customAuthTypes.has(cpKey)) continue;
      for (const m of cp.models) {
        const modelKey = customModelKey(cp.id, m.model_name);
        if (seen.has(modelKey)) continue;
        seen.set(modelKey, models.length);
        const inputPerToken =
          m.input_price_per_million_tokens != null
            ? m.input_price_per_million_tokens / 1_000_000
            : null;
        const outputPerToken =
          m.output_price_per_million_tokens != null
            ? m.output_price_per_million_tokens / 1_000_000
            : null;
        models.push({
          id: modelKey,
          displayName: m.model_name,
          provider: cpKey,
          authType: customAuthTypes.get(cpKey) ?? 'api_key',
          contextWindow: m.context_window ?? DEFAULT_CONTEXT_WINDOW,
          inputPricePerToken: inputPerToken,
          outputPricePerToken: outputPerToken,
          capabilityReasoning: false,
          capabilityCode: false,
          qualityScore: 2,
          providerName: cp.name,
          ...(cp.alias ? { providerAlias: cp.alias } : {}),
        });
      }
    }

    return models;
  }

  private async filterProvidersForAgent(
    providers: TenantProvider[],
    agentId?: string,
  ): Promise<TenantProvider[]> {
    if (!agentId || !this.enabledProviderRepo) return providers;
    const rows = await this.enabledProviderRepo.find({ where: { agent_id: agentId } });
    if (rows.length === 0) return [];
    const enabledIds = new Set(rows.map((r) => r.tenant_provider_id));
    return providers.filter((p) => enabledIds.has(p.id));
  }

  async getModelForAgent(
    tenantId: string,
    modelName: string,
    agentId?: string,
  ): Promise<DiscoveredModel | undefined> {
    const all = await this.getModelsForAgent(tenantId, agentId);
    const matches = all.filter((m) => m.id === modelName);
    // Provider-less lookups are legacy fallbacks. Once multiple providers can
    // expose the same model ID, only a single matching route is safe to infer.
    return matches.length === 1 ? matches[0] : undefined;
  }

  private enrichModel(model: DiscoveredModel, providerId: string): DiscoveredModel {
    // Fill modality gaps from the curated list before enrichment, so
    // provider-native and models.dev modalities (applied below) still win.
    const knownModalities = lookupKnownModalities(providerId, model.id);
    if (knownModalities) {
      model = {
        ...model,
        inputModalities: model.inputModalities ?? knownModalities.input,
        outputModalities: model.outputModalities ?? knownModalities.output,
        capabilities: mergeModelCapabilities(model.capabilities, knownModalities.capabilities),
      };
    }

    // Skip pricing enrichment when both prices are already set (price=0 for free/subscription)
    // but still apply capability flags from models.dev for better scoring
    if (
      model.inputPricePerToken !== null &&
      model.inputPricePerToken >= 0 &&
      model.outputPricePerToken !== null &&
      model.outputPricePerToken >= 0
    ) {
      return this.computeScore(this.applyCapabilities(model, providerId));
    }

    // Priority 1: hardcoded known prices — hand-curated, per-provider intent.
    // These have to win over models.dev / OpenRouter because the same model id
    // (e.g. `qwen/qwen3-32b`) can exist on multiple inference providers at
    // different prices, and a connection's pricing must reflect THAT
    // connection's provider, not the cheapest place the model id happens to
    // appear in upstream catalogs. For models we don't curate (the vast
    // majority), this is a no-op and we fall through to models.dev / OR.
    //
    // Even when known-prices wins on pricing we still consult models.dev for
    // capability flags (reasoning / tool-call) — those drive tier auto-
    // assignment quality scoring and shouldn't be lost just because we
    // overrode the price. Mirrors the price-already-set branch above.
    const metadata = resolveProviderMetadataIdentity(providerId, model.id);
    const metadataProvider = metadata.provider ?? providerId;
    const metadataModel = metadata.model;
    const isBedrock = providerId.toLowerCase() === 'bedrock';
    const metadataEntry = this.modelsDevSync?.lookupModel(metadataProvider, metadataModel) ?? null;
    const modelWithMetadataName =
      metadataEntry?.name && metadataEntry.name !== model.id
        ? { ...model, displayName: metadataEntry.name }
        : model;
    const pricingProvider = isBedrock ? providerId : metadataProvider;
    const pricingModel = isBedrock ? model.id : metadataModel;
    const known = lookupKnownPrice(pricingModel) ?? lookupKnownPrice(model.id);
    if (known) {
      return this.computeScore(
        this.applyCapabilities(
          {
            ...modelWithMetadataName,
            inputPricePerToken: known.input,
            outputPricePerToken: known.output,
          },
          providerId,
        ),
      );
    }

    // Priority 2: models.dev — uses native provider IDs. Bedrock pricing must
    // come from a Bedrock/AWS entry keyed by the AWS model ID; underlying
    // vendor metadata may still provide the display name/capabilities.
    if (this.modelsDevSync) {
      const mdEntry =
        pricingProvider === metadataProvider && pricingModel === metadataModel
          ? metadataEntry
          : this.modelsDevSync.lookupModel(pricingProvider, pricingModel);
      if (mdEntry && mdEntry.inputPricePerToken !== null) {
        const capabilityEntry = metadataEntry ?? mdEntry;
        return this.computeScore({
          ...modelWithMetadataName,
          inputPricePerToken: mdEntry.inputPricePerToken,
          outputPricePerToken: mdEntry.outputPricePerToken,
          contextWindow:
            mdEntry.contextWindow ?? capabilityEntry.contextWindow ?? model.contextWindow,
          displayName: capabilityEntry.name || mdEntry.name || modelWithMetadataName.displayName,
          capabilityReasoning: capabilityEntry.reasoning ?? model.capabilityReasoning,
          capabilityCode: capabilityEntry.toolCall ?? model.capabilityCode,
          ...(capabilityEntry.inputModalities
            ? { inputModalities: capabilityEntry.inputModalities }
            : {}),
          ...(capabilityEntry.outputModalities
            ? { outputModalities: capabilityEntry.outputModalities }
            : {}),
          capabilities: mergeModelCapabilities(
            model.capabilities,
            capabilityEntry.capabilities,
            modelSupportsStreaming(metadataProvider, metadataModel) ? ['stream'] : undefined,
          ),
        });
      }
    }

    // Priority 3: OpenRouter cache — broader coverage, needs prefix + variant matching
    let priced = modelWithMetadataName;
    if (this.pricingSync && !isBedrock) {
      const orPrefix = findOpenRouterPrefix(metadataProvider);
      const orPricing = orPrefix
        ? lookupWithVariants(this.pricingSync, orPrefix, metadataModel)
        : null;
      const pricing = orPricing ?? this.pricingSync.lookupPricing(model.id);
      if (pricing) {
        priced = {
          ...modelWithMetadataName,
          inputPricePerToken: pricing.input,
          outputPricePerToken: pricing.output,
          contextWindow: pricing.contextWindow ?? modelWithMetadataName.contextWindow,
          displayName: pricing.displayName || modelWithMetadataName.displayName,
        };
      }
    }

    // Capabilities are independent of which catalog priced the model: a miss on
    // every pricing source still leaves modalities and capability flags to
    // apply. Providers whose own /models endpoint publishes no modality data
    // (Kilo, Pioneer, Cline Pass, Xiaomi) reach models.dev only here.
    return this.computeScore(this.applyCapabilities(priced, providerId));
  }

  /** Merge capability flags from models.dev without touching pricing or display name. */
  private applyCapabilities(model: DiscoveredModel, providerId: string): DiscoveredModel {
    if (!this.modelsDevSync) return model;
    const metadata = resolveProviderMetadataIdentity(providerId, model.id);
    const metadataProvider = metadata.provider ?? providerId;
    const mdEntry = this.modelsDevSync.lookupModelCapabilities(metadataProvider, metadata.model);
    if (!mdEntry) return model;
    return {
      ...model,
      capabilityReasoning: mdEntry.reasoning ?? model.capabilityReasoning,
      capabilityCode: mdEntry.toolCall ?? model.capabilityCode,
      ...(mdEntry.inputModalities ? { inputModalities: mdEntry.inputModalities } : {}),
      ...(mdEntry.outputModalities ? { outputModalities: mdEntry.outputModalities } : {}),
      capabilities: mergeModelCapabilities(
        model.capabilities,
        mdEntry.capabilities,
        modelSupportsStreaming(metadataProvider, metadata.model) ? ['stream'] : undefined,
      ),
    };
  }

  private computeScore(model: DiscoveredModel): DiscoveredModel {
    const score = computeQualityScore({
      model_name: model.id,
      input_price_per_token: model.inputPricePerToken,
      output_price_per_token: model.outputPricePerToken,
      capability_reasoning: model.capabilityReasoning,
      capability_code: model.capabilityCode,
      context_window: model.contextWindow,
    });
    return { ...model, qualityScore: score };
  }
}
