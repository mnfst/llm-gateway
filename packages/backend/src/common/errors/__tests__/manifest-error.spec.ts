import { HttpStatus } from '@nestjs/common';
import { classifyMessageError, MANIFEST_ERROR_ORIGINS } from 'manifest-shared';
import { MANIFEST_ERRORS, type ManifestErrorCode } from '../error-codes';
import {
  MANIFEST_BLOCKED_REQUEST_REASONS,
  MANIFEST_CODE_TO_REASON,
  ManifestError,
  UNRECORDABLE_MANIFEST_CODES,
  isRecordableManifestCode,
} from '../manifest-error';

describe('ManifestError', () => {
  it('renders the documented message and keeps the code queryable', () => {
    const err = new ManifestError('M300', HttpStatus.BAD_REQUEST);

    expect(err.code).toBe('M300');
    expect(err.getStatus()).toBe(400);
    expect(err.message).toContain('[🦚 Manifest M300]');
    expect(err.message).toContain('`messages` array is required.');
    expect(err.title).toBe('Missing messages array');
  });

  it('interpolates template variables', () => {
    const err = new ManifestError('M100', HttpStatus.OK, {
      provider: 'anthropic',
      dashboardUrl: 'https://app.example/routing',
    });

    expect(err.message).toContain('No anthropic API key yet');
    expect(err.message).toContain('https://app.example/routing');
  });
});

describe('every documented error code is accounted for', () => {
  const allCodes = Object.keys(MANIFEST_ERRORS) as ManifestErrorCode[];

  // The guardrail: a new M### either maps to a recorder reason or is explicitly
  // declared unrecordable. Neither is a silent option.
  it.each(allCodes)('%s is either recordable or explicitly unrecordable', (code) => {
    const recordable = isRecordableManifestCode(code);
    const declaredUnrecordable = (UNRECORDABLE_MANIFEST_CODES as readonly string[]).includes(code);

    expect(recordable || declaredUnrecordable).toBe(true);
    if (recordable) {
      expect(MANIFEST_CODE_TO_REASON[code]).toBeDefined();
    }
  });

  it('only the pre-authentication auth failures are unrecordable', () => {
    expect(UNRECORDABLE_MANIFEST_CODES).toEqual(['M001', 'M002', 'M003', 'M005']);
    // M004 resolves an agent before rejecting, so it must stay recordable.
    expect(isRecordableManifestCode('M004')).toBe(true);
  });

  it('maps every recordable code onto a declared reason', () => {
    for (const reason of Object.values(MANIFEST_CODE_TO_REASON)) {
      expect(MANIFEST_BLOCKED_REQUEST_REASONS).toContain(reason);
    }
  });

  it('classifies every reason as a Manifest origin, never a provider fault', () => {
    for (const reason of MANIFEST_BLOCKED_REQUEST_REASONS) {
      const { error_origin, error_class } = classifyMessageError({
        status: 'error',
        routingReason: reason,
      });

      expect(error_origin).not.toBeNull();
      expect(MANIFEST_ERROR_ORIGINS).toContain(error_origin!);
      expect(error_class).not.toBeNull();
    }
  });

  it('puts a malformed caller body on the request origin, not config or provider', () => {
    const { error_origin, error_class } = classifyMessageError({
      status: 'error',
      errorHttpStatus: 400,
      routingReason: MANIFEST_CODE_TO_REASON.M300,
    });

    expect(error_origin).toBe('request');
    expect(error_class).toBe('invalid_request');
  });

  it('puts an unavailable explicit model on the request origin, not config', () => {
    const { error_origin, error_class } = classifyMessageError({
      status: 'error',
      routingReason: MANIFEST_CODE_TO_REASON.M302,
    });

    expect(error_origin).toBe('request');
    expect(error_class).toBe('not_found');
  });

  it('puts a cloud-inaccessible local provider on the config origin', () => {
    const { error_origin, error_class } = classifyMessageError({
      status: 'error',
      routingReason: MANIFEST_CODE_TO_REASON.M303,
    });

    expect(error_origin).toBe('config');
    expect(error_class).toBe('local_provider_unavailable');
  });

  it('keeps a Manifest internal error off the provider reliability signal', () => {
    const { error_origin } = classifyMessageError({
      status: 'error',
      errorHttpStatus: 500,
      routingReason: MANIFEST_CODE_TO_REASON.M500,
    });

    expect(error_origin).toBe('internal');
  });

  it('separates the three rate limits instead of collapsing them', () => {
    expect(MANIFEST_CODE_TO_REASON.M201).toBe('manifest_rate_limited');
    expect(MANIFEST_CODE_TO_REASON.M202).toBe('manifest_ip_rate_limited');
    expect(MANIFEST_CODE_TO_REASON.M203).toBe('manifest_concurrency_limited');

    const reasons = [
      MANIFEST_CODE_TO_REASON.M201,
      MANIFEST_CODE_TO_REASON.M202,
      MANIFEST_CODE_TO_REASON.M203,
    ];
    expect(new Set(reasons).size).toBe(3);
    for (const reason of reasons) {
      expect(classifyMessageError({ status: 'rate_limited', routingReason: reason })).toMatchObject(
        {
          error_origin: 'policy',
          error_class: 'rate_limit',
        },
      );
    }
  });

  it('classifies an expired key as a setup problem, not a provider auth failure', () => {
    const { error_origin, error_class } = classifyMessageError({
      status: 'error',
      errorHttpStatus: 401,
      routingReason: MANIFEST_CODE_TO_REASON.M004,
    });

    expect(error_origin).toBe('config');
    expect(error_class).toBe('auth');
  });
});
