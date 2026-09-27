import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, QueryRunner, Repository, SelectQueryBuilder } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { rangeToInterval } from '../../common/utils/range.util';
import {
  addTenantFilter,
  formatTimestamp,
  selectMessageRowColumns,
  ERROR_MESSAGE_STATUSES,
  SUCCESS_STATUS_SQL_LIST,
  MANIFEST_ORIGIN_PREDICATE,
  CUSTOM_PROVIDER_JOIN_CONDITION,
  excludePlaygroundAgents,
  filterByLiveAgentName,
  sqlExcludePlayground,
  excludeDirectAttempts,
  sqlExcludeDirectRequests,
  sqlIsFailedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';
import type {
  MessageOriginFilter,
  MessageStatusFilter,
  MessageTriggerFilter,
} from '../dto/messages-query.dto';
import { computeCutoff, sqlCastFloat, sqlSanitizeCost } from '../../common/utils/postgres-sql';
import { inferProviderFromModel } from '../../common/utils/provider-inference';
import { TtlCache } from '../../common/utils/ttl-cache';
import { ManifestRequest } from '../../entities/request.entity';
import { HeaderTier } from '../../entities/header-tier.entity';

// The Messages-log "failed"/"errors" filters and every "messages" KPI count
// share one definition of an error status (see query-helpers.sqlCountMessages).
const FAILED_STATUSES = ERROR_MESSAGE_STATUSES;
const ERROR_STATUSES = ERROR_MESSAGE_STATUSES;
const AUTOFIX_TRIGGER_ROLE = 'retry';

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const DISTINCT_MODELS_DEFAULT_INTERVAL = '90 days';
const COUNT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

// Recursive loose-index-scan ("skip scan") that enumerates a tenant's distinct
// models without scanning/sorting every row: the base case grabs the smallest
// value via the (tenant_id, model) index, and each recursive step seeks the next
// value strictly greater than the last. ~one index seek per distinct value.
// $1 (tenant_id) is reused by position across all three references.
const DISTINCT_MODELS_SKIP_SCAN_SQL = `
WITH RECURSIVE t AS (
  (SELECT model FROM agent_messages
     WHERE tenant_id = $1 AND model IS NOT NULL AND model <> ''
     ORDER BY model LIMIT 1)
  UNION ALL
  SELECT (SELECT model FROM agent_messages
            WHERE tenant_id = $1 AND model > t.model AND model IS NOT NULL AND model <> ''
            ORDER BY model LIMIT 1)
  FROM t WHERE t.model IS NOT NULL
)
SELECT model FROM t WHERE model IS NOT NULL`;

// Same technique for distinct providers, backed by the partial
// IDX_agent_messages_tenant_provider_value (tenant_id, provider) index.
const DISTINCT_PROVIDERS_SKIP_SCAN_SQL = `
WITH RECURSIVE p AS (
  (SELECT provider FROM agent_messages
     WHERE tenant_id = $1 AND provider IS NOT NULL AND provider <> ''
     ORDER BY provider LIMIT 1)
  UNION ALL
  SELECT (SELECT provider FROM agent_messages
            WHERE tenant_id = $1 AND provider > p.provider AND provider IS NOT NULL AND provider <> ''
            ORDER BY provider LIMIT 1)
  FROM p WHERE p.provider IS NOT NULL
)
SELECT provider FROM p WHERE provider IS NOT NULL`;

/**
 * Bound a correlated Provider Attempt lookup to the tenant and time window its
 * parent Request already sits in.
 *
 * An attempt always carries its parent's tenant and never starts before its
 * parent: the Request row takes the first attempt's start time, and the request
 * backfill keeps the earliest attempt's time. So for any Request in range these
 * predicates are always true, and the lookup returns the same rows. They exist
 * for the planner: without them Postgres probes `agent_messages` by request_id
 * once per parent row (about 135k pages for a 23k-request week, tens of seconds
 * cold); with them it reads the tenant's attempts in range once through a
 * (tenant_id, timestamp) index and hash-joins them. The day of slack absorbs
 * clock ordering between rows written by different hops.
 *
 * `tenantParam` and `cutoffParam` name parameters the caller already binds.
 */
function attemptWindow(alias: string, tenantParam: string, cutoffParam?: string): string {
  const tenant = `${alias}.tenant_id = :${tenantParam}`;
  if (!cutoffParam) return tenant;
  return `${tenant} AND ${alias}.timestamp >= CAST(:${cutoffParam} AS timestamp) - interval '1 day'`;
}

interface MessageFilterParams {
  range?: string;
  tenantId: string | null;
  agent_name?: string;
}

interface MessageQueryParams extends MessageFilterParams {
  provider?: string;
  /** tenant_providers ids; requests must have touched one of these connections. */
  connections?: string[];
  /**
   * Model names, OR'd together. Matches any attempt's model — the same "any
   * attempt" rule the provider filter uses — or, for a request that never
   * reached a provider, its `requested_model`.
   */
  models?: string[];
  service_type?: string;
  cost_min?: number;
  cost_max?: number;
  limit: number;
  cursor?: string;
  status?: MessageStatusFilter;
  /** AND facet: the request must hold at least one attempt of each kind. */
  attemptStatus?: ('has_failed' | 'has_succeeded')[];
  triggers?: MessageTriggerFilter[];
  origin?: MessageOriginFilter;
  error_class?: string;
  routing_tier?: string;
  specificity_category?: string;
  header_tier_id?: string;
  include_total?: boolean;
  /** Allow a recent exact total to be reused instead of forcing a fresh first-page count. */
  cache_total?: boolean;
  include_filter_options?: boolean;
  exclude_playground?: boolean;
  /**
   * Drop requests whose model the caller pinned in the request body, so the
   * agent's routing never chose it (`routing_reason='direct'` on the attempt).
   * Opt-in and used ONLY by the harness Overview's Recent Messages panel — the
   * Requests log itself must keep showing them, which is where they are
   * accounted for. See `sqlExcludeDirectRequests` in query-helpers.
   */
  exclude_direct?: boolean;
}

interface ConnectionIdentity {
  id: string;
  provider: string;
  authType: string;
  label: string;
}

/**
 * One connection's attempt predicate, with the SAME legacy folds as the
 * dashboard's connection scoping (attempt-stats.service): a NULL auth_type
 * reads as 'api_key', and an orphan attempt (NULL tenant_provider_id) belongs
 * to the connection whose label folds to its own (NULL label = 'Default').
 */
function connectionAttemptPredicate(
  alias: string,
  conn: ConnectionIdentity,
  index: number,
  parameters: Record<string, unknown>,
): string {
  const p = `connProvider${index}`;
  const a = `connAuthType${index}`;
  const id = `connId${index}`;
  const l = `connLabel${index}`;
  parameters[p] = conn.provider;
  parameters[a] = conn.authType;
  parameters[id] = conn.id;
  parameters[l] = conn.label;
  const authFold =
    conn.authType === 'api_key'
      ? `(${alias}.auth_type = :${a} OR ${alias}.auth_type IS NULL)`
      : `${alias}.auth_type = :${a}`;
  return (
    `(${alias}.provider = :${p} AND ${authFold} AND ` +
    `(${alias}.tenant_provider_id = :${id} OR (${alias}.tenant_provider_id IS NULL ` +
    `AND LOWER(COALESCE(${alias}.provider_key_label, 'Default')) = LOWER(:${l}))))`
  );
}

/** A custom (header) tier as the Requests Tier filter offers it. */
export interface HeaderTierFilterOption {
  name: string;
  /** Every tier id the option covers — same name on several harnesses. */
  ids: string[];
}

/**
 * One Tier-filter option can cover the same custom tier defined on several
 * harnesses, so `header_tier_id` accepts a comma-separated list of ids. A
 * single id (what older clients send) parses to a one-element list.
 */
function parseHeaderTierIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

/** Filter metadata for a caller that opted out of computing it. */
function emptyFilterOptions(): {
  providers: string[];
  provider_labels: Record<string, string>;
  header_tiers: HeaderTierFilterOption[];
  models: string[];
} {
  return { providers: [], provider_labels: {}, header_tiers: [], models: [] };
}

@Injectable()
export class MessagesQueryService {
  private readonly modelsCache = new TtlCache<string, { models: string[]; providers: string[] }>({
    maxSize: MAX_CACHE_ENTRIES,
    ttlMs: MODELS_CACHE_TTL_MS,
  });
  private readonly attemptlessModelsCache = new TtlCache<string, string[]>({
    maxSize: MAX_CACHE_ENTRIES,
    ttlMs: MODELS_CACHE_TTL_MS,
  });
  private readonly countCache = new TtlCache<string, number>({
    maxSize: MAX_CACHE_ENTRIES,
    ttlMs: COUNT_CACHE_TTL_MS,
  });

  constructor(
    @InjectRepository(AgentMessage)
    private readonly turnRepo: Repository<AgentMessage>,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    @Optional()
    @InjectRepository(ManifestRequest)
    private readonly requestRepo?: Repository<ManifestRequest>,
    @Optional()
    @InjectRepository(TenantProvider)
    private readonly tenantProviderRepo?: Repository<TenantProvider>,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
    @Optional()
    @InjectRepository(HeaderTier)
    private readonly headerTierRepo?: Repository<HeaderTier>,
  ) {}

  async getMessages(params: MessageQueryParams) {
    if (this.requestRepo) return this.getRequests(params);
    const baseQb = await this.buildBaseMessageQuery(params);

    const includeTotal = params.include_total !== false;
    const includeFilterOptions = params.include_filter_options !== false;
    const countCacheKey = this.buildCountCacheKey(params);
    const countQb = baseQb.clone().select('COUNT(*)', 'total');

    const costExpr = sqlCastFloat(sqlSanitizeCost('at.cost_usd'));
    const dataQb = selectMessageRowColumns(baseQb.clone(), costExpr)
      .addSelect('at.description', 'description')
      .addSelect('at.service_type', 'service_type')
      .addSelect('at.cache_read_tokens', 'cache_read_tokens')
      .addSelect('at.cache_creation_tokens', 'cache_creation_tokens')
      .addSelect('at.duration_ms', 'duration_ms')
      .addSelect('at.error_http_status', 'error_http_status');

    this.applyCursor(dataQb, params.cursor);

    // Only reuse a cached count on paginated (cursor) requests; the first page
    // always runs a fresh count so the total stays current for clients that poll
    // it (a stale first-page total would lag newly recorded messages by the TTL).
    const cachedCount =
      includeTotal && (params.cursor || params.cache_total)
        ? this.countCache.get(countCacheKey)
        : undefined;
    const countHit = cachedCount !== undefined;
    const [countResult, rows, filterOptions] = await Promise.all([
      includeTotal ? (countHit ? null : countQb.getRawOne()) : null,
      dataQb
        .orderBy('at.timestamp', 'DESC')
        .addOrderBy('at.id', 'DESC')
        .limit(params.limit + 1)
        .getRawMany(),
      includeFilterOptions
        ? this.getMessageFilterOptions(params)
        : Promise.resolve(emptyFilterOptions()),
    ]);

    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    let totalCount: number;
    if (!includeTotal) {
      totalCount = items.length;
      if (hasMore) totalCount += 1;
    } else if (cachedCount !== undefined) {
      totalCount = cachedCount;
    } else {
      totalCount = this.cacheAndReturnCount(countCacheKey, Number(countResult?.total ?? 0));
    }
    const lastItem = items[items.length - 1] as Record<string, unknown> | undefined;
    const nextCursor = hasMore && lastItem ? this.encodeCursor(lastItem) : null;

    return {
      items,
      next_cursor: nextCursor,
      total_count: totalCount,
      total_count_exact: includeTotal,
      providers: filterOptions.providers,
      provider_labels: filterOptions.provider_labels,
      header_tiers: filterOptions.header_tiers,
      models: filterOptions.models,
    };
  }

  /** Request-first log. Attempts are aggregated into their parent row. */
  private async getRequests(params: MessageQueryParams) {
    const qb = this.requestRepo!.createQueryBuilder('r');
    const cutoff = params.range ? computeCutoff(rangeToInterval(params.range)) : undefined;
    if (cutoff) qb.where('r.timestamp >= :requestCutoff', { requestCutoff: cutoff });
    if (params.tenantId)
      qb.andWhere('r.tenant_id = :requestTenantId', { requestTenantId: params.tenantId });
    // Still bound without a tenant: the agent and attempt-window subqueries
    // reference it, and `1 = 0` already empties the result.
    else qb.andWhere('1 = 0', { requestTenantId: null });
    if (params.agent_name && params.tenantId) {
      const agentId = await this.resolveLiveAgentId(params.tenantId, params.agent_name);
      if (agentId) qb.andWhere('r.agent_id = :requestAgentId', { requestAgentId: agentId });
      else qb.andWhere('1 = 0');
    }
    // Only meaningful with a tenant: without one the query is already `1 = 0`.
    const window = (alias: string): string =>
      attemptWindow(alias, 'requestTenantId', cutoff ? 'requestCutoff' : undefined);
    if (params.exclude_playground) {
      qb.andWhere(sqlExcludePlayground('r'));
    }
    if (params.exclude_direct) {
      qb.andWhere(sqlExcludeDirectRequests('r'));
    }
    if (params.status === 'failed' || params.status === 'errors') {
      // "Not a success" across both vocabularies: a normalized `success` row must
      // never leak into the failed filter just because it is not literally `ok`.
      // `cancelled` and `pending` are excluded on purpose — a hung-up caller and
      // an in-flight request are not failures, which is the same line
      // `sqlIsFailedStatus` draws. `cancelled` has its own filter value.
      qb.andWhere(sqlIsFailedStatus('r.status'));
    } else if (params.status === 'ok' || params.status === 'success') {
      qb.andWhere(`r.status IN (${SUCCESS_STATUS_SQL_LIST})`);
    } else if (params.status) {
      qb.andWhere('r.status = :requestStatus', { requestStatus: params.status });
    }
    if (params.origin === 'manifest') {
      qb.andWhere(`r.error_origin IN ('config', 'policy', 'internal', 'request')`);
    } else if (params.origin) {
      qb.andWhere('r.error_origin = :requestOrigin', { requestOrigin: params.origin });
    }
    if (params.error_class) {
      qb.andWhere('r.error_class = :requestErrorClass', {
        requestErrorClass: params.error_class,
      });
    }
    if (params.models?.length) {
      // Kept outside `attemptPredicates` on purpose: those AND together on ONE
      // attempt row, while a model match is about the request as a whole. The
      // requested_model arm catches Manifest-blocked requests, which carry no
      // attempt but still render a model in the log.
      qb.andWhere(
        `(EXISTS (
            SELECT 1 FROM agent_messages model_attempt
            WHERE model_attempt.request_id = r.id AND ${window('model_attempt')}
              AND model_attempt.model IN (:...requestModels)
          )
          OR (
            r.requested_model IN (:...requestModels)
            AND NOT EXISTS (
              SELECT 1 FROM agent_messages any_attempt
              WHERE any_attempt.request_id = r.id AND ${window('any_attempt')}
            )
          ))`,
        { requestModels: params.models },
      );
    }
    const attemptPredicates: string[] = [];
    const attemptParameters: Record<string, unknown> = {};
    const matchingAttempt = (predicates: string[]): string => `EXISTS (
      SELECT 1 FROM agent_messages filtered_attempt
      WHERE filtered_attempt.request_id = r.id AND ${window('filtered_attempt')}
        AND ${predicates.join(' AND ')}
    )`;
    if (params.provider) {
      attemptPredicates.push('filtered_attempt.provider = :requestProvider');
      attemptParameters['requestProvider'] = params.provider;
    }
    const resolvedConnections = params.connections?.length
      ? await this.resolveConnections(params.tenantId, params.connections)
      : null;
    if (resolvedConnections) {
      // No resolvable connection: the filter names nothing this tenant owns.
      if (resolvedConnections.length === 0) qb.andWhere('1 = 0');
      else {
        const parts = resolvedConnections.map((c, i) =>
          connectionAttemptPredicate('filtered_attempt', c, i, attemptParameters),
        );
        attemptPredicates.push(`(${parts.join(' OR ')})`);
      }
    }
    if (params.service_type) {
      attemptPredicates.push('filtered_attempt.service_type = :requestServiceType');
      attemptParameters['requestServiceType'] = params.service_type;
    }
    if (params.routing_tier) {
      attemptPredicates.push('filtered_attempt.routing_tier = :requestTier');
      attemptParameters['requestTier'] = params.routing_tier;
    }
    if (params.specificity_category) {
      attemptPredicates.push('filtered_attempt.specificity_category = :requestSpecificity');
      attemptParameters['requestSpecificity'] = params.specificity_category;
    }
    const requestHeaderTierIds = params.header_tier_id
      ? parseHeaderTierIds(params.header_tier_id)
      : [];
    if (requestHeaderTierIds.length) {
      attemptPredicates.push('filtered_attempt.header_tier_id IN (:...requestHeaderTiers)');
      attemptParameters['requestHeaderTiers'] = requestHeaderTierIds;
    }
    if (params.triggers?.length) {
      // Several recovery-attempt kinds OR together (a multiselect facet). When
      // a connections filter is active, the recovery attempt must be ON one of
      // the selected connections, so a connection card's "fallback retries"
      // link lands on exactly the requests it counted.
      const triggerParameters: Record<string, unknown> = {};
      const connScope = resolvedConnections?.length
        ? ' AND (' +
          resolvedConnections
            .map((c, i) =>
              connectionAttemptPredicate(
                'trigger_attempt',
                c,
                i + resolvedConnections.length,
                triggerParameters,
              ),
            )
            .join(' OR ') +
          ')'
        : '';
      const triggerExists = (condition: string): string => `EXISTS (
        SELECT 1 FROM agent_messages trigger_attempt
        WHERE trigger_attempt.request_id = r.id AND ${window('trigger_attempt')}
          AND ${condition}${connScope}
      )`;
      const parts = params.triggers.map((trigger) => {
        if (trigger === 'autofix') return triggerExists('trigger_attempt.autofix_applied = true');
        if (trigger === 'fallback')
          return triggerExists('trigger_attempt.fallback_from_model IS NOT NULL');
        // 'none': no recovery attempt anywhere on the request. Two anti-joins
        // rather than one over `autofix OR fallback`: each kind has its own
        // partial index, and the OR forced a heap read of every attempt in range.
        const noAttempt = (condition: string): string => `NOT EXISTS (
          SELECT 1 FROM agent_messages trigger_attempt
          WHERE trigger_attempt.request_id = r.id AND ${window('trigger_attempt')}
            AND ${condition}
        )`;
        return `(${noAttempt('trigger_attempt.autofix_applied = true')} AND ${noAttempt(
          'trigger_attempt.fallback_from_model IS NOT NULL',
        )})`;
      });
      qb.andWhere(`(${parts.join(' OR ')})`, triggerParameters);
    }
    if (params.attemptStatus?.length) {
      // Same succeeded/failed reading as the connection dashboards:
      // Both canonical and legacy outcomes are accepted during the transition.
      const outcomeParameters: Record<string, unknown> = {};
      const connScope = resolvedConnections?.length
        ? ' AND (' +
          resolvedConnections
            .map((c, i) =>
              connectionAttemptPredicate(
                'outcome_attempt',
                c,
                i + 2 * resolvedConnections.length,
                outcomeParameters,
              ),
            )
            .join(' OR ') +
          ')'
        : '';
      for (const kind of params.attemptStatus) {
        const condition =
          kind === 'has_succeeded'
            ? sqlIsSuccessStatus('outcome_attempt.status')
            : sqlIsFailedStatus('outcome_attempt.status');
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM agent_messages outcome_attempt
            WHERE outcome_attempt.request_id = r.id AND ${window('outcome_attempt')}
              AND ${condition}${connScope}
          )`,
          outcomeParameters,
        );
      }
    }
    if (attemptPredicates.length > 0) {
      qb.andWhere(matchingAttempt(attemptPredicates), attemptParameters);
    }
    const includeTotal = params.include_total !== false;
    const countCacheKey = this.buildCountCacheKey(params);
    const cachedCount =
      includeTotal && (params.cursor || params.cache_total)
        ? this.countCache.get(countCacheKey)
        : undefined;
    const needsCount = includeTotal && cachedCount === undefined;
    const canPageFirst = params.cost_min === undefined && params.cost_max === undefined;
    let requestCountQuery: { sql: string; parameters: unknown[] } | null = null;

    // Without cost HAVING, the exact total is a direct count of eligible parent
    // requests. Do not clone the display query: joining every Provider Attempt
    // before COUNT made the common unfiltered first page scan the full history.
    if (needsCount && canPageFirst) {
      const countSource = qb.clone().select('COUNT(*)', 'total').orderBy();
      const [countSql, countParameters] = countSource.getQueryAndParameters();
      requestCountQuery = {
        sql: countSql,
        parameters: countParameters,
      };
    }

    if (params.cursor) {
      const sep = params.cursor.indexOf('|');
      if (sep !== -1) {
        const cursorTs = params.cursor.slice(0, sep);
        const cursorId = params.cursor.slice(sep + 1);
        qb.andWhere(
          new Brackets((sub) => {
            sub.where('r.timestamp < :requestCursorTs', { requestCursorTs: cursorTs }).orWhere(
              new Brackets((inner) => {
                inner
                  .where('r.timestamp = :requestCursorTsEqual', {
                    requestCursorTsEqual: cursorTs,
                  })
                  .andWhere('r.id < :requestCursorId', { requestCursorId: cursorId });
              }),
            );
          }),
        );
      }
    }

    if (canPageFirst) {
      // Select the 51 parent ids first, then aggregate attempts only for that
      // small page. The outer WHERE intentionally replaces the duplicated
      // filters: they remain inside the bounded keyset subquery.
      const pageSource = qb
        .clone()
        .select('r.id', 'id')
        .orderBy('r.timestamp', 'DESC')
        .addOrderBy('r.id', 'DESC')
        .limit(params.limit + 1);
      qb.where(`r.id IN (${pageSource.getQuery()})`, pageSource.getParameters());
    }

    qb.leftJoin(AgentMessage, 'at', 'at.request_id = r.id');
    const rank = `CASE WHEN ${sqlIsSuccessStatus('at.status')} THEN 3 WHEN NOT COALESCE(at.superseded, false) AND at.status NOT IN ('fallback_error', 'auto_fixed') THEN 2 ELSE 1 END`;
    const picked = (column: string): string =>
      `(ARRAY_AGG(${column} ORDER BY at.attempt_number DESC NULLS LAST, ${rank} DESC, at.timestamp DESC, at.id DESC) FILTER (WHERE at.id IS NOT NULL))[1]`;
    const safeCost = sqlSanitizeCost('at.cost_usd');
    qb.leftJoin(CustomProvider, 'cp', CUSTOM_PROVIDER_JOIN_CONDITION)
      .select('r.id', 'id')
      .addSelect('r.timestamp', 'timestamp')
      .addSelect('r.agent_name', 'agent_name')
      .addSelect(`COALESCE(${picked('at.model')}, r.requested_model)`, 'model')
      .addSelect(picked('at.provider'), 'provider')
      .addSelect(`COALESCE(${picked('at.model')}, r.requested_model)`, 'display_name')
      .addSelect('COALESCE(SUM(at.input_tokens), 0)', 'input_tokens')
      .addSelect('COALESCE(SUM(at.output_tokens), 0)', 'output_tokens')
      .addSelect('COALESCE(SUM(at.input_tokens + at.output_tokens), 0)', 'total_tokens')
      .addSelect(`COALESCE(SUM(${safeCost}), 0)`, 'cost')
      .addSelect('r.status', 'status')
      .addSelect('r.api_mode', 'api_mode')
      .addSelect('r.error_message', 'error_message')
      .addSelect('r.error_code', 'error_code')
      .addSelect('r.error_origin', 'error_origin')
      .addSelect('r.error_class', 'error_class')
      .addSelect('r.error_http_status', 'error_http_status')
      // Latency, like tokens and cost, is attempt-derived. The parent value is
      // only needed for zero-attempt rejections.
      .addSelect('COALESCE(SUM(at.duration_ms), r.duration_ms)::int', 'duration_ms')
      .addSelect(picked('at.routing_tier'), 'routing_tier')
      .addSelect(picked('at.routing_reason'), 'routing_reason')
      .addSelect(picked('at.specificity_category'), 'specificity_category')
      .addSelect(picked('at.auth_type'), 'auth_type')
      .addSelect(picked('at.fallback_from_model'), 'fallback_from_model')
      .addSelect(picked('at.fallback_index'), 'fallback_index')
      .addSelect('r.feedback_rating', 'feedback_rating')
      .addSelect(picked('at.header_tier_id'), 'header_tier_id')
      .addSelect(picked('at.header_tier_name'), 'header_tier_name')
      .addSelect(picked('at.header_tier_color'), 'header_tier_color')
      .addSelect(picked('at.provider_key_label'), 'provider_key_label')
      .addSelect(picked('cp.name'), 'custom_provider_name')
      .addSelect('COALESCE(BOOL_OR(at.autofix_applied), false)', 'autofix_applied')
      .addSelect(
        `CASE WHEN COALESCE(BOOL_OR(at.autofix_applied), false) THEN 'retry' ELSE NULL END`,
        'autofix_role',
      )
      .addSelect('COALESCE(SUM(at.cache_read_tokens), 0)', 'cache_read_tokens')
      .addSelect('COALESCE(SUM(at.cache_creation_tokens), 0)', 'cache_creation_tokens')
      .addSelect('COUNT(at.id)::int', 'attempt_count')
      .groupBy('r.id');
    if (params.cost_min !== undefined) {
      qb.having(`COALESCE(SUM(${safeCost}), 0) >= :requestCostMin`, {
        requestCostMin: params.cost_min,
      });
    }
    if (params.cost_max !== undefined) {
      qb.andHaving(`COALESCE(SUM(${safeCost}), 0) <= :requestCostMax`, {
        requestCostMax: params.cost_max,
      });
    }

    // Count the grouped request rows after cost HAVING has been applied. A
    // window count on the page query would disappear on an empty page, making
    // an exact non-zero total look like zero after the last cursor.
    if (needsCount && !canPageFirst) {
      const countSource = qb.clone().select('r.id', 'id').orderBy();
      const [countSql, countParameters] = countSource.getQueryAndParameters();
      requestCountQuery = {
        sql: `SELECT COUNT(*) AS total FROM (${countSql}) "filtered_requests"`,
        parameters: countParameters,
      };
    }

    // Keep the log complete while the online backfill is running. Each still-
    // unlinked attempt is temporarily its own synthetic request; it disappears
    // from this branch as soon as the backfill links it to a real parent.
    const legacyBase = await this.buildBaseMessageQuery(params);
    legacyBase.andWhere('at.request_id IS NULL');
    if (resolvedConnections) {
      if (resolvedConnections.length === 0) legacyBase.andWhere('1 = 0');
      else {
        const legacyParams: Record<string, unknown> = {};
        const parts = resolvedConnections.map((c, i) =>
          connectionAttemptPredicate('at', c, i, legacyParams),
        );
        legacyBase.andWhere(`(${parts.join(' OR ')})`, legacyParams);
      }
    }
    if (params.exclude_playground) excludePlaygroundAgents(legacyBase);
    // An unlinked attempt is its own synthetic request here, so `direct` is read
    // off the attempt row itself rather than through NOT EXISTS on a parent.
    if (params.exclude_direct) excludeDirectAttempts(legacyBase);
    const legacyCountQb = legacyBase.clone().select('COUNT(*)', 'total');
    const legacyDataQb = selectMessageRowColumns(
      legacyBase.clone(),
      sqlCastFloat(sqlSanitizeCost('at.cost_usd')),
    )
      .addSelect('at.description', 'description')
      .addSelect('at.service_type', 'service_type')
      .addSelect('at.cache_read_tokens', 'cache_read_tokens')
      .addSelect('at.cache_creation_tokens', 'cache_creation_tokens')
      .addSelect('at.duration_ms', 'duration_ms')
      .addSelect('NULL', 'api_mode')
      .addSelect('1', 'attempt_count');
    this.applyCursor(legacyDataQb, params.cursor);

    const readRows = async (runner?: QueryRunner) => {
      if (runner) {
        qb.setQueryRunner(runner);
        legacyCountQb.setQueryRunner(runner);
        legacyDataQb.setQueryRunner(runner);
      }
      const requestCountPromise = requestCountQuery
        ? ((runner
            ? runner.query(requestCountQuery.sql, requestCountQuery.parameters)
            : this.requestRepo!.query(
                requestCountQuery.sql,
                requestCountQuery.parameters,
              )) as Promise<Array<{ total: string }>>)
        : Promise.resolve([] as Array<{ total: string }>);
      // QueryRunner owns one pg client. Await each statement rather than
      // issuing concurrent client.query calls (deprecated in pg); all four
      // statements still share this transaction snapshot.
      const requestCountRows = await requestCountPromise;
      const legacyCount = needsCount ? await legacyCountQb.getRawOne() : null;
      const requestRows = await qb
        .orderBy('r.timestamp', 'DESC')
        .addOrderBy('r.id', 'DESC')
        .limit(params.limit + 1)
        .getRawMany();
      const legacyRows = await legacyDataQb
        .orderBy('at.timestamp', 'DESC')
        .addOrderBy('at.id', 'DESC')
        .limit(params.limit + 1)
        .getRawMany();
      return [requestCountRows, legacyCount, requestRows, legacyRows] as const;
    };
    const [[requestCountRows, legacyCount, requestRows, legacyRows], filterOptions] =
      await Promise.all([
        this.withCompatibilitySnapshot(readRows),
        params.include_filter_options !== false
          ? this.getMessageFilterOptions(params)
          : Promise.resolve(emptyFilterOptions()),
      ]);
    const rows = [...requestRows, ...legacyRows].sort((a, b) => {
      const byTime = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      return byTime || String(b.id).localeCompare(String(a.id));
    });
    const hasMore = rows.length > params.limit;
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1] as Record<string, unknown> | undefined;
    return {
      items,
      next_cursor: hasMore && last ? this.encodeCursor(last) : null,
      total_count: includeTotal
        ? (cachedCount ??
          this.cacheAndReturnCount(
            countCacheKey,
            Number(requestCountRows[0]?.total ?? 0) + Number(legacyCount?.total ?? 0),
          ))
        : items.length + (hasMore ? 1 : 0),
      total_count_exact: includeTotal,
      providers: filterOptions.providers,
      provider_labels: filterOptions.provider_labels,
      header_tiers: filterOptions.header_tiers,
      models: filterOptions.models,
    };
  }

  /**
   * The live harness id for a name, or null when none is live.
   *
   * Resolved before the Requests queries are built so Postgres plans them with
   * the actual value. Written as `agent_id = (SELECT id FROM agents ...)`, the
   * lookup is an InitPlan whose result the planner cannot see: it guesses a
   * handful of rows even for a harness that owns most of its tenant's traffic,
   * then probes attempts once per request (117k pages for a 23k-request week,
   * against 950 with the value). Correlating it on `r.tenant_id` was worse
   * still, a per-row SubPlan that kept `agent_id` out of the index condition.
   *
   * The unique live-name index on `agents` makes this the same single row the
   * subquery returned.
   */
  private async resolveLiveAgentId(tenantId: string, agentName: string): Promise<string | null> {
    const rows = (await this.requestRepo!.query(
      'SELECT id FROM agents WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1',
      [tenantId, agentName],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }

  /** Resolve connection ids to their identity triple, tenant-scoped. */
  private async resolveConnections(
    tenantId: string | null,
    ids: string[],
  ): Promise<ConnectionIdentity[]> {
    if (!tenantId || ids.length === 0 || !this.tenantProviderRepo) return [];
    const rows = await this.tenantProviderRepo.find({
      where: { tenant_id: tenantId, id: In(ids) },
      select: ['id', 'provider', 'auth_type', 'label'],
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      authType: r.auth_type,
      label: r.label ?? 'Default',
    }));
  }

  /**
   * The request backfill inserts a parent and links its attempts atomically, but
   * request and unlinked compatibility branches are separate SELECTs. Pin them
   * to one repeatable-read transaction so a row cannot disappear from one
   * branch before becoming visible in the other (or appear in both).
   *
   * A transaction works through Railway's transaction-mode PgBouncer: PgBouncer
   * keeps one server connection for BEGIN→COMMIT. Unlike the backfill itself,
   * this read path does not depend on session locks or temporary tables.
   */
  private async withCompatibilitySnapshot<T>(
    read: (runner?: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const dataSource = this.dataSource ?? this.turnRepo.manager?.connection;
    if (!dataSource) return read();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('REPEATABLE READ');
      try {
        await runner.query('SET TRANSACTION READ ONLY');
        const result = await read(runner);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    } finally {
      await runner.release();
    }
  }

  async getMessageFilterOptions(params: MessageFilterParams): Promise<{
    providers: string[];
    provider_labels: Record<string, string>;
    header_tiers: HeaderTierFilterOption[];
    models: string[];
  }> {
    const [distinctRows, headerTiers] = await Promise.all([
      this.getDistinctModels(params.tenantId, params.range, params.agent_name),
      this.getHeaderTierOptions(params.tenantId, params.agent_name),
    ]);
    const providers = this.deriveProviders(distinctRows.models, distinctRows.providers);
    const providerLabels = await this.resolveCustomProviderLabels(providers, params.tenantId);
    // The distinct-model scan already ran to derive providers, so the Model
    // filter reuses it. It only sees `agent_messages`, though: a request Manifest
    // blocked before any provider call has no attempt, and the log renders its
    // `requested_model` in the Model column. Those models must be selectable too,
    // or the column shows a value the dropdown cannot offer.
    const blockedModels = await this.getAttemptlessRequestedModels(params);
    const models = [...new Set([...distinctRows.models, ...blockedModels])].sort();
    return {
      providers,
      provider_labels: providerLabels,
      header_tiers: headerTiers,
      models,
    };
  }

  /**
   * Custom (header) tiers the Tier filter can offer. The Requests log spans the
   * whole tenant unless a harness is picked, so with no `agent_name` this lists
   * every harness's tiers — otherwise the filter would be empty exactly where
   * the log shows every harness's requests. Same-named tiers on different
   * harnesses collapse into one option carrying all their ids, because there
   * "Premium" can only mean "any harness's Premium tier".
   *
   * Disabled tiers stay listed: requests routed through them before they were
   * turned off are still in the log.
   */
  private async getHeaderTierOptions(
    tenantId: string | null,
    agentName?: string,
  ): Promise<HeaderTierFilterOption[]> {
    if (!tenantId || !this.headerTierRepo) return [];
    const qb = this.headerTierRepo
      .createQueryBuilder('ht')
      .select('ht.id', 'id')
      .addSelect('ht.name', 'name')
      .where('ht.tenant_id = :headerTierTenant', { headerTierTenant: tenantId })
      .orderBy('LOWER(ht.name)', 'ASC');
    if (agentName) {
      qb.andWhere(
        `ht.agent_id = (
          SELECT id FROM agents
          WHERE tenant_id = :headerTierTenant AND name = :headerTierAgent AND deleted_at IS NULL
          LIMIT 1
        )`,
        { headerTierAgent: agentName },
      );
    }
    const rows = await qb.getRawMany<{ id: string; name: string }>();
    const byName = new Map<string, HeaderTierFilterOption>();
    for (const row of rows) {
      const existing = byName.get(row.name.toLowerCase());
      if (existing) existing.ids.push(row.id);
      else byName.set(row.name.toLowerCase(), { name: row.name, ids: [row.id] });
    }
    return [...byName.values()];
  }

  /**
   * Map `custom:<uuid>` provider ids to their display names so the Messages
   * filter dropdown can label them. Deleted providers simply have no entry
   * and fall back to the raw id in the UI.
   */
  private async resolveCustomProviderLabels(
    providers: string[],
    tenantId: string | null,
  ): Promise<Record<string, string>> {
    const uuids = providers
      .filter((p) => p.startsWith('custom:'))
      .map((p) => p.slice('custom:'.length));
    if (uuids.length === 0 || !tenantId) return {};
    // Scope to the caller's tenant so a custom-provider display name can never
    // resolve across tenants, regardless of how the provider ids were sourced.
    const rows = await this.customProviderRepo.find({
      where: { id: In(uuids), tenant_id: tenantId },
    });
    return Object.fromEntries(rows.map((cp) => [`custom:${cp.id}`, cp.name]));
  }

  private async buildBaseMessageQuery(params: {
    range?: string;
    tenantId: string | null;
    provider?: string;
    models?: string[];
    service_type?: string;
    cost_min?: number;
    cost_max?: number;
    agent_name?: string;
    status?: MessageStatusFilter;
    triggers?: MessageTriggerFilter[];
    origin?: MessageOriginFilter;
    error_class?: string;
    routing_tier?: string;
    specificity_category?: string;
    header_tier_id?: string;
  }): Promise<SelectQueryBuilder<AgentMessage>> {
    const cutoff = params.range ? computeCutoff(rangeToInterval(params.range)) : undefined;
    const qb = this.turnRepo.createQueryBuilder('at');
    if (cutoff) qb.where('at.timestamp >= :cutoff', { cutoff });

    addTenantFilter(qb, params.tenantId);

    if (params.models?.length)
      qb.andWhere('at.model IN (:...legacyModels)', { legacyModels: params.models });
    if (params.service_type)
      qb.andWhere('at.service_type = :serviceType', { serviceType: params.service_type });
    if (params.cost_min !== undefined)
      qb.andWhere('at.cost_usd >= :costMin', { costMin: params.cost_min });
    if (params.cost_max !== undefined)
      qb.andWhere('at.cost_usd <= :costMax', { costMax: params.cost_max });
    if (params.agent_name && params.tenantId) {
      filterByLiveAgentName(qb, params.agent_name, params.tenantId);
    }

    if (params.status === 'failed') {
      qb.andWhere('at.status IN (:...failedStatuses)', { failedStatuses: FAILED_STATUSES });
    } else if (params.status === 'errors') {
      qb.andWhere('at.status IN (:...errorStatuses)', { errorStatuses: ERROR_STATUSES });
    } else if (params.status === 'ok' || params.status === 'success') {
      qb.andWhere(sqlIsSuccessStatus('at.status'));
    } else if (params.status) {
      qb.andWhere('at.status = :statusFilter', { statusFilter: params.status });
    }

    this.applyTriggerFilter(qb, params.triggers);

    // Error-origin scope. Nothing is hidden by default: the log is the complete
    // event listing, and a Manifest setup error is exactly the row a user needs
    // to see to fix their setup. `manifest` is a shorthand for every
    // Manifest-authored origin at once.
    if (params.origin === 'manifest') {
      qb.andWhere(MANIFEST_ORIGIN_PREDICATE);
    } else if (params.origin) {
      qb.andWhere('at.error_origin = :originFilter', { originFilter: params.origin });
    }

    if (params.error_class) {
      qb.andWhere('at.error_class = :errorClassFilter', { errorClassFilter: params.error_class });
    }

    if (params.routing_tier) {
      qb.andWhere('at.routing_tier = :tierFilter', { tierFilter: params.routing_tier });
    }

    if (params.specificity_category) {
      qb.andWhere('at.specificity_category = :specificityFilter', {
        specificityFilter: params.specificity_category,
      });
    }

    const headerTierIds = params.header_tier_id ? parseHeaderTierIds(params.header_tier_id) : [];
    if (headerTierIds.length) {
      qb.andWhere('at.header_tier_id IN (:...headerTierFilter)', {
        headerTierFilter: headerTierIds,
      });
    }

    if (params.provider) {
      await this.applyProviderFilter(qb, params.provider, {
        tenantId: params.tenantId,
        range: params.range,
        agentName: params.agent_name,
      });
    }

    return qb;
  }

  private applyTriggerFilter(
    qb: SelectQueryBuilder<AgentMessage>,
    triggers: MessageTriggerFilter[] | undefined,
  ): void {
    if (!triggers?.length) return;
    if (triggers.length > 1) {
      // Attempt-grain OR of the selected kinds.
      const conditions = triggers.map((t) => {
        if (t === 'autofix') return 'at.autofix_role = :triggerAutofixRole';
        if (t === 'fallback')
          return "(COALESCE(at.autofix_role, '') != :triggerAutofixRole AND at.fallback_from_model IS NOT NULL AND at.fallback_from_model != '')";
        return "(COALESCE(at.autofix_role, '') != :triggerAutofixRole AND (at.fallback_from_model IS NULL OR at.fallback_from_model = ''))";
      });
      qb.andWhere(`(${conditions.join(' OR ')})`, { triggerAutofixRole: AUTOFIX_TRIGGER_ROLE });
      return;
    }
    const trigger = triggers[0];

    if (trigger === 'autofix') {
      qb.andWhere('at.autofix_role = :triggerAutofixRole', {
        triggerAutofixRole: AUTOFIX_TRIGGER_ROLE,
      });
      return;
    }

    qb.andWhere('(at.autofix_role IS NULL OR at.autofix_role != :triggerAutofixRole)', {
      triggerAutofixRole: AUTOFIX_TRIGGER_ROLE,
    });

    if (trigger === 'fallback') {
      qb.andWhere("at.fallback_from_model IS NOT NULL AND at.fallback_from_model != ''");
    } else {
      qb.andWhere("(at.fallback_from_model IS NULL OR at.fallback_from_model = '')");
    }
  }

  private async applyProviderFilter(
    qb: SelectQueryBuilder<AgentMessage>,
    provider: string,
    ctx: { tenantId: string | null; range?: string; agentName?: string },
  ): Promise<void> {
    // Prefer the stored provider column (populated by the proxy from routing
    // resolution), and fall back to inference for legacy rows that pre-date
    // the column.
    const distinct = await this.getDistinctModels(ctx.tenantId, ctx.range, ctx.agentName);
    const matching = distinct.models.filter((m) => inferProviderFromModel(m) === provider);
    qb.andWhere(
      new Brackets((sub) => {
        sub.where('at.provider = :providerId', { providerId: provider });
        if (matching.length > 0) {
          sub.orWhere(
            new Brackets((inner) => {
              inner
                .where('at.provider IS NULL')
                .andWhere('at.model IN (:...providerModels)', { providerModels: matching });
            }),
          );
        }
      }),
    );
  }

  private applyCursor(qb: SelectQueryBuilder<AgentMessage>, cursor: string | undefined): void {
    if (!cursor) return;
    const sepIdx = cursor.indexOf('|');
    if (sepIdx === -1) return;
    const cursorTs = cursor.substring(0, sepIdx);
    const cursorId = cursor.substring(sepIdx + 1);
    qb.andWhere(
      new Brackets((sub) => {
        sub.where('at.timestamp < :cursorTs', { cursorTs }).orWhere(
          new Brackets((inner) => {
            inner
              .where('at.timestamp = :cursorTs2', { cursorTs2: cursorTs })
              .andWhere('at.id < :cursorId', { cursorId });
          }),
        );
      }),
    );
  }

  private encodeCursor(lastItem: Record<string, unknown>): string {
    const ts = lastItem['timestamp'];
    const tsStr = ts instanceof Date ? formatTimestamp(ts) : String(ts ?? '');
    return `${tsStr}|${String(lastItem['id'])}`;
  }

  private cacheAndReturnCount(key: string, value: number): number {
    this.countCache.set(key, value);
    return value;
  }

  /**
   * Derive sorted unique provider IDs. Combines:
   *   1. Providers explicitly stored on message rows (accurate, populated by
   *      the proxy from routing resolution).
   *   2. Providers inferred from the distinct model list for legacy rows
   *      that pre-date the stored column.
   */
  private deriveProviders(models: string[], storedProviders: string[]): string[] {
    const seen = new Set<string>();
    for (const p of storedProviders) {
      if (p) seen.add(p);
    }
    for (const m of models) {
      const p = inferProviderFromModel(m);
      if (p) seen.add(p);
    }
    return [...seen].sort();
  }

  /**
   * Models named only by requests that never reached a provider. Cached on the
   * same key shape and TTL as the distinct-model scan, so a tenant pays for it
   * once per window rather than on every log load.
   */
  private async getAttemptlessRequestedModels(params: MessageFilterParams): Promise<string[]> {
    // No tenant resolves to no rows, matching addTenantFilter's own contract.
    if (!this.requestRepo || params.tenantId === null) return [];
    const cacheKey = `blocked:${params.tenantId ?? 'no-tenant'}:${params.agent_name ?? ''}:${params.range ?? 'all'}`;
    const cached = this.attemptlessModelsCache.get(cacheKey);
    if (cached) return cached;

    const cutoff = params.range
      ? computeCutoff(rangeToInterval(params.range))
      : computeCutoff(DISTINCT_MODELS_DEFAULT_INTERVAL);
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .select('DISTINCT r.requested_model', 'model')
      .where('r.timestamp >= :cutoff', { cutoff })
      .andWhere("r.requested_model IS NOT NULL AND r.requested_model <> ''")
      // The attempt window turns a per-request probe (40 s cold on a 23k-request
      // week, for an answer that is almost always empty) into one hash anti-join.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM agent_messages blocked_attempt
          WHERE blocked_attempt.request_id = r.id
            AND ${attemptWindow('blocked_attempt', 'blockedTenantId', 'cutoff')}
        )`,
      )
      // Scoped on `r` by hand: addTenantFilter hardcodes the `at` alias of the
      // attempt-first queries and would emit SQL with no such FROM entry here.
      .andWhere('r.tenant_id = :blockedTenantId', { blockedTenantId: params.tenantId });
    if (params.agent_name) {
      const agentId = await this.resolveLiveAgentId(params.tenantId, params.agent_name);
      if (agentId) qb.andWhere('r.agent_id = :blockedAgentId', { blockedAgentId: agentId });
      else qb.andWhere('1 = 0');
    }
    const rows = (await qb.getRawMany()) as { model: string }[];
    const models = rows.map((row) => String(row.model)).filter(Boolean);
    this.attemptlessModelsCache.set(cacheKey, models);
    return models;
  }

  private async getDistinctModels(
    tenantId: string | null,
    range?: string,
    agentName?: string,
  ): Promise<{ models: string[]; providers: string[] }> {
    const cacheKey = `${tenantId ?? 'no-tenant'}:${agentName ?? ''}:${range ?? 'all'}`;
    const cached = this.modelsCache.get(cacheKey);
    if (cached) return cached;

    // Fast path: the tenant-global filter dropdown (no agent constraint, tenant
    // resolved). A recursive loose-index-scan jumps value-to-value through
    // IDX_agent_messages_tenant_model / IDX_agent_messages_tenant_provider_value
    // — roughly one index seek per distinct value, versus scanning and
    // disk-sorting the tenant's entire history (measured 2.2s -> ~10ms on a
    // 322k-row tenant). The window is intentionally all-time: cost is now bounded
    // by cardinality, and a rarely-used older model in the dropdown is harmless.
    // The per-agent / no-tenant cases stay on the bounded scan below — they touch
    // far fewer rows (or lack a supporting index for the skip scan).
    const result =
      tenantId && !agentName
        ? await this.getDistinctModelsViaSkipScan(tenantId)
        : await this.getDistinctModelsViaScan(tenantId, range, agentName);

    this.modelsCache.set(cacheKey, result);
    return result;
  }

  private async getDistinctModelsViaSkipScan(
    tenantId: string,
  ): Promise<{ models: string[]; providers: string[] }> {
    const [modelRows, providerRows] = (await Promise.all([
      this.turnRepo.query(DISTINCT_MODELS_SKIP_SCAN_SQL, [tenantId]),
      this.turnRepo.query(DISTINCT_PROVIDERS_SKIP_SCAN_SQL, [tenantId]),
    ])) as [{ model: string }[], { provider: string }[]];
    return {
      models: modelRows.map((r) => String(r.model)).filter((m) => m !== ''),
      providers: providerRows.map((r) => String(r.provider)).filter((p) => p !== ''),
    };
  }

  private async getDistinctModelsViaScan(
    tenantId: string | null,
    range: string | undefined,
    agentName: string | undefined,
  ): Promise<{ models: string[]; providers: string[] }> {
    // Bound the scan: when the caller doesn't constrain the range, default to
    // the last 90 days. The DISTINCT covers the entire agent_messages table
    // otherwise, which scales poorly as ingest grows.
    const cutoff = range
      ? computeCutoff(rangeToInterval(range))
      : computeCutoff(DISTINCT_MODELS_DEFAULT_INTERVAL);
    const modelsQb = this.turnRepo
      .createQueryBuilder('at')
      .select('at.model', 'model')
      .addSelect('at.provider', 'provider')
      .distinct(true)
      .where('at.model IS NOT NULL')
      .andWhere("at.model != ''")
      .andWhere('at.timestamp >= :cutoff', { cutoff });
    addTenantFilter(modelsQb, tenantId, agentName);
    const modelsResult = await modelsQb.orderBy('at.model', 'ASC').getRawMany();

    const modelSet = new Set<string>();
    const providerSet = new Set<string>();
    for (const row of modelsResult) {
      const modelValue = row['model'];
      if (modelValue != null && modelValue !== '') {
        modelSet.add(String(modelValue));
      }
      const providerValue = row['provider'];
      if (providerValue != null && providerValue !== '') {
        providerSet.add(String(providerValue));
      }
    }
    return { models: [...modelSet], providers: [...providerSet] };
  }

  private buildCountCacheKey(params: {
    tenantId: string | null;
    range?: string;
    provider?: string;
    connections?: string[];
    models?: string[];
    attemptStatus?: ('has_failed' | 'has_succeeded')[];
    service_type?: string;
    agent_name?: string;
    cost_min?: number;
    cost_max?: number;
    status?: MessageStatusFilter;
    triggers?: MessageTriggerFilter[];
    origin?: MessageOriginFilter;
    error_class?: string;
    routing_tier?: string;
    specificity_category?: string;
    header_tier_id?: string;
    exclude_playground?: boolean;
    exclude_direct?: boolean;
  }): string {
    return [
      params.tenantId ?? 'no-tenant',
      params.range ?? '',
      params.provider ?? '',
      params.connections?.join(',') ?? '',
      params.models?.join(',') ?? '',
      params.attemptStatus?.join(',') ?? '',
      params.service_type ?? '',
      params.agent_name ?? '',
      params.cost_min ?? '',
      params.cost_max ?? '',
      params.status ?? '',
      params.triggers?.join(',') ?? '',
      params.origin ?? '',
      params.error_class ?? '',
      params.routing_tier ?? '',
      params.specificity_category ?? '',
      params.header_tier_id ?? '',
      params.exclude_playground ? 'exclude-playground' : '',
      params.exclude_direct ? 'exclude-direct' : '',
    ].join(':');
  }
}
