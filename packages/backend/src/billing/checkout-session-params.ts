import type Stripe from 'stripe';
import { LEGACY_GRACE_STATUS } from './subscription-status';

/**
 * Extra Checkout Session parameters for the Pro upgrade, passed through
 * better-auth's `subscription.getCheckoutSessionParams`.
 *
 * The Pro price is tax-exclusive and Stripe Tax computes VAT from the buyer's
 * address, so Checkout always collects a billing address and lets a business
 * enter its VAT number. `customer_update` saves that address and the business
 * name onto the Stripe customer: Stripe uses the saved address for tax on every
 * renewal, and it needs `name: 'auto'` to store the name a business types next
 * to its tax ID. Stripe accepts `customer_update` only when the session has a
 * `customer`; the plugin always creates or reuses one for a user upgrade.
 *
 * Kept out of `auth.instance.ts` because that module is ESM-only and cannot be
 * loaded by the unit suite.
 */
export const CHECKOUT_TAX_PARAMS = {
  automatic_tax: { enabled: true },
  tax_id_collection: { enabled: true },
  billing_address_collection: 'required',
  customer_update: { address: 'auto', name: 'auto' },
} as const satisfies Stripe.Checkout.SessionCreateParams;

/**
 * Stripe rejects a Checkout `subscription_data.trial_end` less than 48 hours
 * away. Below that, the overlap with the period already paid is at most two
 * days, so the subscription simply starts now.
 */
export const MIN_TRIAL_END_MS = 48 * 60 * 60 * 1000;

interface SubscriptionRow {
  status: string;
  periodEnd?: Date | string | null;
}

/** The slice of better-auth's endpoint context this module reads. */
export interface CheckoutContext {
  context: {
    adapter: {
      findMany<T>(args: {
        model: string;
        where: Array<{ field: string; value: string }>;
      }): Promise<T[]>;
    };
  };
}

/**
 * End of the period a tenant already paid on the former Stripe account, when
 * it is far enough away to start the new subscription as a trial that ends
 * then. Otherwise null.
 */
async function legacyPaidUntil(
  referenceId: string,
  ctx: CheckoutContext | undefined,
  now: number,
): Promise<number | null> {
  if (!ctx) return null;
  const rows = await ctx.context.adapter.findMany<SubscriptionRow>({
    model: 'subscription',
    where: [{ field: 'referenceId', value: referenceId }],
  });
  const ends = rows
    .filter((row) => row.status === LEGACY_GRACE_STATUS && row.periodEnd != null)
    .map((row) => new Date(row.periodEnd!).getTime())
    .filter((end) => end - now >= MIN_TRIAL_END_MS);
  return ends.length > 0 ? Math.max(...ends) : null;
}

/**
 * A subscriber detached from the former account who subscribes again before
 * the end of the period they paid there starts the new subscription as a
 * trial ending on that date, so Stripe charges them once for those days.
 */
export async function getCheckoutSessionParams(
  data?: { user: { id: string } },
  _request?: unknown,
  ctx?: CheckoutContext,
  now: number = Date.now(),
): Promise<{ params: Stripe.Checkout.SessionCreateParams }> {
  const params: Stripe.Checkout.SessionCreateParams = {
    ...CHECKOUT_TAX_PARAMS,
    automatic_tax: { ...CHECKOUT_TAX_PARAMS.automatic_tax },
    tax_id_collection: { ...CHECKOUT_TAX_PARAMS.tax_id_collection },
    customer_update: { ...CHECKOUT_TAX_PARAMS.customer_update },
  };
  const paidUntil = data ? await legacyPaidUntil(data.user.id, ctx, now) : null;
  if (paidUntil != null) {
    params.subscription_data = { trial_end: Math.floor(paidUntil / 1000) };
  }
  return { params };
}
