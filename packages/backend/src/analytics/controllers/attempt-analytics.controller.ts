import { CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { DASHBOARD_CACHE_TTL_MS } from '../../common/constants/cache.constants';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { RangeQueryDto } from '../../common/dto/range-query.dto';
import { UserCacheInterceptor } from '../../common/interceptors/user-cache.interceptor';
import { AttemptStatsService } from '../services/attempt-stats.service';

@Controller('api/v1')
@UseInterceptors(UserCacheInterceptor)
@CacheTTL(DASHBOARD_CACHE_TTL_MS)
export class AttemptAnalyticsController {
  constructor(private readonly attemptStats: AttemptStatsService) {}

  @Get('overview/attempt-stats')
  async getStats(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    return this.attemptStats.getStats({
      tenantId: ctx.tenantId,
      range: query.range,
      agentName: query.agent_name,
    });
  }

  @Get('overview/attempt-timeseries')
  async getTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    return this.attemptStats.getTimeseries({
      tenantId: ctx.tenantId,
      range: query.range,
      agentName: query.agent_name,
    });
  }
}
