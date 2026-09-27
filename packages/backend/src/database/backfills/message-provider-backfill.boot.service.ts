import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { BackfillState } from '../../entities/backfill-state.entity';
import {
  BackfillOptions,
  BackfillResult,
  runMessageProviderBackfill,
} from './backfill-message-providers';
import { TypeOrmBackfillGateway } from './backfill-message-providers.gateway';

/** Marker name in `backfill_state`; presence == this backfill has finished. */
export const MESSAGE_PROVIDER_BACKFILL_NAME = 'agent_message_provider_attribution';
/** Shared lock key so only one post-deploy backfill runs at once. */
export const MESSAGE_PROVIDER_BACKFILL_LOCK_KEY = 1792000000;
const LOCK_RETRY_MS = 30_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });

export type BackfillRunner = (
  dataSource: DataSource,
  options: BackfillOptions,
) => Promise<BackfillResult>;

const defaultRunner: BackfillRunner = (dataSource, options) =>
  runMessageProviderBackfill(new TypeOrmBackfillGateway(dataSource), options);

/**
 * Runs the post-deploy agent-message attribution backfill automatically, once,
 * after the app is up — so operators never have to invoke the CLI by hand.
 *
 * - Self-hosted production only; Cloud coordinates it over the direct backfill
 *   connection before starting the request-history backfill.
 * - Fire-and-forget from onApplicationBootstrap: never blocks readiness/health
 *   and never crashes boot.
 * - Single-runner across replicas via a Postgres advisory lock.
 * - Exactly once per install via the `backfill_state` marker. The backfill is
 *   idempotent + resumable, so a crash mid-run simply re-runs on the next boot
 *   (the marker is only written on success).
 *
 * It calls the same `runMessageProviderBackfill` as `npm run
 * backfill:message-providers`, so the data it writes is identical either way.
 */
@Injectable()
export class MessageProviderBackfillBootService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MessageProviderBackfillBootService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(BackfillState)
    private readonly stateRepo: Repository<BackfillState>,
  ) {}

  onApplicationBootstrap(): void {
    // Only on real deploys, and never await — boot must not wait on the backfill.
    if (process.env['NODE_ENV'] !== 'production' || !isSelfHosted()) {
      return;
    }
    void this.runUntilComplete().catch((error) => {
      this.logger.error(
        `post-deploy backfill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async runUntilComplete(): Promise<void> {
    while (!(await this.runOnce())) {
      await wait(LOCK_RETRY_MS);
    }
  }

  /** `runner` is injectable for tests; production uses the real backfill. */
  async runOnce(runner: BackfillRunner = defaultRunner): Promise<boolean> {
    if (await this.isCompleted()) {
      return true;
    }
    const lock = this.dataSource.createQueryRunner();
    await lock.connect();
    let acquired = false;
    try {
      const rows = (await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [
        MESSAGE_PROVIDER_BACKFILL_LOCK_KEY,
      ])) as { locked: boolean }[];
      acquired = rows[0]?.locked === true;
      if (!acquired) {
        this.logger.log('another backfill is running; retrying provider attribution later');
        return false;
      }
      // Re-check under the lock: a peer may have finished between the first
      // check and acquiring the lock.
      if (await this.isCompleted()) {
        return true;
      }
      this.logger.log('running post-deploy agent-message attribution backfill…');
      const result = await runner(this.dataSource, { logger: this.logger });
      await this.markCompleted();
      this.logger.log(
        `post-deploy backfill complete: stamped ${result.stamped} message(s) across ${result.windows} window(s)`,
      );
      return true;
    } finally {
      if (acquired) {
        await lock
          .query('SELECT pg_advisory_unlock($1)', [MESSAGE_PROVIDER_BACKFILL_LOCK_KEY])
          .catch(() => undefined);
      }
      await lock.release();
    }
  }

  private async isCompleted(): Promise<boolean> {
    return (await this.stateRepo.countBy({ name: MESSAGE_PROVIDER_BACKFILL_NAME })) > 0;
  }

  private async markCompleted(): Promise<void> {
    await this.stateRepo
      .createQueryBuilder()
      .insert()
      .into(BackfillState)
      .values({ name: MESSAGE_PROVIDER_BACKFILL_NAME })
      .orIgnore()
      .execute();
  }
}
