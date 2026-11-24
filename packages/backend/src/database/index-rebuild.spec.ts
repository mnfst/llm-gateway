import { InPlaceIndex, rebuildIndexInPlace } from './index-rebuild';

const SPEC: InPlaceIndex = {
  table: 'requests',
  index: 'IDX_live',
  build: 'IDX_live_next',
  key: '"tenant_id", "timestamp"',
  include: '"id", "status"',
};

type Shape = { valid: boolean; covering: boolean } | null;

/** A query runner whose catalog holds `shapes` by index name; returns the DDL it ran. */
async function run(shapes: Record<string, Shape>, target: 'covering' | 'plain'): Promise<string[]> {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM pg_index i')) {
      const shape = shapes[String(params?.[0])];
      return shape ? [shape] : [];
    }
    return [];
  });
  await rebuildIndexInPlace({ query } as never, SPEC, target);
  return query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => !sql.includes('FROM pg_index i'));
}

const CREATE_COVERING =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_live_next" ON "requests" ("tenant_id", "timestamp") INCLUDE ("id", "status")';
const CREATE_PLAIN =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_live_next" ON "requests" ("tenant_id", "timestamp")';
const DROP_LIVE = 'DROP INDEX CONCURRENTLY IF EXISTS "IDX_live"';
const DROP_BUILD = 'DROP INDEX CONCURRENTLY IF EXISTS "IDX_live_next"';
const RENAME = 'ALTER INDEX "IDX_live_next" RENAME TO "IDX_live"';

const covering = { valid: true, covering: true };
const plain = { valid: true, covering: false };

describe('rebuildIndexInPlace', () => {
  it('builds the covering index beside the live one, then swaps it in', async () => {
    expect(await run({ IDX_live: plain }, 'covering')).toEqual([
      CREATE_COVERING,
      DROP_LIVE,
      RENAME,
    ]);
  });

  it('does nothing when the live index already has the target shape', async () => {
    expect(await run({ IDX_live: covering }, 'covering')).toEqual([]);
    expect(await run({ IDX_live: plain }, 'plain')).toEqual([]);
  });

  it('finishes a same-direction swap that crashed before the rename', async () => {
    // The build is right, so it is kept; only the rename remains.
    expect(await run({ IDX_live_next: covering }, 'covering')).toEqual([
      CREATE_COVERING,
      DROP_LIVE,
      RENAME,
    ]);
  });

  it('rebuilds a leftover of the opposite shape instead of swapping it in', async () => {
    // A revert crashed after dropping the live index and before renaming its
    // plain build. Migrating up must not rename that plain build into place.
    expect(await run({ IDX_live_next: plain }, 'covering')).toEqual([
      DROP_BUILD,
      CREATE_COVERING,
      DROP_LIVE,
      RENAME,
    ]);
  });

  it('restores the index when a crashed revert is rerun', async () => {
    // Same crash, revert again: the live index is missing, so it is not "done".
    expect(await run({ IDX_live_next: plain }, 'plain')).toEqual([CREATE_PLAIN, DROP_LIVE, RENAME]);
  });

  it('drops an invalid build left by a cancelled concurrent build', async () => {
    expect(
      await run({ IDX_live: plain, IDX_live_next: { valid: false, covering: true } }, 'covering'),
    ).toEqual([DROP_BUILD, CREATE_COVERING, DROP_LIVE, RENAME]);
  });

  it('rebuilds a live index that is invalid even when its shape matches', async () => {
    expect(await run({ IDX_live: { valid: false, covering: true } }, 'covering')).toEqual([
      CREATE_COVERING,
      DROP_LIVE,
      RENAME,
    ]);
  });

  it('builds a plain index on revert', async () => {
    expect(await run({ IDX_live: covering }, 'plain')).toEqual([CREATE_PLAIN, DROP_LIVE, RENAME]);
  });
});
