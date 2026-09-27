import 'dotenv/config';
import { DataSource } from 'typeorm';

import { BackfillState } from '../../entities/backfill-state.entity';
import {
  createRequestBackfillDataSource,
  resolveRequestBackfillDatabaseUrl,
} from './request-backfill.datasource';
import {
  REQUEST_BACKFILL_GENERIC_GRACE_MS,
  REQUEST_BACKFILL_LOCK_RETRY_MS,
  RequestBackfillBootService,
} from './request-backfill.boot.service';

export { createRequestBackfillDataSource, resolveRequestBackfillDatabaseUrl };

interface BackfillCoordinator {
  runUntilComplete(): Promise<void>;
  runTailOnce(): Promise<boolean>;
  hasUnlinkedAttempts(): Promise<boolean>;
  runTransitionFinalizeOnce(): Promise<boolean>;
}

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  logger?: { log: (message: string) => void; error: (message: unknown) => void };
  dataSource?: DataSource;
  coordinator?: BackfillCoordinator;
  sleep?: (ms: number) => Promise<void>;
  initialOnly?: boolean;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Run after the new Railway deployment is healthy and the old replica drained. */
export async function main(deps: MainDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const sleep = deps.sleep ?? realSleep;
  const dataSource = deps.dataSource ?? createRequestBackfillDataSource(env);

  await dataSource.initialize();
  try {
    const coordinator =
      deps.coordinator ??
      new RequestBackfillBootService(dataSource, dataSource.getRepository(BackfillState));
    await coordinator.runUntilComplete();
    if (deps.initialOnly === true) {
      logger.log(
        'request/provider-attempt historical backfill complete; live-write delta deferred',
      );
      return;
    }

    // Old replicas can write their unchanged columns during the rolling
    // handover. Give each observed delta a full generic grace window, sweep it,
    // then recheck under the shared transition lock before finalizing.
    while (true) {
      while (await coordinator.hasUnlinkedAttempts()) {
        logger.log(`waiting ${REQUEST_BACKFILL_GENERIC_GRACE_MS / 1000}s for legacy writes to age`);
        await sleep(REQUEST_BACKFILL_GENERIC_GRACE_MS);
        while (!(await coordinator.runTailOnce())) {
          await sleep(REQUEST_BACKFILL_LOCK_RETRY_MS);
        }
      }
      if (await coordinator.runTransitionFinalizeOnce()) break;
      await sleep(REQUEST_BACKFILL_LOCK_RETRY_MS);
    }
    logger.log('request/provider-attempt backfill, catch-up, and transition complete');
  } finally {
    await dataSource.destroy();
  }
}

/* istanbul ignore next -- thin process entrypoint, exercised by the Railway worker */
if (require.main === module) {
  main({ initialOnly: process.argv.slice(2).includes('--initial-only') }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
