import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { isBillingEnabled } from '../billing/billing.config';
import { PAID_SUBSCRIPTION_STATUS_SQL_LIST } from '../billing/subscription-status';
import { RequestRecordingStorageService } from '../common/services/request-recording-storage.service';

const FREE_RETENTION_DAYS = 7;
const PRO_RETENTION_DAYS = 365;
const NON_BILLING_RETENTION_DAYS = 365;
const RETENTION_LOCK_KEY = 4011986;

const TRY_LOCK_SQL = `
  SELECT pg_try_advisory_lock(${RETENTION_LOCK_KEY}::bigint) AS acquired
`;

const UNLOCK_SQL = `SELECT pg_advisory_unlock(${RETENTION_LOCK_KEY}::bigint)`;

const SELECT_ALL_EXPIRED_SQL = `
  SELECT id AS attempt_id, recording_key AS storage_key
  FROM agent_messages
  WHERE recording_key IS NOT NULL
    AND timestamp < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
  ORDER BY timestamp ASC
`;

// The top-level timestamp bound is implied by the OR below (LEAST($1, $2) is
// the shorter retention, so the later cutoff), but the planner cannot hoist it
// out of the OR on its own. Stated explicitly it becomes a range scan on the
// partial index IDX_agent_messages_recording (migration 1802600000000), and the
// `::int` casts pin $1/$2 to integers, so the retention constants above must
// stay whole days — a fractional value fails loudly at parse time.
// Every arm's cutoff must be an argument to `LEAST`, or that arm silently stops
// matching.
const SELECT_PLAN_EXPIRED_SQL = `
  SELECT attempt.id AS attempt_id, attempt.recording_key AS storage_key
  FROM agent_messages attempt
  JOIN requests request ON request.id = attempt.request_id
  WHERE attempt.recording_key IS NOT NULL
    AND attempt.timestamp < CURRENT_TIMESTAMP - (LEAST($1::int, $2::int) * INTERVAL '1 day')
    AND (
    (
      attempt.timestamp < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1
        FROM tenants tenant
        JOIN "subscription" subscription
          ON subscription."referenceId" = tenant.owner_user_id
        WHERE tenant.id = request.tenant_id
          AND subscription.plan = 'pro'
          AND subscription.status IN (${PAID_SUBSCRIPTION_STATUS_SQL_LIST})
      )
    )
    OR (
      attempt.timestamp < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 day')
      AND EXISTS (
        SELECT 1
        FROM tenants tenant
        JOIN "subscription" subscription
          ON subscription."referenceId" = tenant.owner_user_id
        WHERE tenant.id = request.tenant_id
          AND subscription.plan = 'pro'
          AND subscription.status IN (${PAID_SUBSCRIPTION_STATUS_SQL_LIST})
      )
    )
  )
  ORDER BY attempt.timestamp ASC
`;

const DELETE_METADATA_SQL = `
  UPDATE agent_messages
  SET recording_key = NULL
  WHERE id = $1 AND recording_key = $2
  RETURNING id
`;

interface ExpiredRecording {
  attempt_id: string;
  storage_key: string;
}

@Injectable()
export class RequestRecordingRetentionService {
  private readonly logger = new Logger(RequestRecordingRetentionService.name);
  private readonly globalRetentionDays: number | null;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    private readonly storage: RequestRecordingStorageService,
  ) {
    this.globalRetentionDays =
      config.get<number | null>('app.requestRecordingRetentionDays') ?? null;
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'request-recording-retention',
    waitForCompletion: true,
  })
  async deleteExpiredRecordings(): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    let acquired = false;
    try {
      await queryRunner.connect();
      const lockRows = (await queryRunner.query(TRY_LOCK_SQL)) as Array<{ acquired?: boolean }>;
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) return 0;

      const recordings =
        this.globalRetentionDays !== null || !isBillingEnabled()
          ? await this.findAllExpired(
              queryRunner,
              this.globalRetentionDays ?? NON_BILLING_RETENTION_DAYS,
            )
          : await this.findExpiredByPlan(queryRunner);
      const deleted = await this.deleteRecordings(queryRunner, recordings);

      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} expired Provider Attempt recording(s)`);
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Request recording retention failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    } finally {
      if (acquired) await queryRunner.query(UNLOCK_SQL).catch(() => undefined);
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async findAllExpired(
    queryRunner: QueryRunner,
    retentionDays: number,
  ): Promise<ExpiredRecording[]> {
    return queryRunner.query(SELECT_ALL_EXPIRED_SQL, [retentionDays]) as Promise<
      ExpiredRecording[]
    >;
  }

  private async findExpiredByPlan(queryRunner: QueryRunner): Promise<ExpiredRecording[]> {
    return queryRunner.query(SELECT_PLAN_EXPIRED_SQL, [
      FREE_RETENTION_DAYS,
      PRO_RETENTION_DAYS,
    ]) as Promise<ExpiredRecording[]>;
  }

  private async deleteRecordings(
    queryRunner: QueryRunner,
    recordings: ExpiredRecording[],
  ): Promise<number> {
    let deleted = 0;
    for (const recording of recordings) {
      try {
        await this.storage.delete(recording.storage_key);
        const result = (await queryRunner.query(DELETE_METADATA_SQL, [
          recording.attempt_id,
          recording.storage_key,
        ])) as Array<{ id: string }> | [Array<{ id: string }>, number];
        const rows = Array.isArray(result[0]) ? result[0] : result;
        deleted += rows.length;
      } catch (error) {
        this.logger.warn(
          `Could not delete Provider Attempt recording ${recording.attempt_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return deleted;
  }
}
