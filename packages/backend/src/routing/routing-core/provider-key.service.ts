import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType, ModelRoute } from 'manifest-shared';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { CachedProviderKey, RoutingCacheService } from './routing-cache.service';
import { ProviderService } from './provider.service';
import { decryptWithAny, getDecryptionSecrets } from '../../common/utils/crypto.util';
import {
  expandProviderNames,
  inferProviderFromModelName,
} from '../../common/utils/provider-aliases';
import { isManifestUsableProvider } from '../../common/utils/subscription-support';

/**
 * Sentinel id for the built-in Ollama tile. getProviderKeys() short-circuits
 * Ollama to a synthetic key without a DB lookup, so this id matches no
 * `tenant_providers` row — callers stamping `agent_messages.tenant_provider_id`
 * must treat it as "no persisted connection" (NULL) to avoid an FK violation.
 */
export const SYNTHETIC_OLLAMA_PROVIDER_ID = 'ollama';

/** Longest connection label echoed into a log line. */
const MAX_LOGGED_LABEL_LENGTH = 64;
const STALE_PIN_WARN_WINDOW_MS = 60_000;
const MAX_STALE_PIN_WARNING_KEYS = 256;

/**
 * Connection labels are user-authored text. Strip control characters (a
 * newline would let a label forge extra log lines) and cap the length before
 * interpolating one into a log message.
 */
function forLog(label: string): string {
  const cleaned = [...label]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : c;
    })
    .join('');
  return cleaned.length > MAX_LOGGED_LABEL_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_LABEL_LENGTH)}…`
    : cleaned;
}

@Injectable()
export class ProviderKeyService {
  private readonly logger = new Logger(ProviderKeyService.name);
  private readonly stalePinWarnings = new Map<string, number>();

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly discoveryService: ModelDiscoveryService,
    private readonly routingCache: RoutingCacheService,
    private readonly providerService: ProviderService,
    @Optional()
    @InjectRepository(AgentEnabledProvider)
    private readonly enabledProviderRepo: Repository<AgentEnabledProvider> | null = null,
  ) {}

  /**
   * Returns the ordered list of API keys for (tenant, provider, authType),
   * optionally filtered to only those the given agent has access to.
   * Each entry's apiKey is decrypted; entries that fail to decrypt are
   * dropped silently. Local providers (Ollama) yield a single empty-key entry.
   */
  async getProviderKeys(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    agentId?: string,
  ): Promise<CachedProviderKey[]> {
    if (provider.toLowerCase() === 'ollama') {
      return [
        {
          id: SYNTHETIC_OLLAMA_PROVIDER_ID,
          label: 'Default',
          priority: 0,
          apiKey: '',
          region: null,
        },
      ];
    }

    // Agent-scoped lookups (the proxy path) cache under an agent-qualified
    // key. invalidateAgent clears the agent segment; invalidateTenant clears
    // every entry for the tenant, so both invalidation paths stay effective.
    const cached = this.routingCache.getProviderKeys(tenantId, provider, authType, agentId);
    if (cached !== undefined) return cached;

    const result = await this.resolveProviderKeys(tenantId, provider, authType, agentId);
    this.routingCache.setProviderKeys(tenantId, provider, result, authType, agentId);
    return result;
  }

  /** Returns the label of the first (default) key for the given provider+authType. */
  async getDefaultKeyLabel(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    agentId?: string,
  ): Promise<string | undefined> {
    const keys = await this.getProviderKeys(tenantId, provider, authType, agentId);
    return keys[0]?.label;
  }

  /**
   * Selects the key for (tenant, provider, authType): the case-insensitive label
   * match when a label is given, else the first (priority-ordered) default key.
   * Returns null when no key resolves. getProviderApiKey/getProviderRegion are
   * thin projections of this — callers that also need the `tenant_providers` row
   * id (e.g. the proxy, to stamp `agent_messages.tenant_provider_id`) call it
   * directly so the id selected and the key forwarded can never diverge.
   */
  async selectProviderKey(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    label?: string,
    agentId?: string,
  ): Promise<CachedProviderKey | null> {
    const keys = await this.getProviderKeys(tenantId, provider, authType, agentId);
    if (keys.length === 0) return null;
    if (label) {
      const match = keys.find((k) => k.label.toLowerCase() === label.toLowerCase());
      if (match) return match;
      // A pin that names no connection is a stale route (the key was renamed
      // or deleted). Serving the default keeps traffic flowing, but it silently
      // bills a connection the operator did not choose. Throttle identical
      // warnings so subscription re-reads and fallback retries stay diagnosable
      // without producing one log line per lookup.
      const warningKey = [tenantId, agentId ?? '', provider.toLowerCase(), authType ?? '', label]
        .join('\0')
        .toLowerCase();
      const now = Date.now();
      const warnedAt = this.stalePinWarnings.get(warningKey);
      if (warnedAt === undefined || now - warnedAt >= STALE_PIN_WARN_WINDOW_MS) {
        this.stalePinWarnings.delete(warningKey);
        this.stalePinWarnings.set(warningKey, now);
        if (this.stalePinWarnings.size > MAX_STALE_PIN_WARNING_KEYS) {
          const oldest = this.stalePinWarnings.keys().next().value as string | undefined;
          if (oldest !== undefined) this.stalePinWarnings.delete(oldest);
        }
        this.logger.warn(
          `Key label "${forLog(label)}" matches no ${provider} connection for tenant=${tenantId} ` +
            `authType=${authType ?? 'any'} — falling back to "${forLog(keys[0].label)}"`,
        );
      }
    }
    return keys[0];
  }

  /**
   * Cheap gateway-path check for a persisted route. This deliberately reuses
   * the provider-key cache instead of assembling the full discovered-model
   * list: the proxy must resolve the same key before forwarding anyway, so a
   * successful check makes that later lookup a cache hit and adds no separate
   * discovery query to automatic routing.
   */
  async hasRouteCredentials(
    tenantId: string,
    route: ModelRoute,
    agentId?: string,
  ): Promise<boolean> {
    if (!route.provider) return false;
    const keys = await this.getProviderKeys(tenantId, route.provider, route.authType, agentId);
    return keys.length > 0;
  }

  async getProviderApiKey(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    label?: string,
    agentId?: string,
  ): Promise<string | null> {
    const key = await this.selectProviderKey(tenantId, provider, authType, label, agentId);
    return key ? key.apiKey : null;
  }

  /**
   * Returns the `tenant_providers` row id of the selected key, for stamping
   * `agent_messages.tenant_provider_id` at proxy time. Returns null when no key
   * resolves OR when the selection is the synthetic Ollama tile (which has no
   * persisted row — stamping its id would violate the agent_messages FK).
   */
  async getProviderKeyId(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    label?: string,
    agentId?: string,
  ): Promise<string | null> {
    const key = await this.selectProviderKey(tenantId, provider, authType, label, agentId);
    if (!key || key.id === SYNTHETIC_OLLAMA_PROVIDER_ID) return null;
    return key.id;
  }

  async getAuthType(
    tenantId: string,
    provider: string,
    excludeAuthTypes?: Set<string>,
    agentId?: string,
  ): Promise<AuthType> {
    const names = expandProviderNames([provider]);
    const records = await this.filterProvidersForAgent(
      await this.providerService.getProviders(tenantId),
      agentId,
    );
    let matches = records.filter((r) => r.is_active && names.has(r.provider.toLowerCase()));
    // When the caller knows certain auth types already failed (e.g. during
    // fallback retries), filter them out so the alternate type is preferred.
    if (excludeAuthTypes && excludeAuthTypes.size > 0) {
      const filtered = matches.filter((r) => !excludeAuthTypes.has(r.auth_type));
      if (filtered.length > 0) matches = filtered;
    }
    // Local providers (Ollama, LM Studio) don't store a key — prefer them
    // explicitly before the key-based heuristics below so a local-only
    // record doesn't get overridden by a keyed record for a sibling alias.
    const localMatch = matches.find((r) => r.auth_type === 'local');
    if (localMatch) return 'local';
    // Prefer subscription if both exist and the subscription record has a usable key
    const subMatch = matches.find((r) => r.auth_type === 'subscription' && r.api_key_encrypted);
    if (subMatch) return 'subscription';
    // Fallback: prefer records that have a decryptable key (avoids returning
    // 'subscription' for a keyless record when an api_key record has a real key)
    const withKey = matches.find((r) => r.api_key_encrypted);
    return withKey?.auth_type ?? matches[0]?.auth_type ?? 'api_key';
  }

  async hasActiveProvider(tenantId: string, provider: string, agentId?: string): Promise<boolean> {
    const names = expandProviderNames([provider]);
    const records = await this.filterProvidersForAgent(
      await this.providerService.getProviders(tenantId),
      agentId,
    );
    return records.some((r) => r.is_active && names.has(r.provider.toLowerCase()));
  }

  async getProviderRegion(
    tenantId: string,
    provider: string,
    authType?: AuthType,
    label?: string,
    agentId?: string,
  ): Promise<string | null> {
    const key = await this.selectProviderKey(tenantId, provider, authType, label, agentId);
    return key ? key.region : null;
  }

  async findProviderForModel(
    tenantId: string,
    model: string,
    agentId?: string,
  ): Promise<string | undefined> {
    const providers = await this.filterProvidersForAgent(
      await this.providerService.getProviders(tenantId),
      agentId,
    );
    for (const p of providers) {
      if (!p.cached_models) continue;
      if (p.cached_models.some((m) => m.id === model)) return p.provider;
    }
    return undefined;
  }

  private async resolveProviderKeys(
    tenantId: string,
    provider: string,
    preferredAuthType?: AuthType,
    agentId?: string,
  ): Promise<CachedProviderKey[]> {
    // Custom providers: exact match on provider key, allow empty key for local endpoints
    if (provider.startsWith('custom:')) {
      const records = await this.providerRepo.find({
        where: { tenant_id: tenantId, provider, is_active: true },
        // id tiebreaker keeps selection deterministic when keys share a priority,
        // so the key forwarded and the id stamped never resolve to different rows.
        order: { priority: 'ASC', id: 'ASC' },
      });
      return (await this.filterProvidersForAgent(records, agentId)).flatMap((record) =>
        this.decryptOne(record),
      );
    }

    const names = expandProviderNames([provider]);
    const records = await this.providerRepo.find({
      where: { tenant_id: tenantId, is_active: true },
      // id tiebreaker keeps selection deterministic when keys share a priority,
      // so the key forwarded and the id stamped never resolve to different rows.
      order: { priority: 'ASC', id: 'ASC' },
    });

    const scopedRecords = await this.filterProvidersForAgent(records, agentId);
    const matches = scopedRecords.filter(
      (r) => isManifestUsableProvider(r) && names.has(r.provider.toLowerCase()),
    );
    if (matches.length === 0) return [];

    // When a caller explicitly requests an auth type, do not fall through
    // to a different auth type record.
    const candidates = preferredAuthType
      ? matches.filter((m) => m.auth_type === preferredAuthType)
      : [...matches].sort((a, b) => {
          const aPref = a.auth_type === 'api_key' ? 0 : 1;
          const bPref = b.auth_type === 'api_key' ? 0 : 1;
          if (aPref !== bPref) return aPref - bPref;
          return a.priority - b.priority;
        });

    return candidates.flatMap((record) => this.decryptOne(record));
  }

  private decryptOne(record: TenantProvider): CachedProviderKey[] {
    if (!record.api_key_encrypted) {
      // Local providers (auth_type='local') legitimately have no key — surface
      // an empty string so callers treat the provider as "available". Other
      // keyless records (e.g. a subscription row pre-staged before OAuth
      // completes) should not be returned as resolvable.
      if (record.auth_type === 'local') {
        return [
          {
            id: record.id,
            label: record.label,
            priority: record.priority,
            apiKey: '',
            region: record.region,
          },
        ];
      }
      // Custom providers without a key (local-style endpoints) are also valid.
      if (record.provider.startsWith('custom:')) {
        return [
          {
            id: record.id,
            label: record.label,
            priority: record.priority,
            apiKey: '',
            region: record.region,
          },
        ];
      }
      return [];
    }
    try {
      return [
        {
          id: record.id,
          label: record.label,
          priority: record.priority,
          apiKey: decryptWithAny(record.api_key_encrypted, getDecryptionSecrets()).plaintext,
          region: record.region,
        },
      ];
    } catch {
      const credentialLabel = record.auth_type === 'subscription' ? 'token' : 'API key';
      this.logger.warn(`Failed to decrypt ${credentialLabel} for provider ${record.provider}`);
      return [];
    }
  }

  async isModelAvailable(tenantId: string, model: string, agentId?: string): Promise<boolean> {
    // Check discovered models first.
    const discovered = await this.discoveryService.getModelForAgent(tenantId, model, agentId);
    if (discovered) return true;

    const pricing = this.pricingCache.getByModel(model);
    const inferredPrefix = inferProviderFromModelName(model);
    const pricingNames = pricing ? expandProviderNames([pricing.provider]) : null;
    const inferredNames = inferredPrefix ? expandProviderNames([inferredPrefix]) : null;

    // Qwen model ids must come from the provider's native discovery list.
    // Pricing/OpenRouter aliases are not reliable enough to treat as runnable DashScope ids.
    if (pricingNames?.has('qwen') || inferredNames?.has('qwen')) {
      return false;
    }

    const records = (
      await this.filterProvidersForAgent(
        await this.providerRepo.find({
          where: { tenant_id: tenantId, is_active: true },
        }),
        agentId,
      )
    ).filter(isManifestUsableProvider);
    if (pricing) {
      const names = expandProviderNames([pricing.provider]);
      if (records.find((r) => names.has(r.provider.toLowerCase()))) return true;
      const canonicalPrefix = inferProviderFromModelName(pricing.model_name);
      if (canonicalPrefix) {
        const cpNames = expandProviderNames([canonicalPrefix]);
        if (records.find((r) => cpNames.has(r.provider.toLowerCase()))) return true;
      }
    }
    if (inferredPrefix) {
      const prefixNames = expandProviderNames([inferredPrefix]);
      if (records.find((r) => prefixNames.has(r.provider.toLowerCase()))) return true;
    }
    return false;
  }

  /**
   * Availability check for an explicit ModelRoute. isModelAvailable() resolves
   * the model by name alone, and getModelForAgent() deliberately refuses
   * provider-less lookups once two connections expose the same model id — so a
   * pinned override like {model: gpt-5.5, provider: openai, authType:
   * subscription} would be reported unavailable the moment the tenant also
   * connects an openai api_key. A route carries the (provider, authType) pin,
   * so honor it: filter the discovered list down to the pinned pair instead of
   * asking the ambiguous question. Routes without a provider pin keep the
   * legacy name-only behavior.
   */
  async isRouteAvailable(tenantId: string, route: ModelRoute, agentId?: string): Promise<boolean> {
    if (!route.provider) {
      return this.isModelAvailable(tenantId, route.model, agentId);
    }
    const providerNames = expandProviderNames([route.provider]);
    const discovered = await this.discoveryService.getModelsForAgent(tenantId, agentId);
    const connectionModels = discovered.filter(
      (m) =>
        providerNames.has(m.provider.toLowerCase()) &&
        (!route.authType || !m.authType || m.authType === route.authType),
    );
    if (connectionModels.some((m) => m.id === route.model)) return true;
    if (connectionModels.length > 0) return false;

    // Qwen/Alibaba model IDs must come from native discovery. The provider has
    // region-specific routable names, so an active key alone is not enough.
    if (providerNames.has('qwen') || providerNames.has('alibaba')) return false;

    // Discovery can be cold for a connection; fall back to "an active, usable
    // record for the pinned provider exists" only when discovery returned no
    // model evidence for that pinned provider/authType.
    const records = (
      await this.filterProvidersForAgent(
        await this.providerRepo.find({
          where: { tenant_id: tenantId, is_active: true },
        }),
        agentId,
      )
    ).filter(isManifestUsableProvider);
    return records.some(
      (r) =>
        providerNames.has(r.provider.toLowerCase()) &&
        (!route.authType || r.auth_type === route.authType),
    );
  }

  /**
   * Filters a list of global tenant providers down to only those the given
   * agent has enabled. If no agentId is provided, or if the
   * enabled-provider repo is not available, returns the full list unchanged.
   */
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
}
