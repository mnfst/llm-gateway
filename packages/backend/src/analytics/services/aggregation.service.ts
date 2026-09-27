import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { rangeToInterval, rangeToPreviousInterval } from '../../common/utils/range.util';
import {
  MetricWithTrend,
  computeTrend,
  addTenantFilter,
  excludePlaygroundAgents,
  excludeDirectAttempts,
  sqlExcludeDirectRequests,
  scopeToConnection,
  sqlCountMessages,
  sqlExcludePlayground,
  sqlIsCompletedStatus,
  sqlIsFailedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';
import { computeCutoff, sqlSanitizeCost } from '../../common/utils/postgres-sql';
import { ManifestRequest } from '../../entities/request.entity';
import { AgentUsageDailyService } from './agent-usage-daily.service';

export { MetricWithTrend };

interface RangeWindow {
  cutoff: string;
  prevCutoff: string;
}

@Injectable()
export class AggregationService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly turnRepo: Repository<AgentMessage>,
    @Optional()
    @InjectRepository(ManifestRequest)
    private readonly requestRepo?: Repository<ManifestRequest>,
    @Optional()
    private readonly agentUsageDaily?: AgentUsageDailyService,
  ) {}

  async hasAnyData(
    tenantId: string | null,
    agentName?: string,
    excludePlayground = false,
    excludeDirect = false,
  ): Promise<boolean> {
    const attemptQb = this.turnRepo.createQueryBuilder('at').select('1').limit(1);
    addTenantFilter(attemptQb, tenantId, agentName);
    // Mirror the overview's exclusion: a tenant whose only traffic is Playground
    // must read as empty, or has_data=true paints a non-empty state over cards
    // and charts that all dropped Playground and so render blank.
    if (excludePlayground) excludePlaygroundAgents(attemptQb);
    // Same reasoning for client-pinned (direct) traffic on a harness Overview:
    // a harness whose only traffic bypassed its routing must read as empty.
    if (excludeDirect) excludeDirectAttempts(attemptQb);

    let requestRow: Promise<unknown> = Promise.resolve(null);
    if (this.requestRepo) {
      const requestQb = this.requestRepo.createQueryBuilder('r').select('1').limit(1);
      if (tenantId)
        requestQb.where('r.tenant_id = :requestTenantId', { requestTenantId: tenantId });
      else requestQb.where('1 = 0');
      if (agentName && tenantId) {
        requestQb.andWhere(
          `r.agent_id = (
            SELECT id FROM agents
            WHERE tenant_id = :requestTenantId AND name = :requestAgentName AND deleted_at IS NULL
            LIMIT 1
          )`,
          { requestAgentName: agentName },
        );
      }
      if (excludePlayground) requestQb.andWhere(sqlExcludePlayground('r'));
      if (excludeDirect) requestQb.andWhere(sqlExcludeDirectRequests('r'));
      requestRow = requestQb.getRawOne();
    }

    const [attempt, request] = await Promise.all([attemptQb.getRawOne(), requestRow]);
    return attempt != null || request != null;
  }

  async getPreviousTokenTotal(
    range: string,
    tenantId: string | null,
    agentName?: string,
  ): Promise<number> {
    const { cutoff, prevCutoff } = this.computeWindow(range);
    const row = await this.buildPreviousWindowQuery(tenantId, agentName, cutoff, prevCutoff)
      .select('COALESCE(SUM(at.input_tokens + at.output_tokens), 0)', 'total')
      .getRawOne();
    return Number(row?.total ?? 0);
  }

  async getPreviousCostTotal(
    range: string,
    tenantId: string | null,
    agentName?: string,
  ): Promise<number> {
    const { cutoff, prevCutoff } = this.computeWindow(range);
    const safeCost = sqlSanitizeCost('at.cost_usd');
    const row = await this.buildPreviousWindowQuery(tenantId, agentName, cutoff, prevCutoff)
      .select(`COALESCE(SUM(${safeCost}), 0)`, 'total')
      .getRawOne();
    return Number(row?.total ?? 0);
  }

  async getSummaryMetrics(
    range: string,
    tenantId: string | null,
    agentName?: string,
    authType?: string,
    provider?: string,
    excludePlayground = false,
    label?: string,
    tenantProviderId?: string,
  ) {
    const { cutoff, prevCutoff } = this.computeWindow(range);
    const safeCost = sqlSanitizeCost('at.cost_usd');

    const currentQb = this.turnRepo
      .createQueryBuilder('at')
      .select(sqlCountMessages(), 'msg_count')
      .addSelect('COALESCE(SUM(at.input_tokens), 0)', 'inp')
      .addSelect('COALESCE(SUM(at.output_tokens), 0)', 'out')
      .addSelect(`COALESCE(SUM(${safeCost}), 0)`, 'cost')
      .where('at.timestamp >= :cutoff', { cutoff });
    addTenantFilter(currentQb, tenantId, agentName);
    if (authType) currentQb.andWhere('at.auth_type = :authType', { authType });
    if (provider) currentQb.andWhere('at.provider = :provider', { provider });
    if (excludePlayground) excludePlaygroundAgents(currentQb);
    scopeToConnection(currentQb, tenantProviderId, label);

    const prevQb = this.buildPreviousWindowQuery(
      tenantId,
      agentName,
      cutoff,
      prevCutoff,
      authType,
      provider,
      excludePlayground,
      label,
      tenantProviderId,
    )
      .select(sqlCountMessages(), 'msg_count')
      .addSelect('COALESCE(SUM(at.input_tokens + at.output_tokens), 0)', 'tokens')
      .addSelect(`COALESCE(SUM(${safeCost}), 0)`, 'cost');

    const [cur, prev] = await Promise.all([currentQb.getRawOne(), prevQb.getRawOne()]);

    const inputTotal = Number(cur?.inp ?? 0);
    const outputTotal = Number(cur?.out ?? 0);
    const curTokens = inputTotal + outputTotal;
    const prevTokens = Number(prev?.tokens ?? 0);
    const curCost = Number(cur?.cost ?? 0);
    const prevCost = Number(prev?.cost ?? 0);
    const curMsgs = Number(cur?.msg_count ?? 0);
    const prevMsgs = Number(prev?.msg_count ?? 0);

    return {
      tokens: {
        tokens_today: {
          value: curTokens,
          trend_pct: computeTrend(curTokens, prevTokens),
          sub_values: { input: inputTotal, output: outputTotal },
        } as MetricWithTrend,
        input_tokens: inputTotal,
        output_tokens: outputTotal,
      },
      cost: { value: curCost, trend_pct: computeTrend(curCost, prevCost) } as MetricWithTrend,
      messages: { value: curMsgs, trend_pct: computeTrend(curMsgs, prevMsgs) } as MetricWithTrend,
    };
  }

  /**
   * Raw totals for the window *before* the current one, used only to compute the
   * trend arrows on the Overview summary cards. The Overview derives its
   * current-window totals by summing the timeseries buckets it already fetches
   * (see AggregationService.buildSummary), so it no longer needs the full
   * current+previous double-scan that getSummaryMetrics runs for the per-agent /
   * per-connection widgets.
   */
  async getPreviousWindowMetrics(
    range: string,
    tenantId: string | null,
    agentName?: string,
    excludePlayground = false,
    excludeDirect = false,
  ): Promise<{ tokens: number; cost: number; messages: number }> {
    if (
      excludePlayground &&
      this.agentUsageDaily?.supportsRange(tenantId, range) &&
      tenantId !== null
    ) {
      const rows = await this.agentUsageDaily.getRangeRows(tenantId, range, {
        agentName,
        previous: true,
        excludeDirect,
      });
      return rows.reduce(
        (totals, row) => {
          totals.tokens += Number(row.input_tokens) + Number(row.output_tokens);
          totals.cost += Number(row.cost_usd);
          totals.messages += Number(row.request_count);
          return totals;
        },
        { tokens: 0, cost: 0, messages: 0 },
      );
    }

    const { cutoff, prevCutoff } = this.computeWindow(range);
    const safeCost = sqlSanitizeCost('at.cost_usd');
    const prev = await this.buildPreviousWindowQuery(
      tenantId,
      agentName,
      cutoff,
      prevCutoff,
      undefined,
      undefined,
      excludePlayground,
      undefined,
      undefined,
      excludeDirect,
    )
      .select(sqlCountMessages(), 'msg_count')
      .addSelect('COALESCE(SUM(at.input_tokens + at.output_tokens), 0)', 'tokens')
      .addSelect(`COALESCE(SUM(${safeCost}), 0)`, 'cost')
      .getRawOne();
    return {
      tokens: Number(prev?.tokens ?? 0),
      cost: Number(prev?.cost ?? 0),
      messages: Number(prev?.msg_count ?? 0),
    };
  }

  /** Request-level reliability for the headline KPI and Manifest value gap. */
  async getRequestReliability(
    range: string,
    tenantId: string | null,
    agentName?: string,
    excludePlayground = false,
    excludeDirect = false,
  ): Promise<{
    total: number;
    successful: number;
    success_rate: number;
    attempt_success_rate: number;
    manifest_lift_pct: number;
    recovered: number;
    previous_total: number;
  }> {
    if (!tenantId) {
      return {
        total: 0,
        successful: 0,
        success_rate: 0,
        attempt_success_rate: 0,
        manifest_lift_pct: 0,
        recovered: 0,
        previous_total: 0,
      };
    }
    const { cutoff, prevCutoff } = this.computeWindow(range);
    const agentPredicate = agentName
      ? `AND r.agent_id = (
          SELECT id FROM agents
          WHERE tenant_id = $1 AND name = $4 AND deleted_at IS NULL
          LIMIT 1
        )`
      : '';
    const playgroundPredicate = excludePlayground ? `AND ${sqlExcludePlayground('r')}` : '';
    const unlinkedAgentPredicate = agentName
      ? `AND pa.agent_id = (
          SELECT id FROM agents
          WHERE tenant_id = $1 AND name = $4 AND deleted_at IS NULL
          LIMIT 1
        )`
      : '';
    const unlinkedPlaygroundPredicate = excludePlayground
      ? `AND ${sqlExcludePlayground('pa')}`
      : '';
    // `routing_reason` lives on the attempt, so a linked request is dropped via
    // NOT EXISTS over its attempts while an unlinked legacy attempt is tested
    // directly. This feeds the Overview's *messages* card, so it has to drop the
    // same traffic as the token/cost cards beside it.
    const directPredicate = excludeDirect ? `AND ${sqlExcludeDirectRequests('r')}` : '';
    const unlinkedDirectPredicate = excludeDirect
      ? `AND pa.routing_reason IS DISTINCT FROM 'direct'`
      : '';
    const queryParams = agentName
      ? [tenantId, prevCutoff, cutoff, agentName]
      : [tenantId, prevCutoff, cutoff];
    const rows = (await this.turnRepo.query(
      `WITH scoped_requests AS (
         SELECT r.id, r.timestamp, r.status
         FROM requests r
         WHERE r.tenant_id = $1
           AND r.timestamp >= $2
           AND ${sqlIsCompletedStatus('r.status')}
           ${agentPredicate}
           ${playgroundPredicate}
           ${directPredicate}
         UNION ALL
         SELECT 'unlinked:' || pa.id, pa.timestamp, pa.status
         FROM agent_messages pa
         WHERE pa.request_id IS NULL
           AND pa.tenant_id = $1
           AND pa.timestamp >= $2
           AND ${sqlIsCompletedStatus('pa.status')}
           ${unlinkedAgentPredicate}
           ${unlinkedPlaygroundPredicate}
           ${unlinkedDirectPredicate}
       ), attempt_stats AS (
         SELECT pa.request_id,
                COUNT(*) FILTER (WHERE ${sqlIsCompletedStatus('pa.status')}) AS attempts,
                COUNT(*) FILTER (WHERE ${sqlIsSuccessStatus('pa.status')}) AS successful_attempts,
                BOOL_OR(${sqlIsFailedStatus('pa.status')}) AS had_failure
         FROM agent_messages pa
         JOIN scoped_requests r ON r.id = pa.request_id
         GROUP BY pa.request_id
         UNION ALL
         SELECT r.id,
                1 AS attempts,
                CASE WHEN ${sqlIsSuccessStatus('pa.status')} THEN 1 ELSE 0 END AS successful_attempts,
                ${sqlIsFailedStatus('pa.status')} AS had_failure
         FROM agent_messages pa
         JOIN scoped_requests r ON r.id = 'unlinked:' || pa.id
         WHERE pa.request_id IS NULL
       )
       SELECT
         COUNT(*) FILTER (WHERE r.timestamp >= $3)::int AS total,
         COUNT(*) FILTER (WHERE r.timestamp >= $3 AND ${sqlIsSuccessStatus('r.status')})::int AS successful,
         COUNT(*) FILTER (WHERE r.timestamp < $3)::int AS previous_total,
         COALESCE(SUM(a.attempts) FILTER (WHERE r.timestamp >= $3), 0)::int AS attempts,
         COALESCE(SUM(a.successful_attempts) FILTER (WHERE r.timestamp >= $3), 0)::int AS successful_attempts,
         COUNT(*) FILTER (WHERE r.timestamp >= $3 AND ${sqlIsSuccessStatus('r.status')} AND a.had_failure)::int AS recovered
       FROM scoped_requests r
       LEFT JOIN attempt_stats a ON a.request_id = r.id`,
      queryParams,
    )) as Array<{
      total: number;
      successful: number;
      previous_total: number;
      attempts: number;
      successful_attempts: number;
      recovered: number;
    }>;
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const successful = Number(row?.successful ?? 0);
    const attempts = Number(row?.attempts ?? 0);
    const successfulAttempts = Number(row?.successful_attempts ?? 0);
    const successRate = total === 0 ? 0 : (successful / total) * 100;
    const attemptSuccessRate = attempts === 0 ? 0 : (successfulAttempts / attempts) * 100;
    return {
      total,
      successful,
      success_rate: successRate,
      attempt_success_rate: attemptSuccessRate,
      manifest_lift_pct: successRate - attemptSuccessRate,
      recovered: Number(row?.recovered ?? 0),
      previous_total: Number(row?.previous_total ?? 0),
    };
  }

  /**
   * Assemble the Overview summary cards (value + trend vs the previous window)
   * from already-computed current totals and previous-window totals. Pure (no
   * DB) so the current totals can be sourced from the timeseries buckets.
   */
  static buildSummary(
    current: { input: number; output: number; cost: number; messages: number },
    previous: { tokens: number; cost: number; messages: number },
  ): {
    tokens: { tokens_today: MetricWithTrend; input_tokens: number; output_tokens: number };
    cost: MetricWithTrend;
    messages: MetricWithTrend;
  } {
    const curTokens = current.input + current.output;
    return {
      tokens: {
        tokens_today: {
          value: curTokens,
          trend_pct: computeTrend(curTokens, previous.tokens),
          sub_values: { input: current.input, output: current.output },
        },
        input_tokens: current.input,
        output_tokens: current.output,
      },
      cost: { value: current.cost, trend_pct: computeTrend(current.cost, previous.cost) },
      messages: {
        value: current.messages,
        trend_pct: computeTrend(current.messages, previous.messages),
      },
    };
  }

  private computeWindow(range: string): RangeWindow {
    return {
      cutoff: computeCutoff(rangeToInterval(range)),
      prevCutoff: computeCutoff(rangeToPreviousInterval(range)),
    };
  }

  private buildPreviousWindowQuery(
    tenantId: string | null,
    agentName: string | undefined,
    cutoff: string,
    prevCutoff: string,
    authType?: string,
    provider?: string,
    excludePlayground = false,
    label?: string,
    tenantProviderId?: string,
    excludeDirect = false,
  ): SelectQueryBuilder<AgentMessage> {
    const qb = this.turnRepo
      .createQueryBuilder('at')
      .where('at.timestamp >= :prevCutoff', { prevCutoff })
      .andWhere('at.timestamp < :cutoff', { cutoff });
    addTenantFilter(qb, tenantId, agentName);
    if (authType) qb.andWhere('at.auth_type = :authType', { authType });
    if (provider) qb.andWhere('at.provider = :provider', { provider });
    if (excludePlayground) excludePlaygroundAgents(qb);
    if (excludeDirect) excludeDirectAttempts(qb);
    scopeToConnection(qb, tenantProviderId, label);
    return qb;
  }
}
