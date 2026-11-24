import { MigrationInterface, QueryRunner } from 'typeorm';
import { InPlaceIndex, rebuildIndexInPlace } from '../index-rebuild';

/**
 * Serve the Requests log's harness-scoped filters from the harness index.
 *
 * With a harness picked, Postgres reads `IDX_requests_tenant_agent_timestamp`
 * and then fetched one `requests` heap page per row in range to test the
 * status or error origin. For a harness that carries most of its tenant's
 * traffic that was ~20k random pages for a week, about 16 s on a cold cache,
 * the one filter combination 1803000000000 did not reach. Including the
 * columns the log filters on makes those scans index-only. The key is
 * unchanged, so every query that used the old index can still use it.
 *
 * Rebuilt in place under the same name, concurrently so request writes
 * continue during deploy; see rebuildIndexInPlace for why every step is safe
 * to rerun in either direction.
 */
export class CoverHarnessRequestsIndex1803100000000 implements MigrationInterface {
  name = 'CoverHarnessRequestsIndex1803100000000';
  transaction = false;

  static readonly INDEX: InPlaceIndex = {
    table: 'requests',
    index: 'IDX_requests_tenant_agent_timestamp',
    build: 'IDX_requests_tenant_agent_timestamp_next',
    key: '"tenant_id", "agent_id", "timestamp"',
    include: '"id", "status", "error_origin", "error_class", "requested_model"',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    await rebuildIndexInPlace(
      queryRunner,
      CoverHarnessRequestsIndex1803100000000.INDEX,
      'covering',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await rebuildIndexInPlace(queryRunner, CoverHarnessRequestsIndex1803100000000.INDEX, 'plain');
  }
}
