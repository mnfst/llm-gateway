import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { BackfillState } from '../../entities/backfill-state.entity';
import {
  MESSAGE_PROVIDER_BACKFILL_LOCK_KEY,
  MESSAGE_PROVIDER_BACKFILL_NAME,
  MessageProviderBackfillBootService,
} from './message-provider-backfill.boot.service';

function makeLock(locked: boolean) {
  return {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ locked }] : undefined,
    ),
  };
}

function makeState(completed: boolean) {
  const execute = jest.fn(async () => undefined);
  const orIgnore = jest.fn(() => ({ execute }));
  const values = jest.fn(() => ({ orIgnore }));
  const into = jest.fn(() => ({ values }));
  const insert = jest.fn(() => ({ into }));
  const createQueryBuilder = jest.fn(() => ({ insert }));
  const countBy = jest.fn(async () => (completed ? 1 : 0));
  const repo = { countBy, createQueryBuilder } as unknown as Repository<BackfillState>;
  return { repo, countBy, createQueryBuilder, insert, into, values, orIgnore, execute };
}

const UNLOCK = 'SELECT pg_advisory_unlock($1)';
const TRYLOCK = 'SELECT pg_try_advisory_lock($1) AS locked';

describe('MessageProviderBackfillBootService', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const originalEnv = process.env['NODE_ENV'];
  const originalMode = process.env['MANIFEST_MODE'];

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.env['NODE_ENV'] = originalEnv;
    if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = originalMode;
  });

  describe('onApplicationBootstrap', () => {
    it('does nothing outside production', () => {
      process.env['NODE_ENV'] = 'test';
      const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;
      new MessageProviderBackfillBootService(ds, makeState(false).repo).onApplicationBootstrap();
      expect(ds.createQueryRunner).not.toHaveBeenCalled();
    });

    it('leaves Cloud coordination to the direct request-backfill connection', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['MANIFEST_MODE'] = 'cloud';
      const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;

      new MessageProviderBackfillBootService(ds, makeState(false).repo).onApplicationBootstrap();

      expect(ds.createQueryRunner).not.toHaveBeenCalled();
    });

    it('fires the backfill in production and logs (not throws) on failure', async () => {
      process.env['NODE_ENV'] = 'production';
      const state = makeState(false);
      state.countBy.mockRejectedValue(new Error('db down'));
      const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;

      new MessageProviderBackfillBootService(ds, state.repo).onApplicationBootstrap();
      await new Promise((resolve) => setImmediate(resolve));

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('post-deploy backfill failed'));
    });

    it('waits and retries after advisory-lock contention', async () => {
      jest.useFakeTimers();
      process.env['NODE_ENV'] = 'production';
      const state = makeState(false);
      state.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const lock = makeLock(false);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;

      new MessageProviderBackfillBootService(ds, state.repo).onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(state.countBy).toHaveBeenCalledTimes(2);
      expect(lock.release).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('keeps retrying until the competing backfill completes', async () => {
      jest.useFakeTimers();
      process.env['NODE_ENV'] = 'production';
      const state = makeState(false);
      const lock = makeLock(false);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;

      new MessageProviderBackfillBootService(ds, state.repo).onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30_000 * 12);

      expect(state.countBy.mock.calls.length).toBeGreaterThan(10);
      expect(errSpy).not.toHaveBeenCalled();
      state.countBy.mockResolvedValue(1);
      await jest.advanceTimersByTimeAsync(30_000);
      jest.useRealTimers();
    });
  });

  describe('runOnce', () => {
    it('returns immediately when already marked complete', async () => {
      const state = makeState(true);
      const ds = { createQueryRunner: jest.fn() } as unknown as DataSource;
      const runner = jest.fn();
      await expect(
        new MessageProviderBackfillBootService(ds, state.repo).runOnce(runner),
      ).resolves.toBe(true);
      expect(ds.createQueryRunner).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    });

    it('skips (without unlocking) when another instance holds the advisory lock', async () => {
      const lock = makeLock(false);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
      const runner = jest.fn();
      await expect(
        new MessageProviderBackfillBootService(ds, makeState(false).repo).runOnce(runner),
      ).resolves.toBe(false);
      expect(lock.query).toHaveBeenCalledWith(TRYLOCK, [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY]);
      expect(runner).not.toHaveBeenCalled();
      expect(lock.query).not.toHaveBeenCalledWith(UNLOCK, [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY]);
      expect(lock.release).toHaveBeenCalled();
    });

    it('runs the backfill under the lock, marks complete, then unlocks and releases', async () => {
      const lock = makeLock(true);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
      const state = makeState(false);
      const runner = jest.fn(async () => ({ windows: 3, stamped: 42 }));

      await expect(
        new MessageProviderBackfillBootService(ds, state.repo).runOnce(runner),
      ).resolves.toBe(true);

      expect(runner).toHaveBeenCalledWith(
        ds,
        expect.objectContaining({ logger: expect.anything() }),
      );
      expect(state.values).toHaveBeenCalledWith({ name: MESSAGE_PROVIDER_BACKFILL_NAME });
      expect(state.execute).toHaveBeenCalled();
      expect(lock.query).toHaveBeenCalledWith(UNLOCK, [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY]);
      expect(lock.release).toHaveBeenCalled();
    });

    it('re-checks under the lock and skips the run if a peer finished first', async () => {
      const lock = makeLock(true);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
      const state = makeState(false);
      state.countBy.mockResolvedValueOnce(0).mockResolvedValueOnce(1); // free, then taken
      const runner = jest.fn();

      await expect(
        new MessageProviderBackfillBootService(ds, state.repo).runOnce(runner),
      ).resolves.toBe(true);

      expect(runner).not.toHaveBeenCalled();
      expect(lock.query).toHaveBeenCalledWith(UNLOCK, [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY]);
      expect(lock.release).toHaveBeenCalled();
    });

    it('unlocks and releases even if the backfill throws', async () => {
      const lock = makeLock(true);
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
      const runner = jest.fn(async () => {
        throw new Error('boom');
      });

      await expect(
        new MessageProviderBackfillBootService(ds, makeState(false).repo).runOnce(runner),
      ).rejects.toThrow('boom');
      expect(lock.query).toHaveBeenCalledWith(UNLOCK, [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY]);
      expect(lock.release).toHaveBeenCalled();
    });

    it('swallows an unlock failure in the finally block (still releases, no throw)', async () => {
      const lock = {
        connect: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        query: jest.fn(async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) {
            return [{ locked: true }];
          }
          throw new Error('unlock failed');
        }),
      };
      const ds = { createQueryRunner: jest.fn(() => lock) } as unknown as DataSource;
      const runner = jest.fn(async () => ({ windows: 1, stamped: 1 }));

      await expect(
        new MessageProviderBackfillBootService(ds, makeState(false).repo).runOnce(runner),
      ).resolves.toBe(true);
      expect(lock.release).toHaveBeenCalled();
    });

    it('defaults to the real backfill runner when none is injected', async () => {
      const lock = makeLock(true);
      const ds = {
        createQueryRunner: jest.fn(() => lock),
        // gateway.nextWindowEnd → no rows → backfill completes with zero windows
        query: jest.fn(async (sql: string) =>
          sql.includes('FROM "agent_messages"') ? [{ end_id: null }] : undefined,
        ),
      } as unknown as DataSource;
      const state = makeState(false);

      await new MessageProviderBackfillBootService(ds, state.repo).runOnce();

      expect(state.execute).toHaveBeenCalled(); // ran to completion → marked done
      expect(lock.release).toHaveBeenCalled();
    });
  });
});
