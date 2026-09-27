import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import {
  addTenantFilter,
  sqlCountMessages,
  sqlIsCompletedStatus,
  sqlIsSuccessStatus,
} from './query-helpers';

/**
 * Per (provider, auth_type) usage summary surfaced to the dashboard provider
 * pages. Mirrors the shape the old `/api/v1/providers` endpoint inlined before
 * usage was split off into its own endpoint (`GET /api/v1/providers/usage`).
 */
export interface ProviderUsageSummary {
  provider: string;
  auth_type: string;
  /** Folded key label (NULL reads 'Default'): the connection identity. */
  key_label: string;
  /** Summed input+output tokens over the last 30 days. */
  consumption_tokens: number;
  /** Message count over the last 30 days. */
  consumption_messages: number;
  /** Summed cost (USD) over the last 30 days. Raw numeric sum, not rounded per-row. */
  consumption_cost: number;
  /** Every provider call over the last 30 days (retries and fallbacks included). */
  attempts_30d: number;
  /** Attempts that returned success over the last 30 days. */
  succeeded_30d: number;
  /** Max message timestamp within the 30-day window, ISO-8601, or null. */
  last_used_at: string | null;
  /** Dense 7-element daily token series for the last 7 UTC days (oldest → today). */
  sparkline_7d: number[];
}

/**
 * Number of UTC days the sparkline covers. The frontend renders a fixed-width
 * 7-bar sparkline, so the array is always dense (zero-filled) to this length.
 */
const SPARKLINE_DAYS = 7;

interface DailyBucketRow {
  provider: string | null;
  auth_type: string | null;
  key_label: string | null;
  /** UTC day label `YYYY-MM-DD`. */
  day: string;
  tokens: string | number | null;
  cost: string | number | null;
  messages: string | number | null;
  attempts: string | number | null;
  succeeded: string | number | null;
  last_used_at: Date | string | null;
}

/**
 * Computes provider usage stats from `agent_messages` in a single collapsed,
 * daily-bucketed aggregation. Kept out of the providers/routing config path so
 * a provider-config read never scans the (large) `agent_messages` table.
 *
 * All time bucketing is pinned to UTC via `AT TIME ZONE 'UTC'` so the day
 * labels line up exactly with the frontend, which builds its 7 sparkline slots
 * from `new Date(...).toISOString().slice(0, 10)` (UTC dates). Truncating with a
 * bare `date_trunc` would inherit the session timezone and silently misalign
 * the buckets on a non-UTC host.
 */
@Injectable()
export class ProviderUsageService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
  ) {}

  /**
   * Build the dense list of the last `SPARKLINE_DAYS` UTC day labels
   * (`YYYY-MM-DD`), oldest first, ending today. Matches the frontend slot
   * construction so a bucket lands in the right column.
   */
  private utcDayLabels(now: Date): string[] {
    const days: string[] = [];
    for (let i = SPARKLINE_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    return days;
  }

  async getUsage(tenantId: string | null): Promise<ProviderUsageSummary[]> {
    if (!tenantId) return [];

    // ONE collapsed query: 30-day window, daily buckets per (provider,
    // auth_type, UTC day). We derive 30d totals (sum of buckets), the dense 7d
    // sparkline, and last_used (max bucket day's max timestamp) in JS so the DB
    // only scans agent_messages once.
    //
    // `m.timestamp AT TIME ZONE 'UTC'` reads the stored `timestamp without time
    // zone` as UTC (→ timestamptz); truncating to day then converting back with
    // a second `AT TIME ZONE 'UTC'` yields a session-tz-independent UTC label.
    const dayExpr = "date_trunc('day', at.timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
    const qb = this.messageRepo
      .createQueryBuilder('at')
      .select('at.provider', 'provider')
      .addSelect('at.auth_type', 'auth_type')
      .addSelect("COALESCE(at.provider_key_label, 'Default')", 'key_label')
      .addSelect(`to_char(${dayExpr}, 'YYYY-MM-DD')`, 'day')
      .addSelect('SUM(COALESCE(at.input_tokens, 0) + COALESCE(at.output_tokens, 0))', 'tokens')
      // Sum the RAW numeric cost (not a pre-rounded per-row value) so totals stay
      // precise; rounding for display happens client-side.
      .addSelect('SUM(COALESCE(at.cost_usd, 0))', 'cost')
      .addSelect(sqlCountMessages(), 'messages')
      // Attempt-world reliability at the SAME grain as this row (provider +
      // auth_type): the connection lists must not blend a subscription's
      // rate with an api_key connection's rate for the same provider.
      .addSelect('COUNT(*)', 'attempts')
      .addSelect(`COUNT(*) FILTER (WHERE ${sqlIsSuccessStatus('at.status')})`, 'succeeded')
      .addSelect('MAX(at.timestamp)', 'last_used_at')
      .where("at.timestamp >= NOW() - INTERVAL '30 days'")
      .andWhere(sqlIsCompletedStatus('at.status'))
      .groupBy('at.provider')
      .addGroupBy('at.auth_type')
      .addGroupBy("COALESCE(at.provider_key_label, 'Default')")
      .addGroupBy('day');
    addTenantFilter(qb, tenantId);

    const rows = (await qb.getRawMany()) as DailyBucketRow[];

    const dayLabels = this.utcDayLabels(new Date());
    const sparklineIndex = new Map(dayLabels.map((d, i) => [d, i]));

    interface Acc {
      provider: string;
      auth_type: string;
      key_label: string;
      tokens: number;
      messages: number;
      cost: number;
      attempts: number;
      succeeded: number;
      lastUsed: number | null;
      sparkline: number[];
    }
    const byKey = new Map<string, Acc>();

    for (const row of rows) {
      // Drop NULL-provider rows (local/blind-proxy telemetry with no provider)
      // to match the prior endpoint's behaviour; default a NULL auth_type to
      // 'api_key' so subscription/api_key keys with legacy NULLs still group.
      if (!row.provider) continue;
      const authType = row.auth_type ?? 'api_key';
      const keyLabel = row.key_label ?? 'Default';
      const key = `${row.provider}::${authType}::${keyLabel.toLowerCase()}`;

      let acc = byKey.get(key);
      if (!acc) {
        acc = {
          provider: row.provider,
          auth_type: authType,
          key_label: keyLabel,
          tokens: 0,
          messages: 0,
          cost: 0,
          attempts: 0,
          succeeded: 0,
          lastUsed: null,
          sparkline: new Array(SPARKLINE_DAYS).fill(0),
        };
        byKey.set(key, acc);
      }

      const tokens = Number(row.tokens) || 0;
      acc.tokens += tokens;
      acc.messages += Number(row.messages) || 0;
      acc.cost += Number(row.cost) || 0;
      acc.attempts += Number(row.attempts) || 0;
      acc.succeeded += Number(row.succeeded) || 0;

      const lastUsedMs =
        row.last_used_at instanceof Date
          ? row.last_used_at.getTime()
          : row.last_used_at
            ? new Date(row.last_used_at).getTime()
            : null;
      if (lastUsedMs !== null && (acc.lastUsed === null || lastUsedMs > acc.lastUsed)) {
        acc.lastUsed = lastUsedMs;
      }

      // Place the bucket into its 7d sparkline slot when it falls inside the
      // window (the 30d query also returns days 8–30, which simply don't map).
      const slot = sparklineIndex.get(row.day);
      if (slot !== undefined) acc.sparkline[slot] = tokens;
    }

    return Array.from(byKey.values()).map((acc) => ({
      provider: acc.provider,
      auth_type: acc.auth_type,
      key_label: acc.key_label,
      consumption_tokens: acc.tokens,
      consumption_messages: acc.messages,
      consumption_cost: acc.cost,
      attempts_30d: acc.attempts,
      succeeded_30d: acc.succeeded,
      last_used_at: acc.lastUsed === null ? null : new Date(acc.lastUsed).toISOString(),
      sparkline_7d: acc.sparkline,
    }));
  }
}
