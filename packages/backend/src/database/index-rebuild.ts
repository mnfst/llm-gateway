import type { QueryRunner } from 'typeorm';

/** An index rebuilt in place: same name, same key, with or without INCLUDE columns. */
export interface InPlaceIndex {
  table: string;
  /** Live name; callers such as the CRM metrics check look it up by name. */
  index: string;
  /** Temporary name the replacement is built under before the swap. */
  build: string;
  /** Key columns, quoted, e.g. `"tenant_id", "timestamp"`. */
  key: string;
  /** Covering columns, quoted, e.g. `"id", "status"`. */
  include: string;
}

interface IndexShape {
  valid: boolean;
  covering: boolean;
}

async function shapeOf(queryRunner: QueryRunner, name: string): Promise<IndexShape | null> {
  const rows = (await queryRunner.query(
    `SELECT i.indisvalid AS "valid", pg_get_indexdef(i.indexrelid) LIKE '% INCLUDE %' AS "covering"
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = current_schema()`,
    [name],
  )) as IndexShape[];
  return rows[0] ?? null;
}

/**
 * Bring `spec.index` to the target shape (covering or plain) without ever
 * trusting a name alone.
 *
 * The replacement is built concurrently under `spec.build`, then the live
 * index is dropped and the build renamed, so the name is missing only between
 * two catalog statements. Every step is safe to rerun, in either direction: a
 * leftover build is reused only when it is valid AND already has the target
 * shape. A build left by the opposite direction (a revert that crashed before
 * its rename, say) is dropped and rebuilt, because `CREATE INDEX ... IF NOT
 * EXISTS` matches by name and would otherwise swap in the wrong shape and
 * report success.
 */
export async function rebuildIndexInPlace(
  queryRunner: QueryRunner,
  spec: InPlaceIndex,
  target: 'covering' | 'plain',
): Promise<void> {
  const covering = target === 'covering';

  const live = await shapeOf(queryRunner, spec.index);
  if (live?.valid && live.covering === covering) return;

  const build = await shapeOf(queryRunner, spec.build);
  if (build && (!build.valid || build.covering !== covering)) {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.build}"`);
  }
  const include = covering ? ` INCLUDE (${spec.include})` : '';
  await queryRunner.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${spec.build}" ON "${spec.table}" (${spec.key})${include}`,
  );
  await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.index}"`);
  await queryRunner.query(`ALTER INDEX "${spec.build}" RENAME TO "${spec.index}"`);
}
