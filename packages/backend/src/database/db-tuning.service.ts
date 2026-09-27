import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

/**
 * Applies PgBouncer-safe planner defaults as role-level settings at boot.
 *
 * Manifest's analytics queries aggregate hundreds of thousands of rows per
 * tenant. On a default Postgres these queries (a) trigger JIT, which adds
 * 0.5–1.3s of pure compilation overhead for queries that return tiny result
 * sets, (b) spill GROUP BY/DISTINCT sorts to disk because work_mem is 4MB, and
 * (c) over-cost index scans because random_page_cost assumes spinning disks.
 *
 * We can't push these via the connection `options` startup parameter — Railway's
 * PgBouncer rejects everything outside its `extra_float_digits` allowlist (see
 * database.module.ts). `ALTER ROLE CURRENT_USER SET ...` instead stores the
 * value server-side as the role default; new backends pick it up and PgBouncer's
 * `DISCARD ALL` resets to it rather than away from it. The params are all USERSET
 * GUCs, so a non-superuser role can set them on itself.
 *
 * Each statement is best-effort: a managed Postgres that forbids ALTER ROLE just
 * logs a warning instead of aborting boot.
 */
@Injectable()
export class DbTuningService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DbTuningService.name);

  /** Planner defaults applied to the connecting role. Values are constants (not
   * user input) so they are safe to inline into the ALTER ROLE statements. */
  static readonly SETTINGS: ReadonlyArray<{ param: string; value: string }> = [
    { param: 'jit', value: 'off' },
    { param: 'work_mem', value: "'24MB'" },
    { param: 'random_page_cost', value: '1.1' },
  ];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<boolean>('app.dbTuneSession') === false) {
      this.logger.log('Session planner tuning skipped (DB_TUNE_SESSION=false)');
      return;
    }
    await this.apply();
  }

  /** Run each ALTER ROLE independently so one failure doesn't block the rest. */
  async apply(): Promise<void> {
    let applied = 0;
    for (const { param, value } of DbTuningService.SETTINGS) {
      try {
        await this.dataSource.query(`ALTER ROLE CURRENT_USER SET ${param} = ${value}`);
        applied++;
      } catch (err) {
        this.logger.warn(
          `Could not set role default ${param}=${value} (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const total = DbTuningService.SETTINGS.length;
    // Report what actually took effect — an unconditional success log would
    // mislead operators when some (or all) ALTER ROLE statements failed.
    if (applied === total) {
      this.logger.log('Applied session planner defaults (jit/work_mem/random_page_cost)');
    } else if (applied > 0) {
      this.logger.warn(
        `Applied ${applied}/${total} session planner defaults; the rest failed (see warnings above)`,
      );
    } else {
      this.logger.warn('Could not apply any session planner defaults (see warnings above)');
    }
  }
}
