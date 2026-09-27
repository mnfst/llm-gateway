import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { BackfillState } from '../../entities/backfill-state.entity';
import * as requestBackfillDataSource from './request-backfill.datasource';
import { MessageProviderBackfillBootService } from './message-provider-backfill.boot.service';
import {
  REQUEST_BACKFILL_GENERIC_GRACE_MS,
  REQUEST_BACKFILL_LOCK_KEY,
  REQUEST_BACKFILL_LOCK_RETRY_MS,
  REQUEST_BACKFILL_NAME,
  REQUEST_BACKFILL_TAIL_INTERVAL_MS,
  REQUEST_TRANSITION_FINALIZATION_NAME,
  RequestBackfillBootService,
} from './request-backfill.boot.service';

function makeLock(locked: boolean) {
  return {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ locked }] : undefined,
    ),
  };
}

function makeState(completed: boolean, transitionFinalized = false) {
  const execute = jest.fn(async () => undefined);
  const orIgnore = jest.fn(() => ({ execute }));
  const values = jest.fn(() => ({ orIgnore }));
  const into = jest.fn(() => ({ values }));
  const insert = jest.fn(() => ({ into }));
  const createQueryBuilder = jest.fn(() => ({ insert }));
  const countBy = jest.fn(async ({ name }: { name: string }) => {
    if (name === REQUEST_TRANSITION_FINALIZATION_NAME) return transitionFinalized ? 1 : 0;
    return completed ? 1 : 0;
  });
  const repo = { countBy, createQueryBuilder } as unknown as Repository<BackfillState>;
  return { repo, countBy, values, execute };
}

describe('RequestBackfillBootService', () => {
  const originalEnv = process.env['NODE_ENV'];
  const originalMode = process.env['MANIFEST_MODE'];
  const originalBackfillUrl = process.env['BACKFILL_DATABASE_URL'];
  const originalMigrationUrl = process.env['MIGRATION_DATABASE_URL'];
  const originalUnpooledUrl = process.env['DATABASE_UNPOOLED_URL'];
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
    if (originalBackfillUrl === undefined) delete process.env['BACKFILL_DATABASE_URL'];
    else process.env['BACKFILL_DATABASE_URL'] = originalBackfillUrl;
    if (originalMigrationUrl === undefined) delete process.env['MIGRATION_DATABASE_URL'];
    else process.env['MIGRATION_DATABASE_URL'] = originalMigrationUrl;
    if (originalUnpooledUrl === undefined) delete process.env['DATABASE_UNPOOLED_URL'];
    else process.env['DATABASE_UNPOOLED_URL'] = originalUnpooledUrl;
    jest.restoreAllMocks();
  });

  it('does nothing outside production', () => {
    process.env['NODE_ENV'] = 'test';
    const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;
    new RequestBackfillBootService(ds, makeState(false).repo).onApplicationBootstrap();
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('uses a separate direct DataSource in cloud production', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'cloud';
    process.env['MIGRATION_DATABASE_URL'] = 'postgres://direct/cloud';
    const appDataSource = { createQueryRunner: jest.fn() } as unknown as DataSource;
    const directState = makeState(true);
    const directDataSource = {
      initialize: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
      isInitialized: true,
      getRepository: jest.fn(() => directState.repo),
      query: jest.fn(async () => [{ present: false }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    const factory = jest
      .spyOn(requestBackfillDataSource, 'createRequestBackfillDataSource')
      .mockReturnValue(directDataSource);
    const providerBackfill = jest
      .spyOn(MessageProviderBackfillBootService.prototype, 'runUntilComplete')
      .mockResolvedValue(undefined);
    const service = new RequestBackfillBootService(appDataSource, makeState(false).repo);

    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(factory).toHaveBeenCalledWith(process.env);
    expect(directDataSource.initialize).toHaveBeenCalled();
    expect(directDataSource.getRepository).toHaveBeenCalledWith(BackfillState);
    expect(providerBackfill).toHaveBeenCalledTimes(1);
    expect(appDataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(directDataSource.query).not.toHaveBeenCalled();
    expect(directDataSource.destroy).toHaveBeenCalledTimes(1);
    await service.onApplicationShutdown();
    expect(directDataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('closes a Cloud direct pool that finishes connecting during shutdown', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'cloud';
    process.env['MIGRATION_DATABASE_URL'] = 'postgres://direct/cloud';
    let finishInitialize!: () => void;
    const directDataSource = {
      initialize: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishInitialize = resolve;
          }),
      ),
      destroy: jest.fn(async () => undefined),
      isInitialized: true,
      getRepository: jest.fn(),
    } as unknown as DataSource;
    jest
      .spyOn(requestBackfillDataSource, 'createRequestBackfillDataSource')
      .mockReturnValue(directDataSource);
    const service = new RequestBackfillBootService(
      { createQueryRunner: jest.fn() } as unknown as DataSource,
      makeState(false).repo,
    );

    service.onApplicationBootstrap();
    await Promise.resolve();
    await service.onApplicationShutdown();
    finishInitialize();
    await new Promise((resolve) => setImmediate(resolve));

    expect(directDataSource.destroy).toHaveBeenCalledTimes(1);
    expect(directDataSource.getRepository).not.toHaveBeenCalled();
  });

  it('retries a self-hosted startup failure without requiring a restart or direct URL', async () => {
    jest.useFakeTimers();
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'selfhosted';
    delete process.env['BACKFILL_DATABASE_URL'];
    delete process.env['MIGRATION_DATABASE_URL'];
    delete process.env['DATABASE_UNPOOLED_URL'];
    const state = makeState(false);
    state.countBy.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1);
    const ds = {
      query: jest.fn(async () => [{ present: false }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    const factory = jest.spyOn(requestBackfillDataSource, 'createRequestBackfillDataSource');
    const service = new RequestBackfillBootService(ds, state.repo);

    try {
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('post-deploy request backfill failed: db down; retrying in 30s'),
      );
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS);

      expect(state.countBy).toHaveBeenCalledTimes(2);
      expect(factory).not.toHaveBeenCalled();
      await service.onApplicationShutdown();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('stops retrying a self-hosted failure during shutdown', async () => {
    jest.useFakeTimers();
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'selfhosted';
    const state = makeState(false);
    state.countBy.mockRejectedValue(new Error('db down'));
    const service = new RequestBackfillBootService(
      { createQueryRunner: jest.fn() } as unknown as DataSource,
      state.repo,
    );

    try {
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(state.countBy).toHaveBeenCalledTimes(1);

      await service.onApplicationShutdown();
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS);

      expect(state.countBy).toHaveBeenCalledTimes(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('recreates the Cloud direct pool after a transient coordinator failure', async () => {
    jest.useFakeTimers();
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'cloud';
    process.env['MIGRATION_DATABASE_URL'] = 'postgres://direct/cloud';
    const failedState = makeState(false);
    failedState.countBy.mockRejectedValue(new Error('connection reset'));
    const completedState = makeState(true);
    const firstDirect = {
      initialize: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
      isInitialized: true,
      getRepository: jest.fn(() => failedState.repo),
    } as unknown as DataSource;
    const secondDirect = {
      initialize: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
      isInitialized: true,
      getRepository: jest.fn(() => completedState.repo),
      query: jest.fn(async () => [{ present: false }]),
    } as unknown as DataSource;
    const factory = jest
      .spyOn(requestBackfillDataSource, 'createRequestBackfillDataSource')
      .mockReturnValueOnce(firstDirect)
      .mockReturnValueOnce(secondDirect);
    const service = new RequestBackfillBootService(
      { createQueryRunner: jest.fn() } as unknown as DataSource,
      makeState(false).repo,
    );

    try {
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(firstDirect.destroy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection reset; retrying in 30s'),
      );

      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(secondDirect.initialize).toHaveBeenCalled();
      expect(completedState.countBy).toHaveBeenCalled();
      await service.onApplicationShutdown();
      expect(secondDirect.destroy).toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('waits and retries when the shared lock is initially busy', async () => {
    jest.useFakeTimers();
    const state = makeState(false);
    state.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const lock = makeLock(false);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;

    try {
      const result = new RequestBackfillBootService(ds, state.repo).runUntilComplete();
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS);
      await result;

      expect(state.countBy).toHaveBeenCalledTimes(2);
      expect(lock.release).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps retrying until the competing backfill completes', async () => {
    jest.useFakeTimers();
    const state = makeState(false);
    const lock = makeLock(false);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;

    try {
      const result = new RequestBackfillBootService(ds, state.repo).runUntilComplete();
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS * 12);

      expect(state.countBy.mock.calls.length).toBeGreaterThan(10);
      expect(errorSpy).not.toHaveBeenCalled();
      state.countBy.mockResolvedValue(1);
      await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_LOCK_RETRY_MS);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns true without taking a lock when already complete', async () => {
    const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;
    const runner = jest.fn();

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runOnce(runner),
    ).resolves.toBe(true);
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns false and releases its connection when the shared lock is busy', async () => {
    const lock = makeLock(false);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
    const runner = jest.fn();

    await expect(
      new RequestBackfillBootService(ds, makeState(false).repo).runOnce(runner),
    ).resolves.toBe(false);
    expect(lock.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS locked', [
      REQUEST_BACKFILL_LOCK_KEY,
    ]);
    expect(runner).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it('passes its logger, marks completion, and releases the shared lock', async () => {
    const lock = makeLock(true);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
    const state = makeState(false);
    const runner = jest.fn(async () => ({ windows: 2, requests: 2, attempts: 3, rejections: 1 }));

    await expect(new RequestBackfillBootService(ds, state.repo).runOnce(runner)).resolves.toBe(
      true,
    );
    expect(runner).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ log: expect.any(Function) }),
      expect.objectContaining({
        analyze: true,
        finalize: true,
        before: expect.any(String),
        fallbackBefore: expect.any(String),
      }),
    );
    expect(state.values).toHaveBeenCalledWith({ name: REQUEST_BACKFILL_NAME });
    expect(state.execute).toHaveBeenCalled();
    expect(lock.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      REQUEST_BACKFILL_LOCK_KEY,
    ]);
    expect(lock.release).toHaveBeenCalled();
  });

  it('re-checks completion after acquiring the lock', async () => {
    const lock = makeLock(true);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
    const state = makeState(false);
    state.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const runner = jest.fn();

    await expect(new RequestBackfillBootService(ds, state.repo).runOnce(runner)).resolves.toBe(
      true,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it('unlocks and releases when the runner fails', async () => {
    const lock = makeLock(true);
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
    const runner = jest.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      new RequestBackfillBootService(ds, makeState(false).repo).runOnce(runner),
    ).rejects.toThrow('boom');
    expect(lock.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      REQUEST_BACKFILL_LOCK_KEY,
    ]);
    expect(lock.release).toHaveBeenCalled();
  });

  it('swallows unlock failures and still releases', async () => {
    const lock = makeLock(true);
    lock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      throw new Error('unlock failed');
    });
    const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;

    await expect(
      new RequestBackfillBootService(ds, makeState(false).repo).runOnce(
        jest.fn().mockResolvedValue({ windows: 0, requests: 0, attempts: 0, rejections: 0 }),
      ),
    ).resolves.toBe(true);
    expect(lock.release).toHaveBeenCalled();
  });

  it('uses the production backfill runner by default', async () => {
    const lock = makeLock(true);
    const transaction = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FALLBACK_PRIMARY_WINDOW_END_SQL')) return [{ end_id: null }];
        if (sql.includes("status = 'fallback_error'") && sql.includes('max(id)')) {
          return [{ end_id: null }];
        }
        if (sql.includes('max(pair_seq)')) return [{ max_seq: 0 }];
        if (sql.includes('INSERT INTO "requests"')) return [{ n: 0 }];
        if (sql.includes('UPDATE "agent_messages"')) return [{ n: 0 }];
        return undefined;
      }),
    };
    const ds = {
      createQueryRunner: jest.fn().mockReturnValueOnce(lock).mockReturnValue(transaction),
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ end_id: null }]),
    } as unknown as DataSource;
    const state = makeState(false);

    await expect(new RequestBackfillBootService(ds, state.repo).runOnce()).resolves.toBe(true);
    expect(state.execute).toHaveBeenCalled();
  });

  it('skips a tail sweep when no grace-aged writes are waiting', async () => {
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    const runner = jest.fn();

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(runner),
    ).resolves.toBe(true);
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports whether any attempts remain unlinked', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ pending: true }])
      .mockResolvedValueOnce([{ pending: false }]);
    const ds = { query } as unknown as DataSource;
    const service = new RequestBackfillBootService(ds, makeState(true).repo);

    await expect(service.hasUnlinkedAttempts()).resolves.toBe(true);
    await expect(service.hasUnlinkedAttempts()).resolves.toBe(false);
  });

  it('tail-sweeps old-replica writes without re-analyzing', async () => {
    const lock = makeLock(true);
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ pending: true }])
      .mockResolvedValueOnce([{ pending: true }]);
    const ds = {
      query,
      createQueryRunner: jest.fn(() => lock),
    } as unknown as DataSource;
    const runner = jest.fn(
      async (
        _dataSource: DataSource,
        _logger: Pick<Logger, 'log'>,
        _options: {
          analyze?: boolean;
          finalize?: boolean;
          before?: string;
          fallbackBefore?: string;
        },
      ) => ({
        windows: 1,
        requests: 1,
        attempts: 2,
        rejections: 0,
      }),
    );

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(runner),
    ).resolves.toBe(true);

    const options = runner.mock.calls[0]![2];
    expect(options).toEqual(
      expect.objectContaining({
        analyze: false,
        finalize: true,
        before: expect.any(String),
        fallbackBefore: expect.any(String),
      }),
    );
    expect(Date.parse(options.fallbackBefore!)).toBeGreaterThan(Date.parse(options.before!));
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), [options.fallbackBefore]);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [options.fallbackBefore]);
    expect(lock.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      REQUEST_BACKFILL_LOCK_KEY,
    ]);
  });

  it('uses the default tail runner only after eligible attempts are found', async () => {
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(),
    ).resolves.toBe(true);
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('returns false when the tail sweep cannot acquire the shared lock', async () => {
    const lock = makeLock(false);
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: true }]),
      createQueryRunner: jest.fn(() => lock),
    } as unknown as DataSource;

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(jest.fn()),
    ).resolves.toBe(false);
    expect(lock.release).toHaveBeenCalled();
  });

  it('rechecks tail eligibility after acquiring the lock', async () => {
    const lock = makeLock(true);
    const ds = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ pending: true }])
        .mockResolvedValueOnce([{ pending: false }]),
      createQueryRunner: jest.fn(() => lock),
    } as unknown as DataSource;
    const runner = jest.fn();

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(runner),
    ).resolves.toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it('swallows tail unlock failures and still releases', async () => {
    const lock = makeLock(true);
    lock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      throw new Error('unlock failed');
    });
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: true }]),
      createQueryRunner: jest.fn(() => lock),
    } as unknown as DataSource;

    await expect(
      new RequestBackfillBootService(ds, makeState(true).repo).runTailOnce(
        jest.fn().mockResolvedValue({ windows: 0, requests: 0, attempts: 0, rejections: 0 }),
      ),
    ).resolves.toBe(true);
    expect(lock.release).toHaveBeenCalled();
  });

  it('skips transition finalization when it is complete or unlinked attempts remain', async () => {
    const completedDataSource = { createQueryRunner: jest.fn() } as unknown as DataSource;
    await expect(
      new RequestBackfillBootService(
        completedDataSource,
        makeState(true, true).repo,
      ).runTransitionFinalizeOnce(jest.fn()),
    ).resolves.toBe(true);
    expect(completedDataSource.createQueryRunner).not.toHaveBeenCalled();

    const pendingDataSource = {
      query: jest.fn().mockResolvedValue([{ pending: true }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    await expect(
      new RequestBackfillBootService(
        pendingDataSource,
        makeState(true).repo,
      ).runTransitionFinalizeOnce(jest.fn()),
    ).resolves.toBe(false);
    expect(pendingDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rechecks transition readiness under the shared lock', async () => {
    const busyLock = makeLock(false);
    const busyDataSource = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn(() => busyLock),
    } as unknown as DataSource;
    await expect(
      new RequestBackfillBootService(
        busyDataSource,
        makeState(true).repo,
      ).runTransitionFinalizeOnce(jest.fn()),
    ).resolves.toBe(false);
    expect(busyLock.release).toHaveBeenCalled();

    const completedLock = makeLock(true);
    const completedState = makeState(true);
    completedState.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const completedDataSource = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn(() => completedLock),
    } as unknown as DataSource;
    const completedRunner = jest.fn();
    await expect(
      new RequestBackfillBootService(
        completedDataSource,
        completedState.repo,
      ).runTransitionFinalizeOnce(completedRunner),
    ).resolves.toBe(true);
    expect(completedRunner).not.toHaveBeenCalled();
    expect(completedLock.release).toHaveBeenCalled();

    const pendingLock = makeLock(true);
    const pendingDataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ pending: false }])
        .mockResolvedValueOnce([{ pending: true }]),
      createQueryRunner: jest.fn(() => pendingLock),
    } as unknown as DataSource;
    await expect(
      new RequestBackfillBootService(
        pendingDataSource,
        makeState(true).repo,
      ).runTransitionFinalizeOnce(jest.fn()),
    ).resolves.toBe(false);
    expect(pendingLock.release).toHaveBeenCalled();
  });

  it('marks transition cleanup complete under the shared lock', async () => {
    const lock = makeLock(true);
    lock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
      throw new Error('unlock failed');
    });
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn(() => lock),
    } as unknown as DataSource;
    const state = makeState(true);
    const runner = jest.fn().mockResolvedValue({ rejections: 4 });

    await expect(
      new RequestBackfillBootService(ds, state.repo).runTransitionFinalizeOnce(runner),
    ).resolves.toBe(true);

    expect(runner).toHaveBeenCalledWith(ds, expect.objectContaining({ log: expect.any(Function) }));
    expect(state.values).toHaveBeenCalledWith({ name: REQUEST_TRANSITION_FINALIZATION_NAME });
    expect(state.execute).toHaveBeenCalled();
    expect(lock.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      REQUEST_BACKFILL_LOCK_KEY,
    ]);
    expect(lock.release).toHaveBeenCalled();
  });

  it('uses the production transition finalizer by default', async () => {
    const lock = makeLock(true);
    const transaction = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    let cleanupBatch = 0;
    transaction.query.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM "agent_messages"')) {
        cleanupBatch += 1;
        return cleanupBatch === 1 ? [{ n: 1 }] : [];
      }
      return undefined;
    });
    const ds = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
      createQueryRunner: jest.fn().mockReturnValueOnce(lock).mockReturnValue(transaction),
    } as unknown as DataSource;
    const state = makeState(true);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await expect(
      new RequestBackfillBootService(ds, state.repo).runTransitionFinalizeOnce(),
    ).resolves.toBe(true);

    expect(logSpy).toHaveBeenCalledWith('request transition: removed 1 staged rejection(s)');
    expect(transaction.query).toHaveBeenCalledWith(
      'ALTER TABLE "agent_messages" VALIDATE CONSTRAINT "FK_agent_messages_request"',
    );
    expect(state.execute).toHaveBeenCalled();
  });

  it('waits through the rolling-deploy grace window before finalizing the transition', async () => {
    jest.useFakeTimers();
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'selfhosted';
    const ds = {
      query: jest.fn().mockResolvedValue([{ present: true }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    const service = new RequestBackfillBootService(ds, makeState(true).repo);
    const tail = jest.spyOn(service, 'runTailOnce').mockResolvedValue(true);
    const finalize = jest.spyOn(service, 'runTransitionFinalizeOnce').mockResolvedValue(true);

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(
      REQUEST_BACKFILL_GENERIC_GRACE_MS - REQUEST_BACKFILL_TAIL_INTERVAL_MS,
    );
    expect(tail).toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_TAIL_INTERVAL_MS);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await service.onApplicationShutdown();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports a self-hosted tail failure and stops the timer on shutdown', async () => {
    jest.useFakeTimers();
    process.env['NODE_ENV'] = 'production';
    process.env['MANIFEST_MODE'] = 'selfhosted';
    const ds = {
      query: jest.fn().mockResolvedValue([{ present: true }]),
      createQueryRunner: jest.fn(),
    } as unknown as DataSource;
    const service = new RequestBackfillBootService(ds, makeState(true).repo);
    const tail = jest.spyOn(service, 'runTailOnce').mockRejectedValue(new Error('tail failed'));

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_TAIL_INTERVAL_MS);

    expect(tail).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('request backfill tail sweep failed'),
    );
    expect(jest.getTimerCount()).toBe(1);
    await service.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
