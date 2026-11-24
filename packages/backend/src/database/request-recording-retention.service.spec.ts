import { Logger } from '@nestjs/common';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { RequestRecordingRetentionService } from './request-recording-retention.service';

jest.mock('../common/utils/detect-self-hosted', () => ({
  isSelfHosted: jest.fn(),
}));

const mockedIsSelfHosted = jest.mocked(isSelfHosted);

describe('RequestRecordingRetentionService', () => {
  const query = jest.fn();
  const connect = jest.fn();
  const release = jest.fn();
  const queryRunner = { query, connect, release };
  const createQueryRunner = jest.fn(() => queryRunner);
  const get = jest.fn();
  const storage = { delete: jest.fn() };
  const expired = {
    attempt_id: 'attempt-1',
    storage_key: 'request-recordings/v1/attempt-1.json.gz',
  };
  let warn: jest.SpyInstance;

  const build = () =>
    new RequestRecordingRetentionService(
      { createQueryRunner } as never,
      { get } as never,
      storage as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mockedIsSelfHosted.mockReturnValue(true);
    get.mockReturnValue(30);
    connect.mockResolvedValue(undefined);
    release.mockResolvedValue(undefined);
    storage.delete.mockResolvedValue(undefined);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('FROM agent_messages')) return [expired];
      if (sql.includes('UPDATE agent_messages')) return [[{ id: 'attempt-1' }], 1];
      return [];
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('never deletes on Manifest Cloud, even when a retention window is configured', async () => {
    mockedIsSelfHosted.mockReturnValue(false);
    const service = build();

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'REQUEST_RECORDING_RETENTION_DAYS is ignored on Manifest Cloud: request recordings are never deleted',
    );
  });

  it('never deletes on Manifest Cloud without a retention window', async () => {
    mockedIsSelfHosted.mockReturnValue(false);
    get.mockReturnValue(undefined);
    const service = build();

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps every self-hosted recording when the operator sets no retention window', async () => {
    get.mockReturnValue(null);
    const service = build();

    await expect(service.deleteExpiredRecordings()).resolves.toBe(0);

    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes self-hosted recordings past the operator window, object before pointer', async () => {
    const service = build();

    await expect(service.deleteExpiredRecordings()).resolves.toBe(1);

    const select = query.mock.calls.find(([sql]) => String(sql).includes('FROM agent_messages'));
    expect(select).toBeDefined();
    expect(select![0]).not.toContain('subscription');
    expect(select![1]).toEqual([30]);
    expect(storage.delete).toHaveBeenCalledWith(expired.storage_key);
    const pointerUpdate = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE agent_messages'),
    );
    expect(storage.delete.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[pointerUpdate]!,
    );
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Deleted 1 expired Provider Attempt recording(s)',
    );
  });

  it('counts pointer rows returned without the affected-count tuple', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('FROM agent_messages')) return [expired];
      if (sql.includes('UPDATE agent_messages')) return [{ id: 'attempt-1' }];
      return [];
    });

    await expect(build().deleteExpiredRecordings()).resolves.toBe(1);
  });

  it('ignores unlock and release failures after a run', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.includes('pg_advisory_unlock')) throw new Error('connection dropped');
      return [];
    });
    release.mockRejectedValue(new Error('already released'));

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);
  });

  it('does no work when another replica owns the advisory lock', async () => {
    query.mockResolvedValueOnce([{ acquired: false }]);

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('keeps metadata when object deletion fails so cleanup can retry', async () => {
    storage.delete.mockRejectedValue(new Error('bucket offline'));

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);

    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_messages'))).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      'Could not delete Provider Attempt recording attempt-1: bucket offline',
    );
  });

  it('logs non-Error object deletion failures', async () => {
    storage.delete.mockRejectedValue('offline');

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(
      'Could not delete Provider Attempt recording attempt-1: offline',
    );
  });

  it('logs and swallows cleanup failures', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    query.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Request recording retention failed: database unavailable');
    expect(release).toHaveBeenCalled();
  });

  it('logs non-Error cleanup failures', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    query.mockRejectedValueOnce('offline');

    await expect(build().deleteExpiredRecordings()).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith('Request recording retention failed: offline');
  });
});
