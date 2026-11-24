import { CoverRequestsLogFilters1803000000000 } from './1803000000000-CoverRequestsLogFilters';

type Shape = { valid: boolean; covering: boolean };

/**
 * A query runner whose catalog holds `shapes` by index name (the requests
 * index probe) and reports `invalid` names as INVALID shells (the fallback
 * index probe). Returns the DDL it ran.
 */
async function run(
  direction: 'up' | 'down',
  shapes: Record<string, Shape> = {},
  invalid: string[] = [],
): Promise<string[]> {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const name = String(params?.[0]);
    if (sql.includes('pg_get_indexdef')) return shapes[name] ? [shapes[name]] : [];
    if (sql.includes('FROM pg_index i')) return invalid.includes(name) ? [{}] : [];
    return [];
  });
  await new CoverRequestsLogFilters1803000000000()[direction]({ query } as never);
  return query.mock.calls
    .map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    .filter((sql) => !sql.includes('FROM pg_index i'));
}

const LIVE = 'IDX_requests_tenant_timestamp';
const FALLBACK =
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_fallback_window" ON "agent_messages" ("tenant_id", "timestamp") INCLUDE ("request_id") WHERE "fallback_from_model" IS NOT NULL';

describe('CoverRequestsLogFilters1803000000000', () => {
  it('runs outside a transaction so the builds can be concurrent', () => {
    expect(new CoverRequestsLogFilters1803000000000().transaction).toBe(false);
  });

  it('rebuilds the requests index as a covering index under the same name, then adds the fallback index', async () => {
    expect(await run('up', { [LIVE]: { valid: true, covering: false } })).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_tenant_timestamp_next" ON "requests" ("tenant_id", "timestamp") INCLUDE ("id", "agent_id", "status", "error_origin", "error_class", "requested_model")',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_tenant_timestamp"',
      'ALTER INDEX "IDX_requests_tenant_timestamp_next" RENAME TO "IDX_requests_tenant_timestamp"',
      FALLBACK,
    ]);
  });

  it('leaves an already covering requests index alone on rerun', async () => {
    expect(await run('up', { [LIVE]: { valid: true, covering: true } })).toEqual([FALLBACK]);
  });

  it('drops an invalid fallback shell before retrying it', async () => {
    expect(
      await run('up', { [LIVE]: { valid: true, covering: true } }, [
        'IDX_agent_messages_fallback_window',
      ]),
    ).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_fallback_window"', FALLBACK]);
  });

  it('drops the fallback index and restores the plain requests index on revert', async () => {
    expect(await run('down', { [LIVE]: { valid: true, covering: true } })).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_fallback_window"',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_tenant_timestamp_next" ON "requests" ("tenant_id", "timestamp")',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_tenant_timestamp"',
      'ALTER INDEX "IDX_requests_tenant_timestamp_next" RENAME TO "IDX_requests_tenant_timestamp"',
    ]);
  });

  it('only drops the fallback index on revert when the requests index is already plain', async () => {
    expect(await run('down', { [LIVE]: { valid: true, covering: false } })).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_fallback_window"',
    ]);
  });
});
