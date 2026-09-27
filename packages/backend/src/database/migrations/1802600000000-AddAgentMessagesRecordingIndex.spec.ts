import { AddAgentMessagesRecordingIndex1802600000000 } from './1802600000000-AddAgentMessagesRecordingIndex';

describe('AddAgentMessagesRecordingIndex1802600000000', () => {
  const migration = new AddAgentMessagesRecordingIndex1802600000000();
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
    expect(migration.name).toBe('AddAgentMessagesRecordingIndex1802600000000');
  });

  it('runs outside a transaction so CONCURRENTLY is legal', () => {
    expect(migration.transaction).toBe(false);
  });

  it('builds the partial index over recorded attempts, then refreshes the planner stats', async () => {
    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('NOT i.indisvalid');
    expect(args[0]).toEqual([['IDX_agent_messages_recording']]);
    expect(queries[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_recording"',
    );
    expect(queries[1]).toContain('ON "agent_messages" ("timestamp")');
    expect(queries[1]).toContain('INCLUDE ("id", "request_id", "recording_key")');
    expect(queries[1]).toContain('WHERE "recording_key" IS NOT NULL');
    expect(queries[2]).toBe('ANALYZE "agent_messages"');
  });

  it('keeps a valid index instead of rebuilding it on a retried deploy', async () => {
    await migration.up(mockQueryRunner);

    expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
  });

  it('drops an INVALID shell before rebuilding, since IF NOT EXISTS matches on name', async () => {
    invalidRows = [{}];

    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(4);
    expect(queries[1]).toBe('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_recording"');
    expect(queries[2]).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(queries[3]).toBe('ANALYZE "agent_messages"');
  });

  it('drops the index on rollback', async () => {
    await migration.down(mockQueryRunner);

    expect(queries).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_recording"']);
  });
});
