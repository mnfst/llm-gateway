import { LEGACY_GRACE_STATUS, PAID_SUBSCRIPTION_STATUS_SQL_LIST } from './subscription-status';

/**
 * One-time switch from the former Stripe account (MNFST, Inc.) to the current
 * one (Buddyweb). Run by hand once the new STRIPE_* variables are live; see
 * `stripe-account-migration.cli.ts`.
 *
 * Every Stripe id in the database belongs to the former account, where the
 * current keys cannot see it. The migration:
 *   - detaches each paid subscription: status `legacy_grace`, Stripe ids
 *     cleared, `cancelAtPeriodEnd` set. `PlanService` keeps the tenant on Pro
 *     until `periodEnd`, then the owner subscribes again on the new account.
 *   - clears the Stripe ids of every other subscription row (incomplete,
 *     canceled, unpaid), so better-auth never sends them to the new account.
 *   - clears `user.stripeCustomerId`, so the next upgrade creates a customer
 *     on the new account instead of failing on an unknown customer id.
 *
 * It is idempotent: a second run finds nothing left to change.
 */

export interface SqlRunner {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

export interface TransactionalSqlRunner extends SqlRunner {
  transaction<T>(work: (runner: SqlRunner) => Promise<T>): Promise<T>;
}

export interface PaidSubscriptionRow {
  id: string;
  referenceId: string;
  email: string | null;
  status: string;
  plan: string;
  periodEnd: Date | string | null;
}

export interface StripeAccountMigrationPlan {
  paidSubscriptions: PaidSubscriptionRow[];
  otherSubscriptionRows: number;
  usersWithCustomerId: number;
}

const PAID_WITH_STRIPE_ID = `"status" IN (${PAID_SUBSCRIPTION_STATUS_SQL_LIST}) AND "stripeSubscriptionId" IS NOT NULL`;
const HAS_STRIPE_ID = `("stripeCustomerId" IS NOT NULL OR "stripeSubscriptionId" IS NOT NULL)`;

const SELECT_PAID = `SELECT s."id", s."referenceId", u."email", s."status", s."plan", s."periodEnd"
   FROM "subscription" s
   LEFT JOIN "user" u ON u."id" = s."referenceId"
  WHERE s."status" IN (${PAID_SUBSCRIPTION_STATUS_SQL_LIST}) AND s."stripeSubscriptionId" IS NOT NULL
  ORDER BY s."periodEnd" ASC NULLS FIRST`;

const COUNT_OTHER = `SELECT COUNT(*)::int AS "n" FROM "subscription"
  WHERE ${HAS_STRIPE_ID} AND NOT (${PAID_WITH_STRIPE_ID})`;

const COUNT_USERS = `SELECT COUNT(*)::int AS "n" FROM "user" WHERE "stripeCustomerId" IS NOT NULL`;

export const DETACH_PAID_SQL = `UPDATE "subscription"
    SET "status" = '${LEGACY_GRACE_STATUS}',
        "cancelAtPeriodEnd" = true,
        "stripeCustomerId" = NULL,
        "stripeSubscriptionId" = NULL,
        "stripeScheduleId" = NULL
  WHERE ${PAID_WITH_STRIPE_ID}`;

export const CLEAR_OTHER_SQL = `UPDATE "subscription"
    SET "stripeCustomerId" = NULL,
        "stripeSubscriptionId" = NULL,
        "stripeScheduleId" = NULL
  WHERE ${HAS_STRIPE_ID}`;

export const CLEAR_USERS_SQL = `UPDATE "user" SET "stripeCustomerId" = NULL WHERE "stripeCustomerId" IS NOT NULL`;

export async function planStripeAccountMigration(
  db: SqlRunner,
): Promise<StripeAccountMigrationPlan> {
  const paidSubscriptions = await db.query<PaidSubscriptionRow[]>(SELECT_PAID);
  const [other] = await db.query<Array<{ n: number }>>(COUNT_OTHER);
  const [users] = await db.query<Array<{ n: number }>>(COUNT_USERS);
  return {
    paidSubscriptions,
    otherSubscriptionRows: Number(other?.n ?? 0),
    usersWithCustomerId: Number(users?.n ?? 0),
  };
}

/** Applies the three updates in one transaction, in the order above. */
export async function applyStripeAccountMigration(db: TransactionalSqlRunner): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(DETACH_PAID_SQL);
    await tx.query(CLEAR_OTHER_SQL);
    await tx.query(CLEAR_USERS_SQL);
  });
}

function formatDate(value: Date | string | null): string {
  if (value == null) return 'no period end (loses Pro immediately)';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

export function describeStripeAccountMigration(
  plan: StripeAccountMigrationPlan,
  now: Date = new Date(),
): string[] {
  const lines = [
    `Paid subscriptions to detach (status -> ${LEGACY_GRACE_STATUS}, Pro until period end): ${plan.paidSubscriptions.length}`,
  ];
  for (const row of plan.paidSubscriptions) {
    const end = row.periodEnd == null ? null : new Date(row.periodEnd);
    const expired = end != null && end.getTime() <= now.getTime() ? ' [period already over]' : '';
    lines.push(
      `  - ${row.email ?? row.referenceId} (${row.plan}, ${row.status}): Pro until ${formatDate(row.periodEnd)}${expired}`,
    );
  }
  lines.push(`Other subscription rows with Stripe ids to clear: ${plan.otherSubscriptionRows}`);
  lines.push(`Users with a stripeCustomerId to clear: ${plan.usersWithCustomerId}`);
  return lines;
}
