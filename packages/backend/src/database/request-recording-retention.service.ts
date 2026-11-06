import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { RequestRecordingStorageService } from '../common/services/request-recording-storage.service';
import { isSelfHosted } from '../common/utils/detect-self-hosted';

const RETENTION_LOCK_KEY = 4011986;

const TRY_LOCK_SQL = `
  SELECT pg_try_advisory_lock(${RETENTION_LOCK_KEY}::bigint) AS acquired
`;

const UNLOCK_SQL = `SELECT pg_advisory_unlock(${RETENTION_LOCK_KEY}::bigint)`;

// A range scan on the partial index IDX_agent_messages_recording
// (migration 1802600000000).
const SELECT_EXPIRED_SQL = `
  SELECT id AS attempt_id, recording_key AS storage_key
  FROM agent_messages
  WHERE recording_key IS NOT NULL
    AND timestamp < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
  ORDER BY timestamp ASC
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

/**
 * Deletes Provider Attempt recordings older than the operator's retention window.
 *
 * Manifest Cloud never deletes recordings: not for any plan, not at any age, and
 * not when `REQUEST_RECORDING_RETENTION_DAYS` is set. A self-hosted install keeps
 * them forever too unless its operator sets that variable.
 */
@Injectable()
export class RequestRecordingRetentionService {
  private readonly logger = new Logger(RequestRecordingRetentionService.name);
  private readonly retentionDays: number | null;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    private readonly storage: RequestRecordingStorageService,
  ) {
    const configured = config.get<number | null>('app.requestRecordingRetentionDays') ?? null;
    this.retentionDays = isSelfHosted() ? configured : null;
    if (configured !== null && this.retentionDays === null) {
      this.logger.warn(
        'REQUEST_RECORDING_RETENTION_DAYS is ignored on Manifest Cloud: request recordings are never deleted',
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'request-recording-retention',
    waitForCompletion: true,
  })
  async deleteExpiredRecordings(): Promise<number> {
    if (this.retentionDays === null) return 0;

    const queryRunner = this.dataSource.createQueryRunner();
    let acquired = false;
    try {
      await queryRunner.connect();
      const lockRows = (await queryRunner.query(TRY_LOCK_SQL)) as Array<{ acquired?: boolean }>;
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) return 0;

      const recordings = (await queryRunner.query(SELECT_EXPIRED_SQL, [
        this.retentionDays,
      ])) as ExpiredRecording[];
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
