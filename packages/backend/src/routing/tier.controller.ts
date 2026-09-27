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
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TIER_SLOTS } from 'manifest-shared';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { TierService } from './routing-core/tier.service';
import { ResolveAgentService } from './routing-core/resolve-agent.service';
import {
  AgentNameParamDto,
  SetOverrideDto,
  SetFallbacksDto,
  SetResponseModeDto,
  responseModeFromDto,
  UpdateAutofixDto,
  UpdateRecordingDto,
} from './dto/routing.dto';
import { v4 as uuid } from 'uuid';
import { Agent } from '../entities/agent.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { AutofixService } from './autofix/autofix.service';
import { AgentRecordingConfigService } from '../common/services/agent-recording-config.service';

@Controller('api/v1/routing')
export class TierController {
  constructor(
    private readonly tierService: TierService,
    private readonly resolveAgentService: ResolveAgentService,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(InstallMetadata)
    private readonly installMetadataRepo: Repository<InstallMetadata>,
    private readonly autofixService: AutofixService,
    private readonly recordingConfig: AgentRecordingConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  @Get(':agentName/tiers')
  async getTiers(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.tierService.getTiers(agent.id, agent.tenant_id);
  }

  @Put(':agentName/tiers/:tier')
  async setOverride(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
    @Body() body: SetOverrideDto,
  ) {
    this.validateTier(tier);
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    // Prefer the structured route when the client sent it, otherwise use the
    // flat fields. Either form is accepted — the service synthesizes the
    // missing one before persisting. `route.keyLabel` and the legacy flat
    // `providerKeyLabel` carry the same multi-key pin.
    const model = body.route?.model ?? body.model;
    const provider = body.route?.provider ?? body.provider;
    const authType = body.route?.authType ?? body.authType;
    const providerKeyLabel = body.route?.keyLabel ?? body.providerKeyLabel;
    return this.tierService.setOverride(
      agent.id,
      agent.tenant_id,
      tier,
      model,
      provider,
      authType,
      providerKeyLabel,
    );
  }

  @Delete(':agentName/tiers/:tier')
  async clearOverride(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
  ) {
    this.validateTier(tier);
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.tierService.clearOverride(agent.id, tier);
    return { ok: true };
  }

  @Patch(':agentName/tiers/:tier/response-mode')
  async setResponseMode(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
    @Body() body: SetResponseModeDto,
  ) {
    this.validateTier(tier);
    const responseMode = responseModeFromDto(body);
    if (!responseMode) throw new BadRequestException('response_mode is required');
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.tierService.setResponseMode(agent.id, tier, responseMode);
  }

  @Post(':agentName/tiers/reset-all')
  async resetAllOverrides(@TenantCtx() ctx: TenantContext, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    await this.tierService.resetAllOverrides(agent.id);
    return { ok: true };
  }

  @Get(':agentName/tiers/:tier/fallbacks')
  async getFallbacks(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
  ) {
    this.validateTier(tier);
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.tierService.getFallbacks(agent.id, tier);
  }

  @Put(':agentName/tiers/:tier/fallbacks')
  async setFallbacks(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
    @Body() body: SetFallbacksDto,
  ) {
    this.validateTier(tier);
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.tierService.setFallbacks(agent.id, agent.tenant_id, tier, body.models, body.routes);
  }

  @Delete(':agentName/tiers/:tier/fallbacks')
  async clearFallbacks(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
  ) {
    this.validateTier(tier);
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.tierService.clearFallbacks(agent.id, tier);
    return { ok: true };
  }

  @Get(':agentName/complexity/status')
  async getComplexityStatus(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return { enabled: agent.complexity_routing_enabled };
  }

  @Post(':agentName/complexity/toggle')
  async toggleComplexity(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    const newValue = !agent.complexity_routing_enabled;
    await this.agentRepo.update(agent.id, { complexity_routing_enabled: newValue });
    this.resolveAgentService.invalidate(agent.tenant_id, agentName);
    return { enabled: newValue };
  }

  @Get(':agentName/autofix')
  async getAutofix(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return {
      enabled: this.autofixService.resolveEnabled(agent.autofix_enabled),
      consented: await this.hasAutofixConsent(),
    };
  }

  @Patch(':agentName/autofix')
  async updateAutofix(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: UpdateAutofixDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    // Require an explicit boolean: `@IsOptional()` lets `{"enabled": null}` through,
    // and a bare presence check would then reset the stored flag to null and echo
    // back `enabled: null` (off-contract). Undefined/null → no write, read-back.
    const applied = typeof body.enabled === 'boolean';
    if (applied) {
      await this.agentRepo.update(agent.id, { autofix_enabled: body.enabled });
      this.resolveAgentService.invalidate(agent.tenant_id, agentName);

      if (body.enabled) {
        // Per-agent enable also records consent-once so the sidebar CTA doesn't
        // keep prompting after a single agent was turned on deliberately.
        if (!(await this.hasAutofixConsent())) await this.recordAutofixConsent();
      }
      // Both `any_enabled` and `consented` just changed. `UserCacheInterceptor`
      // keys the workspace status as `${tenantId}:/api/v1/autofix/status`, so
      // without this the sidebar keeps prompting for consent already given —
      // or keeps offering the fleet CTA — until the dashboard TTL expires.
      if (agent.tenant_id) {
        await this.cacheManager.del(`${agent.tenant_id}:/api/v1/autofix/status`);
      }
    }
    return {
      enabled: applied
        ? (body.enabled as boolean)
        : this.autofixService.resolveEnabled(agent.autofix_enabled),
      consented: await this.hasAutofixConsent(),
    };
  }

  /** Consent-once: the modal never shows again once the install consented. */
  private async hasAutofixConsent(): Promise<boolean> {
    if (!isSelfHosted()) return true;
    const row = await this.installMetadataRepo.findOne({ where: { id: 'singleton' } });
    return row?.autofix_consented_at != null;
  }

  private async recordAutofixConsent(): Promise<void> {
    // The singleton row may not exist yet (telemetry disabled, Autofix enabled
    // directly). install_id is NOT NULL, so mint one alongside the consent; the
    // healing client's lazy getOrCreate() then reuses it.
    await this.installMetadataRepo
      .createQueryBuilder()
      .insert()
      .into(InstallMetadata)
      .values({
        id: 'singleton',
        install_id: uuid(),
        autofix_consented_at: new Date().toISOString(),
      })
      .orUpdate(['autofix_consented_at'], ['id'])
      .execute();
  }

  @Get(':agentName/recording')
  async getRecording(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return { enabled: await this.recordingConfig.isRecording(agent.id) };
  }

  @Patch(':agentName/recording')
  async updateRecording(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: UpdateRecordingDto,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    if (typeof body.enabled !== 'boolean') {
      return { enabled: await this.recordingConfig.isRecording(agent.id) };
    }

    await this.agentRepo.update(agent.id, { record_messages: body.enabled });
    this.resolveAgentService.invalidate(agent.tenant_id, agentName);
    return { enabled: body.enabled };
  }

  private validateTier(tier: string): void {
    if (!(TIER_SLOTS as readonly string[]).includes(tier)) {
      throw new BadRequestException(
        `Invalid tier: ${tier}. Must be one of: ${TIER_SLOTS.join(', ')}`,
      );
    }
  }
}
