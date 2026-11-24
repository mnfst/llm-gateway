import type { BillingPrice } from 'manifest-shared';

/**
 * The Pro price is tax-exclusive: Stripe Tax adds VAT or sales tax at checkout
 * from the buyer's country. Every place that shows the price says so.
 */
export const PRICE_TAX_SUFFIX = ' + tax';
export const TAX_NOTE = 'Tax is added based on your country.';

export function formatBillingPrice(price: BillingPrice | null | undefined): string | null {
  if (price?.amount == null || !price.currency) return null;
  const wholeAmount = Number.isInteger(price.amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: wholeAmount ? 0 : undefined,
      maximumFractionDigits: wholeAmount ? 0 : undefined,
    }).format(price.amount);
  } catch {
    return `${price.amount.toLocaleString(undefined)} ${price.currency}`;
  }
}

export function billingIntervalSuffix(price: BillingPrice | null | undefined): string {
  if (!price?.interval) return '';
  return price.interval === 'month' ? '/mo' : `/${price.interval}`;
}

export function formatBillingPriceWithInterval(
  price: BillingPrice | null | undefined,
): string | null {
  const formatted = formatBillingPrice(price);
  return formatted ? `${formatted}${billingIntervalSuffix(price)}${PRICE_TAX_SUFFIX}` : null;
}
