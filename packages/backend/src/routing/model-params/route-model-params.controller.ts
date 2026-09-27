import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { ResolveAgentService } from '../routing-core/resolve-agent.service';
import {
  TierModelParamsPathDto,
  TierModelParamsQueryDto,
  UpdateTierModelParamsBodyDto,
} from '../dto/model-params.dto';
import { RouteModelParamsService, type RouteModelParamsView } from './route-model-params.service';

/**
 * Model params addressed by tier + model, for the CLI (`mnfst routing params`).
 * `:tier` is `default` or a custom tier's name; `?model=` picks one of the
 * models the tier routes to and defaults to its primary. The query string
 * carries the model because model ids contain slashes.
 */
@Controller('api/v1/routing')
export class RouteModelParamsController {
  constructor(
    private readonly routeParams: RouteModelParamsService,
    private readonly resolveAgentService: ResolveAgentService,
  ) {}

  @Get(':agentName/tiers/:tier/model-params')
  async get(
    @TenantCtx() ctx: TenantContext,
    @Param() params: TierModelParamsPathDto,
    @Query() query: TierModelParamsQueryDto,
  ): Promise<RouteModelParamsView> {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.routeParams.get(agent.id, params.tier, query.model);
  }

  @Patch(':agentName/tiers/:tier/model-params')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param() params: TierModelParamsPathDto,
    @Query() query: TierModelParamsQueryDto,
    @Body() body: UpdateTierModelParamsBodyDto,
  ): Promise<RouteModelParamsView> {
    const agent = await this.resolveAgentService.resolve(ctx.tenantId, params.agentName);
    return this.routeParams.update(agent.id, params.tier, query.model, {
      set: body.set,
      unset: body.unset,
    });
  }
}
