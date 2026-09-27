import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ALL_TIERS, AUTH_TYPES, ERROR_CLASSES, TIER_SLOTS } from 'manifest-shared';
import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import { Agent } from '../entities/agent.entity';
import { ApiKey } from '../entities/api-key.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { sqlIsFailedStatus } from '../analytics/services/query-helpers';
import { CLI_KEY_NAME } from '../auth/cli-auth.service';
import type { TelemetryPayloadV1 } from './dto/telemetry-payload';
import { TELEMETRY_SCHEMA_VERSION } from './telemetry.config';

const TIER_WHITELIST: ReadonlySet<string> = new Set<string>([...TIER_SLOTS, ...ALL_TIERS]);
const AUTH_TYPE_WHITELIST: ReadonlySet<string> = new Set<string>(AUTH_TYPES);
const ERROR_CLASS_WHITELIST: ReadonlySet<string> = new Set<string>(ERROR_CLASSES);

/**
 * MCP hosts we recognise by the `client_name` they register with (via CIMD or
 * DCR), after `slugifyClientName`. Anything else is a free-form string an
 * operator or client chose, so it collapses to `"other"` — same posture as
 * custom provider names.
 */
const MCP_CLIENT_NAME_WHITELIST: ReadonlySet<string> = new Set<string>([
  'claude-code',
  'claude',
  'claude-desktop',
  'cursor',
  'windsurf',
  'vs-code',
  'visual-studio-code',
  'codex',
  'codex-cli',
  'chatgpt',
  'gemini-cli',
  'cline',
  'zed',
  'goose',
  'opencode',
  'mcp-inspector',
]);

interface CliKeyRow {
  total: string;
  active: string | null;
}

interface McpCountsRow {
  clients: string;
  consents: string;
  tokens: string;
  active_clients: string;
}

interface McpClientNameRow {
  name: string | null;
  count: string;
}

interface McpAggregates {
  clients_total: number;
  consents_total: number;
  tokens_issued_24h: number;
  clients_active_24h: number;
  clients_by_name: Record<string, number>;
}

interface ProviderAggregateRow {
  provider: string | null;
  count: string;
  cost: string | null;
}

interface BucketRow {
  bucket: string | null;
  count: string;
}

interface TotalsRow {
  total: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost: string | null;
}

/**
 * Builds the daily telemetry payload by aggregating the last 24h of
 * `agent_messages` plus the total agent count + runtime metadata. All
 * SELECTs are parameterised so the window is consistent across queries.
 */
@Injectable()
export class PayloadBuilderService {
  private readonly logger = new Logger(PayloadBuilderService.name);

  constructor(
    @InjectRepository(AgentMessage)
    private readonly messages: Repository<AgentMessage>,
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    @InjectRepository(ManifestRequest)
    private readonly requests: Repository<ManifestRequest>,
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
  ) {}

  async build(installId: string, manifestVersion: string): Promise<TelemetryPayloadV1> {
    const [
      providerRows,
      tierRows,
      authRows,
      totals,
      agentsTotal,
      agentPlatformRows,
      requestCounts,
      errorClassRows,
      cliKeys,
      mcp,
    ] = await Promise.all([
      this.messagesByProvider(),
      this.messagesByBucket('routing_tier'),
      this.messagesByBucket('auth_type'),
      this.totals(),
      this.userAgentsCount(),
      this.agentsByPlatform(),
      this.requestCounts(),
      this.failedRequestsByClass(),
      this.cliKeyCounts(),
      this.mcpAggregates(),
    ]);

    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      install_id: installId,
      manifest_version: manifestVersion,
      messages_total: Number(totals.total),
      messages_by_provider: this.collapseProviders(providerRows),
      // Defense in depth: whitelist tier and auth_type values against the
      // shared enums. If a future write path inserts an unexpected string,
      // it collapses to `"other"` instead of leaking verbatim to the
      // telemetry endpoint.
      messages_by_tier: this.bucketsToRecord(tierRows, 'unknown', TIER_WHITELIST),
      messages_by_auth_type: this.bucketsToRecord(authRows, 'unknown', AUTH_TYPE_WHITELIST),
      tokens_input_total: Number(totals.input_tokens ?? 0),
      tokens_output_total: Number(totals.output_tokens ?? 0),
      cost_usd_total: roundCents(Number(totals.cost ?? 0)),
      cost_usd_by_provider: this.collapseProviderCosts(providerRows),
      requests_total: Number(requestCounts.total),
      errors_total: Number(requestCounts.failed ?? 0),
      // NULL error_class (unclassified failures) buckets under "unknown";
      // anything outside the shared taxonomy collapses to "other".
      errors_by_class: this.bucketsToRecord(errorClassRows, 'unknown', ERROR_CLASS_WHITELIST),
      agents_total: agentsTotal,
      agents_by_platform: this.bucketsToRecord(agentPlatformRows, 'unknown'),
      cli_keys_total: cliKeys.total,
      cli_keys_active_7d: cliKeys.active7d,
      mcp_clients_total: mcp.clients_total,
      mcp_consents_total: mcp.consents_total,
      mcp_tokens_issued_24h: mcp.tokens_issued_24h,
      mcp_clients_active_24h: mcp.clients_active_24h,
      mcp_clients_by_name: mcp.clients_by_name,
      platform: process.platform,
      arch: process.arch,
    };
  }

  private async messagesByProvider(): Promise<ProviderAggregateRow[]> {
    return this.messages
      .createQueryBuilder('m')
      .select('m.provider', 'provider')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(m.cost_usd), 0)', 'cost')
      .where(`m.timestamp >= NOW() - INTERVAL '24 hours'`)
      .groupBy('m.provider')
      .getRawMany<ProviderAggregateRow>();
  }

  /**
   * Groups the 24h-window messages by any column whose values are already a
   * short stable set (`routing_tier`, `auth_type`). We trust the set because
   * the producer — our own proxy — writes known enum strings.
   */
  private async messagesByBucket(column: 'routing_tier' | 'auth_type'): Promise<BucketRow[]> {
    return this.messages
      .createQueryBuilder('m')
      .select(`m.${column}`, 'bucket')
      .addSelect('COUNT(*)', 'count')
      .where(`m.timestamp >= NOW() - INTERVAL '24 hours'`)
      .groupBy(`m.${column}`)
      .getRawMany<BucketRow>();
  }

  /**
   * `other` is a sentinel valid in every category (personal/app/coding), so a
   * bare `agent_platform` bucket loses the category dimension peacock needs to
   * tell "Other personal agent" from "Other coding tool". For the `other`
   * platform we emit a composite `<category>:other` key (peacock's
   * platform-classification.ts already handles this format); known platforms
   * stay as bare keys so existing self-hosted reports don't change shape.
   */
  private async agentsByPlatform(): Promise<BucketRow[]> {
    interface CategoryPlatformRow {
      category: string | null;
      platform: string | null;
      count: string;
    }
    const rows = await this.agents
      .createQueryBuilder('a')
      .select('a.agent_category', 'category')
      .addSelect('a.agent_platform', 'platform')
      .addSelect('COUNT(*)', 'count')
      .where('a.is_playground = false')
      .groupBy('a.agent_category')
      .addGroupBy('a.agent_platform')
      .getRawMany<CategoryPlatformRow>();
    return rows.map((r) => ({
      bucket: r.platform === 'other' && r.category ? `${r.category}:${r.platform}` : r.platform,
      count: r.count,
    }));
  }

  /** Count only user-created agents; playground agents (e.g. Playground) are excluded. */
  private async userAgentsCount(): Promise<number> {
    const result = await this.agents
      .createQueryBuilder('a')
      .select('COUNT(*)', 'count')
      .where('a.is_playground = false')
      .getRawOne<{ count: string }>();
    return Number(result?.count ?? 0);
  }

  /**
   * Request-level counters over the same 24h window. `requests` is the
   * request-first ledger (one row per caller call), so `total` never counts
   * provider retries/fallbacks twice, and `failed` is the caller-visible
   * failure count — including gateway rejections that never produced an
   * attempt row in `agent_messages`.
   */
  private async requestCounts(): Promise<{ total: string; failed: string | null }> {
    const row = await this.requests
      .createQueryBuilder('r')
      .select('COUNT(*)', 'total')
      // Shared legacy-aware predicate: rows written by a not-yet-drained old
      // replica (or pre-normalization backfill) say `error`/`rate_limited`/…
      // rather than the canonical `failed`; a bare `= 'failed'` would
      // undercount them.
      .addSelect(`SUM(CASE WHEN ${sqlIsFailedStatus('r.status')} THEN 1 ELSE 0 END)`, 'failed')
      .where(`r.timestamp >= NOW() - INTERVAL '24 hours'`)
      .getRawOne<{ total: string; failed: string | null }>();
    return row ?? { total: '0', failed: '0' };
  }

  /** Failed requests grouped by their shared-taxonomy `error_class`. */
  private async failedRequestsByClass(): Promise<BucketRow[]> {
    return this.requests
      .createQueryBuilder('r')
      .select('r.error_class', 'bucket')
      .addSelect('COUNT(*)', 'count')
      .where(`r.timestamp >= NOW() - INTERVAL '24 hours'`)
      .andWhere(sqlIsFailedStatus('r.status'))
      .groupBy('r.error_class')
      .getRawMany<BucketRow>();
  }

  /**
   * Management-CLI adoption. `mnfst login` mints a PAT named `cli`
   * (`CLI_KEY_NAME`) and nothing else does, so the name is the durable marker.
   * `active` reads `last_used_at`, which the API-key guard stamps with the DB
   * clock on every authenticated call — so it is compared against `NOW()`.
   */
  private async cliKeyCounts(): Promise<{ total: number; active7d: number }> {
    const row = await this.apiKeys
      .createQueryBuilder('k')
      .select('COUNT(*)', 'total')
      .addSelect(
        `SUM(CASE WHEN k.last_used_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)`,
        'active',
      )
      .where('k.name = :name', { name: CLI_KEY_NAME })
      .getRawOne<CliKeyRow>();
    return { total: Number(row?.total ?? 0), active7d: Number(row?.active ?? 0) };
  }

  /**
   * Remote-MCP adoption, read from the OAuth tables the Better Auth MCP plugin
   * owns (`oauthClient`, `oauthConsent`, `oauthAccessToken`). They have no
   * TypeORM entity, so this is raw SQL through the api_keys repository's
   * entity manager — the same connection, one fewer injected dependency.
   * Access tokens live 15 minutes and a
   * connected client refreshes them for as long as it is in use, so tokens
   * minted per 24h is the activity proxy — no per-tool-call counter exists.
   *
   * Better Auth creates these tables on its own migration path; an install
   * that has not run it yet has none. That must degrade to zeros, never fail
   * the whole daily report.
   */
  private async mcpAggregates(): Promise<McpAggregates> {
    const empty: McpAggregates = {
      clients_total: 0,
      consents_total: 0,
      tokens_issued_24h: 0,
      clients_active_24h: 0,
      clients_by_name: {},
    };
    try {
      const [countRows, nameRows] = await Promise.all([
        this.apiKeys.manager.query<McpCountsRow[]>(`
          SELECT
            (SELECT COUNT(*) FROM "oauthClient" WHERE "disabled" IS NOT TRUE) AS clients,
            (SELECT COUNT(*) FROM "oauthConsent") AS consents,
            (SELECT COUNT(*) FROM "oauthAccessToken"
              WHERE "createdAt" >= NOW() - INTERVAL '24 hours') AS tokens,
            (SELECT COUNT(DISTINCT "clientId") FROM "oauthAccessToken"
              WHERE "createdAt" >= NOW() - INTERVAL '24 hours') AS active_clients
        `),
        this.apiKeys.manager.query<McpClientNameRow[]>(`
          SELECT "name" AS name, COUNT(*) AS count
          FROM "oauthClient"
          WHERE "disabled" IS NOT TRUE
          GROUP BY "name"
        `),
      ]);
      const counts = countRows[0];
      if (!counts) return empty;
      const byName: Record<string, number> = {};
      for (const row of nameRows) {
        // Only a NULL name is `unknown`; an empty or unrecognised declared name
        // is a name we chose not to forward, i.e. `other`.
        const slug = row.name === null ? null : slugifyClientName(row.name);
        const key =
          slug === null ? 'unknown' : MCP_CLIENT_NAME_WHITELIST.has(slug) ? slug : 'other';
        byName[key] = (byName[key] ?? 0) + Number(row.count);
      }
      return {
        clients_total: Number(counts.clients),
        consents_total: Number(counts.consents),
        tokens_issued_24h: Number(counts.tokens),
        clients_active_24h: Number(counts.active_clients),
        clients_by_name: byName,
      };
    } catch (error) {
      this.logger.debug(
        `MCP telemetry aggregates unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return empty;
    }
  }

  private async totals(): Promise<TotalsRow> {
    const row = await this.messages
      .createQueryBuilder('m')
      .select('COUNT(*)', 'total')
      .addSelect('SUM(m.input_tokens)', 'input_tokens')
      .addSelect('SUM(m.output_tokens)', 'output_tokens')
      .addSelect('COALESCE(SUM(m.cost_usd), 0)', 'cost')
      .where(`m.timestamp >= NOW() - INTERVAL '24 hours'`)
      .getRawOne<TotalsRow>();
    return row ?? { total: '0', input_tokens: '0', output_tokens: '0', cost: '0' };
  }

  /**
   * Maps each raw `provider` value to either its canonical registry ID or
   * the bucket `"custom"` (for user-defined providers) / `"unknown"` (for
   * pre-provider-column rows). Prevents custom provider names — which may
   * leak URLs or user configuration — from escaping the box.
   */
  private collapseProviders(rows: ProviderAggregateRow[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const bucket = this.bucketFor(row.provider);
      out[bucket] = (out[bucket] ?? 0) + Number(row.count);
    }
    return out;
  }

  /**
   * Same bucketing as `collapseProviders`, but sums `cost_usd` instead of
   * row counts. Custom provider names collapse into a single `"custom"`
   * bucket, so admin-configured BYOK pricing never appears keyed by the
   * raw provider string. Values are rounded to cents to avoid emitting
   * micro-precision floats over the wire.
   */
  private collapseProviderCosts(rows: ProviderAggregateRow[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const cost = row.cost == null ? 0 : Number(row.cost);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const bucket = this.bucketFor(row.provider);
      out[bucket] = (out[bucket] ?? 0) + cost;
    }
    for (const key of Object.keys(out)) {
      const rounded = roundCents(out[key]);
      if (rounded === 0) delete out[key];
      else out[key] = rounded;
    }
    return out;
  }

  private bucketFor(provider: string | null): string {
    if (!provider) return 'unknown';
    const entry = PROVIDER_BY_ID_OR_ALIAS.get(provider.toLowerCase());
    return entry ? entry.id : 'custom';
  }

  private bucketsToRecord(
    rows: BucketRow[],
    nullLabel: string,
    whitelist?: ReadonlySet<string>,
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
      let key = row.bucket ?? nullLabel;
      if (whitelist && row.bucket !== null && !whitelist.has(row.bucket)) {
        key = 'other';
      }
      out[key] = (out[key] ?? 0) + Number(row.count);
    }
    return out;
  }
}

/** `"Claude Code"` → `claude-code`; the whitelist above is keyed on this form. */
function slugifyClientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function roundCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
