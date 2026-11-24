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
export class TokensController {
  constructor(
    private readonly analyticsScope: AnalyticsScopeService,
    private readonly aggregation: AggregationService,
    private readonly timeseries: TimeseriesQueriesService,
  ) {}

  @Get('tokens')
  async getTokens(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const range = query.range ?? '24h';
    const agentScope = await this.analyticsScope.resolve(ctx.tenantId, query.agent_name);

    const [{ tokenUsage: hourly }, { tokenUsage: daily }, prevTokens] = await Promise.all([
      this.timeseries.getTimeseries(range, ctx.tenantId, true, agentScope),
      this.timeseries.getTimeseries(range, ctx.tenantId, false, agentScope),
      this.aggregation.getPreviousTokenTotal(range, ctx.tenantId, agentScope),
    ]);

    // Derive summary from hourly timeseries data (avoids separate aggregation query)
    const inputTotal = hourly.reduce((s, h) => s + h.input_tokens, 0);
    const outputTotal = hourly.reduce((s, h) => s + h.output_tokens, 0);
    const current = inputTotal + outputTotal;

    return {
      summary: {
        total_tokens: {
          value: current,
          trend_pct: computeTrend(current, prevTokens),
          sub_values: { input: inputTotal, output: outputTotal },
        },
        input_tokens: inputTotal,
        output_tokens: outputTotal,
      },
      hourly,
      daily,
    };
  }
}
