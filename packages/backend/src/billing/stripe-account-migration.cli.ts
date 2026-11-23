import 'dotenv/config';
import { DataSource } from 'typeorm';

import {
  applyStripeAccountMigration,
  describeStripeAccountMigration,
  planStripeAccountMigration,
  type TransactionalSqlRunner,
} from './stripe-account-migration';

/**
 * Detach every subscription from the former Stripe account (MNFST, Inc.).
 *
 *   npm run billing:migrate-stripe-account --workspace=packages/backend            # dry run
 *   npm run billing:migrate-stripe-account --workspace=packages/backend -- --apply # writes
 *
 * Reads the database from MIGRATION_DATABASE_URL, then DATABASE_URL. Without
 * --apply it only prints what it would change.
 */

export interface MainDeps {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: { log: (message: string) => void };
  connect?: (url: string) => Promise<TransactionalSqlRunner & { close(): Promise<void> }>;
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env['MIGRATION_DATABASE_URL']?.trim() || env['DATABASE_URL']?.trim();
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL');
  return url;
}

async function connectPostgres(url: string) {
  const dataSource = new DataSource({ type: 'postgres', url, extra: { max: 1 } });
  await dataSource.initialize();
  return {
    query: <T>(sql: string, params?: unknown[]) => dataSource.query(sql, params) as Promise<T>,
    transaction: <T>(work: (runner: { query: <R>(sql: string) => Promise<R> }) => Promise<T>) =>
      dataSource.transaction((manager) =>
        work({ query: <R>(sql: string) => manager.query(sql) as Promise<R> }),
      ),
    close: () => dataSource.destroy(),
  };
}

export async function main(deps: MainDeps = {}): Promise<void> {
  const argv = deps.argv ?? process.argv.slice(2);
  const logger = deps.logger ?? console;
  const apply = argv.includes('--apply');
  const db = await (deps.connect ?? connectPostgres)(resolveDatabaseUrl(deps.env ?? process.env));
  try {
    const plan = await planStripeAccountMigration(db);
    logger.log(apply ? 'Stripe account migration (APPLY)' : 'Stripe account migration (DRY RUN)');
    for (const line of describeStripeAccountMigration(plan)) logger.log(line);
    if (!apply) {
      logger.log('Dry run: nothing was written. Rerun with --apply to write these changes.');
      return;
    }
    await applyStripeAccountMigration(db);
    const after = await planStripeAccountMigration(db);
    logger.log(
      `Done. Left with Stripe ids: ${after.paidSubscriptions.length} paid subscriptions, ` +
        `${after.otherSubscriptionRows} other rows, ${after.usersWithCustomerId} users.`,
    );
  } finally {
    await db.close();
  }
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
