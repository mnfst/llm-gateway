import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Splits the overloaded `agent_messages.status` into orthogonal error axes:
 * `error_origin` (WHO failed), `error_class` (WHAT kind), and `superseded`
 * (a recovered attempt, not a terminal outcome). See the classifyMessageError
 * source of truth in `packages/shared/src/error-taxonomy.ts`.
 *
 * The backfill CASE below MIRRORS classifyMessageError exactly. Keep them in
 * lock-step — a divergence would classify history differently from live rows.
 *
 * Runs OUTSIDE a transaction (`transaction = false`) so the historical backfill
 * can commit in ~20k-row batches instead of locking the whole hot table under
 * one giant UPDATE, and so the trailing index can be built CONCURRENTLY. The
 * batch predicate (`status IN (error/rate_limited/fallback_error) AND
 * error_origin IS NULL`) makes it idempotent and resumable: every pass only
 * touches still-unclassified error rows, and each pass strictly shrinks the
 * remaining set (a non-ok row always resolves to a non-null origin), so the loop
 * terminates. The IN-list rides the existing error partial indexes so the scan
 * stays cheap on multi-GB tables instead of seq-scanning the whole heap.
 */

// error_origin, mirroring classifyMessageError precedence. `m` is the UPDATE target alias.
const ERROR_ORIGIN_CASE = `CASE
  WHEN m.routing_reason = 'no_provider' THEN 'config'
  WHEN m.routing_reason = 'no_provider_key' THEN 'config'
  WHEN m.routing_reason = 'limit_exceeded' THEN 'policy'
  WHEN m.routing_reason = 'plan_request_limit_exceeded' THEN 'policy'
  WHEN m.routing_reason = 'manifest_rate_limited' THEN 'policy'
  WHEN m.routing_reason = 'friendly_error' THEN 'internal'
  WHEN m.status = 'rate_limited' THEN 'provider'
  WHEN m.error_http_status = 504 THEN 'transport'
  WHEN m.error_http_status = 503 THEN 'transport'
  WHEN m.error_http_status IS NOT NULL THEN 'provider'
  ELSE 'transport'
END`;

// error_class, mirroring classifyMessageError + classifyHttpErrorClass.
const ERROR_CLASS_CASE = `CASE
  WHEN m.routing_reason = 'no_provider' THEN 'no_provider'
  WHEN m.routing_reason = 'no_provider_key' THEN 'no_provider_key'
  WHEN m.routing_reason = 'limit_exceeded' AND m.error_http_status = 402 THEN 'plan_request_limit_exceeded'
  WHEN m.routing_reason = 'limit_exceeded' THEN 'limit_exceeded'
  WHEN m.routing_reason = 'plan_request_limit_exceeded' THEN 'plan_request_limit_exceeded'
  WHEN m.routing_reason = 'manifest_rate_limited' THEN 'rate_limit'
  WHEN m.routing_reason = 'friendly_error' THEN 'internal'
  WHEN m.status = 'rate_limited' THEN 'rate_limit'
  WHEN m.error_http_status = 504 THEN 'timeout'
  WHEN m.error_http_status = 503 THEN 'network'
  WHEN m.error_http_status = 429 THEN 'rate_limit'
  WHEN m.error_http_status = 402 THEN 'billing'
  WHEN m.error_http_status IN (401, 403) THEN 'auth'
  WHEN m.error_http_status = 404 THEN 'not_found'
  WHEN m.error_http_status = 413 THEN 'payload_too_large'
  WHEN m.error_http_status IN (400, 422) THEN 'invalid_request'
  WHEN m.error_http_status >= 500 THEN 'server_error'
  WHEN m.error_http_status >= 400 THEN 'client_error'
  WHEN m.error_http_status IS NOT NULL THEN 'server_error'
  ELSE 'network'
END`;

// The set of non-ok statuses, spelled as an explicit IN list (identical to
// `status <> 'ok'` — the proxy only ever writes ok/error/rate_limited/
// fallback_error) so the batch/remaining scans ride the existing
// IDX_agent_messages_errors* partial indexes (defined `WHERE status IN (...)`)
// instead of a full seq scan of the multi-GB heap. Verified on prod: `<> 'ok'`
// plans a Seq Scan; this plans an Index Scan over just the error rows. Keeps the
// backfill cheap on large tables (cloud pre-deploy load, self-hosted boot time).
const NON_OK_STATUSES = `('error', 'fallback_error', 'rate_limited')`;

const BACKFILL_BATCH_SQL = `
WITH batch AS (
  SELECT id FROM agent_messages
  WHERE status IN ${NON_OK_STATUSES} AND error_origin IS NULL
  LIMIT 20000
)
UPDATE agent_messages AS m SET
  superseded = (m.status = 'fallback_error'),
  error_origin = ${ERROR_ORIGIN_CASE},
  error_class = ${ERROR_CLASS_CASE}
FROM batch
WHERE m.id = batch.id`;

// Whether any still-unclassified error rows remain. Driver-return-shape
// independent (a plain boolean projection), unlike counting UPDATE ... RETURNING
// rows — which node-pg does not surface as an empty array on zero matches.
const REMAINING_SQL = `SELECT EXISTS (
  SELECT 1 FROM agent_messages WHERE status IN ${NON_OK_STATUSES} AND error_origin IS NULL
) AS more`;

// Backstop so a driver quirk can never spin forever. 20k rows/pass over any
// realistic agent_messages volume terminates far below this.
const MAX_BACKFILL_PASSES = 100_000;

export class AddErrorClassification1798000000000 implements MigrationInterface {
  name = 'AddErrorClassification1798000000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "error_origin" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "error_class" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "superseded" boolean NOT NULL DEFAULT false`,
    );

    // Batched, resumable backfill of historical rows (see class doc). Each pass
    // classifies up to 20k still-unclassified error rows, then re-checks whether
    // any remain — the set strictly shrinks (a non-ok row always resolves to a
    // non-null origin), so this terminates.
    for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass++) {
      await queryRunner.query(BACKFILL_BATCH_SQL);
      const remaining = (await queryRunner.query(REMAINING_SQL)) as Array<{ more: boolean }>;
      if (!remaining?.[0]?.more) break;
    }

    // Partial index over classified (error) rows for the error-breakdown reads.
    // Errors are a small fraction of rows, so it stays small and skips the 'ok'
    // majority. CONCURRENTLY (allowed here since transaction = false) avoids the
    // ACCESS EXCLUSIVE lock that deadlocks live writes on deploy.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_error_origin"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_error_origin" ON "agent_messages" ("tenant_id", "timestamp") WHERE "error_origin" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_error_origin"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "superseded"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "error_class"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "error_origin"`);
  }
}
