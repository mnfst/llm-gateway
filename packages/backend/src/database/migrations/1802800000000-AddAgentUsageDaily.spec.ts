import { AddAgentUsageDaily1802800000000 } from './1802800000000-AddAgentUsageDaily';

describe('AddAgentUsageDaily1802800000000', () => {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const queryRunner = { query: jest.fn() };

  beforeEach(() => {
    statements.length = 0;
    queryRunner.query.mockReset();
    queryRunner.query.mockImplementation(
      async (sql: string, params?: unknown[]): Promise<unknown[]> => {
        statements.push({ sql, params });
        return [];
      },
    );
  });

  it('creates only schema and the resumable queue index', async () => {
    const migration = new AddAgentUsageDaily1802800000000();
    await migration.up(queryRunner as never);

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(migration.transaction).toBe(false);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "agent_usage_daily"');
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "agent_id", "day")');
    expect(sql).toContain('FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "agent_usage_rolled_up_at" timestamp NULL');
    expect(sql).toContain('ALTER TABLE "agent_messages"');
    expect(sql).toContain('"IDX_requests_agent_usage_pending"');
    expect(sql).toContain('"IDX_agent_messages_agent_usage_pending"');
    expect(sql).toContain('"IDX_agent_usage_daily_tenant_day"');
    expect(sql).toContain('WHERE "agent_usage_rolled_up_at" IS NULL');
    expect(sql).not.toMatch(/DROP INDEX CONCURRENTLY/);
    expect(sql).not.toMatch(/INSERT INTO "agent_usage_daily"/);
    expect(statements[0]?.sql).toContain("SET lock_timeout = '1s'");
    expect(sql).toContain('RESET lock_timeout');
  });

  it('drops an interrupted index before recreating it', async () => {
    queryRunner.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes('NOT i.indisvalid')) return [{ exists: 1 }];
      return [];
    });

    await new AddAgentUsageDaily1802800000000().up(queryRunner as never);

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS "IDX_requests_agent_usage_pending"');
  });

  it('removes the queue index before the marker and rollup table', async () => {
    await new AddAgentUsageDaily1802800000000().down(queryRunner as never);

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql.indexOf('DROP INDEX CONCURRENTLY')).toBeLessThan(
      sql.indexOf('DROP COLUMN IF EXISTS "agent_usage_rolled_up_at"'),
    );
    expect(sql).toContain('ALTER TABLE "agent_messages" DROP COLUMN');
    expect(sql).toContain('DROP TABLE IF EXISTS "agent_usage_daily"');
  });
});
