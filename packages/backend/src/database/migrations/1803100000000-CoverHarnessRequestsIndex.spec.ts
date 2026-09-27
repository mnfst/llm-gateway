import { CoverHarnessRequestsIndex1803100000000 } from './1803100000000-CoverHarnessRequestsIndex';

type Shape = { valid: boolean; covering: boolean };

/** A query runner whose catalog holds `shapes` by index name; returns the DDL it ran. */
async function run(
  direction: 'up' | 'down',
  shapes: Record<string, Shape> = {},
): Promise<string[]> {
  const query = jest.fn(async (sql: string, params?: unknown[]) =>
    sql.includes('FROM pg_index i') && shapes[String(params?.[0])]
      ? [shapes[String(params?.[0])]]
      : [],
  );
  await new CoverHarnessRequestsIndex1803100000000()[direction]({ query } as never);
  return query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => !sql.includes('FROM pg_index i'));
}

const LIVE = 'IDX_requests_tenant_agent_timestamp';

describe('CoverHarnessRequestsIndex1803100000000', () => {
  it('runs outside a transaction so the build can be concurrent', () => {
    expect(new CoverHarnessRequestsIndex1803100000000().transaction).toBe(false);
  });

  it('rebuilds the harness index as a covering index under the same name', async () => {
    expect(await run('up', { [LIVE]: { valid: true, covering: false } })).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_tenant_agent_timestamp_next" ON "requests" ("tenant_id", "agent_id", "timestamp") INCLUDE ("id", "status", "error_origin", "error_class", "requested_model")',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_tenant_agent_timestamp"',
      'ALTER INDEX "IDX_requests_tenant_agent_timestamp_next" RENAME TO "IDX_requests_tenant_agent_timestamp"',
    ]);
  });

  it('does nothing on rerun once the index is covering', async () => {
    expect(await run('up', { [LIVE]: { valid: true, covering: true } })).toEqual([]);
  });

  it('restores the plain index on revert', async () => {
    expect(await run('down', { [LIVE]: { valid: true, covering: true } })).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_tenant_agent_timestamp_next" ON "requests" ("tenant_id", "agent_id", "timestamp")',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_tenant_agent_timestamp"',
      'ALTER INDEX "IDX_requests_tenant_agent_timestamp_next" RENAME TO "IDX_requests_tenant_agent_timestamp"',
    ]);
  });
});
