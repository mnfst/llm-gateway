import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MANIFEST_ERROR_ORIGINS, PLAN_LIMITS, UNLIMITED_PLAN_LIMITS } from 'manifest-shared';
import type {
  BillingEmailPreferences,
  BillingPlanStatus,
  BillingPrice,
  BillingStatus,
  Plan,
  PlanLimits,
} from 'manifest-shared';
import type Stripe from 'stripe';
import { Tenant } from '../entities/tenant.entity';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';
import { toLocalSqlTimestamp, toSqlTimestamp } from '../common/utils/postgres-sql';
import { getStripeClient, isBillingEnabled } from './billing.config';
import {
  DEFAULT_BILLING_EMAIL_PREFERENCES,
  normalizeBillingEmailPreferences,
} from './billing-email-preferences';
import { REQUEST_USAGE_CUTOVER_STATE, requestQuotaWindowStartMs } from './request-quota-window';
import { PAID_SUBSCRIPTION_STATUS_SQL_LIST } from './subscription-status';

const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const BILLING_PRICE_UNAVAILABLE: BillingPrice = Object.freeze({
  amount: null,
  currency: null,
  interval: null,
});
// Throttle the "count failed → failing open" warning: a sustained DB outage
// hits this on every proxied request, which would flood logs and add avoidable
// pressure to the hot path. One line per window, with a suppressed-count tail so
// the true rate stays visible.
const COUNT_FAILURE_WARN_WINDOW_MS = 60 * 1000;
const LIMIT_FAILURE_WARN_WINDOW_MS = 60 * 1000;
const MANIFEST_ERROR_ORIGIN_SQL_LIST = MANIFEST_ERROR_ORIGINS.map((origin) => `'${origin}'`).join(
  ', ',
);

function envLimit(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  // Digits only: plan limits are non-negative integers. `Number()` would also
  // accept hex (0x10), scientific (1e3), and whitespace-padded values, silently
  // producing an unexpected limit instead of falling back to the plan default.
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

interface BillingSnapshot {
  plan: Plan;
  limitOverrides: { requestsPerMonth?: number } | null;
  billingEmailPreferences: Partial<BillingEmailPreferences> | null;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
}

interface BillingSnapshotRow {
  subscriptionPlan: string | null;
  cancelAtPeriodEnd: boolean | null;
  periodEnd: string | null;
  limitOverrides: { requestsPerMonth?: number } | null;
  billingEmailPreferences: Partial<BillingEmailPreferences> | null;
}

function canonicalTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
}

function currentProcessTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

@Injectable()
export class PlanService implements OnModuleInit {
  private readonly logger = new Logger(PlanService.name);
  private priceCache: { value: BillingPrice; fetchedAt: number } | null = null;
  private lastCountFailureWarnAtMs = 0;
  private suppressedCountFailureWarns = 0;
  private lastLimitFailureWarnAtMs = 0;
  private suppressedLimitFailureWarns = 0;
  /** In-flight baseline initializations keyed by tenant+window. Never awaited on
   * the admission/billing hot path — only used for single-flight coalescing. */
  private readonly requestUsageInitializations = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isBillingEnabled()) return;

    const storageTimeZone = await this.readRequestStorageTimeZone();
    const processTimeZone = currentProcessTimeZone();
    if (canonicalTimeZone(storageTimeZone) !== canonicalTimeZone(processTimeZone)) {
      throw new Error(
        `Request quota storage timezone mismatch: trigger=${storageTimeZone}, process=${processTimeZone}`,
      );
    }
  }

  /**
   * Billing attaches to the tenant. The Stripe subscription row is keyed by
   * referenceId = the tenant OWNER's user id (better-auth's plugin keys
   * checkout to the session user); fall back to ctx.userId for fresh
   * accounts that have no tenant yet.
   */
  private async getBillingSnapshot(ctx: TenantContext): Promise<BillingSnapshot> {
    if (!isBillingEnabled() || (!ctx.tenantId && !ctx.userId)) {
      return {
        plan: 'free',
        limitOverrides: null,
        billingEmailPreferences: null,
        cancelAtPeriodEnd: false,
        periodEnd: null,
      };
    }
    const rows: BillingSnapshotRow[] = await this.dataSource.query(
      `SELECT
          t."limit_overrides" AS "limitOverrides",
          t."billing_email_preferences" AS "billingEmailPreferences",
          s."plan" AS "subscriptionPlan",
          s."cancelAtPeriodEnd" AS "cancelAtPeriodEnd",
          s."periodEnd" AS "periodEnd"
         FROM (SELECT 1) seed
    LEFT JOIN "tenants" t
           ON t."id" = $1
    LEFT JOIN LATERAL (
          SELECT "plan", "cancelAtPeriodEnd", "periodEnd"
            FROM "subscription"
           WHERE "referenceId" = COALESCE(t."owner_user_id", $2)
             AND "status" IN (${PAID_SUBSCRIPTION_STATUS_SQL_LIST})
        ORDER BY "periodEnd" DESC NULLS LAST
           LIMIT 1
         ) s
           ON COALESCE(t."owner_user_id", $2) IS NOT NULL`,
      [ctx.tenantId, ctx.userId],
    );
    const row = rows[0];
    return {
      plan: row?.subscriptionPlan === 'pro' ? 'pro' : 'free',
      limitOverrides: row?.limitOverrides ?? null,
      billingEmailPreferences: row?.billingEmailPreferences ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
      periodEnd: row?.periodEnd ?? null,
    };
  }

  private async findTenant(ctx: TenantContext): Promise<Tenant | null> {
    if (!ctx.tenantId) return null;
    return this.tenantRepo.findOne({ where: { id: ctx.tenantId } });
  }

  /** Resolve the tenant's plan from better-auth's webhook-synced subscription table. */
  async getPlan(ctx: TenantContext): Promise<Plan> {
    return (await this.getBillingSnapshot(ctx)).plan;
  }

  /**
   * Light plan lookup for UI gating (range locks, AuthGuard bootstrap). One
   * snapshot query — never touches the usage counter or Stripe.
   */
  async getPlanStatus(ctx: TenantContext): Promise<BillingPlanStatus> {
    if (!isBillingEnabled()) return { enabled: false, plan: 'free' };
    return { enabled: true, plan: await this.getPlan(ctx) };
  }

  private limitsForSnapshot(snapshot: BillingSnapshot): PlanLimits {
    const defaults = PLAN_LIMITS[snapshot.plan];
    const prefix = `PLAN_LIMIT_${snapshot.plan.toUpperCase()}`;
    const overrides = snapshot.limitOverrides;
    return {
      requestsPerMonth:
        overrides?.requestsPerMonth ?? envLimit(`${prefix}_REQUESTS`) ?? defaults.requestsPerMonth,
    };
  }

  /** Resolution order: per-tenant override > instance env > plan defaults. */
  async getLimits(ctx: TenantContext, opts: { failOpen?: boolean } = {}): Promise<PlanLimits> {
    if (!isBillingEnabled()) return UNLIMITED_PLAN_LIMITS;
    try {
      return this.limitsForSnapshot(await this.getBillingSnapshot(ctx));
    } catch (err) {
      if (!opts.failOpen) throw err;
      this.warnLimitFailureThrottled(ctx.tenantId, err as Error);
      return UNLIMITED_PLAN_LIMITS;
    }
  }

  /** Start of the current calendar month in UTC (epoch ms). */
  private monthStartMsUtc(now: Date): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }

  /** Start of next calendar month in UTC — the moment the request quota resets. */
  private nextMonthStartUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  /**
   * Routed requests recorded for the tenant in the effective monthly quota
   * window. Hot path is one PK read of `tenant_request_usage`.
   *
   * When the pre-cutover baseline has not been applied yet (`baseline_counted =
   * false`, or the row is missing), this returns the live post-cutover counter
   * immediately and schedules the historical baseline scan in the background.
   * Waiting on that scan used to block `/billing/status` and free-tier
   * admission for tens of seconds on high-volume tenants. Undercounting until
   * the baseline lands is fail-open — the same posture as a COUNT failure.
   */
  async countRequestsSince(tenantId: string | null, monthStartMs: number): Promise<number> {
    if (!tenantId) return 0;
    const windowStartMs = requestQuotaWindowStartMs(monthStartMs);
    const windowStart = toSqlTimestamp(new Date(windowStartMs));
    const rows: Array<{ n: number | string; baseline_counted: boolean }> =
      await this.dataSource.query(
        `SELECT "request_count" AS n, "baseline_counted"
         FROM "tenant_request_usage"
        WHERE "tenant_id" = $1
          AND "window_start" = $2`,
        [tenantId, windowStart],
      );
    if (rows[0]?.baseline_counted) return Number(rows[0].n);

    // Live trigger increments only (or 0 if the row does not exist yet). Kick
    // the one-shot historical baseline off the hot path so dashboard/admission
    // stay O(1) even for large pre-cutover histories.
    this.scheduleRequestUsageInitialization(tenantId, windowStartMs, windowStart);
    return Number(rows[0]?.n ?? 0);
  }

  /** Single-flight background baseline init. Errors are logged, not thrown. */
  private scheduleRequestUsageInitialization(
    tenantId: string,
    windowStartMs: number,
    windowStart: string,
  ): void {
    const initializationKey = `${tenantId}:${windowStart}`;
    if (this.requestUsageInitializations.has(initializationKey)) return;

    const pending = this.initializeRequestUsage(tenantId, windowStartMs, windowStart)
      .then(() => undefined)
      .catch((err: Error) => {
        this.logger.warn(
          `Request usage baseline init failed for tenant ${tenantId}: ${err.message}`,
        );
      })
      .finally(() => {
        if (this.requestUsageInitializations.get(initializationKey) === pending) {
          this.requestUsageInitializations.delete(initializationKey);
        }
      });
    this.requestUsageInitializations.set(initializationKey, pending);
  }

  private async initializeRequestUsage(
    tenantId: string,
    windowStartMs: number,
    windowStart: string,
  ): Promise<number> {
    const cutoverRows: Array<{ cutover_ms: number | string }> = await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM ("completed_at" AT TIME ZONE 'UTC')) * 1000 AS cutover_ms
         FROM "backfill_state"
        WHERE "name" = $1`,
      [REQUEST_USAGE_CUTOVER_STATE],
    );
    const cutoverMs = Number(cutoverRows[0]?.cutover_ms);
    if (!Number.isFinite(cutoverMs)) {
      throw new Error(`Missing request usage cutover state: ${REQUEST_USAGE_CUTOVER_STATE}`);
    }

    let baseline = 0;
    if (windowStartMs < cutoverMs) {
      const storageTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const baselineRows: Array<{ n: number | string }> = await this.dataSource.query(
        `WITH cutover AS (
           SELECT ("completed_at" AT TIME ZONE 'UTC') AT TIME ZONE $3::text AS local_timestamp
             FROM "backfill_state"
            WHERE "name" = $4
         )
         SELECT COUNT(*)::bigint AS n
           FROM (
             SELECT r."id"
               FROM "requests" r
              CROSS JOIN cutover c
              WHERE r."tenant_id" = $1
                AND r."timestamp" >= $2
                AND EXISTS (
                  SELECT 1
                    FROM "agent_messages" pa
                   WHERE pa."request_id" = r."id"
                     AND pa."timestamp" < c.local_timestamp
                     AND (
                       pa."error_origin" IS NULL
                       OR pa."error_origin" NOT IN (${MANIFEST_ERROR_ORIGIN_SQL_LIST})
                     )
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM "agents" a
                   WHERE a."id" = r."agent_id"
                     AND a."is_playground" = true
                )
             UNION ALL
             SELECT m."id"
               FROM "agent_messages" m
              CROSS JOIN cutover c
              WHERE m."tenant_id" = $1
                AND m."request_id" IS NULL
                AND m."timestamp" >= $2
                AND m."timestamp" < c.local_timestamp
                AND COALESCE(m."superseded", false) = false
                AND (
                  m."error_origin" IS NULL
                  OR m."error_origin" NOT IN (${MANIFEST_ERROR_ORIGIN_SQL_LIST})
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM "agents" a
                   WHERE a."id" = m."agent_id"
                     AND a."is_playground" = true
                )
           ) historical`,
        [
          tenantId,
          toLocalSqlTimestamp(new Date(windowStartMs)),
          storageTimeZone,
          REQUEST_USAGE_CUTOVER_STATE,
        ],
      );
      baseline = Number(baselineRows[0]?.n ?? 0);
    }

    const initializedRows: Array<{ n: number | string }> = await this.dataSource.query(
      `INSERT INTO "tenant_request_usage" (
         "tenant_id",
         "window_start",
         "request_count",
         "baseline_counted"
       )
       VALUES ($1, $2, $3, true)
       ON CONFLICT ("tenant_id", "window_start")
       DO UPDATE SET
         "request_count" = "tenant_request_usage"."request_count" +
           CASE
             WHEN "tenant_request_usage"."baseline_counted" THEN 0
             ELSE EXCLUDED."request_count"
           END,
         "baseline_counted" = true
       RETURNING "request_count" AS n`,
      [tenantId, windowStart, baseline],
    );
    return Number(initializedRows[0]?.n ?? baseline);
  }

  private async readRequestStorageTimeZone(): Promise<string> {
    const rows: Array<{ definition: string | null }> = await this.dataSource.query(`
      SELECT pg_get_functiondef(
               to_regprocedure('"count_tenant_request_usage"()')
             ) AS "definition"
    `);
    const storageTimeZone = rows[0]?.definition?.match(
      /(?:OLD|NEW|prior|r)\."timestamp"\s+AT TIME ZONE '([^']+)'/,
    )?.[1];
    if (!storageTimeZone) {
      throw new Error('Could not read request quota timezone from installed trigger');
    }
    return storageTimeZone;
  }

  /** Routed requests for the tenant so far this calendar month (UTC). */
  async countRequestsThisMonth(tenantId: string | null): Promise<number> {
    return this.countRequestsSince(tenantId, this.monthStartMsUtc(new Date()));
  }

  /**
   * Log the fail-open warning at most once per {@link COUNT_FAILURE_WARN_WINDOW_MS},
   * carrying a count of how many were suppressed since the last emit. Keeps a
   * DB outage from turning every proxied request into a log line while still
   * surfacing the true failure rate.
   */
  private warnCountFailureThrottled(tenantId: string | null, err: Error): void {
    const now = Date.now();
    if (now - this.lastCountFailureWarnAtMs < COUNT_FAILURE_WARN_WINDOW_MS) {
      this.suppressedCountFailureWarns++;
      return;
    }
    const suppressed = this.suppressedCountFailureWarns;
    this.suppressedCountFailureWarns = 0;
    this.lastCountFailureWarnAtMs = now;
    const tail =
      suppressed > 0
        ? ` (${suppressed} more suppressed in the last ${COUNT_FAILURE_WARN_WINDOW_MS / 1000}s)`
        : '';
    this.logger.warn(
      `Request-limit usage lookup failed for tenant ${tenantId}; allowing request: ${err.message}${tail}`,
    );
  }

  private warnLimitFailureThrottled(tenantId: string | null, err: Error): void {
    const now = Date.now();
    if (now - this.lastLimitFailureWarnAtMs < LIMIT_FAILURE_WARN_WINDOW_MS) {
      this.suppressedLimitFailureWarns++;
      return;
    }
    const suppressed = this.suppressedLimitFailureWarns;
    this.suppressedLimitFailureWarns = 0;
    this.lastLimitFailureWarnAtMs = now;
    const tail =
      suppressed > 0
        ? ` (${suppressed} more suppressed in the last ${LIMIT_FAILURE_WARN_WINDOW_MS / 1000}s)`
        : '';
    this.logger.warn(
      `Request-limit lookup failed for tenant ${tenantId}; allowing request: ${err.message}${tail}`,
    );
  }

  /**
   * Block a routed request when the tenant is at/over its monthly request cap.
   * Called on the /v1/* proxy admission path BEFORE the request is recorded, so
   * a blocked request never becomes an `agent_messages` row (which would count
   * toward the very limit it hit). Only structured data is thrown; the friendly
   * copy + upgrade link is built in ProxyExceptionFilter.
   */
  async assertWithinRequestLimit(ctx: TenantContext): Promise<void> {
    if (!isBillingEnabled()) return;
    const limits = await this.getLimits(ctx, { failOpen: true });
    if (limits.requestsPerMonth === null) return; // Pro / unlimited
    let used: number;
    try {
      used = await this.countRequestsThisMonth(ctx.tenantId);
    } catch (err) {
      // Fail open: a transient usage lookup failure must never block a request. The
      // limit is a soft Free-tier gate, not a hard financial guard, so erring
      // toward "allow" is correct. The next request retries the count. Warn is
      // throttled so a sustained outage can't flood the log / hot path.
      this.warnCountFailureThrottled(ctx.tenantId, err as Error);
      return;
    }
    if (used < limits.requestsPerMonth) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: 'PLAN_LIMIT_REQUESTS',
        limit: limits.requestsPerMonth,
        used,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  async getBillingStatus(ctx: TenantContext): Promise<BillingStatus> {
    const billingEnabled = isBillingEnabled();
    if (!billingEnabled) {
      return {
        enabled: false,
        plan: 'free',
        priceMonthly: BILLING_PRICE_UNAVAILABLE,
        emailPreferences: DEFAULT_BILLING_EMAIL_PREFERENCES,
        requests: { used: null, limit: null, periodEnd: null },
        cancelAtPeriodEnd: false,
        subscriptionPeriodEnd: null,
      };
    }
    const snapshot = await this.getBillingSnapshot(ctx);
    const limits = this.limitsForSnapshot(snapshot);
    const emailPreferences = normalizeBillingEmailPreferences(snapshot.billingEmailPreferences);
    const now = new Date();
    const [requestsUsed, priceMonthly] = await Promise.all([
      this.countRequestsSince(ctx.tenantId, this.monthStartMsUtc(now)),
      this.getProPrice(),
    ]);
    return {
      enabled: true,
      plan: snapshot.plan,
      priceMonthly,
      emailPreferences,
      requests: {
        used: requestsUsed,
        limit: limits.requestsPerMonth,
        periodEnd: this.nextMonthStartUtc(now).toISOString(),
      },
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      subscriptionPeriodEnd: snapshot.periodEnd,
    };
  }

  async getBillingEmailPreferences(ctx: TenantContext): Promise<BillingEmailPreferences> {
    if (!ctx.tenantId) return DEFAULT_BILLING_EMAIL_PREFERENCES;
    const tenant = await this.findTenant(ctx);
    return normalizeBillingEmailPreferences(tenant?.billing_email_preferences);
  }

  async updateBillingEmailPreferences(
    ctx: TenantContext,
    preferences: BillingEmailPreferences,
  ): Promise<BillingEmailPreferences> {
    if (!ctx.tenantId) {
      throw new BadRequestException('A workspace is required to update billing email preferences.');
    }
    const normalized = normalizeBillingEmailPreferences(preferences);
    await this.tenantRepo.update({ id: ctx.tenantId }, { billing_email_preferences: normalized });
    return normalized;
  }

  /** Display price for the Pro plan, cached; never lets a Stripe outage break the endpoint. */
  private async getProPrice(): Promise<BillingPrice> {
    if (this.priceCache && Date.now() - this.priceCache.fetchedAt < PRICE_CACHE_TTL_MS) {
      return this.priceCache.value;
    }
    try {
      const price = await getStripeClient().prices.retrieve(process.env['STRIPE_PRO_PRICE_ID']!);
      const value = this.stripePriceToBillingPrice(price);
      this.priceCache = { value, fetchedAt: Date.now() };
      return value;
    } catch {
      this.priceCache = { value: BILLING_PRICE_UNAVAILABLE, fetchedAt: Date.now() };
      return BILLING_PRICE_UNAVAILABLE;
    }
  }

  private stripePriceToBillingPrice(price: Stripe.Price): BillingPrice {
    const rawAmount =
      price.unit_amount_decimal ?? (price.unit_amount != null ? String(price.unit_amount) : null);
    const minorAmount = rawAmount != null ? Number(rawAmount) : null;
    return {
      amount:
        minorAmount != null && Number.isFinite(minorAmount)
          ? minorAmount / this.currencyMinorUnitDivisor(price.currency)
          : null,
      currency: price.currency ? price.currency.toUpperCase() : null,
      interval: price.recurring?.interval ?? null,
    };
  }

  private currencyMinorUnitDivisor(currency: string): number {
    try {
      const digits =
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency,
        }).resolvedOptions().maximumFractionDigits ?? 2;
      return 10 ** digits;
    } catch {
      return 100;
    }
  }
}
