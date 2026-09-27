import {
  AUTOFIX_STATUSES,
  AUTOFIX_STATUS_LABELS,
  deriveAutofixStatus,
} from '../src/autofix-status';

describe('deriveAutofixStatus', () => {
  it('uses null for requests with no recorded Autofix flow', () => {
    expect(deriveAutofixStatus(undefined)).toBeNull();
    expect(deriveAutofixStatus(null)).toBeNull();
  });

  it.each([
    [200, 'retry_succeeded'],
    [299, 'retry_succeeded'],
    [400, 'retry_failed'],
  ] as const)('derives retry status from HTTP %i', (http_status, expected) => {
    expect(deriveAutofixStatus({ chain: [{ origin: 'autofix', http_status }] })).toBe(expected);
  });

  it.each([
    ['resolving', 'resolving'],
    ['no_patch', 'no_patch'],
  ] as const)('preserves the Phoenix %s decision', (phoenix_status, expected) => {
    expect(
      deriveAutofixStatus({
        chain: [{ origin: 'original', http_status: 400, phoenix_status }],
      }),
    ).toBe(expected);
  });

  it('records a retry failure when the patched resend throws', () => {
    expect(
      deriveAutofixStatus({
        chain: [
          {
            origin: 'original',
            http_status: 400,
            phoenix_status: 'patched',
            heal_attempt_id: 'heal-1',
            patch_worked: false,
          },
        ],
      }),
    ).toBe('retry_failed');
  });

  it('uses service_error for an attempted flow without a usable result', () => {
    expect(deriveAutofixStatus({ chain: [] })).toBe('service_error');
    expect(deriveAutofixStatus({ chain: [{ origin: 'original', http_status: 400 }] })).toBe(
      'service_error',
    );
    expect(
      deriveAutofixStatus({
        chain: [{ origin: 'original', http_status: 400, phoenix_status: 'patched' }],
      }),
    ).toBe('service_error');
  });

  it('defines a frontend label for every stored status', () => {
    expect(Object.keys(AUTOFIX_STATUS_LABELS)).toEqual([...AUTOFIX_STATUSES]);
    expect(Object.values(AUTOFIX_STATUS_LABELS)).toEqual([
      'No patch',
      'Resolving',
      'Retry succeeded',
      'Retry failed',
      'Service error',
    ]);
  });
});
