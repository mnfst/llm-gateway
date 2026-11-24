import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { TtlCache } from '../common/utils/ttl-cache';
import { toLocalSqlTimestamp } from '../common/utils/postgres-sql';
import { sqlIsSuccessStatus } from '../analytics/services/query-helpers';
import {
  domainOf,
  isCorporateSignupEmail,
  isMachineGeneratedDomain,
  isSignupCluster,
  isExcludedEmail,
} from './crm-metrics.filters';
import type {
  CohortRow,
  CrmCorporateSignup,
  CrmHealedUser,
  CrmWaitlistClaim,
  SignupRow,
} from './crm-metrics.types';

/**
 * Answers on the cheap: the requests Autofix repaired lately, grouped by the
 * person who owns them, plus the waiting-list claims that measure whether the
 * campaign worked.
 *
 * Read once a day by the CRM, so there is no snapshot table and no cron. A
 * snapshot would need a cron running exactly the cross-tenant scan this is
 * trying to avoid, plus leader election; once indexed, the live query is
 * cheaper than that cron would be. Results sit behind a TTL cache.
 */

const HEALED_INDEX = 'IDX_requests_autofix_healed';

/**
 * The signup feed's whole cost model is one index probe per tenant. Without
 * this index the lateral degrades to a sequential scan of `requests` per row,
 * which measured 22s and 6.9 GB of reads against production.
 */
const TENANT_TIMESTAMP_INDEX = 'IDX_requests_tenant_timestamp';

/**
 * Short on purpose. The cache exists to stop a retrying client from replaying
 * the provider join (~80 MB of buffer reads) up to the throttler's 100/min, not
 * to serve the expected traffic — a once-a-day poll misses either way. A long
 * TTL would buy nothing and make the feed surprisingly stale after an operator
 * fixes something and re-runs.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Deliberately *below* the 2.4s the unindexed cohort scan takes. If the
 * partial index is missing the query aborts instead of completing, because the
 * damage from that plan is not latency but reading 6.6 GB through a ~128 MB
 * shared_buffers and evicting everyone else's working set.
 */
const STATEMENT_TIMEOUT_MS = 1_500;
const LOCK_TIMEOUT_MS = 5_000;

/** The index is the entire point; without it, refuse rather than thrash prod. */
const INDEX_READY_SQL = `
  SELECT 1 FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = $1 AND i.indisvalid
`;

/**
 * The canonical "healed" predicate, matching request-volume.service.ts. The
 * status check is not redundant: a retry can return 2xx while the request still
 * concludes failed, and quoting a repair count the dashboard disagrees with is
 * worse than quoting none.
 *
 * No playground exclusion is needed here (every other cross-tenant aggregate
 * carries one): playground.service.ts writes `autofix_status: null` on all of
 * its request paths, so a playground row can never match this predicate.
 */
const IS_HEALED = `r.autofix_status = 'retry_succeeded' AND ${sqlIsSuccessStatus('r.status')}`;

const COHORT_SQL = `
  SELECT lower(u.email)                             AS email,
         u.name                                     AS user_name,
         r.tenant_id                                AS tenant_id,
         count(*) FILTER (WHERE r.timestamp > $1)   AS healed_recent,
         count(*)                                   AS healed_all,
         min(r.timestamp)                           AS first_heal_at,
         max(r.timestamp)                           AS last_heal_at
  FROM requests r
  JOIN tenants t ON t.id = r.tenant_id
  JOIN "user" u ON u.id = t.owner_user_id
  WHERE ${IS_HEALED}
    AND u."emailVerified" = true
  GROUP BY lower(u.email), u.name, r.tenant_id
  HAVING count(*) FILTER (WHERE r.timestamp > $1) > 0
`;

/**
 * Every verified signup in the window, with the timestamp of that tenant's most
 * recent request.
 *
 * `LIMIT 1` on a backward index scan rather than an aggregate: it answers
 * "have they ever used this, and when last" from the index alone, whereas
 * `count(*)` or a filtered aggregate must visit the heap for every row.
 *
 * Domain rules are deliberately *not* in this SQL. They live in
 * crm-metrics.filters.ts so one list governs every consumer and stays under
 * test; the cost of returning all ~8k users and filtering in TypeScript is
 * one probe each, which measured 59-93ms warm and 999ms cold against
 * production. That worst case still fits the 1.5s budget, but the margin is
 * the reason this stays one probe per row and never an aggregate.
 *
 * Anyone on the pivot waiting list is excluded. They raised their hand for
 * exactly this product and are worked by hand, one at a time — a templated
 * signup email landing on top of that conversation would be a worse
 * experience than no email. `waitlist_claims` is ~60 rows with a unique
 * index on email, so the anti-join is free.
 *
 * The join to `tenants` must stay LEFT. Tenants are created lazily on first
 * agent creation, so a user who signed up and never built anything has no
 * tenant row at all — 1,274 verified users in production, 144 of them on
 * corporate domains. An inner join drops exactly the people this feed exists
 * to find. With no tenant the lateral matches nothing, which is the correct
 * answer: `last_request_at` null, `has_traffic` false.
 */
const SIGNUPS_SQL = `
  WITH signups AS MATERIALIZED (
    SELECT lower(u.email)   AS email,
           u.name           AS user_name,
           u."createdAt"    AS signed_up_at,
           t.id             AS tenant_id
    FROM "user" u
    LEFT JOIN tenants t ON t.owner_user_id = u.id
    WHERE u."emailVerified" = true
      AND u."createdAt" > $1
      AND NOT EXISTS (
        SELECT 1 FROM waitlist_claims w WHERE lower(w.email) = lower(u.email)
      )
  )
  SELECT s.email, s.user_name, s.signed_up_at, a.last_request_at
  FROM signups s
  LEFT JOIN LATERAL (
    SELECT r.timestamp AS last_request_at
    FROM requests r
    WHERE r.tenant_id = s.tenant_id
    ORDER BY r.timestamp DESC
    LIMIT 1
  ) a ON true
`;

const CLAIMS_SQL = `
  SELECT email, source, claimed_at
  FROM waitlist_claims
  WHERE claimed_at > $1
  ORDER BY claimed_at DESC
`;

@Injectable()
export class CrmMetricsService {
  private readonly cohortCache = new TtlCache<number, CrmHealedUser[]>({
    maxSize: 8,
    ttlMs: CACHE_TTL_MS,
  });
  private readonly claimsCache = new TtlCache<number, CrmWaitlistClaim[]>({
    maxSize: 8,
    ttlMs: CACHE_TTL_MS,
  });
  private readonly signupsCache = new TtlCache<number, CrmCorporateSignup[]>({
    maxSize: 8,
    ttlMs: CACHE_TTL_MS,
  });

  constructor(private readonly dataSource: DataSource) {}

  /** Users whose requests Autofix repaired within `days`, one row per person. */
  async getHealedCohort(days: number, now: Date = new Date()): Promise<CrmHealedUser[]> {
    const cached = this.cohortCache.get(days);
    if (cached) return cached;

    const cutoff = cutoffFor(days, now);
    const users = await this.withRunner(async (runner) => {
      const ready = (await runner.query(INDEX_READY_SQL, [HEALED_INDEX])) as unknown[];
      if (ready.length === 0) {
        throw new ServiceUnavailableException(
          `${HEALED_INDEX} is missing or invalid; refusing to run an unindexed scan`,
        );
      }
      const merged = mergeByEmail((await runner.query(COHORT_SQL, [cutoff])) as CohortRow[]);
      return buildUsers(merged);
    });

    this.cohortCache.set(days, users);
    return users;
  }

  /**
   * Verified signups on organisation domains within `days`, newest first.
   *
   * Consumer mailboxes, relays, role addresses and scripted signup clusters are
   * removed here rather than in the CRM, so every consumer inherits the same
   * rules.
   */
  async getCorporateSignups(days: number, now: Date = new Date()): Promise<CrmCorporateSignup[]> {
    const cached = this.signupsCache.get(days);
    if (cached) return cached;

    // `user."createdAt"` is `timestamp WITH time zone`, unlike the naive
    // `requests.timestamp` the cohort query compares against — so a UTC
    // boundary is correct here and a local one would be off by the offset.
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const signups = await this.withRunner(async (runner) => {
      const ready = (await runner.query(INDEX_READY_SQL, [TENANT_TIMESTAMP_INDEX])) as unknown[];
      if (ready.length === 0) {
        throw new ServiceUnavailableException(
          `${TENANT_TIMESTAMP_INDEX} is missing or invalid; refusing to run an unindexed scan`,
        );
      }
      return buildSignups((await runner.query(SIGNUPS_SQL, [cutoff])) as SignupRow[]);
    });

    this.signupsCache.set(days, signups);
    return signups;
  }

  /** Pivot waiting-list claims in the window: who converted, and from where. */
  async getConversions(days: number, now: Date = new Date()): Promise<CrmWaitlistClaim[]> {
    const cached = this.claimsCache.get(days);
    if (cached) return cached;

    // `waitlist_claims.claimed_at` is `timestamp WITH time zone`, unlike the
    // naive `requests.timestamp` below — hence the UTC boundary here.
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const claims = await this.withRunner(async (runner) => {
      const rows = (await runner.query(CLAIMS_SQL, [cutoff])) as CrmWaitlistClaim[];
      return rows.map((row) => ({
        email: row.email.toLowerCase(),
        source: row.source,
        claimed_at: new Date(row.claimed_at).toISOString(),
      }));
    });

    this.claimsCache.set(days, claims);
    return claims;
  }

  /**
   * `SET LOCAL` is transaction-scoped, which is the only form Railway's
   * PgBouncer accepts (see the note in database.module.ts).
   */
  private async withRunner<T>(fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await runner.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
        const result = await fn(runner);
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
}

/** Accumulator for the rows belonging to one person. */
interface Merged {
  email: string;
  name: string | null;
  healed_recent: number;
  healed_all: number;
  first_heal_at: number;
  last_heal_at: number;
}

/**
 * Local wall clock, not UTC: `requests.timestamp` is `timestamp without time
 * zone` and the pg driver writes JS Dates in the process timezone, so a UTC
 * boundary would be offset by that amount and silently drop rows.
 */
function cutoffFor(days: number, now: Date): string {
  return toLocalSqlTimestamp(new Date(now.getTime() - days * 86_400_000));
}

/**
 * The SQL groups by (email, tenant) and the totals are summed here. Today a
 * user owns at most one tenant (`uq_tenants_owner_user` is unique), so this is
 * a no-op — but `owner_user_id` is nullable by design for future team
 * workspaces, so the 1:1 is a current fact rather than an invariant.
 *
 * Excluded addresses are dropped before their tenants reach the payload.
 */
function mergeByEmail(rows: CohortRow[]): Map<string, Merged> {
  const merged = new Map<string, Merged>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (isExcludedEmail(email)) continue;

    const first = new Date(row.first_heal_at).getTime();
    const last = new Date(row.last_heal_at).getTime();
    const existing = merged.get(email);
    if (!existing) {
      merged.set(email, {
        email,
        name: row.user_name,
        healed_recent: Number(row.healed_recent),
        healed_all: Number(row.healed_all),
        first_heal_at: first,
        last_heal_at: last,
      });
      continue;
    }
    existing.healed_recent += Number(row.healed_recent);
    existing.healed_all += Number(row.healed_all);
    existing.first_heal_at = Math.min(existing.first_heal_at, first);
    existing.last_heal_at = Math.max(existing.last_heal_at, last);
    existing.name = existing.name ?? row.user_name;
  }
  return merged;
}

function buildUsers(merged: Map<string, Merged>): CrmHealedUser[] {
  const users = [...merged.values()].map((entry) => ({
    email: entry.email,
    name: entry.name,
    healed_recent: entry.healed_recent,
    healed_all: entry.healed_all,
    first_heal_at: new Date(entry.first_heal_at).toISOString(),
    last_heal_at: new Date(entry.last_heal_at).toISOString(),
  }));

  return users.sort((a, b) => b.healed_recent - a.healed_recent);
}

/**
 * Turns raw signup rows into the payload: drop addresses that are not
 * organisations, drop domains whose signups look scripted, then annotate each
 * survivor with how many people share its domain.
 *
 * Ordered by domain size then recency, so if the CRM ever caps a batch it takes
 * the strongest team signals first.
 */
function buildSignups(rows: SignupRow[]): CrmCorporateSignup[] {
  const byDomain = new Map<string, CrmCorporateSignup[]>();

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!isCorporateSignupEmail(email)) continue;

    const lastRequest = row.last_request_at ? new Date(row.last_request_at) : null;
    const signup: CrmCorporateSignup = {
      email,
      name: row.user_name,
      domain: domainOf(email),
      signed_up_at: new Date(row.signed_up_at).toISOString(),
      last_request_at: lastRequest ? lastRequest.toISOString() : null,
      has_traffic: lastRequest !== null,
      // Filled in below, once the domain's full membership is known.
      domain_signups: 0,
    };

    const bucket = byDomain.get(signup.domain);
    if (bucket) bucket.push(signup);
    else byDomain.set(signup.domain, [signup]);
  }

  const kept: CrmCorporateSignup[] = [];
  for (const signups of byDomain.values()) {
    if (isSignupCluster(signups)) continue;
    if (isMachineGeneratedDomain(signups.map((s) => s.email.split('@')[0]))) continue;
    for (const signup of signups) {
      signup.domain_signups = signups.length;
      kept.push(signup);
    }
  }

  return kept.sort(
    (a, b) =>
      b.domain_signups - a.domain_signups ||
      Date.parse(b.signed_up_at) - Date.parse(a.signed_up_at),
  );
}
