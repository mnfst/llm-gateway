export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  /** Max routed requests per calendar month (UTC); null = unlimited. Enforced on the /v1/* proxy. */
  requestsPerMonth: number | null;
}

/**
 * The Cloud Free plan ended on 2026-11-02. `free` stays the plan id of a tenant
 * without a subscription, and such a tenant routes nothing: every /v1 request
 * is refused with M204 before any provider is contacted. Per-tenant overrides
 * (`tenants.limit_overrides.requestsPerMonth`) and `PLAN_LIMIT_FREE_REQUESTS`
 * can still grant a positive allowance.
 */
export const FREE_PLAN_REQUESTS_PER_MONTH = 0;

export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { requestsPerMonth: FREE_PLAN_REQUESTS_PER_MONTH },
  // Pro is unlimited. null = unlimited, enforced the same way as the self-hosted
  // UNLIMITED_PLAN_LIMITS.
  pro: { requestsPerMonth: null },
};

export const UNLIMITED_PLAN_LIMITS: PlanLimits = { requestsPerMonth: null };

export interface BillingPrice {
  amount: number | null;
  currency: string | null;
  interval: string | null;
}

export interface BillingEmailPreferences {
  usageAlerts: boolean;
}

/**
 * Light plan lookup for surfaces that only gate UI on the tenant's plan
 * (range locks, AuthGuard bootstrap). Deliberately excludes usage and price —
 * consumers that render those use the full {@link BillingStatus}.
 */
export interface BillingPlanStatus {
  enabled: boolean;
  plan: Plan;
}

export interface BillingStatus {
  enabled: boolean;
  plan: Plan;
  priceMonthly: BillingPrice;
  emailPreferences: BillingEmailPreferences;
  requests: { used: number | null; limit: number | null; periodEnd: string | null };
  cancelAtPeriodEnd: boolean;
  subscriptionPeriodEnd: string | null;
}
