import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make every Manifest-originated error a first-class, debuggable message row.
 *
 * 1. Adds `agent_messages.error_code`, the documented `M###` code behind the
 *    failure, so the dashboard can deep link to /docs/errors/<code>.
 * 2. Backfills it from `routing_reason` for the reasons that map to exactly one
 *    code. `manifest_rate_limited` is deliberately left NULL: it used to cover
 *    M201 / M202 / M203 (per-user, per-IP, concurrency) and cannot be resolved
 *    retroactively.
 * 3. Clears the placeholder `model`/`provider`/`routing_tier` that the canned
 *    stub path stamped on failed Manifest rows ('manifest' / 'manifest' /
 *    'simple'). Those values are not a real model, provider, or routing decision
 *    — they only polluted the Messages filter dropdowns and put a meaningless
 *    SIMPLE tier badge on setup errors. Only rows Manifest itself authored are
 *    touched, and only the failed ones (see the WHERE clause below).
 */
export class AddMessageErrorCode1800200000000 implements MigrationInterface {
  name = 'AddMessageErrorCode1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE agent_messages ADD COLUMN error_code varchar(8)`);

    await queryRunner.query(`
      UPDATE agent_messages
         SET error_code = CASE
               WHEN routing_reason = 'no_provider' THEN 'M101'
               WHEN routing_reason = 'no_provider_key' THEN 'M100'
               WHEN routing_reason = 'plan_request_limit_exceeded' THEN 'M204'
               WHEN routing_reason = 'limit_exceeded' AND error_http_status = 402 THEN 'M204'
               WHEN routing_reason = 'limit_exceeded' THEN 'M200'
               WHEN routing_reason = 'friendly_error' THEN 'M500'
             END
       WHERE routing_reason IN (
               'no_provider', 'no_provider_key', 'plan_request_limit_exceeded',
               'limit_exceeded', 'friendly_error'
             )
    `);

    // `provider = 'manifest'` is the unambiguous marker: no real provider is
    // named that (custom ones are `custom:<uuid>`), and only the canned-stub path
    // ever wrote it. Keying on that rather than on `error_origin` also catches
    // the handful of failed stubs written between the canned-status change and
    // the taxonomy backfill, whose `error_origin` is still NULL.
    //
    // `status <> 'ok'` protects a much older cohort: Manifest stubs that predate
    // the canned-status change and were recorded as successes. They keep their
    // placeholder model, because they still count as messages and nulling it
    // would move them under "unknown model" in the cost breakdown.
    await queryRunner.query(`
      UPDATE agent_messages
         SET model = NULL, provider = NULL, routing_tier = NULL
       WHERE provider = 'manifest'
         AND status IS DISTINCT FROM 'ok'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The placeholder model/provider/tier are not restored: they carried no
    // information, so re-stamping them would invent data rather than recover it.
    await queryRunner.query(`ALTER TABLE agent_messages DROP COLUMN error_code`);
  }
}
