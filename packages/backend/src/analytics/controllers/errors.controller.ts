import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { CacheTTL } from '@nestjs/cache-manager';
import { RangeQueryDto } from '../../common/dto/range-query.dto';
import { ErrorBreakdownService } from '../services/error-breakdown.service';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { UserCacheInterceptor } from '../../common/interceptors/user-cache.interceptor';
import { DASHBOARD_CACHE_TTL_MS } from '../../common/constants/cache.constants';

@Controller('api/v1')
@UseInterceptors(UserCacheInterceptor)
@CacheTTL(DASHBOARD_CACHE_TTL_MS)
export class ErrorsController {
  constructor(private readonly errorBreakdown: ErrorBreakdownService) {}

  /**
   * Error breakdown split by origin (provider vs. transport vs. Manifest's own
   * config/policy/internal) and by class. This is the endpoint that answers
   * "how many of my errors did a provider actually throw vs. how many are my
   * own setup problems" — the two must never be conflated.
   */
  @Get('errors/breakdown')
  async getBreakdown(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    return this.errorBreakdown.getBreakdown({
      tenantId: ctx.tenantId,
      range: query.range,
      agentName: query.agent_name,
    });
  }
}
