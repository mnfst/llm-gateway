import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { ResolveAgentService } from '../routing-core/resolve-agent.service';
import {
  MAX_PROVIDER_KEY_LABEL_LENGTH,
  ModelRouteDto,
  SetResponseModeDto,
  responseModeFromDto,
} from '../dto/routing.dto';
import { HeaderTierService } from './header-tier.service';
import { AUTH_TYPES, MAX_FALLBACKS, type TierColor } from 'manifest-shared';

interface CreateHeaderTierBody {
  name: string;
  header_key: string;
  header_value: string;
  badge_color: TierColor;
}

interface UpdateHeaderTierBody {
  name?: string;
  header_key?: string;
  header_value?: string;
  badge_color?: TierColor;
}

interface ReorderBody {
  ids: string[];
}

export class OverrideBody {
  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription' | 'local';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  providerKeyLabel?: string;

  // Validate the nested route shape so a malformed payload can't bypass the
  // legacy field validators above by being smuggled in through `route`.
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  route?: ModelRouteDto;
}

export class FallbacksBody {
  @IsArray()
  @IsString({ each: true })
  models!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FALLBACKS)
  @ValidateNested({ each: true })
  @Type(() => ModelRouteDto)
  routes?: ModelRouteDto[];
}

@Controller('api/v1/routing')
export class HeaderTierController {
  constructor(
    private readonly headerTierService: HeaderTierService,
    private readonly resolveAgentService: ResolveAgentService,
  ) {}

  @Get(':agentName/header-tiers')
  async list(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.list(agent.id);
  }

  @Post(':agentName/header-tiers')
  async create(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: CreateHeaderTierBody,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.create(agent.id, agent.tenant_id, body);
  }

  @Put(':agentName/header-tiers/:id')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: UpdateHeaderTierBody,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.update(agent.id, id, body);
  }

  @Patch(':agentName/header-tiers/:id/toggle')
  async toggle(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.setEnabled(agent.id, id, body.enabled);
  }

  @Patch(':agentName/header-tiers/:id/response-mode')
  async setResponseMode(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: SetResponseModeDto,
  ) {
    const responseMode = responseModeFromDto(body);
    if (!responseMode) throw new BadRequestException('response_mode is required');
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.setResponseMode(agent.id, id, responseMode);
  }

  @Delete(':agentName/header-tiers/:id')
  async delete(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.headerTierService.delete(agent.id, id);
    return { ok: true };
  }

  @Post(':agentName/header-tiers/reorder')
  async reorder(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: ReorderBody,
  ) {
    if (!body || !Array.isArray(body.ids)) {
      throw new BadRequestException('reorder: body.ids must be an array');
    }
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.headerTierService.reorder(agent.id, body.ids);
    return { ok: true };
  }

  @Put(':agentName/header-tiers/:id/override')
  async setOverride(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: OverrideBody,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    const model = body.route?.model ?? body.model;
    const provider = body.route?.provider ?? body.provider;
    const authType = body.route?.authType ?? body.authType;
    const providerKeyLabel = body.route?.keyLabel ?? body.providerKeyLabel;
    return this.headerTierService.setOverride(
      agent.id,
      agent.tenant_id,
      id,
      model,
      provider,
      authType,
      providerKeyLabel,
    );
  }

  @Delete(':agentName/header-tiers/:id/override')
  async clearOverride(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.headerTierService.clearOverride(agent.id, id);
    return { ok: true };
  }

  @Put(':agentName/header-tiers/:id/fallbacks')
  async setFallbacks(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
    @Body() body: FallbacksBody,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    return this.headerTierService.setFallbacks(
      agent.id,
      agent.tenant_id,
      id,
      body.models,
      body.routes,
    );
  }

  @Delete(':agentName/header-tiers/:id/fallbacks')
  async clearFallbacks(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Param('id') id: string,
  ) {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, agentName);
    await this.headerTierService.clearFallbacks(agent.id, id);
    return { ok: true };
  }
}
