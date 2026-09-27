import {
  buildMinimaxCodeUrl,
  buildMinimaxResourceUrl,
  buildMinimaxTokenUrl,
  DEFAULT_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REGION,
  DEFAULT_RESOURCE_URL,
  getMinimaxBaseUrl,
  getMinimaxOauthBaseUrl,
  getMinimaxResourceUrl,
  isMinimaxRegion,
  isOAuthTokenBlob,
  MINIMAX_BASE_URLS,
  normalizeMinimaxVerificationUri,
  toAbsoluteExpiryTimestamp,
  toPollIntervalMs,
} from './minimax-oauth-helpers';

describe('minimax-oauth-helpers', () => {
  it('exposes the correct default region and base URLs', () => {
    expect(DEFAULT_REGION).toBe('global');
    expect(DEFAULT_BASE_URL).toBe('https://api.minimax.io');
    expect(DEFAULT_RESOURCE_URL).toBe('https://api.minimax.io/anthropic/v1');
    expect(MINIMAX_BASE_URLS.cn).toBe('https://api.minimaxi.com');
  });

  describe('isMinimaxRegion', () => {
    it('accepts the two known regions', () => {
      expect(isMinimaxRegion('global')).toBe(true);
      expect(isMinimaxRegion('cn')).toBe(true);
    });

    it('rejects anything else (including undefined)', () => {
      expect(isMinimaxRegion(undefined)).toBe(false);
      expect(isMinimaxRegion('GLOBAL')).toBe(false);
      expect(isMinimaxRegion('us')).toBe(false);
    });
  });

  describe('URL builders', () => {
    it('defaults getMinimaxBaseUrl to the global region', () => {
      expect(getMinimaxBaseUrl()).toBe(MINIMAX_BASE_URLS.global);
      expect(getMinimaxBaseUrl('cn')).toBe(MINIMAX_BASE_URLS.cn);
    });

    it('builds the code, token and resource URLs as string concatenations', () => {
      expect(buildMinimaxCodeUrl('https://api.minimax.io')).toBe(
        'https://api.minimax.io/oauth/code',
      );
      expect(buildMinimaxTokenUrl('https://api.minimax.io')).toBe(
        'https://api.minimax.io/oauth/token',
      );
      expect(buildMinimaxResourceUrl('https://api.minimax.io')).toBe(
        'https://api.minimax.io/anthropic/v1',
      );
    });
  });

  describe('getMinimaxResourceUrl', () => {
    it('returns null for falsy input', () => {
      expect(getMinimaxResourceUrl(undefined)).toBeNull();
      expect(getMinimaxResourceUrl('')).toBeNull();
    });

    it.each([
      [
        'current global URL',
        'https://api.minimax.io/anthropic/v1',
        'https://api.minimax.io/anthropic/v1',
      ],
      [
        'legacy global URL',
        'https://api.minimax.io/anthropic',
        'https://api.minimax.io/anthropic/v1',
      ],
      [
        'current CN URL',
        'https://api.minimaxi.com/anthropic/v1',
        'https://api.minimaxi.com/anthropic/v1',
      ],
      [
        'legacy CN URL',
        'https://api.minimaxi.com/anthropic',
        'https://api.minimaxi.com/anthropic/v1',
      ],
    ])('normalises a %s through the provider-base-url helper', (_label, resourceUrl, expected) => {
      expect(getMinimaxResourceUrl(resourceUrl)).toBe(expected);
    });
  });

  describe('getMinimaxOauthBaseUrl', () => {
    it('falls back to the default base URL when the resource URL is missing', () => {
      expect(getMinimaxOauthBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
    });

    it('returns the CN origin for a legacy resource URL', () => {
      expect(getMinimaxOauthBaseUrl('https://api.minimaxi.com/anthropic')).toBe(
        'https://api.minimaxi.com',
      );
    });
  });

  describe('toAbsoluteExpiryTimestamp', () => {
    it('treats small numbers as seconds-from-now', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      expect(toAbsoluteExpiryTimestamp(60)).toBe(Date.now() + 60_000);
      jest.useRealTimers();
    });

    it('passes already-absolute millisecond timestamps through unchanged', () => {
      // 10_000_000_001 > 10_000_000_000 threshold → treated as absolute epoch ms.
      expect(toAbsoluteExpiryTimestamp(10_000_000_001)).toBe(10_000_000_001);
    });
  });

  describe('toPollIntervalMs', () => {
    it('falls back to the default for missing or zero/negative values', () => {
      expect(toPollIntervalMs(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(toPollIntervalMs(0)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(toPollIntervalMs(-10)).toBe(DEFAULT_POLL_INTERVAL_MS);
    });

    it('treats values >= 1000 as already in milliseconds', () => {
      expect(toPollIntervalMs(1500)).toBe(1500);
    });

    it('converts small values (assumed to be seconds) to milliseconds', () => {
      expect(toPollIntervalMs(5)).toBe(5000);
    });
  });

  describe('normalizeMinimaxVerificationUri', () => {
    it('rewrites the broken www.minimax.io oauth-authorize host to platform.minimax.io', () => {
      expect(
        normalizeMinimaxVerificationUri(
          'https://www.minimax.io/oauth-authorize?user_code=ABCD-1234&client=OpenClaw',
        ),
      ).toBe('https://platform.minimax.io/oauth-authorize?user_code=ABCD-1234&client=OpenClaw');
    });

    it('rewrites the CN equivalent www.minimaxi.com to platform.minimaxi.com', () => {
      expect(
        normalizeMinimaxVerificationUri(
          'https://www.minimaxi.com/oauth-authorize?user_code=ABCD-1234',
        ),
      ).toBe('https://platform.minimaxi.com/oauth-authorize?user_code=ABCD-1234');
    });

    it('passes through URLs that already point at the correct host', () => {
      const ok = 'https://platform.minimax.io/oauth-authorize?user_code=Y3CN-NY48';
      expect(normalizeMinimaxVerificationUri(ok)).toBe(ok);
    });

    it('passes through unrelated paths even on the broken host', () => {
      const other = 'https://www.minimax.io/something-else?user_code=Y3CN-NY48';
      expect(normalizeMinimaxVerificationUri(other)).toBe(other);
    });

    it('passes through unrelated hosts on the oauth-authorize path', () => {
      const other = 'https://example.com/oauth-authorize?user_code=Y3CN-NY48';
      expect(normalizeMinimaxVerificationUri(other)).toBe(other);
    });

    it('returns the input unchanged when it is not a valid URL', () => {
      expect(normalizeMinimaxVerificationUri('not a url')).toBe('not a url');
    });
  });

  describe('isOAuthTokenBlob', () => {
    it('accepts a valid blob with or without the optional u field', () => {
      expect(isOAuthTokenBlob({ t: 'a', r: 'b', e: 1 })).toBe(true);
      expect(isOAuthTokenBlob({ t: 'a', r: 'b', e: 1, u: 'x' })).toBe(true);
    });

    it('rejects non-objects and nullish values', () => {
      expect(isOAuthTokenBlob(null)).toBe(false);
      expect(isOAuthTokenBlob(undefined)).toBe(false);
      expect(isOAuthTokenBlob('string')).toBe(false);
      expect(isOAuthTokenBlob(42)).toBe(false);
    });

    it('rejects blobs with missing or wrong-typed fields', () => {
      expect(isOAuthTokenBlob({ r: 'b', e: 1 })).toBe(false);
      expect(isOAuthTokenBlob({ t: 'a', e: 1 })).toBe(false);
      expect(isOAuthTokenBlob({ t: 'a', r: 'b' })).toBe(false);
      expect(isOAuthTokenBlob({ t: 'a', r: 'b', e: 'bad' })).toBe(false);
      expect(isOAuthTokenBlob({ t: 'a', r: 'b', e: Number.NaN })).toBe(false);
      expect(isOAuthTokenBlob({ t: 'a', r: 'b', e: 1, u: 42 })).toBe(false);
    });
  });
});
