import {
  isTransportError,
  isTimeoutError,
  buildTransportErrorResponse,
  describeTransportError,
  getErrorName,
  getErrorMessage,
  getErrorCode,
  getErrorCause,
  sanitizeTransportErrorDetail,
  selectTransportErrorDetail,
  PROVIDER_TRANSPORT_ERROR_STATUS,
  PROVIDER_TIMEOUT_STATUS,
} from '../proxy-transport';

describe('proxy-transport', () => {
  describe('getErrorName', () => {
    it('returns name for Error instances', () => {
      const err = new TypeError('bad');
      expect(getErrorName(err)).toBe('TypeError');
    });

    it('returns undefined for non-Error values', () => {
      expect(getErrorName('string')).toBeUndefined();
      expect(getErrorName(null)).toBeUndefined();
      expect(getErrorName(42)).toBeUndefined();
    });
  });

  describe('getErrorMessage', () => {
    it('returns message from Error instances', () => {
      expect(getErrorMessage(new Error('hello'))).toBe('hello');
    });

    it('returns message from plain objects with string message', () => {
      expect(getErrorMessage({ message: 'obj-msg' })).toBe('obj-msg');
    });

    it('returns undefined for non-string message', () => {
      expect(getErrorMessage({ message: 42 })).toBeUndefined();
    });

    it('returns undefined for null/undefined/non-object', () => {
      expect(getErrorMessage(null)).toBeUndefined();
      expect(getErrorMessage(undefined)).toBeUndefined();
      expect(getErrorMessage(42)).toBeUndefined();
    });
  });

  describe('getErrorCode', () => {
    it('returns code from objects with string code', () => {
      expect(getErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    });

    it('returns undefined for non-string code', () => {
      expect(getErrorCode({ code: 42 })).toBeUndefined();
    });

    it('returns undefined for null/undefined/non-object', () => {
      expect(getErrorCode(null)).toBeUndefined();
      expect(getErrorCode(undefined)).toBeUndefined();
      expect(getErrorCode('str')).toBeUndefined();
    });
  });

  describe('getErrorCause', () => {
    it('returns cause from Error', () => {
      const cause = new Error('root');
      const err = new Error('wrapper', { cause });
      expect(getErrorCause(err)).toBe(cause);
    });

    it('returns undefined when no cause', () => {
      expect(getErrorCause(new Error('no cause'))).toBeUndefined();
    });

    it('returns undefined for non-Error values', () => {
      expect(getErrorCause('string')).toBeUndefined();
      expect(getErrorCause(null)).toBeUndefined();
    });
  });

  describe('isTransportError', () => {
    it('returns true for AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for TimeoutError', () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for "fetch failed" message', () => {
      expect(isTransportError(new Error('fetch failed'))).toBe(true);
    });

    it('returns true for undici "terminated" body errors without a coded cause', () => {
      expect(isTransportError(new TypeError('terminated'))).toBe(true);
    });

    it('does not match "terminated" inside another word', () => {
      expect(isTransportError(new Error('unterminated string'))).toBe(false);
    });

    it('returns true for "failed to parse url" message', () => {
      expect(isTransportError(new TypeError('Failed to parse URL from ...'))).toBe(true);
    });

    it('returns true for ECONNREFUSED code', () => {
      const err = new Error('connect error');
      (err as unknown as { code: string }).code = 'ECONNREFUSED';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for ECONNRESET in cause', () => {
      const cause = new Error('reset');
      (cause as unknown as { code: string }).code = 'ECONNRESET';
      const err = new Error('fetch failed', { cause });
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for network keyword in message', () => {
      expect(isTransportError(new Error('network error'))).toBe(true);
    });

    it('returns true for ENOTFOUND code', () => {
      const err = new Error('dns');
      (err as unknown as { code: string }).code = 'ENOTFOUND';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for EHOSTUNREACH code', () => {
      const err = new Error('host');
      (err as unknown as { code: string }).code = 'EHOSTUNREACH';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for ETIMEDOUT code', () => {
      const err = new Error('timed');
      (err as unknown as { code: string }).code = 'ETIMEDOUT';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns true for UND_ERR_ prefix', () => {
      const err = new Error('request error');
      (err as unknown as { code: string }).code = 'UND_ERR_CONNECT_TIMEOUT';
      expect(isTransportError(err)).toBe(true);
    });

    it('returns false for generic Error', () => {
      expect(isTransportError(new Error('boom'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isTransportError('string')).toBe(false);
    });
  });

  describe('isTimeoutError', () => {
    it('returns true for TimeoutError', () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      expect(isTimeoutError(err)).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isTimeoutError(new Error('timeout'))).toBe(false);
    });
  });

  describe('sanitizeTransportErrorDetail', () => {
    it('redacts key= query params', () => {
      expect(sanitizeTransportErrorDetail('https://api.example.com?key=secret-token')).toBe(
        'https://api.example.com?key=***',
      );
    });

    it('truncates long strings to 500 chars', () => {
      const long = 'a'.repeat(600);
      expect(sanitizeTransportErrorDetail(long)).toHaveLength(500);
    });

    it('passes through clean strings unchanged', () => {
      expect(sanitizeTransportErrorDetail('clean message')).toBe('clean message');
    });
  });

  describe('selectTransportErrorDetail', () => {
    it('returns sanitized message when not generic fetch failed', () => {
      expect(
        selectTransportErrorDetail(new TypeError('Failed to parse URL from url?key=abc')),
      ).toBe('Failed to parse URL from url?key=***');
    });

    it('returns code when message is generic "fetch failed"', () => {
      const err = new Error('fetch failed');
      (err as unknown as { code: string }).code = 'ECONNREFUSED';
      expect(selectTransportErrorDetail(err)).toBe('ECONNREFUSED');
    });

    it('returns undefined when message is generic and no code', () => {
      expect(selectTransportErrorDetail(new Error('fetch failed'))).toBeUndefined();
    });

    it('returns undefined for non-Error values', () => {
      expect(selectTransportErrorDetail(null)).toBeUndefined();
      expect(selectTransportErrorDetail('string')).toBeUndefined();
    });

    it('returns code when no message and code is present', () => {
      expect(selectTransportErrorDetail({ code: 'ENOTFOUND' })).toBe('ENOTFOUND');
    });
  });

  describe('describeTransportError', () => {
    it('returns timeout message for TimeoutError', () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      expect(describeTransportError(err)).toBe('Upstream provider request timed out');
    });

    it('includes detail from error message', () => {
      expect(describeTransportError(new TypeError('Failed to parse URL'))).toBe(
        'Failed to reach upstream provider: Failed to parse URL',
      );
    });

    it('falls back to cause detail', () => {
      const cause = new Error('ECONNREFUSED');
      const err = new Error('fetch failed', { cause });
      expect(describeTransportError(err)).toBe('Failed to reach upstream provider: ECONNREFUSED');
    });

    it('returns generic message when no detail available', () => {
      expect(describeTransportError(new Error('fetch failed'))).toBe(
        'Failed to reach upstream provider',
      );
    });
  });

  describe('buildTransportErrorResponse', () => {
    it('returns 504 for timeout errors', async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      const response = buildTransportErrorResponse(err);

      expect(response.status).toBe(PROVIDER_TIMEOUT_STATUS);
      expect(response.statusText).toBe('Gateway Timeout');
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe('Upstream provider request timed out');
    });

    it('returns 503 for transport errors', async () => {
      const response = buildTransportErrorResponse(new Error('fetch failed'));

      expect(response.status).toBe(PROVIDER_TRANSPORT_ERROR_STATUS);
      expect(response.statusText).toBe('Service Unavailable');
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe('Failed to reach upstream provider');
    });

    it('includes detail in response body', async () => {
      const response = buildTransportErrorResponse(
        new TypeError('Failed to parse URL from https://bad.url'),
      );

      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('Failed to parse URL');
    });
  });
});
