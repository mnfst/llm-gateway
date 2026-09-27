import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces the request/attempt boundary without rewriting historical data in
 * the deploy path. History is linked later by the resumable boot backfill.
 *
 * This migration runs outside a transaction because the request_id index is
 * built CONCURRENTLY. Every statement is restart-safe so a process failure
 * between statements can be retried.
 */
export class AddRequestsAndProviderAttempts1801000000000 implements MigrationInterface {
  name = 'AddRequestsAndProviderAttempts1801000000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail the deploy attempt instead of queueing an ACCESS EXCLUSIVE schema
    // change behind a long Cloud query and then blocking newer traffic.
    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await this.addRequestSchema(queryRunner);
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }

  private async addRequestSchema(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "requests" (
        "id" varchar NOT NULL,
        "tenant_id" varchar,
        "agent_id" varchar,
        "user_id" varchar,
        "agent_name" varchar,
        "trace_id" varchar,
        "session_key" varchar,
        "session_id" varchar,
        "timestamp" timestamp NOT NULL,
        "duration_ms" integer,
        "status" varchar NOT NULL,
        "autofix_status" varchar,
        "error_message" varchar,
        "error_http_status" integer,
        "error_code" varchar(8),
        "error_origin" varchar,
        "error_class" varchar,
        "requested_model" varchar,
        "caller_attribution" text,
        "request_headers" text,
        "request_params" jsonb,
        "feedback_rating" varchar,
        "feedback_tags" varchar,
        "feedback_details" text,
        CONSTRAINT "CHK_requests_autofix_status" CHECK (
          "autofix_status" IN (
            'no_patch', 'resolving', 'retry_succeeded', 'retry_failed', 'service_error'
          )
        ),
        CONSTRAINT "PK_requests" PRIMARY KEY ("id")
      )
    `);

    // Keep agent_messages as the physical table. The new columns are nullable,
    // so replicas from the previous release can continue inserting and updating
    // their unchanged column set while Railway rolls the new release out.
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "request_id" varchar`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_agent_messages_request'
            AND conrelid = 'agent_messages'::regclass
        ) THEN
          ALTER TABLE "agent_messages"
            ADD CONSTRAINT "FK_agent_messages_request"
            FOREIGN KEY ("request_id") REFERENCES "requests"("id")
            ON DELETE CASCADE NOT VALID;
        END IF;
      END $$
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requests_tenant_agent_timestamp" ON "requests" ("tenant_id", "agent_id", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requests_tenant_timestamp" ON "requests" ("tenant_id", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requests_tenant_trace" ON "requests" ("tenant_id", "trace_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requests_tenant_status_timestamp" ON "requests" ("tenant_id", "status", "timestamp")`,
    );
    // Tail sweeps finalize only legacy parents still marked pending. This index
    // is created while requests is empty, then stays small as parents settle.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_requests_pending" ON "requests" ("id") WHERE "status" = 'pending'`,
    );
    const requestIndex = (await queryRunner.query(`
      SELECT i.indisvalid AS valid,
             pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'IDX_agent_messages_request_id'
        AND i.indrelid = 'agent_messages'::regclass
    `)) as Array<{ valid: boolean; definition: string }>;
    // PostgreSQL leaves an invalid shell behind when CREATE INDEX
    // CONCURRENTLY is interrupted. IF NOT EXISTS would treat that shell as a
    // usable index, so remove it before retrying the build.
    const expectedRequestIndex = '(request_id, id)';
    if (
      requestIndex?.[0] &&
      (!requestIndex[0].valid || !requestIndex[0].definition.includes(expectedRequestIndex))
    ) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_request_id"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_request_id" ON "agent_messages" ("request_id", "id")`,
    );

    // Temporary migration support: exact fallback reconstruction repeatedly
    // probes legacy fallback rows by their original model and encoded time.
    // The partial index empties as the backfill links rows, and new request-aware
    // writes never enter it. A later cleanup migration can remove the empty shell.
    const fallbackIndex = (await queryRunner.query(`
      SELECT i.indisvalid AS valid,
             pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'IDX_agent_messages_unlinked_fallback'
        AND i.indrelid = 'agent_messages'::regclass
    `)) as Array<{ valid: boolean; definition: string }>;
    const expectedFallbackIndexParts = [
      '(fallback_from_model, "timestamp", tenant_id, agent_id)',
      'INCLUDE (fallback_index, status, superseded)',
      'request_id IS NULL',
      'fallback_from_model IS NOT NULL',
    ];
    if (
      fallbackIndex?.[0] &&
      (!fallbackIndex[0].valid ||
        expectedFallbackIndexParts.some((part) => !fallbackIndex[0].definition.includes(part)))
    ) {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_unlinked_fallback" ON "agent_messages" ("fallback_from_model", "timestamp", "tenant_id", "agent_id") INCLUDE ("fallback_index", "status", "superseded") WHERE "request_id" IS NULL AND "fallback_from_model" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A newer quota-counter migration attaches a trigger to request_id. In a
    // full-schema test or manual out-of-order rollback, remove it before the
    // column so this historical down migration remains usable.
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_agent_messages_count_tenant_request_usage" ON "agent_messages"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "count_tenant_request_usage"()`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_request_id"`);
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "FK_agent_messages_request"`,
    );
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "request_id"`);
    // Migration tests and manual recovery can invoke this historical down()
    // directly after newer migrations have run. Remove the newer dependent
    // table first so PostgreSQL can safely drop requests.
    await queryRunner.query(`DROP TABLE IF EXISTS "request_recordings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "requests"`);
  }
}
