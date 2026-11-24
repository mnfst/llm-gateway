import {
  classifyHttpErrorClass,
  classifyMessageError,
  isManifestErrorOrigin,
  ERROR_CLASSES,
  ERROR_ORIGINS,
  MANIFEST_ERROR_ORIGINS,
  TRANSPORT_NETWORK_HTTP_STATUS,
  TRANSPORT_TIMEOUT_HTTP_STATUS,
  REQUEST_STATUSES,
  ATTEMPT_STATUSES,
  CANCELLED_STATUS,
  PENDING_STATUS,
  SUCCESS_STATUS,
  FAILED_STATUS,
  normalizeStatus,
  isSuccessStatus,
  isFailedStatus,
} from '../src/error-taxonomy';
import { isAnthropicExtraUsageError } from '../src/provider-error-semantics';

describe('error-taxonomy constants', () => {
  it('pins the synthetic transport codes to 503/504', () => {
    expect(TRANSPORT_NETWORK_HTTP_STATUS).toBe(503);
    expect(TRANSPORT_TIMEOUT_HTTP_STATUS).toBe(504);
  });

  it('keeps every manifest origin inside the origin set', () => {
    for (const origin of MANIFEST_ERROR_ORIGINS) {
      expect(ERROR_ORIGINS).toContain(origin);
    }
  });

  it('counts a caller-malformed request as Manifest-originated, not a provider fault', () => {
    // `request` must live in MANIFEST_ERROR_ORIGINS: that membership is what keeps
    // it out of provider_error_rate and inside the `origin=manifest` shorthand.
    expect(MANIFEST_ERROR_ORIGINS).toContain('request');
    expect(ERROR_ORIGINS).toContain('request');
  });

  it('produces only known classes from the HTTP mapper', () => {
    for (const code of [429, 402, 401, 403, 404, 413, 400, 422, 500, 502, 418, 200]) {
      expect(ERROR_CLASSES).toContain(classifyHttpErrorClass(code));
    }
  });
});

describe('classifyHttpErrorClass', () => {
  it.each([
    [429, 'rate_limit'],
    [402, 'billing'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [413, 'payload_too_large'],
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'client_error'],
    [451, 'client_error'],
    [200, 'server_error'],
    [302, 'server_error'],
  ])('maps HTTP %s to class %s', (code, expected) => {
    expect(classifyHttpErrorClass(code)).toBe(expected);
  });
});

describe('classifyMessageError', () => {
  it('does not classify a pending operation as an error', () => {
    expect(classifyMessageError({ status: 'pending' })).toEqual({
      error_origin: null,
      error_class: null,
      superseded: false,
    });
  });
  it('classifies an ok row as no error and never superseded', () => {
    expect(classifyMessageError({ status: 'ok', errorHttpStatus: 200 })).toEqual({
      error_origin: null,
      error_class: null,
      superseded: false,
    });
  });

  it.each([
    ['no_provider', 'config', 'no_provider'],
    ['no_provider_key', 'config', 'no_provider_key'],
    ['subscription_credentials_unusable', 'config', 'subscription_credentials_unusable'],
    ['local_provider_unavailable', 'config', 'local_provider_unavailable'],
    ['key_expired', 'config', 'auth'],
    ['limit_exceeded', 'policy', 'limit_exceeded'],
    ['plan_request_limit_exceeded', 'policy', 'plan_request_limit_exceeded'],
    ['manifest_rate_limited', 'policy', 'rate_limit'],
    ['manifest_ip_rate_limited', 'policy', 'rate_limit'],
    ['manifest_concurrency_limited', 'policy', 'rate_limit'],
    ['provider_cooldown', 'policy', 'rate_limit'],
    ['manifest_invalid_request', 'request', 'invalid_request'],
    ['model_not_available', 'request', 'not_found'],
    ['manifest_internal_error', 'internal', 'internal'],
    // Legacy alias, kept so rows written before the rename keep classifying.
    ['friendly_error', 'internal', 'internal'],
  ])('maps the Manifest reason %s to %s/%s', (reason, origin, klass) => {
    expect(classifyMessageError({ status: 'error', routingReason: reason })).toEqual({
      error_origin: origin,
      error_class: klass,
      superseded: false,
    });
  });

  it('treats a 429 status as a provider rate limit even without a numeric code', () => {
    expect(classifyMessageError({ status: 'rate_limited', errorHttpStatus: null })).toEqual({
      error_origin: 'provider',
      error_class: 'rate_limit',
      superseded: false,
    });
  });

  it('classifies a rate_limited row carrying the numeric 429 as provider/rate_limit', () => {
    expect(classifyMessageError({ status: 'rate_limited', errorHttpStatus: 429 })).toEqual({
      error_origin: 'provider',
      error_class: 'rate_limit',
      superseded: false,
    });
  });

  it('maps the synthetic 504 to transport/timeout', () => {
    expect(classifyMessageError({ status: 'error', errorHttpStatus: 504 })).toEqual({
      error_origin: 'transport',
      error_class: 'timeout',
      superseded: false,
    });
  });

  it('maps the synthetic 503 to transport/network', () => {
    expect(classifyMessageError({ status: 'error', errorHttpStatus: 503 })).toEqual({
      error_origin: 'transport',
      error_class: 'network',
      superseded: false,
    });
  });

  it('classifies a numeric provider code as a provider error', () => {
    expect(classifyMessageError({ status: 'error', errorHttpStatus: 500 })).toEqual({
      error_origin: 'provider',
      error_class: 'server_error',
      superseded: false,
    });
  });

  it('classifies Anthropic extra-usage exhaustion as billing while preserving HTTP 400', () => {
    expect(
      classifyMessageError({
        status: 'error',
        errorHttpStatus: 400,
        provider: 'anthropic',
        errorMessage: JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'You are out of extra usage. Add more at claude.ai to keep going.',
          },
        }),
      }),
    ).toEqual({
      error_origin: 'provider',
      error_class: 'billing',
      superseded: false,
    });
  });

  it('classifies an errored row with no captured HTTP status as transport/network', () => {
    expect(classifyMessageError({ status: 'error', errorHttpStatus: null })).toEqual({
      error_origin: 'transport',
      error_class: 'network',
      superseded: false,
    });
  });

  it('defaults a missing errorHttpStatus to transport/network', () => {
    expect(classifyMessageError({ status: 'error' })).toEqual({
      error_origin: 'transport',
      error_class: 'network',
      superseded: false,
    });
  });

  it('marks a fallback_error row as superseded while still classifying its cause', () => {
    expect(classifyMessageError({ status: 'fallback_error', errorHttpStatus: 500 })).toEqual({
      error_origin: 'provider',
      error_class: 'server_error',
      superseded: true,
    });
  });

  it('marks an auto_fixed row (healed original) as superseded while classifying its cause', () => {
    // The failed original of a healed request was recovered by the retry, so it
    // must not count as a live fault — same as fallback_error.
    expect(classifyMessageError({ status: 'auto_fixed', errorHttpStatus: 400 })).toEqual({
      error_origin: 'provider',
      error_class: 'invalid_request',
      superseded: true,
    });
  });

  it('marks a fallback_error row with no HTTP status as superseded transport/network', () => {
    expect(classifyMessageError({ status: 'fallback_error', errorHttpStatus: null })).toEqual({
      error_origin: 'transport',
      error_class: 'network',
      superseded: true,
    });
  });

  it('lets a Manifest reason win over an incidental HTTP status on a superseded row', () => {
    expect(
      classifyMessageError({
        status: 'fallback_error',
        routingReason: 'no_provider_key',
        errorHttpStatus: 500,
      }),
    ).toEqual({ error_origin: 'config', error_class: 'no_provider_key', superseded: true });
  });

  it('keeps legacy 402 request-quota rows distinct from user-configured limits', () => {
    expect(
      classifyMessageError({
        status: 'error',
        routingReason: 'limit_exceeded',
        errorHttpStatus: 402,
      }),
    ).toEqual({
      error_origin: 'policy',
      error_class: 'plan_request_limit_exceeded',
      superseded: false,
    });
  });
});

describe('isAnthropicExtraUsageError', () => {
  const errorBody = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: "You're out of extra usage. Add more at claude.ai to keep going.",
    },
  });

  it('matches the Anthropic 400 invalid-request billing envelope', () => {
    expect(
      isAnthropicExtraUsageError({
        provider: 'anthropic',
        httpStatus: 400,
        errorBody,
      }),
    ).toBe(true);
  });

  it('matches a top-level Anthropic error envelope', () => {
    expect(
      isAnthropicExtraUsageError({
        provider: 'anthropic',
        httpStatus: 400,
        errorBody: JSON.stringify({
          type: 'invalid_request_error',
          message: 'You are out of extra usage.',
        }),
      }),
    ).toBe(true);
  });

  it.each([
    ['openai', 400, errorBody],
    ['anthropic', 429, errorBody],
    ['anthropic', 400, ''],
    ['anthropic', 400, 'null'],
    ['anthropic', 400, 'not json'],
    [
      'anthropic',
      400,
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'max_tokens is required' },
      }),
    ],
    [
      'anthropic',
      400,
      JSON.stringify({
        error: { type: 'rate_limit_error', message: 'You are out of extra usage.' },
      }),
    ],
  ])('does not match unrelated provider errors', (provider, httpStatus, body) => {
    expect(
      isAnthropicExtraUsageError({
        provider,
        httpStatus,
        errorBody: body,
      }),
    ).toBe(false);
  });
});

describe('isManifestErrorOrigin', () => {
  it.each(['config', 'policy', 'internal'])('returns true for the manifest origin %s', (origin) => {
    expect(isManifestErrorOrigin(origin)).toBe(true);
  });

  it.each(['provider', 'transport'])('returns false for the provider-side origin %s', (origin) => {
    expect(isManifestErrorOrigin(origin)).toBe(false);
  });

  it('returns false for null / undefined / unknown', () => {
    expect(isManifestErrorOrigin(null)).toBe(false);
    expect(isManifestErrorOrigin(undefined)).toBe(false);
    expect(isManifestErrorOrigin('nonsense')).toBe(false);
  });
});

describe('canonical status vocabulary', () => {
  it('pins the canonical request and attempt statuses', () => {
    expect(REQUEST_STATUSES).toEqual([
      PENDING_STATUS,
      CANCELLED_STATUS,
      SUCCESS_STATUS,
      FAILED_STATUS,
    ]);
    expect(ATTEMPT_STATUSES).toEqual([
      PENDING_STATUS,
      CANCELLED_STATUS,
      SUCCESS_STATUS,
      FAILED_STATUS,
    ]);
    expect([PENDING_STATUS, CANCELLED_STATUS, SUCCESS_STATUS, FAILED_STATUS]).toEqual([
      'pending',
      'cancelled',
      'success',
      'failed',
    ]);
  });

  describe('normalizeStatus', () => {
    it('keeps pending', () => {
      expect(normalizeStatus('pending')).toBe('pending');
    });

    it('keeps cancelled', () => {
      expect(normalizeStatus('cancelled')).toBe('cancelled');
    });

    it('maps legacy and canonical success onto success', () => {
      expect(normalizeStatus('ok')).toBe('success');
      expect(normalizeStatus('success')).toBe('success');
    });

    it('treats nullish as success (legacy absent-status convention)', () => {
      expect(normalizeStatus(null)).toBe('success');
      expect(normalizeStatus(undefined)).toBe('success');
    });

    it.each(['error', 'rate_limited', 'fallback_error', 'auto_fixed', 'failed', 'anything-else'])(
      'collapses %s onto failed',
      (value) => {
        expect(normalizeStatus(value)).toBe('failed');
      },
    );
  });

  describe('isSuccessStatus / isFailedStatus', () => {
    it('recognizes success across vocabularies', () => {
      expect(isSuccessStatus('ok')).toBe(true);
      expect(isSuccessStatus('success')).toBe(true);
      expect(isSuccessStatus(null)).toBe(true);
      expect(isSuccessStatus('error')).toBe(false);
      expect(isSuccessStatus('failed')).toBe(false);
      expect(isSuccessStatus('cancelled')).toBe(false);
    });

    it('recognizes failure across vocabularies', () => {
      expect(isFailedStatus('error')).toBe(true);
      expect(isFailedStatus('fallback_error')).toBe(true);
      expect(isFailedStatus('failed')).toBe(true);
      expect(isFailedStatus('cancelled')).toBe(false);
      expect(isFailedStatus('ok')).toBe(false);
      expect(isFailedStatus('pending')).toBe(false);
    });
  });

  it('classifyMessageError short-circuits the canonical success value', () => {
    expect(classifyMessageError({ status: 'success' })).toEqual({
      error_origin: null,
      error_class: null,
      superseded: false,
    });
  });
});
