import type Stripe from 'stripe';

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

export function getCheckoutSessionParams(): { params: Stripe.Checkout.SessionCreateParams } {
  return {
    params: {
      ...CHECKOUT_TAX_PARAMS,
      automatic_tax: { ...CHECKOUT_TAX_PARAMS.automatic_tax },
      tax_id_collection: { ...CHECKOUT_TAX_PARAMS.tax_id_collection },
      customer_update: { ...CHECKOUT_TAX_PARAMS.customer_update },
    },
  };
}
