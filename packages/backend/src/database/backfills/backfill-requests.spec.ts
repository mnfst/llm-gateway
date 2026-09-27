import {
  runRequestBackfill,
  type RequestBackfillGateway,
  type RequestBackfillTimeouts,
} from './backfill-requests';
import { FINALIZE_PENDING_REQUESTS_SQL } from './backfill-requests.gateway';

describe('runRequestBackfill', () => {
  it('walks bounded windows, throttles, and finalizes only after all rows link', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 1, attempts: 2 }),
      nextWindowEnd: jest
        .fn()
        .mockResolvedValueOnce('b')
        .mockResolvedValueOnce('d')
        .mockResolvedValueOnce(null),
      backfillWindow: jest
        .fn()
        .mockResolvedValueOnce({ requests: 2, attempts: 2, rejections: 0 })
        .mockResolvedValueOnce({ requests: 1, attempts: 1, rejections: 1 }),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      runRequestBackfill(gateway, { batchSize: 2, throttleMs: 5, sleep }),
    ).resolves.toEqual({ windows: 2, requests: 4, attempts: 5, rejections: 1 });

    expect(gateway.backfillFallbackGroups).toHaveBeenCalledWith(
      2,
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
    );
    expect(gateway.nextWindowEnd).toHaveBeenNthCalledWith(1, '', 2, expect.any(String));
    expect(gateway.nextWindowEnd).toHaveBeenNthCalledWith(2, 'b', 2, expect.any(String));
    expect(gateway.backfillWindow).toHaveBeenNthCalledWith(
      1,
      '',
      'b',
      expect.any(String),
      expect.any(Object),
    );
    expect(gateway.backfillWindow).toHaveBeenNthCalledWith(
      2,
      'b',
      'd',
      expect.any(String),
      expect.any(Object),
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(gateway.finalize).toHaveBeenCalledTimes(1);
  });

  it('retries a timeout without advancing the cursor', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValueOnce('b').mockResolvedValueOnce(null),
      backfillWindow: jest
        .fn()
        .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
        .mockResolvedValueOnce({ requests: 1, attempts: 1, rejections: 0 }),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    const result = await runRequestBackfill(gateway, {
      throttleMs: 0,
      retryBackoffMs: 10,
      sleep,
    });

    expect(result.windows).toBe(1);
    expect(gateway.backfillWindow).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('uses defaults when options are omitted', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest.fn().mockResolvedValue(undefined),
    };

    await expect(runRequestBackfill(gateway)).resolves.toEqual({
      windows: 0,
      requests: 0,
      attempts: 0,
      rejections: 0,
    });
  });

  it('finalizes pending outcomes in tail mode', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest.fn(),
    };

    await runRequestBackfill(gateway, {
      analyze: false,
      finalize: true,
    });

    expect(gateway.finalize).toHaveBeenCalledTimes(1);
  });

  it('reports periodic progress and retries finalization', async () => {
    const windowEnds = Array.from({ length: 25 }, (_, index) => `id-${index + 1}`);
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest
        .fn()
        .mockImplementationOnce(async () => windowEnds[0])
        .mockImplementation(async (_afterId: string) => {
          const call = (gateway.nextWindowEnd as jest.Mock).mock.calls.length;
          return windowEnds[call - 1] ?? null;
        }),
      backfillWindow: jest
        .fn()
        .mockRejectedValueOnce('deadlock detected')
        .mockResolvedValue({ requests: 1, attempts: 1, rejections: 0 }),
      finalize: jest
        .fn()
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValueOnce(undefined),
    };
    const sleep = jest.fn().mockResolvedValue(undefined);
    const logger = { log: jest.fn() };

    const result = await runRequestBackfill(gateway, {
      throttleMs: 0,
      retryBackoffMs: 2,
      sleep,
      logger,
    });

    expect(result.windows).toBe(25);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('25 window(s)'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('finalization failed'));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('done'));
    expect(sleep).toHaveBeenCalledWith(2);
  });

  it('uses the real throttle timer when no sleep override is provided', async () => {
    jest.useFakeTimers();
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValueOnce('b').mockResolvedValueOnce(null),
      backfillWindow: jest.fn().mockResolvedValue({ requests: 1, attempts: 1, rejections: 0 }),
      finalize: jest.fn().mockResolvedValue(undefined),
    };

    const resultPromise = runRequestBackfill(gateway, { throttleMs: 1 });
    await jest.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ windows: 1, attempts: 1 }),
    );
    jest.useRealTimers();
  });

  it('uses the configured throttle while staging legacy fallback groups', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn(
        async (
          _batchSize: number,
          _before: string,
          _timeouts: RequestBackfillTimeouts,
          pause: () => Promise<void>,
        ) => {
          await pause();
          return { requests: 0, attempts: 0 };
        },
      ),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest.fn().mockResolvedValue(undefined),
    };

    await runRequestBackfill(gateway, { throttleMs: 5, sleep });

    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('does not retry a non-retryable failure', async () => {
    const failure = new Error('invalid input');
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValue('b'),
      backfillWindow: jest.fn().mockRejectedValue(failure),
      finalize: jest.fn(),
    };

    await expect(runRequestBackfill(gateway, { throttleMs: 0 })).rejects.toBe(failure);
  });

  it('retries a string finalization error', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest
        .fn()
        .mockRejectedValueOnce('deadlock detected')
        .mockResolvedValueOnce(undefined),
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(runRequestBackfill(gateway, { retryBackoffMs: 1, sleep })).resolves.toEqual({
      windows: 0,
      requests: 0,
      attempts: 0,
      rejections: 0,
    });
    expect(gateway.finalize).toHaveBeenCalledTimes(2);
  });

  it('surfaces a non-retryable finalization error', async () => {
    const failure = new Error('invalid final state');
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest.fn().mockResolvedValue({ requests: 0, attempts: 0 }),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest.fn().mockRejectedValue(failure),
    };

    await expect(runRequestBackfill(gateway)).rejects.toBe(failure);
  });

  it('retries legacy fallback regrouping before scanning generic windows', async () => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn().mockResolvedValue(undefined),
      backfillFallbackGroups: jest
        .fn()
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockResolvedValueOnce({ requests: 1, attempts: 3 }),
      nextWindowEnd: jest.fn().mockResolvedValue(null),
      backfillWindow: jest.fn(),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(runRequestBackfill(gateway, { retryBackoffMs: 2, sleep })).resolves.toEqual({
      windows: 0,
      requests: 1,
      attempts: 3,
      rejections: 0,
    });
    expect(sleep).toHaveBeenCalledWith(2);
    expect(gateway.nextWindowEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['batchSize', 0],
    ['batchSize', 1.5],
    ['batchSize', Number.NaN],
    ['batchSize', Number.MAX_SAFE_INTEGER + 1],
    ['throttleMs', -1],
    ['maxRetries', -1],
    ['retryBackoffMs', Number.POSITIVE_INFINITY],
    ['lockTimeoutMs', 0],
    ['statementTimeoutMs', -1],
  ] as const)('rejects invalid %s before touching the gateway', async (name, value) => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn(),
      backfillFallbackGroups: jest.fn(),
      nextWindowEnd: jest.fn(),
      backfillWindow: jest.fn(),
      finalize: jest.fn(),
    };

    await expect(runRequestBackfill(gateway, { [name]: value })).rejects.toThrow(name);
    expect(gateway.analyze).not.toHaveBeenCalled();
  });

  it.each([
    ['before', 'not-a-date', undefined, 'before'],
    ['fallbackBefore', '2026-01-01T00:00:00.000Z', 'not-a-date', 'fallbackBefore'],
    [
      'fallbackBefore ordering',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'must not precede',
    ],
  ])('rejects invalid %s dates', async (_name, before, fallbackBefore, message) => {
    const gateway: RequestBackfillGateway = {
      analyze: jest.fn(),
      backfillFallbackGroups: jest.fn(),
      nextWindowEnd: jest.fn(),
      backfillWindow: jest.fn(),
      finalize: jest.fn(),
    };

    await expect(runRequestBackfill(gateway, { before, fallbackBefore })).rejects.toThrow(message);
    expect(gateway.analyze).not.toHaveBeenCalled();
  });
});

describe('request backfill finalization', () => {
  it('only finalizes backfill-created pending parents', () => {
    expect(FINALIZE_PENDING_REQUESTS_SQL).toContain("r.id LIKE 'legacy-autofix-%'");
    expect(FINALIZE_PENDING_REQUESTS_SQL).toContain("r.id LIKE 'legacy-trace-%'");
    expect(FINALIZE_PENDING_REQUESTS_SQL).toContain('pa.id = r.id');
    expect(FINALIZE_PENDING_REQUESTS_SQL).not.toContain(
      `SELECT id FROM "requests" WHERE status = 'pending'`,
    );
  });
});
