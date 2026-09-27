import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  rangeToInterval,
  rangeToPreviousInterval,
  isHourlyRange,
} from '../../common/utils/range.util';
import { computeCutoff, sqlDateBucket, sqlHourBucket } from '../../common/utils/postgres-sql';
import { AgentMessage } from '../../entities/agent-message.entity';
import {
  addTenantFilter,
  excludePlaygroundAgents,
  scopeToConnection,
  sqlIsCompletedStatus,
  sqlIsFailedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';

export interface AttemptMetric {
  value: number;
  previous: number;
}

export interface AttemptStatsResponse {
  /** Completed, non-Playground rows in the scoped `agent_messages` window. */
  total_attempts: AttemptMetric;
  /** Fallback destinations: attempts whose `fallback_from_model` is non-null. */
  fallbacked_attempts: AttemptMetric;
}

export const ATTEMPT_METRIC_KEYS = ['total_attempts', 'fallbacked_attempts'] as const;

export interface AttemptTimeseriesResponse {
  range: string;
  by: 'metric';
  keys: string[];
  buckets: Array<{ bucket: string; counts: number[] }>;
}

interface AttemptCounts {
  attempts: number;
  fallbacked_attempts: number;
}

/**
 * Universal attempt aggregates. Request totals remain on
 * `overview.request_reliability`; Autofix totals remain on the adjacent
 * Autofix/error aggregates. When those surfaces are composed, the canonical
 * Autofixed attempt is the successful `autofix_role='retry'` row. No cohort
 * or eligibility predicate belongs in this service.
 */
@Injectable()
export class AttemptStatsService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly attemptRepo: Repository<AgentMessage>,
  ) {}

  async getStats(params: {
    tenantId: string | null;
    range?: string;
    agentName?: string;
  }): Promise<AttemptStatsResponse> {
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const previousCutoff = computeCutoff(rangeToPreviousInterval(range));
    const [current, previous] = await Promise.all([
      this.queryWindow(cutoff, undefined, params.tenantId, params.agentName),
      this.queryWindow(previousCutoff, cutoff, params.tenantId, params.agentName),
    ]);

    return {
      total_attempts: { value: current.attempts, previous: previous.attempts },
      fallbacked_attempts: {
        value: current.fallbacked_attempts,
        previous: previous.fallbacked_attempts,
      },
    };
  }

  async getTimeseries(params: {
    tenantId: string | null;
    range?: string;
    agentName?: string;
  }): Promise<AttemptTimeseriesResponse> {
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const bucketExpression = isHourlyRange(range)
      ? sqlHourBucket('at.timestamp')
      : sqlDateBucket('at.timestamp');
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select(bucketExpression, 'bucket')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect(
        'COUNT(*) FILTER (WHERE at.fallback_from_model IS NOT NULL)',
        'fallbacked_attempts',
      )
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'));
    addTenantFilter(qb, params.tenantId, params.agentName);
    excludePlaygroundAgents(qb);

    const rows = (await qb.groupBy('bucket').orderBy('bucket', 'ASC').getRawMany()) as Array<
      Record<string, unknown>
    >;
    return {
      range,
      by: 'metric',
      keys: [...ATTEMPT_METRIC_KEYS],
      buckets: rows.map((row) => ({
        bucket: String(row['bucket']),
        counts: [Number(row['attempts'] ?? 0), Number(row['fallbacked_attempts'] ?? 0)],
      })),
    };
  }

  /**
   * Connection filters with the SAME legacy folds as the usage list rows
   * (provider-usage.service): a NULL auth_type reads as 'api_key', and an
   * orphan attempt (NULL tenant_provider_id, from before connections were
   * stamped) belongs to the connection whose label folds to its own
   * (NULL label reads as 'Default'). Without these folds the detail page
   * excludes rows the list counts, and the two disagree.
   */
  private scopeToConnectionWithLegacyFold<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    params: { authType?: string; provider?: string; label?: string; tenantProviderId?: string },
  ): void {
    if (params.provider) {
      qb.andWhere('at.provider = :provider', { provider: params.provider });
    }
    if (params.authType) {
      if (params.authType === 'api_key') {
        qb.andWhere('(at.auth_type = :authType OR at.auth_type IS NULL)', {
          authType: params.authType,
        });
      } else {
        qb.andWhere('at.auth_type = :authType', { authType: params.authType });
      }
    }
    if (params.tenantProviderId) {
      const labelFold = params.label
        ? "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:connLabel)"
        : "COALESCE(at.provider_key_label, 'Default') = 'Default'";
      qb.andWhere(
        `(at.tenant_provider_id = :tenantProviderId OR (at.tenant_provider_id IS NULL AND ${labelFold}))`,
        {
          tenantProviderId: params.tenantProviderId,
          ...(params.label ? { connLabel: params.label } : {}),
        },
      );
    } else {
      scopeToConnection(qb, undefined, params.label);
    }
  }

  /**
   * Attempt-status timeseries scoped to ONE provider connection: every
   * provider call counts where it ran (retries and fallback attempts
   * included), keyed by its OWN outcome. Success = ok, error = everything
   * else. No healing notion: that belongs to requests.
   */
  async getConnectionStatusTimeseries(params: {
    tenantId: string | null;
    range?: string;
    authType?: string;
    provider?: string;
    label?: string;
    tenantProviderId?: string;
  }): Promise<AttemptTimeseriesResponse> {
    const range = params.range ?? '7d';
    if (!params.tenantId) return { range, by: 'metric', keys: [], buckets: [] };
    const bucketExpression = isHourlyRange(range)
      ? sqlHourBucket('at.timestamp')
      : sqlDateBucket('at.timestamp');
    const cutoff = computeCutoff(rangeToInterval(range));
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select(bucketExpression, 'bucket')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsSuccessStatus('at.status')})`, 'success')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsFailedStatus('at.status')})`, 'error')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'));
    addTenantFilter(qb, params.tenantId);
    excludePlaygroundAgents(qb);
    this.scopeToConnectionWithLegacyFold(qb, params);

    const rows = (await qb.groupBy('bucket').orderBy('bucket', 'ASC').getRawMany()) as Array<
      Record<string, unknown>
    >;
    return {
      range,
      by: 'metric',
      keys: ['success', 'error'],
      buckets: rows.map((row) => ({
        bucket: String(row['bucket']),
        counts: [Number(row['success'] ?? 0), Number(row['error'] ?? 0)],
      })),
    };
  }

  /**
   * Attempts per harness over time, scoped to ONE provider connection. The
   * By harness view of the connection's Attempts chart: same universe as the
   * status view, so both stack to the same totals.
   */
  async getConnectionAttemptsByAgentTimeseries(params: {
    tenantId: string | null;
    range?: string;
    authType?: string;
    provider?: string;
    label?: string;
    tenantProviderId?: string;
  }): Promise<{ agents: string[]; timeseries: Array<Record<string, number | string>> }> {
    const range = params.range ?? '7d';
    if (!params.tenantId) return { agents: [], timeseries: [] };
    const hourly = isHourlyRange(range);
    const bucketExpression = hourly ? sqlHourBucket('at.timestamp') : sqlDateBucket('at.timestamp');
    const bucketAlias = hourly ? 'hour' : 'date';
    const cutoff = computeCutoff(rangeToInterval(range));
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select(bucketExpression, 'bucket')
      .addSelect("COALESCE(at.agent_name, 'Unknown')", 'agent_name')
      .addSelect('COUNT(*)', 'attempts')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'));
    addTenantFilter(qb, params.tenantId);
    excludePlaygroundAgents(qb);
    this.scopeToConnectionWithLegacyFold(qb, params);

    const rows = (await qb
      .groupBy('bucket')
      .addGroupBy("COALESCE(at.agent_name, 'Unknown')")
      .orderBy('bucket', 'ASC')
      .getRawMany()) as Array<Record<string, unknown>>;

    const agents = new Set<string>();
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const row of rows) {
      const bucket = String(row['bucket']);
      const agent = String(row['agent_name']);
      agents.add(agent);
      let entry = byBucket.get(bucket);
      if (!entry) {
        entry = { [bucketAlias]: bucket };
        byBucket.set(bucket, entry);
      }
      entry[agent] = Number(row['attempts'] ?? 0);
    }
    return { agents: [...agents].sort(), timeseries: [...byBucket.values()] };
  }

  /**
   * Attempts by HTTP status over time, scoped to ONE connection. Successful
   * attempts read '200' by convention (their code is not stored); failures
   * read their own code, or 'No response' when the provider never answered.
   */
  async getConnectionHttpStatusTimeseries(params: {
    tenantId: string | null;
    range?: string;
    authType?: string;
    provider?: string;
    label?: string;
    tenantProviderId?: string;
  }): Promise<AttemptTimeseriesResponse> {
    const range = params.range ?? '7d';
    if (!params.tenantId) return { range, by: 'metric', keys: [], buckets: [] };
    const bucketExpression = isHourlyRange(range)
      ? sqlHourBucket('at.timestamp')
      : sqlDateBucket('at.timestamp');
    const codeExpr = `CASE
      WHEN ${sqlIsSuccessStatus('at.status')} THEN '200'
      ELSE COALESCE(at.error_http_status::text, 'No response') END`;
    const cutoff = computeCutoff(rangeToInterval(range));
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select(bucketExpression, 'bucket')
      .addSelect(codeExpr, 'code')
      .addSelect('COUNT(*)', 'attempts')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'));
    addTenantFilter(qb, params.tenantId);
    excludePlaygroundAgents(qb);
    this.scopeToConnectionWithLegacyFold(qb, params);

    const rows = (await qb
      .groupBy('bucket')
      .addGroupBy(codeExpr)
      .orderBy('bucket', 'ASC')
      .getRawMany()) as Array<Record<string, unknown>>;

    const keys = [...new Set(rows.map((r) => String(r['code'])))].sort((a, b) => {
      // Success first, then numeric codes ascending, 'No response' last.
      if (a === '200') return -1;
      if (b === '200') return 1;
      if (a === 'No response') return 1;
      if (b === 'No response') return -1;
      return Number(a) - Number(b);
    });
    const byBucket = new Map<string, number[]>();
    for (const row of rows) {
      const bucket = String(row['bucket']);
      let counts = byBucket.get(bucket);
      if (!counts) {
        counts = new Array(keys.length).fill(0);
        byBucket.set(bucket, counts);
      }
      counts[keys.indexOf(String(row['code']))] = Number(row['attempts'] ?? 0);
    }
    return {
      range,
      by: 'metric',
      keys,
      buckets: [...byBucket.entries()].map(([bucket, counts]) => ({ bucket, counts })),
    };
  }

  /**
   * The connection's attempt breakdown for the header cards: totals, and the
   * two retry families with their own outcomes. Fallback retries exist for
   * everyone; autofixed attempts only exist with the Doctor version.
   */
  async getConnectionBreakdown(params: {
    tenantId: string | null;
    range?: string;
    authType?: string;
    provider?: string;
    label?: string;
    tenantProviderId?: string;
  }): Promise<{
    attempts: number;
    succeeded: number;
    failed: number;
    fallback_retries: number;
    fallback_retries_succeeded: number;
    autofix_attempts: number;
    autofix_attempts_succeeded: number;
  }> {
    const empty = {
      attempts: 0,
      succeeded: 0,
      failed: 0,
      fallback_retries: 0,
      fallback_retries_succeeded: 0,
      autofix_attempts: 0,
      autofix_attempts_succeeded: 0,
    };
    if (!params.tenantId) return empty;
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const okExpr = sqlIsSuccessStatus('at.status');
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select('COUNT(*)', 'attempts')
      .addSelect(`COUNT(*) FILTER (WHERE ${okExpr})`, 'succeeded')
      .addSelect(`COUNT(*) FILTER (WHERE at.fallback_from_model IS NOT NULL)`, 'fallback_retries')
      .addSelect(
        `COUNT(*) FILTER (WHERE at.fallback_from_model IS NOT NULL AND ${okExpr})`,
        'fallback_retries_succeeded',
      )
      .addSelect(`COUNT(*) FILTER (WHERE at.autofix_role = 'retry')`, 'autofix_attempts')
      .addSelect(
        `COUNT(*) FILTER (WHERE at.autofix_role = 'retry' AND ${okExpr})`,
        'autofix_attempts_succeeded',
      )
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'));
    addTenantFilter(qb, params.tenantId);
    excludePlaygroundAgents(qb);
    this.scopeToConnectionWithLegacyFold(qb, params);

    const row = await qb.getRawOne<Record<string, string>>();
    const attempts = Number(row?.attempts ?? 0);
    const succeeded = Number(row?.succeeded ?? 0);
    return {
      attempts,
      succeeded,
      failed: attempts - succeeded,
      fallback_retries: Number(row?.fallback_retries ?? 0),
      fallback_retries_succeeded: Number(row?.fallback_retries_succeeded ?? 0),
      autofix_attempts: Number(row?.autofix_attempts ?? 0),
      autofix_attempts_succeeded: Number(row?.autofix_attempts_succeeded ?? 0),
    };
  }

  private async queryWindow(
    from: string,
    to: string | undefined,
    tenantId: string | null,
    agentName?: string,
  ): Promise<AttemptCounts> {
    const qb = this.attemptRepo
      .createQueryBuilder('at')
      .select('COUNT(*)', 'attempts')
      .addSelect(
        'COUNT(*) FILTER (WHERE at.fallback_from_model IS NOT NULL)',
        'fallbacked_attempts',
      )
      .where('at.timestamp >= :from', { from })
      .andWhere(sqlIsCompletedStatus('at.status'));
    if (to) qb.andWhere('at.timestamp < :to', { to });
    addTenantFilter(qb, tenantId, agentName);
    excludePlaygroundAgents(qb);
    const row = await qb.getRawOne<Record<string, unknown>>();
    return {
      attempts: Number(row?.['attempts'] ?? 0),
      fallbacked_attempts: Number(row?.['fallbacked_attempts'] ?? 0),
    };
  }
}
