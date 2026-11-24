import { AddRequestsAutofixHealedIndex1802200000000 } from './1802200000000-AddRequestsAutofixHealedIndex';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';

jest.mock('../../common/utils/detect-self-hosted', () => ({ isSelfHosted: jest.fn() }));
const mockedIsSelfHosted = jest.mocked(isSelfHosted);

describe('AddRequestsAutofixHealedIndex1802200000000', () => {
  const migration = new AddRequestsAutofixHealedIndex1802200000000();
  let queries: string[];
  let args: unknown[][];
  let invalidRows: unknown[];

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string, ...params: unknown[]) => {
      queries.push(sql);
      args.push(params);
      if (sql.includes('NOT i.indisvalid')) {
        return Promise.resolve(invalidRows);
      }
      return Promise.resolve([]);
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    args = [];
    invalidRows = [];
    jest.clearAllMocks();
    mockedIsSelfHosted.mockReturnValue(false);
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('AddRequestsAutofixHealedIndex1802200000000');
  });

  it('runs outside a transaction so CONCURRENTLY is legal', () => {
    expect(migration.transaction).toBe(false);
  });

  it('builds the partial index, then refreshes the planner stats', async () => {
    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(args[0]).toEqual([['IDX_requests_autofix_healed']]);
    expect(queries[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_autofix_healed"',
    );
    expect(queries[1]).toContain('ON "requests" ("tenant_id", "timestamp")');
    expect(queries[1]).toContain('INCLUDE ("status")');
    expect(queries[1]).toContain(`WHERE "autofix_status" = 'retry_succeeded'`);
    expect(queries[2]).toBe('ANALYZE "requests"');
  });

  it('keeps a valid index instead of rebuilding it on a retried deploy', async () => {
    // A deploy interrupted after the build succeeded but before TypeORM
    // recorded the migration re-runs up(). Dropping unconditionally here would
    // throw away a usable index and leave the feed 503ing while it rebuilt.
    await migration.up(mockQueryRunner);

    expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
  });

  it('drops an INVALID shell before rebuilding, since IF NOT EXISTS matches on name', async () => {
    invalidRows = [{}];

    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(queries[1]).toBe('DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_autofix_healed"');
    expect(queries[2]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_requests_autofix_healed"',
    );
    expect(queries[3]).toBe('ANALYZE "requests"');
  });

  it('drops the index on rollback', async () => {
    await migration.down(mockQueryRunner);

    expect(queries).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_autofix_healed"']);
  });

  describe('self-hosted', () => {
    // The feed is Cloud-only and its module is not registered on self-hosted,
    // so the index would be dead weight. Skipping also spares those upgrades a
    // whole-table CONCURRENTLY scan during boot.
    it('touches nothing on the way up', async () => {
      mockedIsSelfHosted.mockReturnValue(true);

      await migration.up(mockQueryRunner);

      expect(queries).toEqual([]);
    });

    it('still drops on the way down, so a cloud-built index is never orphaned', async () => {
      // A database migrated in cloud mode can be reverted while the process
      // looks self-hosted. DROP ... IF EXISTS is a no-op where it never existed.
      mockedIsSelfHosted.mockReturnValue(true);

      await migration.down(mockQueryRunner);

      expect(queries).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_autofix_healed"']);
    });
  });
});
