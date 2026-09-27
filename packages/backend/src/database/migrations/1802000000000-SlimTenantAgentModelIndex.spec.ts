import { SlimTenantAgentModelIndex1802000000000 } from './1802000000000-SlimTenantAgentModelIndex';

describe('SlimTenantAgentModelIndex1802000000000', () => {
  const migration = new SlimTenantAgentModelIndex1802000000000();
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
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('SlimTenantAgentModelIndex1802000000000');
  });

  it('builds the slim agent+model index then drops the fat dedup index', async () => {
    await migration.up(mockQueryRunner);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(args[0]).toEqual([['IDX_agent_messages_tenant_agent_id_model']]);
    expect(queries[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_agent_id_model"',
    );
    expect(queries[1]).toContain('ON "agent_messages"');
    expect(queries[1]).toContain('("tenant_id", "agent_id", "model")');
    expect(queries[2]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_model_status_ts"',
    );
  });

  it('restores the fat dedup index then drops the slim index on rollback', async () => {
    await migration.down(mockQueryRunner);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(args[0]).toEqual([['IDX_agent_messages_tenant_agent_model_status_ts']]);
    expect(queries[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_agent_model_status_ts"',
    );
    expect(queries[1]).toContain('("tenant_id", "agent_id", "model", "status", "timestamp")');
    expect(queries[2]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_id_model"',
    );
  });

  it('drops an INVALID slim-index shell before rebuilding on up', async () => {
    invalidRows = [{}];
    await migration.up(mockQueryRunner);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(queries[1]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_id_model"',
    );
    expect(queries[2]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_agent_id_model"',
    );
    expect(queries[3]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_model_status_ts"',
    );
  });

  it('drops an INVALID fat-index shell before rebuilding on down', async () => {
    invalidRows = [{}];
    await migration.down(mockQueryRunner);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(queries[1]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_model_status_ts"',
    );
    expect(queries[2]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_agent_model_status_ts"',
    );
    expect(queries[3]).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_id_model"',
    );
  });
});
