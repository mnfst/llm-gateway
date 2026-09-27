import dataSource from './datasource';
import { runMigrationsWithAdvisoryLock } from './run-migrations-with-lock';

/**
 * Migration entry point used by the deploy step (`npm run migration:run`).
 * Wraps TypeORM's migration run in an advisory lock so concurrent deploys /
 * replicas don't deadlock on agent_messages locks. The DataSource reads
 * MIGRATION_DATABASE_URL (a direct, non-pooled connection) so the session-level
 * advisory lock holds.
 */
async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    await runMigrationsWithAdvisoryLock(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
