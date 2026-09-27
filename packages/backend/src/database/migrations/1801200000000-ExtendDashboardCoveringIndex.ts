import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the canonical dashboard covering index (1793200000000) with the
 * columns the request-first dashboard (#2485) reads, and adds a partial index
 * for the new skills aggregation.
 *
 * The provider usage rollup now groups by `provider_key_label` and reads
 * `status` / `request_id` / `id` for its message counts. None of those are in
 * the 1793 INCLUDE list, so the query loses its index-only scan and degrades
 * to a bitmap heap scan — measured on a 455k-row/30d tenant: 257k heap blocks
 * (~2 GB) read per call, 2.1s. Under concurrent dashboard loads the planner's
 * parallel workers then exhaust the host's dynamic shared memory ("could not
 * resize shared memory segment ... No space left on device"), failing the
 * request outright. The extended INCLUDE list is a superset of 1793's, so
 * every aggregation that index served stays index-only too.
 *
 * `IDX_agent_messages_skill_runs` serves the skills aggregation
 * (`timeseries-queries.service.ts`, `skill_name IS NOT NULL`), which
 * otherwise pays the same full bitmap scan to return a handful of rows.
 * Partial on `skill_name IS NOT NULL` (the overwhelming majority of rows are
 * NULL), so it costs nothing on the hot ingest path. Same tenant: 892ms
 * parallel scan → 0.06ms.
 *
 * Same build-new-then-swap as 1793 (build CONCURRENTLY under a temp name,
 * drop the old copy, rename into place) so a usable covering index always
 * exists and no ACCESS EXCLUSIVE lock is taken against live writes. Two
 * additions to that pattern:
 *
 *  - The swap is SKIPPED when the canonical index already carries every
 *    needed column (deployments that converged out-of-band, e.g. hosted).
 *    Rebuilding a multi-GB index at boot just to end up with an identical
 *    definition would stall the deploy for nothing.
 *  - `IDX_agent_messages_provider_usage_v2` (1793's temp name, also used as
 *    an interim hotfix name on hosted) is dropped either way so no stale
 *    duplicate keeps amplifying writes.
 *
 * `npm run migration:revert` cannot run `down()` (TypeORM opens a transaction
 * for reverts regardless of `transaction = false`; Postgres rejects
 * CONCURRENTLY inside one) — run the `down()` statements directly against the
 * database, then delete this migration's row from `migrations`. Same caveat
 * as every CONCURRENTLY migration here.
 */
export class ExtendDashboardCoveringIndex1801200000000 implements MigrationInterface {
  name = 'ExtendDashboardCoveringIndex1801200000000';
  transaction = false;

  private static readonly USAGE_INDEX = 'IDX_agent_messages_provider_usage';
  private static readonly SWAP_INDEX = 'IDX_agent_messages_provider_usage_swap';
  private static readonly LEGACY_V2_INDEX = 'IDX_agent_messages_provider_usage_v2';
  private static readonly SKILLS_INDEX = 'IDX_agent_messages_skill_runs';

  /** Every column the dashboard aggregations read — superset of 1793's list. */
  private static readonly USAGE_INCLUDE = [
    'model',
    'provider',
    'auth_type',
    'provider_key_label',
    'input_tokens',
    'output_tokens',
    'cost_usd',
    'status',
    'request_id',
    'id',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { USAGE_INDEX, SWAP_INDEX, LEGACY_V2_INDEX, SKILLS_INDEX, USAGE_INCLUDE } =
      ExtendDashboardCoveringIndex1801200000000;

    if (!(await this.usageIndexConverged(queryRunner))) {
      // Build-new-then-swap: the old covering index stays usable until the
      // extended one is ready. The pre-drop only clears an INVALID leftover
      // from an interrupted CONCURRENTLY build (CREATE ... IF NOT EXISTS
      // matches on name and would skip over it, wedging it forever).
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SWAP_INDEX}"`);
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SWAP_INDEX}" ON "agent_messages" ("tenant_id", "timestamp") INCLUDE (${USAGE_INCLUDE.map((col) => `"${col}"`).join(', ')})`,
      );
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${USAGE_INDEX}"`);
      await queryRunner.query(`ALTER INDEX IF EXISTS "${SWAP_INDEX}" RENAME TO "${USAGE_INDEX}"`);
    }
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${LEGACY_V2_INDEX}"`);

    // Skills partial index. Clear only an INVALID leftover — a valid
    // pre-existing copy (applied out-of-band) is kept, not rebuilt.
    if (await this.indexIsInvalid(queryRunner, SKILLS_INDEX)) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SKILLS_INDEX}"`);
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SKILLS_INDEX}" ON "agent_messages" ("tenant_id", "timestamp") INCLUDE ("skill_name", "agent_name", "agent_id") WHERE "skill_name" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { USAGE_INDEX, SWAP_INDEX, SKILLS_INDEX } = ExtendDashboardCoveringIndex1801200000000;

    // Restore 1793's definition with the same swap.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SWAP_INDEX}"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SWAP_INDEX}" ON "agent_messages" ("tenant_id", "timestamp") INCLUDE ("model", "provider", "auth_type", "input_tokens", "output_tokens", "cost_usd")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${USAGE_INDEX}"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "${SWAP_INDEX}" RENAME TO "${USAGE_INDEX}"`);

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SKILLS_INDEX}"`);
  }

  /** True when the canonical index already INCLUDEs every column we need. */
  private async usageIndexConverged(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ indexdef: string }> = await queryRunner.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
      [ExtendDashboardCoveringIndex1801200000000.USAGE_INDEX],
    );
    if (rows.length === 0) return false;
    const match = rows[0].indexdef.match(/INCLUDE \(([^)]*)\)/);
    if (!match) return false;
    const columns = match[1].split(',').map((col) => col.trim().replace(/"/g, ''));
    if (
      !ExtendDashboardCoveringIndex1801200000000.USAGE_INCLUDE.every((col) => columns.includes(col))
    ) {
      return false;
    }
    // pg_indexes lists INVALID indexes too — an interrupted out-of-band build
    // under the canonical name would otherwise pass as converged and leave the
    // dashboard with no usable covering index.
    return !(await this.indexIsInvalid(
      queryRunner,
      ExtendDashboardCoveringIndex1801200000000.USAGE_INDEX,
    ));
  }

  /** True when an index of this name exists but is INVALID (interrupted build). */
  private async indexIsInvalid(queryRunner: QueryRunner, indexName: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [indexName],
    );
    return rows.length > 0;
  }
}
