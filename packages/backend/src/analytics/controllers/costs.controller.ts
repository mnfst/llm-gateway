import { AnalyticsScopeService } from '../services/analytics-scope.service';
import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { CacheTTL } from '@nestjs/cache-manager';
import { RangeQueryDto } from '../../common/dto/range-query.dto';
import { AggregationService } from '../services/aggregation.service';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { UserCacheInterceptor } from '../../common/interceptors/user-cache.interceptor';
import { DASHBOARD_CACHE_TTL_MS } from '../../common/constants/cache.constants';
import { computeTrend } from '../services/query-helpers';

@Controller('api/v1')
@UseInterceptors(UserCacheInterceptor)
@CacheTTL(DASHBOARD_CACHE_TTL_MS)
export class CostsController {
  constructor(
    private readonly analyticsScope: AnalyticsScopeService,
    private readonly aggregation: AggregationService,
    private readonly timeseries: TimeseriesQueriesService,
  ) {}

  @Get('costs')
  async getCosts(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const range = query.range ?? '7d';
    const agentScope = await this.analyticsScope.resolve(ctx.tenantId, query.agent_name);

    const [{ costUsage: hourly }, { costUsage: daily }, byModel, prevCost] = await Promise.all([
      this.timeseries.getTimeseries(range, ctx.tenantId, true, agentScope),
      this.timeseries.getTimeseries(range, ctx.tenantId, false, agentScope),
      this.timeseries.getCostByModel(range, ctx.tenantId, agentScope),
      this.aggregation.getPreviousCostTotal(range, ctx.tenantId, agentScope),
    ]);

    // Derive cost summary from hourly timeseries data (avoids separate aggregation query)
    const currentCost = hourly.reduce((s, h) => s + h.cost, 0);

    return {
      summary: {
        weekly_cost: {
          value: currentCost,
          trend_pct: computeTrend(currentCost, prevCost),
        },
      },
      daily,
      hourly,
      by_model: byModel,
    };
  }
}
