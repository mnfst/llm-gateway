import { MigrationInterface, QueryRunner } from 'typeorm';
import { InPlaceIndex, rebuildIndexInPlace } from '../index-rebuild';

/**
 * Serve the Requests log filters from indexes instead of scattered heap pages.
 *
 * 1. `IDX_requests_tenant_timestamp` gains the columns the log filters and
 *    joins on. Before, every filter beyond tenant + date read one `requests`
 *    heap page per row in range to learn its id, status, origin or requested
 *    model: about 19.5k random pages for the largest tenant's week, which is
 *    ~20 s on a cold cache. The key is unchanged, so every query that used the
 *    old index can still use it. It is rebuilt in place under the same name
 *    because the CRM metrics feed refuses to run unless that name is valid.
 *
 * 2. `IDX_agent_messages_fallback_window` lists fallback attempts by tenant and
 *    time, so the `fallback` and `none` triggers read them once per window
 *    rather than fetching every attempt's heap row to test the column.
 *
 * Both build concurrently so live request writes continue during deploy, and
 * every step is safe to rerun after an interruption (see rebuildIndexInPlace
 * for the requests index). The Requests log runs on
 * self-hosted installs too, so nothing is gated by mode.
 */
export class CoverRequestsLogFilters1803000000000 implements MigrationInterface {
  name = 'CoverRequestsLogFilters1803000000000';
  transaction = false;

  static readonly REQUESTS_INDEX: InPlaceIndex = {
    table: 'requests',
    index: 'IDX_requests_tenant_timestamp',
    build: 'IDX_requests_tenant_timestamp_next',
    key: '"tenant_id", "timestamp"',
    include: '"id", "agent_id", "status", "error_origin", "error_class", "requested_model"',
  };
  static readonly FALLBACK_INDEX = 'IDX_agent_messages_fallback_window';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { REQUESTS_INDEX, FALLBACK_INDEX } = CoverRequestsLogFilters1803000000000;
    await rebuildIndexInPlace(queryRunner, REQUESTS_INDEX, 'covering');

    await this.dropIfInvalid(queryRunner, FALLBACK_INDEX);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "${FALLBACK_INDEX}"
        ON "agent_messages" ("tenant_id", "timestamp")
        INCLUDE ("request_id")
        WHERE "fallback_from_model" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { REQUESTS_INDEX, FALLBACK_INDEX } = CoverRequestsLogFilters1803000000000;
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${FALLBACK_INDEX}"`);
    await rebuildIndexInPlace(queryRunner, REQUESTS_INDEX, 'plain');
  }

  /**
   * A cancelled CONCURRENTLY build leaves an INVALID shell that
   * `CREATE ... IF NOT EXISTS` would skip over by name. Drop only that shell,
   * never a valid index a previous run finished building.
   */
  private async dropIfInvalid(queryRunner: QueryRunner, indexName: string): Promise<void> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`,
      [indexName],
    );
    if (rows.length > 0) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
    }
  }
}
