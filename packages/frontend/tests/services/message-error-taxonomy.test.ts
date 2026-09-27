import { describe, expect, it } from 'vitest';
import { isPlanRequestLimitMessage } from '../../src/services/message-error-taxonomy';

describe('isPlanRequestLimitMessage', () => {
  it('detects new plan request-limit rows', () => {
    expect(
      isPlanRequestLimitMessage({
        error_origin: 'policy',
        error_class: 'plan_request_limit_exceeded',
        error_http_status: 402,
      }),
    ).toBe(true);
  });

  it('keeps legacy plan request-limit rows upgrade-compatible', () => {
    expect(
      isPlanRequestLimitMessage({
        error_origin: 'policy',
        error_class: 'limit_exceeded',
        routing_reason: 'limit_exceeded',
        error_http_status: 402,
      }),
    ).toBe(true);
  });

  it('does not treat user-configured Limits as plan quota', () => {
    expect(
      isPlanRequestLimitMessage({
        error_origin: 'policy',
        error_class: 'limit_exceeded',
        error_http_status: 429,
      }),
    ).toBe(false);
  });

  it('does not treat provider billing errors as Manifest plan quota', () => {
    expect(
      isPlanRequestLimitMessage({
        error_origin: 'provider',
        error_class: 'billing',
        error_http_status: 402,
      }),
    ).toBe(false);
  });
});
