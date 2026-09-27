import { describe, it, expect } from 'vitest';
import {
  formatNumber,
  formatCost,
  formatPerRequestCost,
  formatTrend,
  formatStatus,
  formatMetricType,
  formatErrorMessage,
  formatErrorOrigin,
  formatErrorClass,
  formatRelativeTime,
  formatTime,
  formatDuration,
  formatTimeAgo,
} from '../../src/services/formatters';

describe('formatNumber', () => {
  it('formats millions', () => {
    expect(formatNumber(1_200_000)).toBe('1.2M');
    expect(formatNumber(5_000_000)).toBe('5M');
  });
  it('formats thousands', () => {
    expect(formatNumber(1_500)).toBe('1.5k');
    expect(formatNumber(304_300)).toBe('304.3k');
  });
  it('returns plain number below 1000', () => {
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(0)).toBe('0');
  });
});

describe('formatCost', () => {
  it('formats with dollar sign and 2 decimals', () => {
    expect(formatCost(6.18)).toBe('$6.18');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(17.5)).toBe('$17.50');
  });
  it('returns null for negative costs (invalid pricing)', () => {
    expect(formatCost(-1527)).toBeNull();
    expect(formatCost(-0.01)).toBeNull();
    expect(formatCost(-9909)).toBeNull();
  });
  it('returns null for non-finite input instead of "$NaN"', () => {
    expect(formatCost(NaN)).toBeNull();
    expect(formatCost(undefined as unknown as number)).toBeNull();
    expect(formatCost(null as unknown as number)).toBe('$0.00');
    expect(formatCost(Infinity)).toBeNull();
  });
  it("returns '< $0.01' for sub-cent positive costs", () => {
    expect(formatCost(0.002836)).toBe('< $0.01');
    expect(formatCost(0.009)).toBe('< $0.01');
    expect(formatCost(0.001)).toBe('< $0.01');
  });
  it('formats costs at or above one cent normally', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.05)).toBe('$0.05');
  });
});

describe('formatPerRequestCost', () => {
  it('formats a per-request cost with 4 decimals', () => {
    expect(formatPerRequestCost(0.013636)).toBe('Included ($0.0136 quota/req)');
    expect(formatPerRequestCost(0.05)).toBe('Included ($0.0500 quota/req)');
  });
  it('returns a floor label for tiny positive costs', () => {
    expect(formatPerRequestCost(0.00001)).toBe('Included (< $0.0001 quota/req)');
  });
  it('returns null for missing, zero, negative, or non-finite values', () => {
    expect(formatPerRequestCost(null)).toBeNull();
    expect(formatPerRequestCost(undefined)).toBeNull();
    expect(formatPerRequestCost(0)).toBeNull();
    expect(formatPerRequestCost(-1)).toBeNull();
    expect(formatPerRequestCost(Number.NaN)).toBeNull();
  });
});

describe('formatTrend', () => {
  it('adds + for positive', () => {
    expect(formatTrend(18.4)).toBe('+18%');
  });
  it('shows - for negative', () => {
    expect(formatTrend(-7.2)).toBe('-7%');
  });
  it('adds + for zero', () => {
    expect(formatTrend(0)).toBe('+0%');
  });
});

describe('formatStatus', () => {
  it('maps known statuses', () => {
    expect(formatStatus('ok')).toBe('Success');
    expect(formatStatus('retry')).toBe('Retried');
    expect(formatStatus('error')).toBe('Failed');
    // A rate limit reads as a plain failure — the Provider pill carries the nuance.
    expect(formatStatus('rate_limited')).toBe('Failed');
    expect(formatStatus('fallback_error')).toBe('Handled');
  });
  it('handles case insensitive', () => {
    expect(formatStatus('OK')).toBe('Success');
    expect(formatStatus('Error')).toBe('Failed');
  });
  it('returns original for unknown status', () => {
    expect(formatStatus('custom')).toBe('custom');
  });
});

describe('formatErrorOrigin', () => {
  it('labels Manifest-side origins distinctly from provider/transport', () => {
    expect(formatErrorOrigin('provider')).toBe('Provider');
    expect(formatErrorOrigin('transport')).toBe('Transport');
    expect(formatErrorOrigin('config')).toBe('Manifest · Setup');
    expect(formatErrorOrigin('policy')).toBe('Manifest · Limit');
    expect(formatErrorOrigin('internal')).toBe('Manifest · Internal');
    expect(formatErrorOrigin('request')).toBe('Manifest · Bad request');
  });
  it('returns null for a missing origin', () => {
    expect(formatErrorOrigin(null)).toBeNull();
    expect(formatErrorOrigin(undefined)).toBeNull();
  });
  it('passes an unknown origin through unchanged', () => {
    expect(formatErrorOrigin('mystery')).toBe('mystery');
  });
});

describe('formatErrorClass', () => {
  it('labels known classes', () => {
    expect(formatErrorClass('rate_limit')).toBe('Rate limit');
    expect(formatErrorClass('billing')).toBe('Billing');
    expect(formatErrorClass('no_provider_key')).toBe('Missing API key');
    expect(formatErrorClass('subscription_credentials_unusable')).toBe('Subscription credentials');
    expect(formatErrorClass('limit_exceeded')).toBe('Limit exceeded');
    expect(formatErrorClass('plan_request_limit_exceeded')).toBe('Plan request limit');
    expect(formatErrorClass('server_error')).toBe('Server error');
  });
  it('returns null for a missing class', () => {
    expect(formatErrorClass(null)).toBeNull();
    expect(formatErrorClass(undefined)).toBeNull();
  });
  it('humanizes an unknown class by de-snaking it', () => {
    expect(formatErrorClass('some_new_thing')).toBe('some new thing');
  });
});

describe('formatMetricType', () => {
  it('maps known metric types', () => {
    expect(formatMetricType('tokens')).toBe('Token usage');
    expect(formatMetricType('cost')).toBe('Cost');
  });
  it('returns original for unknown type', () => {
    expect(formatMetricType('latency')).toBe('latency');
  });
});

describe('formatErrorMessage', () => {
  it('extracts message and code from OpenRouter JSON', () => {
    const raw = '{"error":{"message":"Missing Authentication header","code":401}}';
    expect(formatErrorMessage(raw)).toBe('Missing Authentication header (401)');
  });
  it('extracts message and code from OpenAI-style JSON', () => {
    const raw =
      '{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}';
    expect(formatErrorMessage(raw)).toBe('Invalid API key (invalid_api_key)');
  });
  it('extracts message from Anthropic nested JSON', () => {
    const raw =
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    expect(formatErrorMessage(raw)).toBe('invalid x-api-key (authentication_error)');
  });
  it('extracts message without code when code is absent', () => {
    const raw = '{"error":{"message":"Something went wrong"}}';
    expect(formatErrorMessage(raw)).toBe('Something went wrong');
  });
  it('returns raw string for plain text errors', () => {
    expect(formatErrorMessage('timeout')).toBe('timeout');
    expect(formatErrorMessage('connection refused')).toBe('connection refused');
  });
  it('returns raw string for invalid JSON', () => {
    expect(formatErrorMessage('{bad json')).toBe('{bad json');
  });
});

describe('formatTime', () => {
  it('formats a UTC timestamp with date and time', () => {
    const result = formatTime('2024-01-15T09:22:41Z');
    expect(result).toMatch(/\w+ \d+, \d{2}:\d{2}:\d{2}/);
  });
  it('handles space-separated timestamp', () => {
    const result = formatTime('2024-01-15 09:22:41');
    expect(result).toMatch(/\w+ \d+, \d{2}:\d{2}:\d{2}/);
  });
  it('renders an em dash for an unparseable timestamp', () => {
    // The agents endpoint can fall back to Date.toString() output for
    // never-active harnesses; formatTime must not render "Invalid Date".
    expect(formatTime('Mon Sep 01 2026 14:03:12 GMT+0200 (Central European Summer Time)')).toBe(
      '—',
    );
    expect(formatTime('')).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(423)).toBe('423ms');
    expect(formatDuration(999)).toBe('999ms');
  });
  it('formats durations at or above one second', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(5500)).toBe('5.5s');
  });
});

describe('formatRelativeTime', () => {
  it('returns date+time string for today', () => {
    const now = new Date();
    const ts = now.toISOString();
    const result = formatRelativeTime(ts);
    expect(result).toMatch(/\w+ \d+, \d{2}:\d{2}:\d{2}/);
  });
  it('returns Yesterday for yesterday', () => {
    const yesterday = new Date(Date.now() - 86_400_000 - 1000);
    const ts = yesterday.toISOString();
    const result = formatRelativeTime(ts);
    expect(result).toBe('Yesterday');
  });
  it('returns date for older dates', () => {
    const oldDate = new Date(Date.now() - 5 * 86_400_000);
    const ts = oldDate.toISOString();
    const result = formatRelativeTime(ts);
    expect(result).toMatch(/\w+ \d+/);
  });
});

describe('formatTimeAgo', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(formatTimeAgo(null)).toBeNull();
    expect(formatTimeAgo(undefined)).toBeNull();
    expect(formatTimeAgo('')).toBeNull();
  });
  it('returns null for future timestamps (clock skew)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatTimeAgo(future)).toBeNull();
  });
  it('returns null for unparseable timestamps', () => {
    expect(formatTimeAgo('not-a-date')).toBeNull();
  });
  it('returns "Just now" for timestamps under 45 seconds', () => {
    const ts = new Date(Date.now() - 5_000).toISOString();
    expect(formatTimeAgo(ts)).toBe('Just now');
  });
  it('returns minutes for under-an-hour timestamps', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatTimeAgo(ts)).toBe('5m ago');
  });
  it('returns hours for under-a-day timestamps', () => {
    const ts = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatTimeAgo(ts)).toBe('3h ago');
  });
  it('returns "Yesterday" for timestamps a day old', () => {
    const ts = new Date(Date.now() - 25 * 3_600_000).toISOString();
    expect(formatTimeAgo(ts)).toBe('Yesterday');
  });
  it('returns days ago for timestamps within the last week', () => {
    const ts = new Date(Date.now() - 4 * 86_400_000).toISOString();
    expect(formatTimeAgo(ts)).toBe('4d ago');
  });
  it('falls back to a localized date for older timestamps', () => {
    const ts = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const result = formatTimeAgo(ts);
    expect(result).toMatch(/\w+ \d+/);
  });
  it('accepts the legacy `2026-01-01 12:00:00` (no T, no Z) shape', () => {
    const ts = new Date(Date.now() - 2 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    expect(formatTimeAgo(ts)).toBe('2m ago');
  });
});
