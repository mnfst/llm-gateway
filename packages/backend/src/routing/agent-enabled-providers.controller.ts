import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { Agent } from '../entities/agent.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { HeaderTier } from '../entities/header-tier.entity';
import { ProviderService } from './routing-core/provider.service';
import type { ModelRoute } from 'manifest-shared';

@Controller('api/v1/agents/:agentName/enabled-providers')
export class AgentEnabledProvidersController {
  constructor(
    @InjectRepository(AgentEnabledProvider)
    private readonly enabledProviderRepo: Repository<AgentEnabledProvider>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(TenantProvider)
    private readonly tenantProviderRepo: Repository<TenantProvider>,
    @InjectRepository(TierAssignment)
    private readonly tierRepo: Repository<TierAssignment>,
    @InjectRepository(SpecificityAssignment)
    private readonly specificityRepo: Repository<SpecificityAssignment>,
    @InjectRepository(HeaderTier)
    private readonly headerTierRepo: Repository<HeaderTier>,
    private readonly providerService: ProviderService,
  ) {}

  private async resolveAgent(agentName: string, tenantId: string | null) {
    if (!tenantId) return null;
    // Exclude the reserved Playground agent — its enabled providers are the global
    // pool and must not be togglable/removable through this per-agent endpoint.
    // Exclude soft-deleted agents too: a new agent can reuse a deleted one's name,
    // and without this filter both rows match and findOne may return the dead one.
    return this.agentRepo.findOne({
      where: {
        name: decodeURIComponent(agentName),
        tenant_id: tenantId,
        is_playground: false,
        deleted_at: IsNull(),
      },
    });
  }

  @Get()
  async listEnabled(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const agent = await this.resolveAgent(agentName, ctx.tenantId);
    if (!agent) return { enabled: [] };

    const rows = await this.enabledProviderRepo.find({ where: { agent_id: agent.id } });
    return { enabled: rows.map((r) => r.tenant_provider_id) };
  }

  @Get(':tenantProviderId/impact')
  async getDisableImpact(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tenantProviderId') tenantProviderId: string,
  ) {
    const agent = await this.resolveAgent(agentName, ctx.tenantId);
    if (!agent) throw new HttpException('Agent not found', HttpStatus.NOT_FOUND);

    const provider = await this.tenantProviderRepo.findOne({
      where: { id: tenantProviderId, tenant_id: agent.tenant_id },
    });
    // Match enable/disable: a provider id that isn't the caller's is a 404, not
    // an empty result. Returning [] here would be an existence oracle and an
    // inconsistent ownership contract across the three handlers.
    if (!provider) throw new HttpException('Provider not found', HttpStatus.NOT_FOUND);

    return { affected_tiers: await this.findAffectedRoutes(agent.id, provider) };
  }

  private async findAffectedRoutes(agentId: string, provider: TenantProvider) {
    const providerModels = new Set(
      (Array.isArray(provider.cached_models) ? provider.cached_models : []).map((m) => m.id),
    );
    const providerName = provider.provider.toLowerCase();
    const providerAuthType = provider.auth_type;
    const providerLabel = provider.label?.toLowerCase();
    const routeBelongsToDisabledProvider = (route: ModelRoute | null): boolean => {
      if (!route) return false;
      if (route.provider) {
        if (route.provider.toLowerCase() !== providerName) return false;
        if (route.authType && route.authType !== providerAuthType) return false;
        if (route.keyLabel && providerLabel && route.keyLabel.toLowerCase() !== providerLabel) {
          return false;
        }
        if (!route.keyLabel && provider.priority !== 0 && providerLabel !== 'default') {
          return false;
        }
        return true;
      }
      return providerModels.has(route.model);
    };

    const tiers = await this.tierRepo.find({ where: { agent_id: agentId } });
    const affected: Array<{ tier: string; model: string; position: string }> = [];

    for (const tier of tiers) {
      if (routeBelongsToDisabledProvider(tier.override_route)) {
        affected.push({ tier: tier.tier, model: tier.override_route!.model, position: 'primary' });
      }
      for (const [i, fb] of (tier.fallback_routes ?? []).entries()) {
        if (routeBelongsToDisabledProvider(fb)) {
          affected.push({ tier: tier.tier, model: fb.model, position: `fallback ${i + 1}` });
        }
      }
    }

    const specificityRows = await this.specificityRepo.find({ where: { agent_id: agentId } });
    for (const assignment of specificityRows) {
      if (routeBelongsToDisabledProvider(assignment.override_route)) {
        affected.push({
          tier: assignment.category,
          model: assignment.override_route!.model,
          position: 'primary',
        });
      }
      for (const [i, fb] of (assignment.fallback_routes ?? []).entries()) {
        if (routeBelongsToDisabledProvider(fb)) {
          affected.push({
            tier: assignment.category,
            model: fb.model,
            position: `fallback ${i + 1}`,
          });
        }
      }
    }

    const headerTiers = await this.headerTierRepo.find({ where: { agent_id: agentId } });
    for (const tier of headerTiers) {
      if (routeBelongsToDisabledProvider(tier.override_route)) {
        affected.push({ tier: tier.name, model: tier.override_route!.model, position: 'primary' });
      }
      for (const [i, fb] of (tier.fallback_routes ?? []).entries()) {
        if (routeBelongsToDisabledProvider(fb)) {
          affected.push({ tier: tier.name, model: fb.model, position: `fallback ${i + 1}` });
        }
      }
    }

    return affected;
  }

  @Put(':tenantProviderId')
  async enable(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tenantProviderId') tenantProviderId: string,
  ) {
    const agent = await this.resolveAgent(agentName, ctx.tenantId);
    if (!agent) throw new HttpException('Agent not found', HttpStatus.NOT_FOUND);

    const provider = await this.tenantProviderRepo.findOne({
      where: { id: tenantProviderId, tenant_id: agent.tenant_id },
    });
    if (!provider) throw new HttpException('Provider not found', HttpStatus.NOT_FOUND);

    await this.enabledProviderRepo
      .createQueryBuilder()
      .insert()
      .into(AgentEnabledProvider)
      .values({ agent_id: agent.id, tenant_provider_id: tenantProviderId })
      .orIgnore()
      .execute();
    await this.providerService.recalculateTiers(agent.id, agent.tenant_id);

    return { ok: true };
  }

  @Delete(':tenantProviderId')
  async disable(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tenantProviderId') tenantProviderId: string,
  ) {
    const agent = await this.resolveAgent(agentName, ctx.tenantId);
    if (!agent) throw new HttpException('Agent not found', HttpStatus.NOT_FOUND);

    const provider = await this.tenantProviderRepo.findOne({
      where: { id: tenantProviderId, tenant_id: agent.tenant_id },
    });
    if (provider) {
      const affected = await this.findAffectedRoutes(agent.id, provider);
      if (affected.length > 0) {
        throw new ConflictException(
          "Can't disable provider while its models are assigned to this harness's routing. Update routing first.",
        );
      }
    }

    await this.enabledProviderRepo.delete({
      agent_id: agent.id,
      tenant_provider_id: tenantProviderId,
    });
    await this.providerService.recalculateTiers(agent.id, agent.tenant_id);
    return { ok: true };
  }
}
