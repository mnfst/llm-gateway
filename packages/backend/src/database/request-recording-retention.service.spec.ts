import { Logger } from '@nestjs/common';
import { isBillingEnabled } from '../billing/billing.config';
import { RequestRecordingRetentionService } from './request-recording-retention.service';

jest.mock('../billing/billing.config', () => ({
  isBillingEnabled: jest.fn(),
}));

const mockedIsBillingEnabled = jest.mocked(isBillingEnabled);

describe('RequestRecordingRetentionService', () => {
  const query = jest.fn();
  const connect = jest.fn();
  const release = jest.fn();
  const queryRunner = { query, connect, release };
  const createQueryRunner = jest.fn(() => queryRunner);
  const get = jest.fn();
  const storage = { delete: jest.fn() };
  let service: RequestRecordingRetentionService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    get.mockReturnValue(null);
    connect.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    storage.delete.mockResolvedValue(undefined);
    mockedIsBillingEnabled.mockReturnValue(true);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('pg_advisory_unlock')) return [{ unlocked: true }];
      if (sql.includes('UPDATE agent_messages')) {
        return [[{ id: 'attempt-1' }], 1];
      }
      return [];
    });
    service = new RequestRecordingRetentionService(
      { createQueryRunner } as never,
      { get } as never,
      storage as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('deletes Free recordings after 7 days and Pro recordings after 365 days', async () => {
    const expired = {
      attempt_id: 'attempt-1',
      storage_key: 'request-recordings/v1/attempt-1.json.gz',
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('FROM agent_messages attempt')) return [expired];
      if (sql.includes('UPDATE agent_messages')) {
        return [[{ id: 'attempt-1' }], 1];
      }
      return [];
    });

    await expect(service.deleteExpiredRecordings()).resolves.toBe(1);

    const planQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agent_messages attempt'),
    );
    expect(planQuery).toBeDefined();
    expect(planQuery![0]).toContain('AND NOT EXISTS');
    expect(planQuery![0]).toContain('AND EXISTS');
    expect(planQuery![0]).toContain("subscription.status IN ('active', 'trialing', 'past_due')");
    expect(planQuery![0]).toContain(
      "AND attempt.timestamp < CURRENT_TIMESTAMP - (LEAST($1::int, $2::int) * INTERVAL '1 day')",
    );
    expect(planQuery![1]).toEqual([7, 365]);
    expect(storage.delete).toHaveBeenCalledWith(expired.storage_key);
    const deleteCall = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE agent_messages'),
    );
    expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[deleteCall]!,
    );
  });

  it('uses one global retention override for every plan', async () => {
    get.mockReturnValue(30);
    service = new RequestRecordingRetentionService(
      { createQueryRunner } as never,
      { get } as never,
      storage as never,
    );

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    const select = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes('FROM agent_messages') &&
        !String(sql).includes('FROM agent_messages attempt'),
    );
    expect(select).toBeDefined();
    expect(select![0]).not.toContain('subscription');
    expect(select![1]).toEqual([30]);
  });

  it('uses the 365-day default outside billing deployments', async () => {
    mockedIsBillingEnabled.mockReturnValue(false);

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM agent_messages'), [365]);
  });

  it('does no work when another replica owns the advisory lock', async () => {
    query.mockResolvedValueOnce([{ acquired: false }]);

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('keeps metadata when object deletion fails so cleanup can retry', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('FROM agent_messages attempt')) {
        return [
          {
            attempt_id: 'attempt-1',
            storage_key: 'request-recordings/v1/attempt-1.json.gz',
          },
        ];
      }
      return [];
    });
    storage.delete.mockRejectedValue(new Error('bucket offline'));

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_messages'))).toBe(
      false,
    );
  });

  it('logs and swallows cleanup failures', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    query.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Request recording retention failed: database unavailable');
    expect(release).toHaveBeenCalled();
  });

  it('logs non-Error cleanup failures', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    query.mockRejectedValueOnce('offline');

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Request recording retention failed: offline');
  });
});
