import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  REQUEST_USAGE_CUTOVER_STATE,
  requestQuotaResetAtMs,
} from '../../billing/request-quota-window';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { toLocalSqlTimestamp, toSqlTimestamp } from '../../common/utils/postgres-sql';

// Keep the migration self-contained: these are the request-level origins at
// this schema version, matching the legacy quota query it replaces.
const MANIFEST_ERROR_ORIGINS = ['config', 'policy', 'internal', 'request'] as const;
const MANIFEST_ERROR_ORIGIN_SQL_LIST = MANIFEST_ERROR_ORIGINS.map((origin) => `'${origin}'`).join(
  ', ',
);

/**
 * Replaces admission-path COUNT scans with one exact monthly counter lookup.
 *
 * The deploy migration never scans historical telemetry. It atomically records
 * a cutover while installing the trigger, then active tenants initialize their
 * pre-cutover baseline once through PlanService. Post-cutover attempts update
 * the counter transactionally and merge safely with that lazy baseline.
 */
export class AddTenantRequestUsage1801300000000 implements MigrationInterface {
  name = 'AddTenantRequestUsage1801300000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Request quotas are a Cloud billing concern. Keep self-hosted schemas and
    // their write path free of the counter table, request flag, and trigger.
    if (isSelfHosted()) return;

    const resetDate = new Date(requestQuotaResetAtMs());
    const resetCutoff = toLocalSqlTimestamp(resetDate);
    const resetWindow = toSqlTimestamp(resetDate);
    const storageTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const storageTimeZoneSql = storageTimeZone.replaceAll("'", "''");

    await queryRunner.query(`SET lock_timeout = '1s'`);
    try {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "tenant_request_usage" (
          "tenant_id" varchar NOT NULL,
          "window_start" timestamp NOT NULL,
          "request_count" bigint NOT NULL DEFAULT 0,
          "baseline_counted" boolean NOT NULL DEFAULT false,
          CONSTRAINT "PK_tenant_request_usage" PRIMARY KEY ("tenant_id", "window_start"),
          CONSTRAINT "CHK_tenant_request_usage_non_negative" CHECK ("request_count" >= 0)
        )
      `);
      await queryRunner.query(
        `ALTER TABLE "tenant_request_usage" ADD COLUMN IF NOT EXISTS "baseline_counted" boolean NOT NULL DEFAULT false`,
      );
      await queryRunner.query(`
        ALTER TABLE "requests"
          ADD COLUMN IF NOT EXISTS "quota_counted" boolean NOT NULL DEFAULT false
      `);

      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION "count_tenant_request_usage"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
          counter_cutover_at timestamp;
          counted_tenant_id varchar;
          counted_window_start timestamp;
        BEGIN
          IF NEW.request_id IS NULL THEN
            RETURN NEW;
          END IF;

          SELECT "completed_at"
            INTO counter_cutover_at
            FROM "backfill_state"
           WHERE "name" = '${REQUEST_USAGE_CUTOVER_STATE}';

          IF counter_cutover_at IS NULL THEN
            RETURN NEW;
          END IF;

          IF TG_OP = 'UPDATE' THEN
            IF OLD.request_id IS NOT NULL THEN
              RETURN NEW;
            END IF;

            IF (OLD."timestamp" AT TIME ZONE '${storageTimeZoneSql}') AT TIME ZONE 'UTC'
                 < counter_cutover_at
               OR COALESCE(OLD.superseded, false)
               OR OLD.error_origin IN (${MANIFEST_ERROR_ORIGIN_SQL_LIST}) THEN
              RETURN NEW;
            END IF;
          ELSIF COALESCE(NEW.superseded, false)
             OR NEW.error_origin IN (${MANIFEST_ERROR_ORIGIN_SQL_LIST}) THEN
            RETURN NEW;
          END IF;

          IF (NEW."timestamp" AT TIME ZONE '${storageTimeZoneSql}') AT TIME ZONE 'UTC'
               < counter_cutover_at THEN
            RETURN NEW;
          END IF;

          -- A Request with any pre-cutover attempt belongs entirely to the lazy
          -- historical baseline. Mark it handled so a later fallback cannot
          -- also increment the live counter.
          IF EXISTS (
            SELECT 1
              FROM "agent_messages" prior
             WHERE prior."request_id" = NEW.request_id
               AND prior."id" <> NEW.id
               AND (
                 (prior."timestamp" AT TIME ZONE '${storageTimeZoneSql}') AT TIME ZONE 'UTC'
               ) < counter_cutover_at
               AND (
                 prior."error_origin" IS NULL
                 OR prior."error_origin" NOT IN (${MANIFEST_ERROR_ORIGIN_SQL_LIST})
               )
          ) THEN
            UPDATE "requests"
               SET "quota_counted" = true
             WHERE "id" = NEW.request_id
               AND "quota_counted" = false;
            RETURN NEW;
          END IF;

          UPDATE "requests" r
             SET "quota_counted" = true
           WHERE r."id" = NEW.request_id
             AND r."quota_counted" = false
             AND r."tenant_id" IS NOT NULL
             AND r."timestamp" >= '${resetCutoff}'::timestamp
             AND NOT EXISTS (
               SELECT 1
                 FROM "agents" a
                WHERE a."id" = r."agent_id"
                  AND a."is_playground" = true
             )
          RETURNING
            r."tenant_id",
            GREATEST(
              date_trunc(
                'month',
                (r."timestamp" AT TIME ZONE '${storageTimeZoneSql}') AT TIME ZONE 'UTC'
              ),
              '${resetWindow}'::timestamp
            )
               INTO counted_tenant_id, counted_window_start;

          IF counted_tenant_id IS NULL THEN
            RETURN NEW;
          END IF;

          INSERT INTO "tenant_request_usage" (
            "tenant_id",
            "window_start",
            "request_count",
            "baseline_counted"
          )
          VALUES (
            counted_tenant_id,
            counted_window_start,
            1,
            counted_window_start >= counter_cutover_at
          )
          ON CONFLICT ("tenant_id", "window_start")
          DO UPDATE SET "request_count" = "tenant_request_usage"."request_count" + 1;

          RETURN NEW;
        END;
        $$
      `);

      // The lock makes cutover publication and trigger installation atomic:
      // rows committed before the lock are historical; rows after commit see
      // the trigger. A one-second lock timeout makes a busy deploy retry instead
      // of pausing writes indefinitely.
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(`LOCK TABLE "agent_messages" IN SHARE ROW EXCLUSIVE MODE`);
        await queryRunner.query(`
          INSERT INTO "backfill_state" ("name", "completed_at")
          VALUES (
            '${REQUEST_USAGE_CUTOVER_STATE}',
            clock_timestamp() AT TIME ZONE 'UTC'
          )
          ON CONFLICT ("name") DO NOTHING
        `);
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
                FROM pg_trigger
               WHERE tgname = 'TRG_agent_messages_count_tenant_request_usage'
                 AND tgrelid = 'agent_messages'::regclass
            ) THEN
              CREATE TRIGGER "TRG_agent_messages_count_tenant_request_usage"
              AFTER INSERT OR UPDATE OF "request_id" ON "agent_messages"
              FOR EACH ROW EXECUTE FUNCTION "count_tenant_request_usage"();
            END IF;
          END
          $$
        `);
        await queryRunner.commitTransaction();
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      }
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '1s'`);
    try {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "TRG_agent_messages_count_tenant_request_usage" ON "agent_messages"`,
      );
      await queryRunner.query(`DROP FUNCTION IF EXISTS "count_tenant_request_usage"()`);
      await queryRunner.query(
        `DELETE FROM "backfill_state" WHERE "name" = '${REQUEST_USAGE_CUTOVER_STATE}'`,
      );
      await queryRunner.query(`ALTER TABLE "requests" DROP COLUMN IF EXISTS "quota_counted"`);
      await queryRunner.query(`DROP TABLE IF EXISTS "tenant_request_usage"`);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
