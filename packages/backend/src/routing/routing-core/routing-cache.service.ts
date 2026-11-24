import { Injectable } from '@nestjs/common';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { HeaderTier } from '../../entities/header-tier.entity';
import { AgentModelParams } from '../../entities/agent-model-params.entity';

const TTL_MS = 120_000; // 2 minutes
const MAX_ENTRIES = 5_000;

interface CachedEntry<T> {
  data: T;
  expiresAt: number;
}

export interface CachedProviderKey {
  id: string;
  label: string;
  priority: number;
  apiKey: string | null;
  region: string | null;
}

function getOrExpire<T>(map: Map<string, CachedEntry<T>>, key: string): T | undefined {
  const cached = map.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now()) return cached.data;
  map.delete(key);
  return undefined;
}

function setWithEviction<T>(map: Map<string, CachedEntry<T>>, key: string, data: T): void {
  if (map.size >= MAX_ENTRIES && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

/** Notified with the agentId whenever that agent's routing cache is invalidated. */
export type AgentInvalidationListener = (agentId: string) => void;
export type TenantInvalidationListener = (tenantId: string) => void;

@Injectable()
export class RoutingCacheService {
  private readonly tiers = new Map<string, CachedEntry<TierAssignment[]>>();
  private readonly providers = new Map<string, CachedEntry<TenantProvider[]>>();
  private readonly customProviders = new Map<string, CachedEntry<CustomProvider[]>>();
  private readonly providerKeys = new Map<string, CachedEntry<CachedProviderKey[]>>();
  private readonly specificity = new Map<string, CachedEntry<SpecificityAssignment[]>>();
  private readonly headerTiers = new Map<string, CachedEntry<HeaderTier[]>>();
  private readonly modelParams = new Map<string, CachedEntry<AgentModelParams[]>>();

  // External caches keyed by agentId that must be dropped alongside the routing
  // cache. Kept as plain callbacks (not DI) so dependents in other modules can
  // subscribe without forming an import cycle — every provider mutation already
  // funnels through invalidateAgent(), so this is the one place to fan out.
  private readonly invalidationListeners: AgentInvalidationListener[] = [];
  // Same idea for tenant-wide mutations (custom provider create/update/delete),
  // which change the model list of every agent in the tenant at once.
  private readonly tenantInvalidationListeners: TenantInvalidationListener[] = [];

  getTiers(agentId: string): TierAssignment[] | null {
    return getOrExpire(this.tiers, agentId) ?? null;
  }

  setTiers(agentId: string, data: TierAssignment[]): void {
    setWithEviction(this.tiers, agentId, data);
  }

  getProviders(tenantId: string): TenantProvider[] | null {
    return getOrExpire(this.providers, tenantId) ?? null;
  }

  setProviders(tenantId: string, data: TenantProvider[]): void {
    setWithEviction(this.providers, tenantId, data);
  }

  getCustomProviders(tenantId: string): CustomProvider[] | null {
    return getOrExpire(this.customProviders, tenantId) ?? null;
  }

  setCustomProviders(tenantId: string, data: CustomProvider[]): void {
    setWithEviction(this.customProviders, tenantId, data);
  }

  /**
   * Provider-key cache key. NUL-delimited because `provider` can itself
   * contain ':' (custom:<uuid>). The agent segment scopes agent-filtered
   * results (the proxy path) separately from user-global ones, so a per-agent
   * provider toggle can never leak another agent's key chain.
   */
  private providerKeysKey(
    tenantId: string,
    provider: string,
    authType?: string,
    agentId?: string,
  ): string {
    return [tenantId, agentId ?? '', provider, authType ?? 'default'].join('\u0000');
  }

  getProviderKeys(
    tenantId: string,
    provider: string,
    authType?: string,
    agentId?: string,
  ): CachedProviderKey[] | undefined {
    return getOrExpire(
      this.providerKeys,
      this.providerKeysKey(tenantId, provider, authType, agentId),
    );
  }

  setProviderKeys(
    tenantId: string,
    provider: string,
    keys: CachedProviderKey[],
    authType?: string,
    agentId?: string,
  ): void {
    setWithEviction(
      this.providerKeys,
      this.providerKeysKey(tenantId, provider, authType, agentId),
      keys,
    );
  }

  getSpecificity(agentId: string): SpecificityAssignment[] | null {
    return getOrExpire(this.specificity, agentId) ?? null;
  }

  setSpecificity(agentId: string, data: SpecificityAssignment[]): void {
    setWithEviction(this.specificity, agentId, data);
  }

  getHeaderTiers(agentId: string): HeaderTier[] | null {
    return getOrExpire(this.headerTiers, agentId) ?? null;
  }

  setHeaderTiers(agentId: string, data: HeaderTier[]): void {
    setWithEviction(this.headerTiers, agentId, data);
  }

  getModelParams(agentId: string): AgentModelParams[] | null {
    return getOrExpire(this.modelParams, agentId) ?? null;
  }

  setModelParams(agentId: string, data: AgentModelParams[]): void {
    setWithEviction(this.modelParams, agentId, data);
  }

  invalidateModelParams(agentId: string): void {
    this.modelParams.delete(agentId);
  }

  /**
   * Register a callback fired (with the agentId) on every invalidateAgent().
   * Used to keep agent-keyed caches that live in other modules — e.g.
   * ModelDiscoveryService's discovered-model cache — in sync without creating
   * a module-level circular dependency.
   */
  addInvalidationListener(listener: AgentInvalidationListener): void {
    this.invalidationListeners.push(listener);
  }

  /**
   * Register a callback fired (with the tenantId) on every invalidateTenant().
   * Custom providers are tenant-global, so an alias or model-list change must
   * drop every agent's discovered-model cache, not one agent's.
   */
  addTenantInvalidationListener(listener: TenantInvalidationListener): void {
    this.tenantInvalidationListeners.push(listener);
  }

  invalidateAgent(agentId: string): void {
    this.tiers.delete(agentId);
    this.specificity.delete(agentId);
    this.headerTiers.delete(agentId);
    this.modelParams.delete(agentId);
    // Agent-scoped provider-key entries carry the agentId as the second
    // NUL-delimited segment (see providerKeysKey).
    const segment = `\u0000${agentId}\u0000`;
    const toDelete = [...this.providerKeys.keys()].filter((k) => k.includes(segment));
    for (const k of toDelete) this.providerKeys.delete(k);
    for (const listener of this.invalidationListeners) {
      try {
        listener(agentId);
      } catch {
        // Best-effort fan-out: a listener failure must not break invalidation
        // callers or skip the remaining listeners.
      }
    }
  }

  /**
   * Invalidate tenant-scoped caches (providers, custom providers, provider keys).
   * Call after any change to the tenant's global provider set (connect, disconnect,
   * rename, reorder).
   */
  invalidateTenant(tenantId: string): void {
    this.providers.delete(tenantId);
    this.customProviders.delete(tenantId);
    // Clears both tenant-global and agent-scoped key chains: every entry for
    // this tenant starts with the same NUL-delimited tenantId segment.
    const prefix = `${tenantId}\u0000`;
    const toDelete = [...this.providerKeys.keys()].filter((k) => k.startsWith(prefix));
    for (const k of toDelete) this.providerKeys.delete(k);
    for (const listener of this.tenantInvalidationListeners) {
      try {
        listener(tenantId);
      } catch {
        // Best-effort fan-out, as for agent listeners.
      }
    }
  }
}
