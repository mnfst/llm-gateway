import { Controller, Get, Optional, Query, UseInterceptors } from '@nestjs/common';
import { CacheTTL } from '@nestjs/cache-manager';
import { RangeQueryDto } from '../../common/dto/range-query.dto';
import { isHourlyRange } from '../../common/utils/range.util';
import { AggregationService } from '../services/aggregation.service';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { UserCacheInterceptor } from '../../common/interceptors/user-cache.interceptor';
import { DASHBOARD_CACHE_TTL_MS } from '../../common/constants/cache.constants';
import { ProviderService } from '../../routing/routing-core/provider.service';
import { ResolveAgentService } from '../../routing/routing-core/resolve-agent.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { computeTrend } from '../services/query-helpers';
import { MessagesQueryService } from '../services/messages-query.service';
import { OverviewQueryDto } from '../dto/overview-query.dto';

/** Sum the timeseries buckets into current-window totals for the summary cards. */
function sumTimeseries(tsData: {
  tokenUsage: { input_tokens: number; output_tokens: number }[];
  costUsage: { cost: number }[];
  messageUsage: { count: number }[];
}): { input: number; output: number; cost: number; messages: number } {
  let input = 0;
  let output = 0;
  for (const b of tsData.tokenUsage) {
    input += b.input_tokens;
    output += b.output_tokens;
  }
  const cost = tsData.costUsage.reduce((sum, b) => sum + b.cost, 0);
  const messages = tsData.messageUsage.reduce((sum, b) => sum + b.count, 0);
  return { input, output, cost, messages };
}

@Controller('api/v1')
@UseInterceptors(UserCacheInterceptor)
@CacheTTL(DASHBOARD_CACHE_TTL_MS)
export class OverviewController {
  constructor(
    private readonly aggregation: AggregationService,
    private readonly timeseries: TimeseriesQueriesService,
    private readonly providerService: ProviderService,
    private readonly resolveAgent: ResolveAgentService,
    @InjectRepository(AgentEnabledProvider)
    private readonly enabledProviderRepo: Repository<AgentEnabledProvider>,
    @Optional()
    private readonly messagesQuery?: MessagesQueryService,
  ) {}

  @Get('overview')
  async getOverview(@Query() query: OverviewQueryDto, @TenantCtx() ctx: TenantContext) {
    const range = query.range ?? '24h';
    const agentName = query.agent_name;
    const fast = query.fast === 'true';
    const hourly = isHourlyRange(range);
    const tenantId = ctx.tenantId;
    // Scoped to one harness => show only what that harness's routing did. A
    // `direct` row is a model the caller pinned in the request body, which
    // bypassed routing entirely, so it is not this harness's traffic. The
    // unscoped (global) Overview and the Messages log stay complete — that is
    // where direct requests are accounted for and where spend reconciles.
    const excludeDirect = !!agentName;

    const [
      prevMetrics,
      requestReliability,
      tsData,
      costByModel,
      recentActivity,
      activeSkills,
      hasData,
      hasProviders,
    ] = await Promise.all([
      // The overview excludes the reserved Playground (is_playground) agent's
      // traffic EVERYWHERE: the per-agent/per-provider charts on the same page
      // always drop it, so the summary cards, the aggregate timeseries and the
      // breakdown widgets must agree or the page contradicts itself. Every call
      // below passes excludePlayground=true so has_data and the visible widgets
      // never disagree (a Playground-only tenant reads as empty, not a populated
      // state painted over blank charts).
      //
      // `excludeDirect` rides along on exactly the same rule: every widget on
      // this page has to drop it or none of them can.
      //
      // The current-window summary is derived from the timeseries buckets
      // below (which scan the same Playground-excluded rows), so we only query
      // the previous window here for the trend arrows instead of repeating the
      // full current+previous double-scan.
      this.aggregation.getPreviousWindowMetrics(range, tenantId, agentName, true, excludeDirect),
      fast
        ? Promise.resolve(null)
        : this.aggregation.getRequestReliability(range, tenantId, agentName, true, excludeDirect),
      this.timeseries.getTimeseries(
        range,
        tenantId,
        hourly,
        agentName,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        excludeDirect,
      ),
      fast
        ? Promise.resolve([])
        : this.timeseries.getCostByModel(range, tenantId, agentName, true, excludeDirect),
      fast
        ? Promise.resolve([])
        : this.getRecentActivity(range, tenantId, agentName, excludeDirect),
      fast
        ? Promise.resolve([])
        : this.timeseries.getActiveSkills(range, tenantId, agentName, true, excludeDirect),
      this.aggregation.hasAnyData(tenantId, agentName, true, excludeDirect),
      this.hasActiveProviders(tenantId, agentName),
    ]);

    const summary = AggregationService.buildSummary(sumTimeseries(tsData), prevMetrics);
    if (requestReliability) {
      summary.messages = {
        value: requestReliability.total,
        trend_pct: computeTrend(requestReliability.total, requestReliability.previous_total),
      };
    }
    return {
      summary: {
        tokens_today: summary.tokens.tokens_today,
        cost_today: summary.cost,
        messages: summary.messages,
        services_hit: { total: 0, healthy: 0, issues: 0 },
      },
      token_usage: tsData.tokenUsage,
      cost_usage: tsData.costUsage,
      message_usage: tsData.messageUsage,
      cost_by_model: costByModel,
      recent_activity: recentActivity,
      active_skills: activeSkills,
      request_reliability: requestReliability,
      has_data: hasData,
      has_providers: hasProviders,
    };
  }

  @Get('overview/details')
  async getOverviewDetails(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const range = query.range ?? '24h';
    const agentName = query.agent_name;
    const excludeDirect = !!agentName;
    const [costByModel, recentActivity, requestReliability, activeSkills] = await Promise.all([
      this.timeseries.getCostByModel(range, ctx.tenantId, agentName, true, excludeDirect),
      this.getRecentActivity(range, ctx.tenantId, agentName, excludeDirect),
      this.aggregation.getRequestReliability(range, ctx.tenantId, agentName, true, excludeDirect),
      this.timeseries.getActiveSkills(range, ctx.tenantId, agentName, true, excludeDirect),
    ]);
    return {
      cost_by_model: costByModel,
      recent_activity: recentActivity,
      request_reliability: requestReliability,
      active_skills: activeSkills,
    };
  }

  @Get('overview/per-agent-timeseries')
  async getPerAgentTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerAgentTimeseries(range, ctx.tenantId, hourly);
  }

  @Get('overview/per-agent-message-timeseries')
  async getPerAgentMessageTimeseries(
    @Query() query: RangeQueryDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    const { range, hourly } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerAgentMessageTimeseries(range, ctx.tenantId, hourly);
  }

  @Get('overview/per-agent-cost-timeseries')
  async getPerAgentCostTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerAgentCostTimeseries(range, ctx.tenantId, hourly);
  }

  @Get('overview/agents/usage')
  async getOverviewAgentsUsage(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getAgentUsageTimeseries(range, ctx.tenantId, hourly);
  }

  @Get('overview/per-provider-timeseries')
  async getPerProviderTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerProviderTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/per-provider-message-timeseries')
  async getPerProviderMessageTimeseries(
    @Query() query: RangeQueryDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerProviderMessageTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/per-provider-cost-timeseries')
  async getPerProviderCostTimeseries(
    @Query() query: RangeQueryDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerProviderCostTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/providers/usage')
  async getOverviewProvidersUsage(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getProviderUsageTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/per-model-cost-timeseries')
  async getPerModelCostTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerModelCostTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/per-model-timeseries')
  async getPerModelTimeseries(@Query() query: RangeQueryDto, @TenantCtx() ctx: TenantContext) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerModelTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  @Get('overview/per-model-message-timeseries')
  async getPerModelMessageTimeseries(
    @Query() query: RangeQueryDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    const { range, hourly, agentName } = this.deriveTimeseriesArgs(query);
    return this.timeseries.getPerModelMessageTimeseries(range, ctx.tenantId, hourly, agentName);
  }

  /**
   * Shared derivation of the (range, hourly, agentName) tuple every
   * `overview/per-*-timeseries` endpoint needs. Extracted so the per-endpoint
   * methods can't drift in how they default the range or compute `hourly`.
   */
  private deriveTimeseriesArgs(query: RangeQueryDto): {
    range: string;
    hourly: boolean;
    agentName?: string;
  } {
    const range = query.range ?? '24h';
    return {
      range,
      hourly: isHourlyRange(range),
      agentName: query.agent_name,
    };
  }

  private async hasActiveProviders(tenantId: string | null, agentName?: string): Promise<boolean> {
    if (!agentName || !tenantId) return false;
    try {
      const agent = await this.resolveAgent.resolve(tenantId, agentName);
      const providers = await this.providerService.getProviders(tenantId);
      const activeProviderIds = new Set(providers.filter((p) => p.is_active).map((p) => p.id));
      if (activeProviderIds.size === 0) return false;
      const enabledRows = await this.enabledProviderRepo.find({ where: { agent_id: agent.id } });
      return enabledRows.some((row) => activeProviderIds.has(row.tenant_provider_id));
    } catch {
      return false;
    }
  }

  private getRecentActivity(
    range: string,
    tenantId: string | null,
    agentName: string | undefined,
    excludeDirect: boolean,
  ) {
    return this.messagesQuery
      ? this.messagesQuery
          .getMessages({
            range,
            tenantId,
            agent_name: agentName,
            limit: 5,
            include_total: false,
            include_filter_options: false,
            exclude_playground: true,
            exclude_direct: excludeDirect,
          })
          .then((result) => result.items)
      : this.timeseries.getRecentActivity(range, tenantId, 5, agentName, true, excludeDirect);
  }
}
