import { BadRequestException, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import { CustomProviderService } from './custom-provider/custom-provider.service';
import { ProviderParamSpecService } from './routing-core/provider-param-spec.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { RoutingCacheService } from './routing-core/routing-cache.service';
import { resolveProviderMetadataIdentity } from 'manifest-shared';
import {
  inputModalitiesFromCapabilities,
  resolveModelCapabilityMetadata,
} from '../model-discovery/model-capabilities';
import {
  dropShadowedGatewayModels,
  publishedOpencodeGoIds,
} from '../model-discovery/published-gateway-models';
import {
  AgentNameParamDto,
  AgentProviderParamDto,
  RemoveProviderQueryDto,
} from './dto/routing.dto';
import {
  CLOUD_LOCAL_PROVIDER_MESSAGE,
  isProviderAvailableForDeployment,
} from '../common/utils/provider-availability';

function formatModelSlug(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayNameForModel(
  provider: string,
  modelId: string,
  displayName: string | null | undefined,
  metadataName: string | null | undefined,
): string | null {
  const trimmedDisplay = displayName?.trim();
  if (trimmedDisplay && trimmedDisplay !== modelId) return trimmedDisplay;

  const trimmedMetadata = metadataName?.trim();
  if (trimmedMetadata && trimmedMetadata !== modelId) return trimmedMetadata;

  const metadata = resolveProviderMetadataIdentity(provider, modelId);
  if (
    provider.toLowerCase() === 'bedrock' &&
    metadata.provider &&
    metadata.provider !== provider &&
    metadata.model !== modelId
  ) {
    return formatModelSlug(metadata.model);
  }

  return trimmedDisplay || null;
}

@Controller('api/v1/routing')
export class ModelController {
  constructor(
    private readonly discoveryService: ModelDiscoveryService,
    private readonly ollamaSync: OllamaSyncService,
    private readonly resolveAgentService: ResolveAgentService,
    private readonly customProviderService: CustomProviderService,
    private readonly pricingSync: PricingSyncService,
    private readonly providerParamSpecs: ProviderParamSpecService,
    private readonly modelsDevSync: ModelsDevSyncService,
    private readonly opencodeGoCatalog: OpencodeGoCatalogService,
    private readonly routingCache: RoutingCacheService,
  ) {}

  @Get('pricing-health')
  pricingHealth() {
    return {
      model_count: this.pricingSync.getAll().size,
      last_fetched_at: this.pricingSync.getLastFetchedAt()?.toISOString() ?? null,
    };
  }

  @Post('pricing/refresh')
  async refreshPricing() {
    const modelCount = await this.pricingSync.refreshCache();
    return {
      ok: modelCount > 0,
      model_count: modelCount,
      last_fetched_at: this.pricingSync.getLastFetchedAt()?.toISOString() ?? null,
    };
  }

  @Post(':agentName/refresh-models')
  async refreshModels(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    await this.discoveryService.discoverAllForAgent(agent.tenant_id, { forceRefresh: true });
    // Discovery bypasses ProviderService, so clear its caches explicitly.
    this.routingCache.invalidateAgent(agent.id);
    this.routingCache.invalidateTenant(agent.tenant_id);
    return { ok: true };
  }

  @Post(':agentName/providers/:provider/refresh-models')
  async refreshProviderModels(
    @TenantCtx() ctx: TenantContext,
    @Param() params: AgentProviderParamDto,
    @Query() query: RemoveProviderQueryDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    const result = await this.discoveryService.refreshProvider(
      agent.tenant_id,
      params.provider,
      query.authType,
    );
    this.routingCache.invalidateAgent(agent.id);
    this.routingCache.invalidateTenant(agent.tenant_id);
    return result;
  }

  @Post('ollama/sync')
  async syncOllama() {
    if (!isProviderAvailableForDeployment('ollama')) {
      throw new BadRequestException(CLOUD_LOCAL_PROVIDER_MESSAGE);
    }
    return this.ollamaSync.sync();
  }

  @Get(':agentName/available-models')
  async getAvailableModels(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    // allowPlayground: true — the Playground frontend reads available models for the
    // reserved Playground agent; all other model.controller endpoints remain blocked.
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName, {
      allowPlayground: true,
    });
    const models = await this.discoveryService.getModelsForAgent(agent.tenant_id, agent.id);
    // Resolved after the rows are built: whether two OpenCode Go ids are the
    // same model is a question about the names the picker prints, not the ids.
    const publishedGatewayIds = await publishedOpencodeGoIds(
      models,
      this.opencodeGoCatalog,
      this.modelsDevSync,
    );

    // Build display name map for custom providers (tenant-global)
    const customProviders = await this.customProviderService.list(agent.tenant_id);
    const cpNameMap = new Map<string, string>();
    for (const cp of customProviders) {
      cpNameMap.set(CustomProviderService.providerKey(cp.id), cp.name);
    }

    const rows = await Promise.all(
      models.map(async (m) => {
        const isCustom = CustomProviderService.isCustom(m.provider);
        const authType = m.authType ?? 'api_key';
        const {
          capabilities: modelCapabilities,
          inputModalities: knownInputModalities,
          modelsDevEntry,
        } = await resolveModelCapabilityMetadata(m, this.providerParamSpecs, this.modelsDevSync);
        const inputModalities =
          knownInputModalities ?? inputModalitiesFromCapabilities(modelCapabilities);
        // OpenCode Go bills a per-request slice of its dollar quota rather than
        // per token, so surface that cost; other subscriptions stay flat-fee.
        const costPerRequest =
          m.provider === 'opencode-go'
            ? await this.opencodeGoCatalog.resolveCostPerRequest(m.id)
            : null;
        return {
          model_name: m.id,
          provider: m.provider,
          auth_type: authType,
          input_price_per_token: m.inputPricePerToken,
          output_price_per_token: m.outputPricePerToken,
          ...(costPerRequest != null ? { cost_per_request: costPerRequest } : {}),
          context_window: m.contextWindow,
          capability_reasoning: m.capabilityReasoning,
          capability_code: m.capabilityCode,
          ...(modelCapabilities ? { capabilities: modelCapabilities } : {}),
          input_modalities: inputModalities,
          output_modalities: ['text'],
          quality_score: m.qualityScore,
          display_name: isCustom
            ? CustomProviderService.rawModelName(m.id)
            : displayNameForModel(m.provider, m.id, m.displayName, modelsDevEntry?.name),
          ...(isCustom && {
            provider_display_name: cpNameMap.get(m.provider) ?? m.provider,
          }),
        };
      }),
    );

    return dropShadowedGatewayModels(rows, publishedGatewayIds);
  }
}
