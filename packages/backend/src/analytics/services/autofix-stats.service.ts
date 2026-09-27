import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ManifestRequest } from '../../entities/request.entity';
import { AutofixService } from '../../routing/autofix/autofix.service';
import { InstallMetadata } from '../../entities/install-metadata.entity';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { v4 as uuid } from 'uuid';
import {
  rangeToInterval,
  rangeToPreviousInterval,
  isHourlyRange,
} from '../../common/utils/range.util';
import { computeCutoff, sqlHourBucket, sqlDateBucket } from '../../common/utils/postgres-sql';
import {
  addTenantFilter,
  excludePlaygroundAgents,
  sqlIsCompletedStatus,
  sqlIsFailedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';
import { RequestVolumeService, type DispositionTotals } from './request-volume.service';

export interface AutofixStatusResponse {
  /** At least one agent is effectively enabled after deployment-mode defaults. */
  any_enabled: boolean;
  /** Names of agents effectively enabled after deployment-mode defaults. */
  enabled_agents: string[];
  /** Names of agents effectively disabled after deployment-mode defaults. */
  disabled_agents: string[];
  /** Legacy agents need the one-time fleet enable action. */
  needs_enable_all: boolean;
  /**
   * Self-hosted consent-once. Cloud always reports true (no gate). False only
   * when the install has never confirmed the enable modal.
   */
  consented: boolean;
}

export interface AutofixStatsResponse {
  success_rate: { value: number; previous: number };
  autofix_saves: { value: number; previous: number };
  /** Additive: requests recovered by a successful fallback attempt. */
  fallback_saves: { value: number; previous: number };
  /** Additive: window total, denominator for the self-healed share. */
  total_requests: { value: number; previous: number };
  errors_remaining: { value: number; previous: number };
  coverage: { rate: number; previous_rate: number };
  dispositions: {
    healed: number;
    no_fix_found: number;
    resolving: number;
    ineffective: number;
  };
  needs_attention: Array<{
    error_message: string;
    provider: string;
    model: string;
    count: number;
    phoenix_issue_id: string | null;
  }>;
}

export const AUTOFIX_TS_DIMENSIONS = [
  'disposition',
  'http_status',
  'provider',
  'error_kind',
  'autofix',
] as const;
export type AutofixTsDimension = (typeof AUTOFIX_TS_DIMENSIONS)[number];

export interface AutofixTimeseriesResponse {
  range: string;
  by: string;
  keys: string[];
  buckets: Array<{ bucket: string; counts: number[] }>;
}

interface WindowCounts {
  total: number;
  successes: number;
  saves: number;
  fallback_saves: number;
  errors: number;
  healed: number;
  no_fix_found: number;
  resolving: number;
  ineffective: number;
}

@Injectable()
export class AutofixStatsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    @InjectRepository(InstallMetadata)
    private readonly installMetadataRepo: Repository<InstallMetadata>,
    private readonly autofix: AutofixService,
    private readonly requestVolume: RequestVolumeService,
  ) {}

  async getWorkspaceStatus(tenantId: string | null): Promise<AutofixStatusResponse> {
    if (!tenantId) {
      return {
        any_enabled: false,
        enabled_agents: [],
        disabled_agents: [],
        needs_enable_all: false,
        consented: await this.hasConsent(),
      };
    }

    const agents = await this.agentRepo.find({
      where: { tenant_id: tenantId, deleted_at: IsNull(), is_playground: false },
      select: ['name', 'autofix_enabled'],
    });
    const enabledAgents: string[] = [];
    const disabledAgents: string[] = [];
    for (const agent of agents) {
      (this.autofix.resolveEnabled(agent.autofix_enabled) ? enabledAgents : disabledAgents).push(
        agent.name,
      );
    }

    const consented = await this.hasConsent();
    return {
      any_enabled: enabledAgents.length > 0,
      enabled_agents: enabledAgents,
      disabled_agents: disabledAgents,
      // The fleet CTA is a one-time onboarding nudge, so it takes all three
      // terms: nothing is enabled, the install has never consented, and some
      // agent never made an explicit choice.
      //
      // `autofix_enabled IS NULL` on its own is NOT a "row predates the
      // feature" marker — NULL is the deliberate "inherit the deployment-mode
      // default" state (see AutofixService.resolveEnabled, and migration
      // 1799000300000 which reset pre-feature rows *to* NULL for exactly that
      // reason). Only the create dialog sends an explicit choice; agents
      // onboarded over OTLP, or by API clients that omit the field, still
      // store NULL. Without the consent term those installs get re-prompted
      // after they have already decided.
      needs_enable_all:
        enabledAgents.length === 0 &&
        !consented &&
        agents.some((agent) => agent.autofix_enabled == null),
      consented,
    };
  }

  /**
   * Enable Autofix for every non-playground agent in the tenant and record
   * the install's once-consent. Used by the sidebar fleet CTA — not by the
   * per-agent toggle, which only ever touches one agent.
   */
  async enableAll(tenantId: string): Promise<AutofixStatusResponse> {
    // Match getWorkspaceStatus: only live, non-playground agents. Soft-deleted
    // rows must keep whatever they had — resurrecting them later shouldn't
    // surprise the operator with Autofix flipped on.
    await this.agentRepo.update(
      { tenant_id: tenantId, is_playground: false, deleted_at: IsNull() },
      { autofix_enabled: true },
    );
    await this.recordAutofixConsent();
    return this.getWorkspaceStatus(tenantId);
  }

  private async hasConsent(): Promise<boolean> {
    if (!isSelfHosted()) return true;
    const row = await this.installMetadataRepo.findOne({ where: { id: 'singleton' } });
    return row?.autofix_consented_at != null;
  }

  async recordAutofixConsent(): Promise<void> {
    if (!isSelfHosted()) return;
    if (await this.hasConsent()) return;
    await this.installMetadataRepo
      .createQueryBuilder()
      .insert()
      .into(InstallMetadata)
      .values({
        id: 'singleton',
        install_id: uuid(),
        autofix_consented_at: new Date().toISOString(),
      })
      .orUpdate(['autofix_consented_at'], ['id'])
      .execute();
  }

  async getStats(params: {
    tenantId: string | null;
    range?: string;
    agentName?: string;
  }): Promise<AutofixStatsResponse> {
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const prevCutoff = computeCutoff(rangeToPreviousInterval(range));

    const [windows, attention] = await Promise.all([
      this.requestVolume.getDispositionTotalsForWindows({
        tenantId: params.tenantId,
        from: prevCutoff,
        splitAt: cutoff,
        to: computeCutoff('0 hours'),
        agentName: params.agentName,
      }),
      this.queryNeedsAttention(cutoff, params.tenantId, params.agentName),
    ]);
    const current = this.windowCounts(windows.current);
    const previous = this.windowCounts(windows.previous);

    const rate = (c: WindowCounts) => (c.total > 0 ? c.successes / c.total : 0);
    const afxTotal = (c: WindowCounts) => c.healed + c.no_fix_found + c.resolving + c.ineffective;
    const covRate = (c: WindowCounts) => {
      const d = afxTotal(c);
      return d > 0 ? c.healed / d : 0;
    };

    return {
      success_rate: { value: rate(current), previous: rate(previous) },
      autofix_saves: { value: current.saves, previous: previous.saves },
      fallback_saves: { value: current.fallback_saves, previous: previous.fallback_saves },
      total_requests: { value: current.total, previous: previous.total },
      errors_remaining: { value: current.errors, previous: previous.errors },
      coverage: { rate: covRate(current), previous_rate: covRate(previous) },
      dispositions: {
        healed: current.healed,
        no_fix_found: current.no_fix_found,
        resolving: current.resolving,
        ineffective: current.ineffective,
      },
      needs_attention: attention,
    };
  }

  /**
   * Attempt-world reliability per CONNECTION: every provider call counts
   * where it ran, by its own outcome, at the grain the dashboards render a
   * row for — (provider, auth_type, key label). Legacy folds match the usage
   * lists: NULL auth_type reads api_key, NULL label reads Default. Healing is
   * a request concept and deliberately absent here.
   */
  async getPerProviderStats(params: {
    tenantId: string | null;
    range?: string;
    agentName?: string;
  }): Promise<
    Array<{
      provider: string;
      auth_type: string;
      key_label: string;
      attempts: number;
      failed: number;
      succeeded: number;
    }>
  > {
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const providerExpr = "CASE WHEN at.provider LIKE 'custom:%' THEN 'custom' ELSE at.provider END";
    const authExpr = "COALESCE(at.auth_type, 'api_key')";
    const labelExpr = "COALESCE(at.provider_key_label, 'Default')";
    const qb = this.messageRepo
      .createQueryBuilder('at')
      .select(providerExpr, 'provider')
      .addSelect(authExpr, 'auth_type')
      .addSelect(labelExpr, 'key_label')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsSuccessStatus('at.status')})`, 'succeeded')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsFailedStatus('at.status')})`, 'failed')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'))
      .groupBy(providerExpr)
      .addGroupBy(authExpr)
      .addGroupBy(labelExpr);
    addTenantFilter(qb, params.tenantId, params.agentName);
    excludePlaygroundAgents(qb);

    const rows = await qb.getRawMany<{
      provider: string;
      auth_type: string;
      key_label: string;
      attempts: string;
      failed: string;
      succeeded: string;
    }>();
    return rows.map((r) => ({
      provider: r.provider,
      auth_type: r.auth_type,
      key_label: r.key_label,
      attempts: Number(r.attempts),
      failed: Number(r.failed),
      succeeded: Number(r.succeeded),
    }));
  }

  async getPerAgentStats(params: { tenantId: string | null; range?: string }): Promise<
    Array<{
      agent_name: string;
      requests: number;
      failed: number;
      autofixed: number;
      fallback_saves: number;
      succeeded: number;
    }>
  > {
    const volume = await this.requestVolume.getVolumeByDimension('agent_name', params);
    return volume.map((v) => ({
      agent_name: v.key,
      requests: v.requests,
      failed: v.failed,
      autofixed: v.healed,
      fallback_saves: v.fallback,
      succeeded: v.succeeded,
    }));
  }

  /**
   * Attempt-world reliability per model: total attempts and their outcomes.
   * A model is not healed; it acts. Feeds the Model usage tables.
   */
  async getPerModelStats(params: {
    tenantId: string | null;
    range?: string;
    agentName?: string;
  }): Promise<
    Array<{
      model: string;
      attempts: number;
      failed: number;
      succeeded: number;
    }>
  > {
    const range = params.range ?? '7d';
    const cutoff = computeCutoff(rangeToInterval(range));
    const qb = this.messageRepo
      .createQueryBuilder('at')
      .select('at.model', 'model')
      .addSelect('COUNT(*)', 'attempts')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsSuccessStatus('at.status')})`, 'succeeded')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsFailedStatus('at.status')})`, 'failed')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'))
      .andWhere('at.model IS NOT NULL')
      .groupBy('at.model');
    addTenantFilter(qb, params.tenantId, params.agentName);
    excludePlaygroundAgents(qb);

    const rows = await qb.getRawMany<{
      model: string;
      attempts: string;
      failed: string;
      succeeded: string;
    }>();
    return rows.map((r) => ({
      model: r.model,
      attempts: Number(r.attempts),
      failed: Number(r.failed),
      succeeded: Number(r.succeeded),
    }));
  }

  async getTimeseries(params: {
    tenantId: string | null;
    range?: string;
    by?: string;
    agentName?: string;
    failedOnly?: boolean;
  }): Promise<AutofixTimeseriesResponse> {
    const range = params.range ?? '7d';
    const by = (AUTOFIX_TS_DIMENSIONS as readonly string[]).includes(params.by ?? '')
      ? (params.by as AutofixTsDimension)
      : 'disposition';
    const cutoff = computeCutoff(rangeToInterval(range));
    const hourly = isHourlyRange(range);

    // Disposition counts LOGICAL REQUESTS (terminal-attempt attribution,
    // #2511) so the By request status bars stack to the same total as the
    // Requests KPI and the by-provider/by-harness views. The other dimensions
    // keep their historical per-attempt semantics.
    if (by === 'disposition') {
      const rows = await this.requestVolume.getDispositionTimeseries({
        tenantId: params.tenantId,
        range,
        hourly,
        agentName: params.agentName,
        failedOnly: params.failedOnly,
      });
      return this.pivotTimeseries(range, by, rows);
    }

    const bucketExpr = hourly ? sqlHourBucket('at.timestamp') : sqlDateBucket('at.timestamp');
    const dimExpr = this.dimensionExpr(by);

    const qb = this.messageRepo
      .createQueryBuilder('at')
      .select(bucketExpr, 'bucket')
      .addSelect(dimExpr, 'dim')
      .addSelect('COUNT(*)', 'count')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere(sqlIsCompletedStatus('at.status'))
      .andWhere("(at.autofix_role IS NULL OR at.autofix_role != 'retry')");

    if (params.failedOnly) {
      qb.andWhere(sqlIsFailedStatus('at.status'));
    }

    qb.groupBy(bucketExpr).addGroupBy(dimExpr).orderBy(bucketExpr, 'ASC');
    addTenantFilter(qb, params.tenantId, params.agentName);
    excludePlaygroundAgents(qb);

    const rows = await qb.getRawMany<{ bucket: string; dim: string | null; count: string }>();
    return this.pivotTimeseries(range, by, rows);
  }

  private dimensionExpr(by: AutofixTsDimension): string {
    switch (by) {
      case 'disposition':
        return `CASE
          WHEN at.status = 'auto_fixed' THEN 'healed'
          WHEN at.status IN ('error','fallback_error','rate_limited') THEN 'error'
          WHEN ${sqlIsSuccessStatus('at.status')} AND at.fallback_from_model IS NOT NULL THEN 'fallback'
          ELSE 'success' END`;
      case 'http_status':
        return `CASE WHEN ${sqlIsSuccessStatus('at.status')} THEN '200'
          ELSE COALESCE(at.error_http_status::text, 'No response') END`;
      case 'provider':
        return `CASE WHEN at.provider LIKE 'custom:%' THEN 'custom' ELSE at.provider END`;
      case 'error_kind':
        return `COALESCE(at.error_class, 'none')`;
      case 'autofix':
        return `CASE WHEN at.autofix_applied = true THEN 'auto-fixed' ELSE 'not fixed' END`;
    }
  }

  private pivotTimeseries(
    range: string,
    by: string,
    rows: Array<{ bucket: string; dim: string | null; count: string }>,
  ): AutofixTimeseriesResponse {
    const keySet = new Set<string>();
    const bucketMap = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const dim = r.dim ?? 'unknown';
      keySet.add(dim);
      let m = bucketMap.get(r.bucket);
      if (!m) {
        m = new Map();
        bucketMap.set(r.bucket, m);
      }
      m.set(dim, (m.get(dim) ?? 0) + Number(r.count));
    }
    // For disposition, use a fixed order: success → autofix → fallback → error.
    const DISPOSITION_ORDER: Record<string, number> = {
      success: 0,
      autofix: 1,
      fallback: 2,
      error: 3,
    };
    const keys =
      by === 'disposition'
        ? [...keySet].sort((a, b) => (DISPOSITION_ORDER[a] ?? 99) - (DISPOSITION_ORDER[b] ?? 99))
        : [...keySet].sort();
    const buckets = [...bucketMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, m]) => ({
        bucket,
        counts: keys.map((k) => m.get(k) ?? 0),
      }));
    return { range, by, keys, buckets };
  }

  /**
   * KPI window counts, read from the SAME request-level reducer as the
   * By request status chart (one request, one disposition; Recovered by
   * Autofix = requests.autofix_status = 'retry_succeeded'). One definition,
   * every surface. Pure — the window totals come from a single
   * `getDispositionTotalsForWindows` scan for both the current and previous
   * window, so the KPI no longer scans the request/attempt window twice.
   */
  private windowCounts(t: DispositionTotals): WindowCounts {
    return {
      total: t.total,
      successes: t.success + t.healed + t.fallback,
      saves: t.healed,
      fallback_saves: t.fallback,
      errors: t.error,
      healed: t.healed,
      no_fix_found: t.error,
      resolving: 0,
      ineffective: 0,
    };
  }

  private async queryNeedsAttention(
    cutoff: string,
    tenantId: string | null,
    agentName?: string,
  ): Promise<AutofixStatsResponse['needs_attention']> {
    const qb = this.messageRepo
      .createQueryBuilder('at')
      .leftJoin(ManifestRequest, 'r', 'r.id = at.request_id')
      .select('LEFT(at.error_message, 200)', 'error_message')
      .addSelect('at.provider', 'provider')
      .addSelect('at.model', 'model')
      .addSelect('COUNT(*)', 'count')
      .addSelect("(at.autofix_phoenix->>'issueId')::text", 'phoenix_issue_id')
      .where('at.timestamp >= :cutoff', { cutoff })
      .andWhere("(at.autofix_role = 'original' OR at.status = 'auto_fixed')")
      .andWhere(sqlIsFailedStatus('at.status'))
      .andWhere("(r.autofix_status IS NULL OR r.autofix_status <> 'retry_succeeded')")
      .andWhere(
        `(r.id IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM agent_messages sib
          WHERE sib.autofix_group_id = at.autofix_group_id
            AND sib.tenant_id = at.tenant_id
            AND sib.autofix_role = 'retry'
            AND ${sqlIsSuccessStatus('sib.status')}
        ))`,
      )
      .groupBy('LEFT(at.error_message, 200)')
      .addGroupBy('at.provider')
      .addGroupBy('at.model')
      .addGroupBy("(at.autofix_phoenix->>'issueId')::text")
      .orderBy('count', 'DESC')
      .limit(5);
    addTenantFilter(qb, tenantId, agentName);
    excludePlaygroundAgents(qb);

    const rows = await qb.getRawMany<{
      error_message: string | null;
      provider: string;
      model: string;
      count: string;
      phoenix_issue_id: string | null;
    }>();

    return rows.map((r) => ({
      error_message: r.error_message ?? '',
      provider: r.provider,
      model: r.model,
      count: Number(r.count),
      phoenix_issue_id: r.phoenix_issue_id ?? null,
    }));
  }
}
