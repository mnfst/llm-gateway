import { DataSource } from 'typeorm';
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  MIGRATION_LOCK_POLL_MS,
  runMigrationsWithAdvisoryLock,
} from './run-migrations-with-lock';

interface Mocks {
  dataSource: DataSource;
  query: jest.Mock;
  release: jest.Mock;
  connect: jest.Mock;
  runMigrations: jest.Mock;
}

const TRY_LOCK = 'SELECT pg_try_advisory_lock($1::bigint) AS locked';
const UNLOCK = 'SELECT pg_advisory_unlock($1::bigint)';

/** Answers the try-lock with `lockResults` in turn (the last one repeats). */
function build(lockResults: boolean[] = [true]): Mocks {
  let attempt = 0;
  const query = jest.fn((sql: string) => {
    if (sql !== TRY_LOCK) return Promise.resolve(undefined);
    const locked = lockResults[Math.min(attempt++, lockResults.length - 1)];
    return Promise.resolve([{ locked }]);
  });
  const release = jest.fn().mockResolvedValue(undefined);
  const connect = jest.fn().mockResolvedValue(undefined);
  const runMigrations = jest.fn().mockResolvedValue([]);
  const queryRunner = { connect, query, release };
  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    runMigrations,
  } as unknown as DataSource;
  return { dataSource, query, release, connect, runMigrations };
}

describe('runMigrationsWithAdvisoryLock', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('acquires the advisory lock, runs migrations, then unlocks and releases', async () => {
    const m = build();
    await runMigrationsWithAdvisoryLock(m.dataSource);

    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(m.query).toHaveBeenNthCalledWith(1, TRY_LOCK, [MIGRATION_ADVISORY_LOCK_KEY]);
    expect(m.runMigrations).toHaveBeenCalledWith({ transaction: 'each' });
    expect(m.query).toHaveBeenNthCalledWith(2, UNLOCK, [MIGRATION_ADVISORY_LOCK_KEY]);
    expect(m.release).toHaveBeenCalledTimes(1);

    // lock acquired before migrations; migrations before unlock.
    const lockOrder = m.query.mock.invocationCallOrder[0];
    const runOrder = m.runMigrations.mock.invocationCallOrder[0];
    const unlockOrder = m.query.mock.invocationCallOrder[1];
    expect(lockOrder).toBeLessThan(runOrder);
    expect(runOrder).toBeLessThan(unlockOrder);
  });

  it('still unlocks and releases when runMigrations throws, and rethrows', async () => {
    const m = build();
    m.runMigrations.mockRejectedValueOnce(new Error('migration boom'));

    await expect(runMigrationsWithAdvisoryLock(m.dataSource)).rejects.toThrow('migration boom');
    // lock (1) + unlock (2) both ran; runner released.
    expect(m.query).toHaveBeenCalledTimes(2);
    expect(m.query).toHaveBeenNthCalledWith(2, UNLOCK, [MIGRATION_ADVISORY_LOCK_KEY]);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('swallows an unlock failure but still releases the runner', async () => {
    const m = build();
    m.query.mockImplementation((sql: string) =>
      sql === UNLOCK
        ? Promise.reject(new Error('unlock failed'))
        : Promise.resolve([{ locked: true }]),
    );

    await expect(runMigrationsWithAdvisoryLock(m.dataSource)).resolves.toBeUndefined();
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('does not attempt unlock if the lock was never acquired, but still releases', async () => {
    const m = build();
    m.query.mockRejectedValueOnce(new Error('lock failed')); // the first try-lock

    await expect(runMigrationsWithAdvisoryLock(m.dataSource)).rejects.toThrow('lock failed');
    expect(m.runMigrations).not.toHaveBeenCalled();
    // Only the lock attempt ran — no unlock query.
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledTimes(1);
  });

  it('polls without blocking while another deployment holds the lock', async () => {
    // A blocking pg_advisory_lock holds a snapshot for the whole wait, which
    // deadlocks against the holder's CREATE INDEX CONCURRENTLY.
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const m = build([false, false, true]);

    await runMigrationsWithAdvisoryLock(m.dataSource, 0);

    const lockCalls = m.query.mock.calls.filter(([sql]) => sql === TRY_LOCK);
    expect(lockCalls).toHaveLength(3);
    expect(m.query.mock.calls.some(([sql]) => sql === 'SELECT pg_advisory_lock($1::bigint)')).toBe(
      false,
    );
    expect(m.runMigrations).toHaveBeenCalledTimes(1);
    expect(m.runMigrations.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.query.mock.invocationCallOrder[2],
    );
    // One waiting line, not one per poll.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Another deployment holds the migration lock; waiting for it to finish.',
    );
  });

  it('logs the wait again about once a minute', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const m = build([...Array(31).fill(false), true]);

    await runMigrationsWithAdvisoryLock(m.dataSource, 0);

    // Attempts 1 and 31 log.
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('waits between attempts by the poll interval', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const m = build([false, true]);

      const run = runMigrationsWithAdvisoryLock(m.dataSource);
      await jest.advanceTimersByTimeAsync(MIGRATION_LOCK_POLL_MS - 1);
      expect(m.runMigrations).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await run;

      expect(m.runMigrations).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats an empty try-lock answer as not acquired', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const m = build();
    let attempt = 0;
    m.query.mockImplementation((sql: string) =>
      sql === TRY_LOCK
        ? Promise.resolve(attempt++ === 0 ? [] : [{ locked: true }])
        : Promise.resolve(undefined),
    );

    await runMigrationsWithAdvisoryLock(m.dataSource, 0);

    // The empty answer must lead to a second attempt, not to running migrations.
    expect(m.query.mock.calls.filter(([sql]) => sql === TRY_LOCK)).toHaveLength(2);
    expect(m.runMigrations).toHaveBeenCalledTimes(1);
    expect(m.runMigrations.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.query.mock.invocationCallOrder[1],
    );
  });
});
