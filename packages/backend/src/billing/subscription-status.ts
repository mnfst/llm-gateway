/**
 * Stripe subscription statuses that keep a tenant on its paid plan.
 *
 * `past_due` is included on purpose: while Stripe retries a failed renewal the
 * subscription is still live. Showing the tenant as Free in that window made
 * the dashboard offer "Upgrade", and better-auth's `subscription.upgrade` only
 * reuses active/trialing/incomplete rows, so checkout started a second
 * subscription next to the one still being retried. Staying Pro sends the user
 * to "Manage billing" instead, where they fix the card on the existing
 * subscription. When the retries run out, Stripe moves it to `canceled` or
 * `unpaid` (per the account's dunning setting), and both drop the tenant to
 * Free.
 */
export const PAID_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** `PAID_SUBSCRIPTION_STATUSES` as a SQL `IN (...)` list of literals. */
export const PAID_SUBSCRIPTION_STATUS_SQL_LIST = PAID_SUBSCRIPTION_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');
