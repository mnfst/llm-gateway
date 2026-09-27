export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  /** Max routed requests per calendar month (UTC); null = unlimited. Enforced on the /v1/* proxy. */
  requestsPerMonth: number | null;
}

export const FREE_PLAN_REQUESTS_PER_MONTH = 10_000;

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
