import { DataSource } from 'typeorm';

import {
  createRequestBackfillDataSource,
  main,
  resolveRequestBackfillDatabaseUrl,
} from './request-backfill.cli';
import {
  REQUEST_BACKFILL_GENERIC_GRACE_MS,
  REQUEST_BACKFILL_LOCK_RETRY_MS,
} from './request-backfill.boot.service';

describe('resolveRequestBackfillDatabaseUrl', () => {
  it('prefers explicit direct connection variables', () => {
    expect(
      resolveRequestBackfillDatabaseUrl({
        BACKFILL_DATABASE_URL: 'postgres://backfill/db',
        MIGRATION_DATABASE_URL: 'postgres://migration/db',
        DATABASE_UNPOOLED_URL: 'postgres://unpooled/db',
      }),
    ).toBe('postgres://migration/db');
    expect(
      resolveRequestBackfillDatabaseUrl({
        MIGRATION_DATABASE_URL: '  ',
        DATABASE_UNPOOLED_URL: 'postgres://unpooled/db',
        BACKFILL_DATABASE_URL: 'postgres://backfill/db',
      }),
    ).toBe('postgres://unpooled/db');
    expect(
      resolveRequestBackfillDatabaseUrl({
        DATABASE_UNPOOLED_URL: '',
        BACKFILL_DATABASE_URL: 'postgres://backfill/db',
      }),
    ).toBe('postgres://backfill/db');
  });

  it('refuses the pooled application URL regardless of NODE_ENV', () => {
    expect(() =>
      resolveRequestBackfillDatabaseUrl({
        DATABASE_URL: 'postgres://pgbouncer/db',
      }),
    ).toThrow('A direct PostgreSQL URL is required');
    expect(() => resolveRequestBackfillDatabaseUrl({})).toThrow(
      'set MIGRATION_DATABASE_URL, DATABASE_UNPOOLED_URL, or BACKFILL_DATABASE_URL',
    );
  });
});

describe('createRequestBackfillDataSource', () => {
  it('uses a two-connection direct pool', () => {
    const dataSource = createRequestBackfillDataSource({
      BACKFILL_DATABASE_URL: 'postgres://backfill/db',
    });
    expect(dataSource.options).toEqual(
      expect.objectContaining({
        url: 'postgres://backfill/db',
        extra: { max: 2 },
      }),
    );
  });
});

describe('main', () => {
  function fakeDataSource(): DataSource & {
    initialize: jest.Mock;
    destroy: jest.Mock;
    getRepository: jest.Mock;
    query: jest.Mock;
  } {
    return {
      initialize: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
      getRepository: jest.fn(() => ({ countBy: jest.fn(async () => 1) })),
      query: jest.fn(async () => [{ pending: false }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource & {
      initialize: jest.Mock;
      destroy: jest.Mock;
      getRepository: jest.Mock;
      query: jest.Mock;
    };
  }

  it('runs the initial pass, waits through grace, retries the lock, and catches up', async () => {
    const dataSource = fakeDataSource();
    const coordinator = {
      runUntilComplete: jest.fn(async () => undefined),
      runTailOnce: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      hasUnlinkedAttempts: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      runTransitionFinalizeOnce: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    const sleep = jest.fn(async () => undefined);
    const logger = { log: jest.fn(), error: jest.fn() };

    await main({
      env: {},
      logger,
      dataSource,
      coordinator,
      sleep,
    });

    expect(coordinator.runUntilComplete).toHaveBeenCalled();
    expect(coordinator.hasUnlinkedAttempts).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, REQUEST_BACKFILL_GENERIC_GRACE_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, REQUEST_BACKFILL_LOCK_RETRY_MS);
    expect(sleep).toHaveBeenNthCalledWith(3, REQUEST_BACKFILL_LOCK_RETRY_MS);
    expect(sleep).toHaveBeenNthCalledWith(4, REQUEST_BACKFILL_GENERIC_GRACE_MS);
    expect(coordinator.runTailOnce).toHaveBeenCalledTimes(3);
    expect(coordinator.runTransitionFinalizeOnce).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenLastCalledWith(
      'request/provider-attempt backfill, catch-up, and transition complete',
    );
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('can stop after the historical pass while live writes continue', async () => {
    const dataSource = fakeDataSource();
    const coordinator = {
      runUntilComplete: jest.fn(async () => undefined),
      runTailOnce: jest.fn(),
      hasUnlinkedAttempts: jest.fn(),
      runTransitionFinalizeOnce: jest.fn(),
    };
    const logger = { log: jest.fn(), error: jest.fn() };

    await main({ dataSource, coordinator, logger, initialOnly: true });

    expect(coordinator.runUntilComplete).toHaveBeenCalledTimes(1);
    expect(coordinator.hasUnlinkedAttempts).not.toHaveBeenCalled();
    expect(coordinator.runTailOnce).not.toHaveBeenCalled();
    expect(coordinator.runTransitionFinalizeOnce).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenLastCalledWith(
      'request/provider-attempt historical backfill complete; live-write delta deferred',
    );
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('uses the real coordinator and exits when nothing remains unlinked', async () => {
    const dataSource = fakeDataSource();
    const sleep = jest.fn(async () => undefined);
    await main({ dataSource, sleep, logger: { log: jest.fn(), error: jest.fn() } });

    expect(dataSource.getRepository).toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('destroys the data source when the worker fails', async () => {
    const dataSource = fakeDataSource();
    const failure = new Error('backfill failed');
    const coordinator = {
      runUntilComplete: jest.fn(async () => {
        throw failure;
      }),
      runTailOnce: jest.fn(),
      hasUnlinkedAttempts: jest.fn(),
      runTransitionFinalizeOnce: jest.fn(),
    };

    await expect(main({ dataSource, coordinator })).rejects.toBe(failure);
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('uses a real timer when no sleep dependency is supplied', async () => {
    jest.useFakeTimers();
    const dataSource = fakeDataSource();
    const coordinator = {
      runUntilComplete: jest.fn(async () => undefined),
      runTailOnce: jest.fn(async () => true),
      hasUnlinkedAttempts: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      runTransitionFinalizeOnce: jest.fn(async () => true),
    };
    try {
      const result = main({
        dataSource,
        coordinator,
        logger: { log: jest.fn(), error: jest.fn() },
      });
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_GENERIC_GRACE_MS);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});
