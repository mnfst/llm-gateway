import { AddStreamWarmupMs1802300000000 } from './1802300000000-AddStreamWarmupMs';

describe('AddStreamWarmupMs1802300000000', () => {
  const migration = new AddStreamWarmupMs1802300000000();
  let queries: string[];

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string) => {
      queries.push(sql);
      return Promise.resolve([]);
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    jest.clearAllMocks();
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('AddStreamWarmupMs1802300000000');
  });

  it('adds both nullable columns with a session-scoped lock timeout', async () => {
    await migration.up(mockQueryRunner);
    expect(queries[0]).toBe(`SET lock_timeout = '5s'`);
    expect(queries[1]).toContain(
      'ALTER TABLE "header_tiers" ADD COLUMN IF NOT EXISTS "stream_warmup_ms" integer DEFAULT NULL',
    );
    expect(queries[2]).toContain(
      'ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "stream_warmup_ms" integer DEFAULT NULL',
    );
    expect(queries[3]).toBe('RESET lock_timeout');
  });

  it('drops both columns on down with a session-scoped lock timeout', async () => {
    await migration.down(mockQueryRunner);
    expect(queries[0]).toBe(`SET lock_timeout = '5s'`);
    expect(queries[1]).toContain(
      'ALTER TABLE "header_tiers" DROP COLUMN IF EXISTS "stream_warmup_ms"',
    );
    expect(queries[2]).toContain(
      'ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "stream_warmup_ms"',
    );
    expect(queries[3]).toBe('RESET lock_timeout');
  });
});
