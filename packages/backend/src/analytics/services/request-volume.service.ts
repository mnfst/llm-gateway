import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { rangeToInterval } from '../../common/utils/range.util';
import { computeCutoff, sqlDateBucket, sqlHourBucket } from '../../common/utils/postgres-sql';
import {
  sqlExcludePlayground,
  sqlIsCompletedStatus,
  sqlIsFailedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';

/**
 * Request-level volume metrics (mnfst/llm-gateway#2511).
 *
 * Grouping is a lens, not a filter: the Overview's Requests chart must stack
 * to the same total in all three views (By request status / By provider /
 * By harness) and match the headline Requests KPI. That requires counting
 * LOGICAL REQUESTS, each exactly once, attributed to its TERMINAL attempt:
 * the `ok` attempt when one exists, else the last real failure. This mirrors
 * both the Requests list's `picked()` ranking (messages-query.service) and
 * the KPI's request universe (aggregation.getRequestReliability), including
 * zero-attempt rejections (Failed: Setup) and unlinked legacy attempts.
 *
 * Deliberately NOT used by usage/billing surfaces (connection 30d tables,
 * tokens, cost): those answer "what did this provider serve", where the
 * served-only counter remains correct.
 */

/** Same ranking as the Requests list: success wins, else the terminal failure. */
const TERMINAL_RANK = `CASE WHEN ${sqlIsSuccessStatus('pa.status')} THEN 3
       WHEN NOT COALESCE(pa.superseded, false)
            AND pa.status NOT IN ('fallback_error', 'auto_fixed') THEN 2
       ELSE 1 END`;

const REQUEST_SUCCEEDED = sqlIsSuccessStatus('t.request_status');

/**
 * How the request CONCLUDED. Autofix comes from the request outcome; fallback
 * comes from the terminal attempt. These mark the method that produced the
 * conclusion, never mere attempts along the way.
 */
const DISPOSITION_EXPR = `CASE
    WHEN ${REQUEST_SUCCEEDED} AND t.autofix_status = 'retry_succeeded' THEN 'healed'
    WHEN ${REQUEST_SUCCEEDED} AND t.fallback_from_model IS NOT NULL THEN 'fallback'
    WHEN ${REQUEST_SUCCEEDED} THEN 'success'
    ELSE 'error'
  END`;

export interface DispositionRow {
  bucket: string;
  dim: string | null;
  count: string;
}

/** Request-level disposition totals over one window: one row per logical request. */
export interface DispositionTotals {
  total: number;
  success: number;
  healed: number;
  fallback: number;
  error: number;
}

export interface VolumeSeriesRow {
  [bucketAlias: string]: unknown;
  messages: string | number;
}

/**
 * Scope to ONE provider connection, by terminal attribution: a request
 * belongs to the connection of its CONCLUDING attempt. A request rescued by
 * another connection's fallback counts there, not here; zero-attempt
 * rejections belong to no connection and never match.
 */
export interface ConnectionScope {
  tenantProviderId?: string;
  provider?: string;
  authType?: string;
  label?: string;
}

export interface DimensionVolumeRow {
  key: string;
  requests: number;
  failed: number;
  succeeded: number;
  /** Requests recovered by Autofix (autofix_status = retry_succeeded). */
  healed: number;
  /** Requests recovered by fallback (terminal ok attempt with a fallback origin). */
  fallback: number;
}

@Injectable()
export class RequestVolumeService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
  ) {}

  /**
   * The shared reduction: one row per logical request carrying its terminal
   * attempt's attribution fields. `$1` tenant, `$2` cutoff, `$3` agent name
   * (only when scoped). In-flight requests (`pending`) are excluded — they
   * have no outcome to chart yet.
   */
  private terminalCte(agentName?: string, hasTo = false): string {
    const agentIdx = hasTo ? 4 : 3;
    const toR = hasTo ? 'AND r.timestamp < $3' : '';
    const toPa = hasTo ? 'AND pa.timestamp < $3' : '';
    const agentPredicateR = agentName
      ? `AND r.agent_id = (
           SELECT id FROM agents
           WHERE tenant_id = $1 AND name = $${agentIdx} AND deleted_at IS NULL
           LIMIT 1
         )`
      : '';
    const agentPredicatePa = agentName
      ? `AND pa.agent_id = (
           SELECT id FROM agents
           WHERE tenant_id = $1 AND name = $${agentIdx} AND deleted_at IS NULL
           LIMIT 1
         )`
      : '';
    return `WITH terminal AS (
      (
        SELECT DISTINCT ON (r.id)
          r.id,
          r.timestamp AS ts,
          r.status AS request_status,
          r.autofix_status,
          r.agent_name,
          pa.provider,
          pa.model,
          pa.fallback_from_model,
          pa.auth_type,
          pa.provider_key_label,
          pa.tenant_provider_id
        FROM requests r
        LEFT JOIN agent_messages pa ON pa.request_id = r.id
        WHERE r.tenant_id = $1
          AND r.timestamp >= $2
          ${toR}
          AND ${sqlIsCompletedStatus('r.status')}
          ${agentPredicateR}
          AND ${sqlExcludePlayground('r')}
        ORDER BY r.id,
          ${TERMINAL_RANK} DESC,
          pa.timestamp DESC,
          pa.id DESC
      )
      UNION ALL
      (
        -- Unlinked legacy attempts (pre-backfill): each is its own synthetic
        -- request, matching the KPI's scoped_requests universe.
        SELECT
          pa.id,
          pa.timestamp,
          pa.status,
          CASE WHEN pa.autofix_role = 'retry' AND ${sqlIsSuccessStatus('pa.status')}
            THEN 'retry_succeeded' ELSE NULL END,
          pa.agent_name,
          pa.provider,
          pa.model,
          pa.fallback_from_model,
          pa.auth_type,
          pa.provider_key_label,
          pa.tenant_provider_id
        FROM agent_messages pa
        WHERE pa.request_id IS NULL
          AND pa.tenant_id = $1
          AND pa.timestamp >= $2
          ${toPa}
          AND ${sqlIsCompletedStatus('pa.status')}
          ${agentPredicatePa}
          AND ${sqlExcludePlayground('pa')}
      )
    )`;
  }

  private params(tenantId: string, range: string, agentName?: string): unknown[] {
    const cutoff = computeCutoff(rangeToInterval(range));
    return agentName ? [tenantId, cutoff, agentName] : [tenantId, cutoff];
  }

  /**
   * WHERE fragment (over the terminal rows) + appended params for a
   * connection scope. Prefers the exact tenant_providers id; falls back to
   * the (provider, auth_type, label) tuple with the legacy-NULL label fold.
   */
  private connectionPredicate(scope: ConnectionScope | undefined, params: unknown[]): string {
    if (!scope) return '';
    const clauses: string[] = [];
    if (scope.tenantProviderId) {
      params.push(scope.tenantProviderId);
      clauses.push(`t.tenant_provider_id = $${params.length}`);
    } else {
      if (scope.provider) {
        params.push(scope.provider);
        clauses.push(`t.provider = $${params.length}`);
      }
      if (scope.authType) {
        params.push(scope.authType);
        clauses.push(
          scope.authType === 'api_key'
            ? `(t.auth_type = $${params.length} OR t.auth_type IS NULL)`
            : `t.auth_type = $${params.length}`,
        );
      }
      if (scope.label) {
        params.push(scope.label);
        clauses.push(`LOWER(COALESCE(t.provider_key_label, 'Default')) = LOWER($${params.length})`);
      }
    }
    return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  }

  /**
   * Request-level disposition totals for the current and previous window from
   * ONE terminal-CTE scan.
   *
   * The KPI cards report the current window and need the previous window only
   * for the trend arrow. Scanning `[from, to)` once and splitting the counts at
   * `splitAt` with FILTER aggregates replaces two scans of the same
   * request/attempt window. The terminal reduction is the same one the By
   * request status chart uses, so both windows cover the identical universe.
   */
  async getDispositionTotalsForWindows(params: {
    tenantId: string | null;
    from: string;
    splitAt: string;
    to?: string;
    agentName?: string;
  }): Promise<{ current: DispositionTotals; previous: DispositionTotals }> {
    const empty = (): DispositionTotals => ({
      total: 0,
      success: 0,
      healed: 0,
      fallback: 0,
      error: 0,
    });
    if (!params.tenantId) return { current: empty(), previous: empty() };
    // `terminalCte(..., hasTo=true)` expects $2 = lower bound, $3 = upper bound,
    // $4 = agent name. The window split then becomes the next parameter.
    const sqlParams: unknown[] = [
      params.tenantId,
      params.from,
      params.to ?? computeCutoff('0 hours'),
    ];
    if (params.agentName) sqlParams.push(params.agentName);
    sqlParams.push(params.splitAt);
    const splitIdx = sqlParams.length;
    const sql = `${this.terminalCte(params.agentName, true)}
      SELECT ${DISPOSITION_EXPR} AS dim,
        COUNT(*) FILTER (WHERE t.ts >= $${splitIdx})::int AS current_count,
        COUNT(*) FILTER (WHERE t.ts < $${splitIdx})::int AS previous_count
      FROM terminal t
      GROUP BY 1`;
    const rows = (await this.messageRepo.query(sql, sqlParams)) as Array<{
      dim: string;
      current_count: number;
      previous_count: number;
    }>;
    const current = empty();
    const previous = empty();
    for (const r of rows) {
      const c = Number(r.current_count);
      const p = Number(r.previous_count);
      current.total += c;
      previous.total += p;
      if (r.dim === 'success') {
        current.success += c;
        previous.success += p;
      } else if (r.dim === 'healed') {
        current.healed += c;
        previous.healed += p;
      } else if (r.dim === 'fallback') {
        current.fallback += c;
        previous.fallback += p;
      } else {
        current.error += c;
        previous.error += p;
      }
    }
    return { current, previous };
  }

  /**
   * Request-level disposition timeseries: feeds the "By request status" chart
   * and the Healed requests tab. One count per request, keyed by how it
   * concluded (success / healed / fallback / error).
   */
  async getDispositionTimeseries(params: {
    tenantId: string | null;
    range: string;
    hourly: boolean;
    agentName?: string;
    failedOnly?: boolean;
    connection?: ConnectionScope;
  }): Promise<DispositionRow[]> {
    if (!params.tenantId) return [];
    const bucketExpr = params.hourly ? sqlHourBucket('t.ts') : sqlDateBucket('t.ts');
    const sqlParams = this.params(params.tenantId, params.range, params.agentName);
    const predicates = [
      params.failedOnly ? `${DISPOSITION_EXPR} = 'error'` : '',
      this.connectionPredicate(params.connection, sqlParams).replace(/^AND /, ''),
    ].filter(Boolean);
    const sql = `${this.terminalCte(params.agentName)}
      SELECT ${bucketExpr} AS bucket, ${DISPOSITION_EXPR} AS dim, COUNT(*)::int AS count
      FROM terminal t
      ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
      GROUP BY 1, 2
      ORDER BY 1 ASC`;
    return (await this.messageRepo.query(sql, sqlParams)) as DispositionRow[];
  }

  /** Request volume per harness bucket (terminal attribution, requests level). */
  async getVolumeByAgentTimeseries(
    range: string,
    tenantId: string | null,
    hourly: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    if (!tenantId) return [];
    const bucketExpr = hourly ? sqlHourBucket('t.ts') : sqlDateBucket('t.ts');
    const bucketAlias = hourly ? 'hour' : 'date';
    const sql = `${this.terminalCte()}
      SELECT ${bucketExpr} AS ${bucketAlias},
        COALESCE(t.agent_name, 'Unknown') AS agent_name,
        COUNT(*)::int AS messages
      FROM terminal t
      GROUP BY 1, 2
      ORDER BY 1 ASC`;
    return (await this.messageRepo.query(sql, this.params(tenantId, range))) as Array<
      Record<string, unknown>
    >;
  }

  /**
   * Request-level totals per dimension for the Overview trio tables
   * (Total requests / Healed / Success rate). `succeeded` counts requests
   * whose terminal outcome is ok (recovered included), so Success rate =
   * succeeded / requests keeps the "success includes rescued" story.
   */
  async getVolumeByDimension(
    dim: 'provider' | 'agent_name' | 'model',
    params: { tenantId: string | null; range?: string; agentName?: string },
  ): Promise<DimensionVolumeRow[]> {
    if (!params.tenantId) return [];
    const range = params.range ?? '7d';
    const keyExpr =
      dim === 'provider'
        ? `CASE WHEN t.provider LIKE 'custom:%' THEN 'custom' ELSE COALESCE(t.provider, 'manifest') END`
        : `t.${dim}`;
    const sql = `${this.terminalCte(params.agentName)}
      SELECT ${keyExpr} AS key,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE ${sqlIsFailedStatus('t.request_status')})::int AS failed,
        COUNT(*) FILTER (WHERE ${REQUEST_SUCCEEDED})::int AS succeeded,
        COUNT(*) FILTER (WHERE ${DISPOSITION_EXPR} = 'healed')::int AS healed,
        COUNT(*) FILTER (WHERE ${DISPOSITION_EXPR} = 'fallback')::int AS fallback
      FROM terminal t
      ${dim === 'provider' ? '' : `WHERE t.${dim} IS NOT NULL`}
      GROUP BY 1`;
    const rows = (await this.messageRepo.query(
      sql,
      this.params(params.tenantId, range, params.agentName),
    )) as Array<{
      key: string;
      requests: number;
      failed: number;
      succeeded: number;
      healed: number;
      fallback: number;
    }>;
    return rows.map((r) => ({
      key: r.key,
      requests: Number(r.requests),
      failed: Number(r.failed),
      succeeded: Number(r.succeeded),
      healed: Number(r.healed),
      fallback: Number(r.fallback),
    }));
  }
}
