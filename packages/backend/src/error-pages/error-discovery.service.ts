import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../entities/agent-message.entity';
import { scrubSecrets } from '../common/utils/secret-scrub';
import { MIN_TENANTS_FOR_PUBLIC } from './error-pages.service';

// A message variant must appear across at least this many distinct tenants
// before it's surfaced publicly — k-anonymity at the variant level so one
// customer's exact (possibly identifying) error string is never exposed.
const MIN_TENANTS_PER_VARIANT = 3;

// Public-facing scrub: provider-credential redaction (shared util) PLUS email
// redaction. Error bodies sometimes echo a user's email; strip it before any
// sample/variant leaves the building.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
function scrubForPublic(text: string | null | undefined): string {
  return scrubSecrets(text ?? '').replace(EMAIL_RE, '[email]');
}

export interface DiscoveredCluster {
  cluster_key: string;
  provider: string;
  http_status: number | null;
  category: string;
  category_label: string;
  suggested_slug: string;
  tenants: number;
  volume_7d: number;
  volume_30d: number;
  recovery_rate: number | null;
  first_seen: string | null;
  last_seen: string | null;
  sample_message: string;
  variants: string[];
  trend: { date: string; count: number }[];
}

function categoryFor(http: number | null): { id: string; label: string } {
  if (http === 429) return { id: 'rate_limit', label: 'Rate limit' };
  if (http === 401 || http === 403) return { id: 'auth', label: 'Authentication' };
  if (http === 402) return { id: 'billing', label: 'Billing / quota' };
  if (http === 404) return { id: 'model_unavailable', label: 'Model unavailable' };
  if (http != null && http >= 500) return { id: 'server', label: 'Server error' };
  if (http != null && http >= 400) return { id: 'bad_request', label: 'Bad request' };
  return { id: 'unknown', label: 'Unknown' };
}

/**
 * Computes error-cluster aggregates live from `agent_messages` (cross-tenant).
 * This is the rollup the Peacock CMS pulls from to discover and refresh clusters.
 * Aggregates only — never returns tenant identities — and applies the same
 * k-anonymity floor as publishing, so a cluster below the floor is never
 * surfaced for curation in the first place.
 */
@Injectable()
export class ErrorDiscoveryService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly repo: Repository<AgentMessage>,
  ) {}

  async discover(): Promise<DiscoveredCluster[]> {
    const aggRows: Array<{
      provider: string;
      http: number | null;
      volume_30d: number;
      volume_7d: number;
      tenants: number;
      first_seen: string | null;
      last_seen: string | null;
      recovery: number | null;
      sample: string | null;
    }> = await this.repo.query(`
      SELECT e.provider AS provider,
             e.error_http_status AS http,
             COUNT(*)::int AS volume_30d,
             COUNT(*) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '7 days')::int AS volume_7d,
             COUNT(DISTINCT e.tenant_id)::int AS tenants,
             MIN(e.timestamp) AS first_seen,
             MAX(e.timestamp) AS last_seen,
             AVG(CASE WHEN ok.trace_id IS NOT NULL THEN 1.0 ELSE 0.0 END)::float AS recovery,
             (array_agg(e.error_message ORDER BY e.timestamp DESC))[1] AS sample
      FROM agent_messages e
      LEFT JOIN (
        SELECT DISTINCT trace_id FROM agent_messages WHERE status IN ('ok', 'success') AND trace_id IS NOT NULL
      ) ok ON ok.trace_id = e.trace_id
      WHERE e.status IN ('error','fallback_error','rate_limited','failed')
        AND e.tenant_id IS NOT NULL
        AND e.provider IS NOT NULL
        AND e.provider NOT LIKE 'custom:%'
      GROUP BY e.provider, e.error_http_status
      HAVING COUNT(DISTINCT e.tenant_id) >= ${MIN_TENANTS_FOR_PUBLIC}
      ORDER BY COUNT(DISTINCT e.tenant_id) DESC
    `);

    const trendRows: Array<{ provider: string; http: number | null; day: string; cnt: number }> =
      await this.repo.query(`
        SELECT e.provider AS provider,
               e.error_http_status AS http,
               to_char(date_trunc('day', e.timestamp), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS cnt
        FROM agent_messages e
        WHERE e.status IN ('error','fallback_error','rate_limited','failed')
          AND e.timestamp >= NOW() - INTERVAL '14 days'
          AND e.tenant_id IS NOT NULL
          AND e.provider IS NOT NULL
          AND e.provider NOT LIKE 'custom:%'
        GROUP BY e.provider, e.error_http_status, day
        ORDER BY day ASC
      `);

    const trendByKey = new Map<string, { date: string; count: number }[]>();
    for (const r of trendRows) {
      const key = `${r.provider}|${r.http ?? 'none'}`;
      if (!trendByKey.has(key)) trendByKey.set(key, []);
      trendByKey.get(key)!.push({ date: r.day, count: Number(r.cnt) });
    }

    // Top distinct message strings per cluster — powers the "Also seen as"
    // block, widening lexical coverage to the variant wordings users search.
    const variantRows: Array<{ provider: string; http: number | null; msg: string; cnt: number }> =
      await this.repo.query(`
        SELECT e.provider AS provider,
               e.error_http_status AS http,
               e.error_message AS msg,
               COUNT(*)::int AS cnt
        FROM agent_messages e
        WHERE e.status IN ('error','fallback_error','rate_limited','failed')
          AND e.error_message IS NOT NULL
          AND e.tenant_id IS NOT NULL
          AND e.provider IS NOT NULL
          AND e.provider NOT LIKE 'custom:%'
        GROUP BY e.provider, e.error_http_status, e.error_message
        HAVING COUNT(DISTINCT e.tenant_id) >= ${MIN_TENANTS_PER_VARIANT}
        ORDER BY cnt DESC
      `);

    const variantsByKey = new Map<string, string[]>();
    for (const r of variantRows) {
      const key = `${r.provider}|${r.http ?? 'none'}`;
      if (!variantsByKey.has(key)) variantsByKey.set(key, []);
      const list = variantsByKey.get(key)!;
      if (list.length < 5) list.push(scrubForPublic(r.msg).slice(0, 160));
    }

    return aggRows.map((r) => {
      const http = r.http != null ? Number(r.http) : null;
      const cat = categoryFor(http);
      const key = `${r.provider}|${http ?? 'none'}`;
      return {
        cluster_key: key,
        provider: r.provider,
        http_status: http,
        category: cat.id,
        category_label: cat.label,
        suggested_slug: `${r.provider}-${http ?? 'error'}-${cat.id.replace(/_/g, '-')}`,
        tenants: Number(r.tenants),
        volume_7d: Number(r.volume_7d),
        volume_30d: Number(r.volume_30d),
        recovery_rate: r.recovery != null ? Number(r.recovery) : null,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        sample_message: scrubForPublic(r.sample),
        variants: variantsByKey.get(key) ?? [],
        trend: trendByKey.get(key) ?? [],
      };
    });
  }
}
