import { PLAN_LIMITS, type BillingPrice } from 'manifest-shared';

export const FREE_REQUEST_LIMIT = PLAN_LIMITS.free.requestsPerMonth ?? 0;
export const FREE_REQUEST_LIMIT_LABEL = FREE_REQUEST_LIMIT.toLocaleString('en-US');

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
  return formatted ? `${formatted}${billingIntervalSuffix(price)}` : null;
}
