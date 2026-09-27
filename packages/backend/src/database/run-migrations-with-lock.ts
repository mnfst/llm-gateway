import { DataSource } from 'typeorm';

/**
 * Fixed key for the migration advisory lock. Every Manifest process that runs
 * migrations (the pre-deploy step, Railway replicas across regions, overlapping
 * deployments) contends on this one key, so migrations run strictly one at a
 * time instead of deadlocking while acquiring DDL locks on the high-churn
 * agent_messages table (the multi-replica deploy deadlock this guards against).
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 4011985;

/** How long a waiting runner sleeps between lock attempts. */
export const MIGRATION_LOCK_POLL_MS = 2_000;

/** Log a waiting line about once a minute, not on every poll. */
const WAIT_LOG_EVERY = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run pending migrations while holding a PostgreSQL session advisory lock, so
 * concurrent runners serialize: the first holder applies every pending
 * migration; the others wait for the lock, then find nothing pending and no-op.
 *
 * Waiters poll `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`.
 * A blocked statement holds a snapshot for as long as it waits, and
 * `CREATE INDEX CONCURRENTLY` waits for every older snapshot to end. With two
 * overlapping deployments, the holder's index build waited on the waiter while
 * the waiter waited on the holder's lock: a deadlock Postgres cannot see,
 * because the lock and the build are two connections of the same process
 * (production, 2026-09-23). A poll is a short statement, so no snapshot
 * outlives it.
 *
 * The lock is session-scoped, so this MUST run over a direct connection (the
 * migration DataSource uses MIGRATION_DATABASE_URL, not the PgBouncer pool —
 * transaction pooling would not preserve a session lock).
 */
export async function runMigrationsWithAdvisoryLock(
  dataSource: DataSource,
  pollMs: number = MIGRATION_LOCK_POLL_MS,
): Promise<void> {
  // Dedicated connection holds the lock for the whole run; runMigrations() uses
  // its own connection from the pool, which the advisory lock does not block.
  const lockRunner = dataSource.createQueryRunner();
  await lockRunner.connect();
  let locked = false;
  try {
    for (let attempt = 1; ; attempt++) {
      const rows = (await lockRunner.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
        MIGRATION_ADVISORY_LOCK_KEY,
      ])) as Array<{ locked: boolean }>;
      if (rows[0]?.locked) break;
      if (attempt % WAIT_LOG_EVERY === 1) {
        console.log('Another deployment holds the migration lock; waiting for it to finish.');
      }
      await sleep(pollMs);
    }
    locked = true;
    // 'each' (per-migration transaction), not 'all': the index migrations run
    // CONCURRENTLY and must execute outside a transaction (transaction = false),
    // which TypeORM forbids under 'all'.
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    if (locked) {
      try {
        await lockRunner.query('SELECT pg_advisory_unlock($1::bigint)', [
          MIGRATION_ADVISORY_LOCK_KEY,
        ]);
      } catch {
        // Best effort — the lock is also released when this connection closes.
      }
    }
    await lockRunner.release();
  }
}
