import { DataSource } from 'typeorm';

import { BackfillState } from '../../entities/backfill-state.entity';

/**
 * Resolve the direct connection used by Cloud migration/backfill workers.
 * Self-hosted boot never calls this helper; it reuses the application's
 * DATABASE_URL-backed DataSource instead. The standalone worker always fails
 * closed: NODE_ENV is not a reliable signal that DATABASE_URL bypasses a
 * transaction-mode pooler.
 */
export function resolveRequestBackfillDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const directUrl =
    env['MIGRATION_DATABASE_URL']?.trim() ||
    env['DATABASE_UNPOOLED_URL']?.trim() ||
    env['BACKFILL_DATABASE_URL']?.trim();
  if (directUrl) return directUrl;

  throw new Error(
    'A direct PostgreSQL URL is required; set MIGRATION_DATABASE_URL, DATABASE_UNPOOLED_URL, or BACKFILL_DATABASE_URL',
  );
}

/** Two direct connections: one holds the advisory lock, one runs backfill SQL. */
export function createRequestBackfillDataSource(env: NodeJS.ProcessEnv): DataSource {
  return new DataSource({
    type: 'postgres',
    url: resolveRequestBackfillDatabaseUrl(env),
    entities: [BackfillState],
    extra: { max: 2 },
  });
}
