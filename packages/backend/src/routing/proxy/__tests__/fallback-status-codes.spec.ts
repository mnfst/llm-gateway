import { shouldTriggerFallback } from '../fallback-status-codes';

describe('shouldTriggerFallback', () => {
  it.each([400, 401, 403, 404, 405, 409, 422, 424, 429, 500, 501, 502, 503, 504])(
    'should return true for error status %d',
    (status) => {
      expect(shouldTriggerFallback(status)).toBe(true);
    },
  );

  it.each([200, 201, 204, 301, 302])('should return false for non-error status %d', (status) => {
    expect(shouldTriggerFallback(status)).toBe(false);
  });

  it('should still fallback for provider context length errors', () => {
    expect(shouldTriggerFallback(400)).toBe(true);
  });
});
