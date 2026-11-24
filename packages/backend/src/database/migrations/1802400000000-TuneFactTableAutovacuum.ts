import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-table autovacuum/autoanalyze thresholds for the two fact tables.
 *
 * Postgres scales both triggers by table size: a table is analyzed after
 * `autovacuum_analyze_scale_factor` (0.1) of its rows change, and vacuumed
 * after `autovacuum_vacuum_scale_factor` (0.2). Those defaults are written for
 * tables of thousands of rows. On `requests` (7.45M rows) they mean 745,000
 * changes before a re-analyze and 1,490,000 dead tuples before a vacuum.
 *
 * Production state when this was written: `requests` held 1,109,815 dead
 * tuples and `last_autovacuum` was **NULL** — it had never been autovacuumed,
 * because it had not yet crossed the 1.49M threshold. `last_autoanalyze` was
 * five days stale on a table taking ~795,000 inserts plus a status update per
 * row.
 *
 * Both consequences are load-bearing for dashboard latency:
 *
 *  - **Stale statistics produce catastrophic plans.** The planner estimated
 *    **2 rows** where a tenant's 7-day slice of `requests` actually returns
 *    **13,164** — four orders of magnitude. Every join above it inherits that
 *    estimate, which is why the Overview kept landing on nested loops whose
 *    inner side is a sequential scan.
 *  - **No vacuum means a cold visibility map**, so index-only scans still hit
 *    the heap. One Overview branch did 9,668 heap fetches on a scan that
 *    returned zero rows.
 *
 * The scale factors here are the usual large-table treatment: analyze after 1%
 * of rows change, vacuum after 2%. On today's `requests` that is ~75k and
 * ~150k rows — frequent enough that statistics track a table growing by
 * ~800k rows, cheap enough that the vacuum never has a huge backlog to chew
 * through. The `*_threshold` floors keep small/new installs (and a fresh
 * self-hosted database) from analyzing on every handful of writes.
 *
 * `agent_messages` already carries the scale factors: migration
 * `1792900000000` set them to the same 0.01/0.02 when that table hit its own
 * size problem. Re-setting them here would be a no-op going up and, worse, the
 * `down()` would RESET them to the Postgres defaults and silently undo that
 * earlier migration's tuning. So `agent_messages` only gets the two absolute
 * thresholds, which are genuinely new, and `requests` gets all four.
 *
 * This only changes *when* autovacuum fires. It does not vacuum anything now —
 * a migration must not hold a transaction open for a multi-GB vacuum, and
 * `VACUUM` cannot run inside one at all. The existing backlog is cleared by a
 * one-off `VACUUM (ANALYZE) requests;` run against the database out of band;
 * until that happens these settings only govern future cycles.
 *
 * `ALTER TABLE ... SET (...)` takes a brief SHARE UPDATE EXCLUSIVE lock. It
 * does not rewrite the table and does not block reads or writes, so this runs
 * inside the normal migration transaction.
 */
export class TuneFactTableAutovacuum1802400000000 implements MigrationInterface {
  name = 'TuneFactTableAutovacuum1802400000000';

  /**
   * Settings this migration owns, per table. `requests` has never been tuned,
   * so it takes all four. `agent_messages` already has the scale factors from
   * `1792900000000`; touching them here would make `up()` a no-op and `down()`
   * destructive, so it takes only the thresholds.
   */
  private static readonly SETTINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      'requests',
      [
        'autovacuum_analyze_scale_factor = 0.01',
        'autovacuum_analyze_threshold = 5000',
        'autovacuum_vacuum_scale_factor = 0.02',
        'autovacuum_vacuum_threshold = 5000',
      ],
    ],
    [
      'agent_messages',
      ['autovacuum_analyze_threshold = 5000', 'autovacuum_vacuum_threshold = 5000'],
    ],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, settings] of TuneFactTableAutovacuum1802400000000.SETTINGS) {
      await queryRunner.query(`ALTER TABLE "${table}" SET (${settings.join(', ')})`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, settings] of TuneFactTableAutovacuum1802400000000.SETTINGS) {
      const names = settings.map((s) => s.split(' = ')[0]);
      await queryRunner.query(`ALTER TABLE "${table}" RESET (${names.join(', ')})`);
    }
  }
}
