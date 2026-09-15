import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { ProviderService } from './routing-core/provider.service';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { TierService } from './routing-core/tier.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import {
  AgentNameParamDto,
  AgentProviderParamDto,
  AgentProviderKeyParamDto,
  ConnectProviderDto,
  RemoveProviderQueryDto,
  RenameProviderKeyDto,
  ReorderProviderKeysDto,
} from './dto/routing.dto';
import { QWEN_REGION_VALIDATION_MESSAGE, isQwenRegion } from './qwen-region';
import { getSubscriptionEndpointRegionConfig } from './subscription-region';
import { isBedrockProvider, isBedrockRegion } from './bedrock-region';
import { isMinimaxRegion } from './oauth/minimax/minimax-oauth-helpers';
import {
  CLOUD_LOCAL_PROVIDER_MESSAGE,
  isProviderAvailableForDeployment,
} from '../common/utils/provider-availability';

@Controller('api/v1/routing')
export class ProviderController {
  constructor(
    private readonly providerService: ProviderService,
    private readonly discoveryService: ModelDiscoveryService,
    private readonly ollamaSync: OllamaSyncService,
    private readonly resolveAgentService: ResolveAgentService,
    private readonly tierService: TierService,
    private readonly pricingSync: PricingSyncService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  @Get(':agentName/status')
  async getStatus(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    const providers = await this.providerService.getProviders(agent.tenant_id);
    const hasActiveProvider = providers.some((p) => p.is_active);

    if (!hasActiveProvider) {
      return { enabled: false, reason: 'no_provider' as const };
    }

    const hasRoutableTier = await this.tierService.hasRoutableTier(agent.id);
    if (!hasRoutableTier) {
      // No tier resolves to a model. If the OpenRouter pricing cache is empty
      // (e.g. first-boot fetch failed), surface that as a more actionable hint.
      const pricingCacheEmpty = this.pricingSync.getAll().size === 0;
      return {
        enabled: false,
        reason: pricingCacheEmpty
          ? ('pricing_cache_empty' as const)
          : ('no_routable_models' as const),
      };
    }

    return { enabled: true, reason: null };
  }

  @Get(':agentName/providers')
  async getProviders(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    // allowPlayground: true — the Playground page reads the provider list for the
    // reserved Playground agent. Destructive/config mutations (rename, reorder,
    // deactivate, remove) still reject it; only additive connect is allowed.
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName, {
      allowPlayground: true,
    });
    const providers = await this.providerService.getProviders(agent.tenant_id);
    return providers.map((p) => ({
      id: p.id,
      provider: p.provider,
      auth_type: p.auth_type ?? 'api_key',
      is_active: p.is_active,
      has_api_key: !!p.api_key_encrypted,
      key_prefix: p.key_prefix ?? null,
      label: p.label,
      priority: p.priority,
      region: p.region ?? null,
      connected_at: p.connected_at,
      models_fetched_at: p.models_fetched_at ?? null,
      cached_model_count: Array.isArray(p.cached_models) ? p.cached_models.length : 0,
    }));
  }

  @Post(':agentName/providers')
  async upsertProvider(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentNameParamDto,
    @Body() body: ConnectProviderDto,
  ) {
    // allowPlayground: true — connecting a provider to the Playground agent
    // is additive and correct (enabled providers belong to the tenant-global pool).
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName, {
      allowPlayground: true,
    });
    const lowerProvider = body.provider.toLowerCase();
    if (
      !isProviderAvailableForDeployment(lowerProvider) ||
      (body.authType === 'local' && !isProviderAvailableForDeployment('ollama'))
    ) {
      throw new BadRequestException(CLOUD_LOCAL_PROVIDER_MESSAGE);
    }
    const isQwenProvider = lowerProvider === 'qwen' || lowerProvider === 'alibaba';
    const isMinimaxApiKey =
      lowerProvider === 'minimax' && (body.authType ?? 'api_key') === 'api_key';
    const qwenBaseUrl = body.baseUrl ?? body.base_url;
    const qwenRegion = qwenBaseUrl ?? body.region;
    const subscriptionRegionConfig = getSubscriptionEndpointRegionConfig(
      lowerProvider,
      body.authType,
    );

    if (qwenBaseUrl !== undefined && !isQwenProvider) {
      throw new BadRequestException('baseUrl is only supported for Alibaba/Qwen providers');
    }

    if (qwenBaseUrl !== undefined && body.region !== undefined) {
      throw new BadRequestException('Use either region or baseUrl for Alibaba/Qwen providers');
    }

    if (qwenRegion !== undefined || body.region !== undefined) {
      if (isQwenProvider) {
        if (!isQwenRegion(qwenRegion)) {
          throw new BadRequestException(QWEN_REGION_VALIDATION_MESSAGE);
        }
      } else if (isBedrockProvider(lowerProvider) && (body.authType ?? 'api_key') === 'api_key') {
        if (!isBedrockRegion(body.region)) {
          throw new BadRequestException('AWS Bedrock region must be a valid AWS region code');
        }
      } else if (subscriptionRegionConfig) {
        if (!subscriptionRegionConfig.isRegion(body.region)) {
          throw new BadRequestException(subscriptionRegionConfig.validationMessage);
        }
      } else if (isMinimaxApiKey) {
        if (!isMinimaxRegion(body.region)) {
          throw new BadRequestException('MiniMax API-key region must be one of: global, cn');
        }
      } else {
        throw new BadRequestException(
          'region is only supported for Alibaba/Qwen providers, AWS Bedrock, MiniMax subscriptions, Xiaomi MiMo Token Plan, and Z.ai subscriptions',
        );
      }
    }

    // Sync Ollama models before connecting so tier assignment has data
    if (body.provider.toLowerCase() === 'ollama') {
      await this.ollamaSync.sync();
    }

    // The service handles enabled-provider rows itself: new rows fan out to
    // every owned agent, updates re-enable the connecting agent via
    // afterProviderChange — no controller-side insert needed.
    const { provider: result } = await this.providerService.upsertProvider(
      agent.id,
      agent.tenant_id,
      body.provider,
      body.apiKey,
      body.authType,
      qwenRegion,
      body.label,
      ctx.userId,
    );

    // Discover models before returning so the frontend sees updated model
    // availability immediately (typically ~1-3s). Route choices remain
    // user-controlled and are not recalculated here.
    try {
      await this.discoveryService.discoverModels(result);
    } catch {
      // Discovery failure is non-fatal — user can retry via "Refresh models"
    }

    return {
      id: result.id,
      provider: result.provider,
      auth_type: result.auth_type ?? 'api_key',
      is_active: result.is_active,
      label: result.label,
      priority: result.priority,
      region: result.region ?? null,
    };
  }

  @Patch(':agentName/providers/:provider/keys/:label')
  async renameProviderKey(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentProviderKeyParamDto,
    @Body() body: RenameProviderKeyDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    const updated = await this.providerService.renameKey(
      agent.id,
      agent.tenant_id,
      params.provider,
      body.authType ?? 'api_key',
      params.label,
      body.newLabel,
    );
    return {
      id: updated.id,
      provider: updated.provider,
      auth_type: updated.auth_type,
      label: updated.label,
      priority: updated.priority,
    };
  }

  @Put(':agentName/providers/:provider/keys/order')
  async reorderProviderKeys(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentProviderParamDto,
    @Body() body: ReorderProviderKeysDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    const updated = await this.providerService.reorderKeys(
      agent.id,
      agent.tenant_id,
      params.provider,
      body.authType ?? 'api_key',
      body.labels,
    );
    return updated
      .sort((a, b) => a.priority - b.priority)
      .map((row) => ({
        id: row.id,
        label: row.label,
        priority: row.priority,
      }));
  }

  @Post(':agentName/providers/deactivate-all')
  async deactivateAllProviders(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentNameParamDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    await this.providerService.deactivateAllProviders(agent.id, agent.tenant_id);
    return { ok: true };
  }

  @Delete(':agentName/providers/:provider')
  async removeProvider(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentProviderParamDto,
    @Query() query: RemoveProviderQueryDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    const { notifications } = await this.providerService.removeProvider(
      agent.id,
      agent.tenant_id,
      params.provider,
      query.authType,
      query.label,
    );
    await this.cacheManager.clear();
    return { ok: true, notifications };
  }
}
