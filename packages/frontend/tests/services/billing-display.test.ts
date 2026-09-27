import { describe, expect, it } from 'vitest';
import {
  FREE_REQUEST_LIMIT,
  FREE_REQUEST_LIMIT_LABEL,
  billingIntervalSuffix,
  formatBillingPrice,
  formatBillingPriceWithInterval,
} from '../../src/services/billing-display';

describe('billing-display', () => {
  it('exports the shared free request limit label', () => {
    expect(FREE_REQUEST_LIMIT).toBe(10_000);
    expect(FREE_REQUEST_LIMIT_LABEL).toBe('10,000');
  });

  it('formats whole and fractional Stripe prices with currency', () => {
    expect(formatBillingPrice({ amount: 20, currency: 'USD', interval: 'month' })).toBe('$20');
    expect(formatBillingPrice({ amount: 19.99, currency: 'USD', interval: 'month' })).toBe(
      '$19.99',
    );
  });

  it('falls back when Intl cannot format the currency code', () => {
    expect(formatBillingPrice({ amount: 20, currency: 'NOT_A_CURRENCY', interval: 'month' })).toBe(
      '20 NOT_A_CURRENCY',
    );
  });

  it('returns null for missing price pieces', () => {
    expect(formatBillingPrice(null)).toBeNull();
    expect(formatBillingPrice({ amount: null, currency: 'USD', interval: 'month' })).toBeNull();
    expect(formatBillingPrice({ amount: 20, currency: null, interval: 'month' })).toBeNull();
  });

  it('formats interval suffixes', () => {
    expect(billingIntervalSuffix({ amount: 20, currency: 'USD', interval: 'month' })).toBe('/mo');
    expect(billingIntervalSuffix({ amount: 200, currency: 'USD', interval: 'year' })).toBe('/year');
    expect(billingIntervalSuffix({ amount: 20, currency: 'USD', interval: null })).toBe('');
  });

  it('combines price and interval when both are available', () => {
    expect(formatBillingPriceWithInterval({ amount: 20, currency: 'USD', interval: 'month' })).toBe(
      '$20/mo',
    );
    expect(
      formatBillingPriceWithInterval({ amount: null, currency: 'USD', interval: 'month' }),
    ).toBeNull();
  });
});
