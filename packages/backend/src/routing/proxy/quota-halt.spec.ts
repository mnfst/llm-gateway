import {
  MAX_QUOTA_RETRY_AFTER_SECONDS,
  MIN_QUOTA_RETRY_AFTER_SECONDS,
  QUOTA_HALT_CODES,
  parseQuotaHalt,
  quotaHaltCooldownTtlMs,
  quotaHaltRetryAfterSeconds,
} from './quota-halt';

// Deterministic "now" so epoch math in assertions stays exact.
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

describe('quota-halt', () => {
  describe('QUOTA_HALT_CODES', () => {
    it('covers the quota-window halts and excludes concurrency/wallet codes', () => {
      expect(QUOTA_HALT_CODES.has(1308)).toBe(true);
      expect(QUOTA_HALT_CODES.has(1310)).toBe(true);
      for (const code of [1316, 1317, 1318, 1319, 1320, 1321]) {
        expect(QUOTA_HALT_CODES.has(code)).toBe(true);
      }
      // Nearby non-halt codes must stay out.
      expect(QUOTA_HALT_CODES.has(1302)).toBe(false);
      expect(QUOTA_HALT_CODES.has(1305)).toBe(false);
      expect(QUOTA_HALT_CODES.has(1113)).toBe(false);
    });
  });

  describe('parseQuotaHalt', () => {
    it('returns null on non-429 status even with a halt body', () => {
      const body = JSON.stringify({ code: 1316, next_flush_time: NOW_S + 30 });
      expect(parseQuotaHalt(500, body, NOW_MS)).toBeNull();
      expect(parseQuotaHalt(403, body, NOW_MS)).toBeNull();
    });

    it('returns null when the body is not JSON', () => {
      expect(parseQuotaHalt(429, '<html>rate limited</html>', NOW_MS)).toBeNull();
      expect(parseQuotaHalt(429, '', NOW_MS)).toBeNull();
    });

    it('returns null for concurrency codes 1302/1305 and wallet code 1113', () => {
      for (const code of [1302, 1305, 1113]) {
        const body = JSON.stringify({ error: { code, next_flush_time: NOW_S + 30 } });
        expect(parseQuotaHalt(429, body, NOW_MS)).toBeNull();
      }
    });

    it('returns null for codes outside the halt set', () => {
      const body = JSON.stringify({ code: 9999, next_flush_time: NOW_S + 30 });
      expect(parseQuotaHalt(429, body, NOW_MS)).toBeNull();
    });

    it('returns null for a halt code with no usable next_flush_time', () => {
      const missing = JSON.stringify({ code: 1316 });
      expect(parseQuotaHalt(429, missing, NOW_MS)).toBeNull();
      const garbage = JSON.stringify({ error: { code: 1316, next_flush_time: 'soon' } });
      expect(parseQuotaHalt(429, garbage, NOW_MS)).toBeNull();
    });

    it('parses a top-level numeric seconds epoch and ceils fractional seconds', () => {
      // 30s window → exactly 30.
      const body = JSON.stringify({ code: 1316, next_flush_time: NOW_S + 30 });
      expect(parseQuotaHalt(429, body, NOW_MS)).toEqual({
        flushMs: NOW_MS + 30_000,
        retryAfterSeconds: 30,
      });
      // 45.5s window → ceil to 46.
      const fractional = JSON.stringify({ code: 1316, next_flush_time: NOW_S + 45.5 });
      expect(parseQuotaHalt(429, fractional, NOW_MS)?.retryAfterSeconds).toBe(46);
    });

    it('parses an error-nested numeric-string milliseconds epoch', () => {
      const body = JSON.stringify({
        error: { code: '1318', next_flush_time: String(NOW_MS + 90_000) },
      });
      expect(parseQuotaHalt(429, body, NOW_MS)).toEqual({
        flushMs: NOW_MS + 90_000,
        retryAfterSeconds: 90,
      });
    });

    it('caps a window beyond the 1h ceiling at MAX_QUOTA_RETRY_AFTER_SECONDS', () => {
      const body = JSON.stringify({ code: 1316, next_flush_time: NOW_S + 7200 });
      const halt = parseQuotaHalt(429, body, NOW_MS);
      expect(halt?.retryAfterSeconds).toBe(MAX_QUOTA_RETRY_AFTER_SECONDS);
      // Identity stays the real flush instant even when the header is capped.
      expect(halt?.flushMs).toBe(NOW_MS + 7_200_000);
    });

    it('floors an already-flushed window at MIN_QUOTA_RETRY_AFTER_SECONDS', () => {
      const body = JSON.stringify({ code: 1310, next_flush_time: NOW_S - 10 });
      const halt = parseQuotaHalt(429, body, NOW_MS);
      expect(halt?.retryAfterSeconds).toBe(MIN_QUOTA_RETRY_AFTER_SECONDS);
    });
  });

  describe('quotaHaltCooldownTtlMs', () => {
    it('returns the bounded window in ms, consistent with the Retry-After header', () => {
      expect(quotaHaltCooldownTtlMs(NOW_MS + 30_000, NOW_MS)).toBe(30_000);
      expect(quotaHaltCooldownTtlMs(NOW_MS + 7_200_000, NOW_MS)).toBe(
        MAX_QUOTA_RETRY_AFTER_SECONDS * 1000,
      );
      expect(quotaHaltCooldownTtlMs(NOW_MS - 10_000, NOW_MS)).toBe(
        MIN_QUOTA_RETRY_AFTER_SECONDS * 1000,
      );
      expect(quotaHaltCooldownTtlMs(NOW_MS + 45_500, NOW_MS)).toBe(46_000);
    });
  });

  describe('quotaHaltRetryAfterSeconds', () => {
    it('ceils and bounds without touching the identity', () => {
      expect(quotaHaltRetryAfterSeconds(NOW_MS + 1500, NOW_MS)).toBe(2);
      expect(quotaHaltRetryAfterSeconds(NOW_MS, NOW_MS)).toBe(1);
    });
  });
});
