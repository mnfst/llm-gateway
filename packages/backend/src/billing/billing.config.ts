import Stripe from 'stripe';
import { isSelfHosted } from '../common/utils/detect-self-hosted';

/**
 * Billing (Stripe plans + request limits) is active only in cloud mode with
 * full Stripe configuration. Self-hosted installs are always unlimited.
 */
export function isBillingEnabled(): boolean {
  return (
    !isSelfHosted() &&
    !!process.env['STRIPE_SECRET_KEY'] &&
    !!process.env['STRIPE_WEBHOOK_SECRET'] &&
    !!process.env['STRIPE_PRO_PRICE_ID']
  );
}

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(process.env['STRIPE_SECRET_KEY']!);
  }
  return stripeClient;
}
