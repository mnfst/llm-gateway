import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import { CustomProviderService } from './custom-provider/custom-provider.service';
import { filterProvidersForDeployment } from '../common/utils/provider-availability';
import { ProviderService } from './routing-core/provider.service';
import { RoutingCacheService } from './routing-core/routing-cache.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import {
  ProviderKeyParamDto,
  ProviderParamDto,
  RemoveProviderQueryDto,
  RenameProviderKeyDto,
} from './dto/routing.dto';

/**
 * Tenant-level provider management endpoints.
 * Returns all providers for the tenant (not scoped to a specific agent).
 *
 * CONFIG ONLY. This endpoint must stay cheap: it reads `tenant_providers`
 * (small) plus the in-memory pricing cache, and never touches `agent_messages`.
 * Usage stats (consumption_*, last_used_at, sparkline_7d) moved to
 * `GET /api/v1/providers/usage` (ProviderUsageController) so a config read no
 * longer triggers two multi-second scans over the 8GB messages table. The
 * frontend fetches the two halves independently and merges by
 * (provider, auth_type).
 *
 * The mutations below (disconnect, rename, refresh) are the tenant-level
 * twins of the `/routing/:agentName/providers/*` routes. Connections belong to
 * the tenant, so managing one must not require a harness to exist.
 */
@Controller('api/v1/providers')
export class TenantProvidersController {
  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly customProviderService: CustomProviderService,
    private readonly providerService: ProviderService,
    private readonly discoveryService: ModelDiscoveryService,
    private readonly routingCache: RoutingCacheService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private requireTenant(ctx: TenantContext): string {
    if (!ctx.tenantId) throw new NotFoundException('Provider not found');
    return ctx.tenantId;
  }

  /** Drop every routing cache that can hold a now-stale view of the tenant's providers. */
  private async invalidateTenantRouting(tenantId: string): Promise<void> {
    for (const agentId of await this.providerService.listOwnedAgentIds(tenantId)) {
      this.routingCache.invalidateAgent(agentId);
    }
    this.routingCache.invalidateTenant(tenantId);
  }

  @Post('refresh-models')
  async refreshModels(@TenantCtx() ctx: TenantContext) {
    const tenantId = this.requireTenant(ctx);
    await this.discoveryService.discoverAllForAgent(tenantId, { forceRefresh: true });
    await this.invalidateTenantRouting(tenantId);
    return { ok: true };
  }

  @Patch(':provider/keys/:label')
  async renameProviderKey(
    @TenantCtx() ctx: TenantContext,
    @Param() params: ProviderKeyParamDto,
    @Body() body: RenameProviderKeyDto,
  ) {
    const tenantId = this.requireTenant(ctx);
    const updated = await this.providerService.renameKey(
      null,
      tenantId,
      params.provider,
      body.authType ?? 'api_key',
      params.label,
      body.newLabel,
    );
    await this.invalidateTenantRouting(tenantId);
    return {
      id: updated.id,
      provider: updated.provider,
      auth_type: updated.auth_type,
      label: updated.label,
      priority: updated.priority,
    };
  }

  @Delete(':provider')
  async removeProvider(
    @TenantCtx() ctx: TenantContext,
    @Param() params: ProviderParamDto,
    @Query() query: RemoveProviderQueryDto,
  ) {
    const tenantId = this.requireTenant(ctx);
    const { notifications } = await this.providerService.removeProvider(
      null,
      tenantId,
      params.provider,
      query.authType,
      query.label,
    );
    await this.invalidateTenantRouting(tenantId);
    await this.cacheManager.clear();
    return { ok: true, notifications };
  }

  /**
   * List all tenant-level providers (config only). Groups by
   * (provider, auth_type) and returns the connected keys, model counts, and
   * display names. No usage aggregation — see ProviderUsageController.
   */
  @Get()
  async listProviders(@TenantCtx() ctx: TenantContext) {
    const tenantId = ctx.tenantId;
    const providers = filterProvidersForDeployment(
      tenantId ? await this.providerRepo.find({ where: { tenant_id: tenantId } }) : [],
    );

    // Group providers and build response
    const grouped = new Map<
      string,
      {
        provider: string;
        auth_type: string;
        connections: Array<{
          id: string;
          label: string;
          key_prefix: string | null;
          priority: number;
          connected_at: string;
          models_fetched_at: string | null;
          cached_model_count: number;
          is_active: boolean;
        }>;
        total_models: number;
      }
    >();

    for (const p of providers) {
      const key = `${p.provider}::${p.auth_type}`;
      const existing = grouped.get(key);
      const modelCount = Array.isArray(p.cached_models) ? p.cached_models.length : 0;

      if (existing) {
        existing.connections.push({
          id: p.id,
          label: p.label,
          key_prefix: p.key_prefix,
          priority: p.priority,
          connected_at: p.connected_at,
          models_fetched_at: p.models_fetched_at,
          cached_model_count: modelCount,
          is_active: p.is_active,
        });
        existing.total_models = Math.max(existing.total_models, modelCount);
      } else {
        grouped.set(key, {
          provider: p.provider,
          auth_type: p.auth_type,
          connections: [
            {
              id: p.id,
              label: p.label,
              key_prefix: p.key_prefix,
              priority: p.priority,
              connected_at: p.connected_at,
              models_fetched_at: p.models_fetched_at,
              cached_model_count: modelCount,
              is_active: p.is_active,
            },
          ],
          total_models: modelCount,
        });
      }
    }

    // Resolve custom provider display names (provider key = `custom:<uuid>`).
    const customProviders = tenantId ? await this.customProviderService.list(tenantId) : [];
    const customNameById = new Map(customProviders.map((cp) => [cp.id, cp.name]));

    const result = Array.from(grouped.values()).map((g) => ({
      provider: g.provider,
      auth_type: g.auth_type,
      display_name: g.provider.startsWith('custom:')
        ? (customNameById.get(g.provider.slice('custom:'.length)) ?? null)
        : null,
      connection_count: g.connections.length,
      connections: g.connections,
      total_models: g.total_models,
    }));

    // Count models per provider from the global pricing cache (covers all providers, connected or not)
    const allPricing = this.pricingCache.getAll();
    const modelCountByProvider = new Map<string, number>();
    for (const entry of allPricing) {
      const prov = entry.provider?.toLowerCase();
      if (prov) {
        modelCountByProvider.set(prov, (modelCountByProvider.get(prov) ?? 0) + 1);
      }
    }

    return {
      providers: result,
      model_counts: Object.fromEntries(modelCountByProvider),
    };
  }
}
