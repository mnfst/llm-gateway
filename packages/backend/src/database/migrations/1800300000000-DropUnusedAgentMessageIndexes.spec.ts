import { DropUnusedAgentMessageIndexes1800300000000 } from './1800300000000-DropUnusedAgentMessageIndexes';

describe('DropUnusedAgentMessageIndexes1800300000000', () => {
  const migration = new DropUnusedAgentMessageIndexes1800300000000();
  let queries: string[];

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string) => {
      queries.push(sql);
      return Promise.resolve();
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    jest.clearAllMocks();
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('DropUnusedAgentMessageIndexes1800300000000');
  });

  it('runs outside a transaction so the drops can be CONCURRENT', () => {
    expect(migration.transaction).toBe(false);
  });

  it('drops both unused indexes concurrently', async () => {
    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_user_id_timestamp"',
    );
    expect(queries[1]).toContain('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors"');
    // The timestamp-leading twin does the cross-tenant work and must survive.
    for (const sql of queries) expect(sql).not.toContain('IDX_agent_messages_errors_timestamp');
  });

  it('recreates both indexes on rollback, matching their original definitions', async () => {
    await migration.down(mockQueryRunner);

    expect(queries).toHaveLength(4);
    expect(queries[1]).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(queries[1]).toContain('"IDX_agent_messages_user_id_timestamp"');
    expect(queries[1]).toContain('ON "agent_messages" ("user_id", "timestamp")');

    expect(queries[3]).toContain('"IDX_agent_messages_errors"');
    expect(queries[3]).toContain('ON "agent_messages" ("tenant_id", "timestamp")');
    expect(queries[3]).toContain(`WHERE "status" IN ('error', 'fallback_error', 'rate_limited')`);
  });

  it('clears an invalid leftover before each concurrent rebuild', async () => {
    await migration.down(mockQueryRunner);

    // `CREATE ... IF NOT EXISTS` matches on name and would skip an INVALID
    // index left by an interrupted CONCURRENTLY build, wedging it forever.
    expect(queries[0]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_user_id_timestamp"',
    );
    expect(queries[2]).toContain('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_errors"');
  });
});
