import { AddTenantRequestUsage1801300000000 } from './1801300000000-AddTenantRequestUsage';

describe('AddTenantRequestUsage1801300000000', () => {
  let statements: Array<{ sql: string; params?: unknown[] }>;
  const originalManifestMode = process.env['MANIFEST_MODE'];
  const queryRunner = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
    }),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
  };

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'cloud';
    statements = [];
    jest.clearAllMocks();
    queryRunner.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
    });
  });

  afterAll(() => {
    if (originalManifestMode === undefined) {
      delete process.env['MANIFEST_MODE'];
    } else {
      process.env['MANIFEST_MODE'] = originalManifestMode;
    }
  });

  it('does not add quota counter artifacts to self-hosted installations', async () => {
    process.env['MANIFEST_MODE'] = 'selfhosted';

    await new AddTenantRequestUsage1801300000000().up(queryRunner as never);

    expect(queryRunner.query).not.toHaveBeenCalled();
    expect(queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  it('adds the exact counter and atomically publishes a trigger cutover without scanning data', async () => {
    const migration = new AddTenantRequestUsage1801300000000();
    await migration.up(queryRunner as never);

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(migration.transaction).toBe(false);
    expect(statements[0].sql).toContain("SET lock_timeout = '1s'");
    expect(statements.at(-1)?.sql).toContain('RESET lock_timeout');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_request_usage"');
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "window_start")');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "baseline_counted" boolean');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "quota_counted" boolean');
    expect(sql).not.toContain('quota_window_start');
    expect(sql).not.toContain('legacy_quota_counted');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "count_tenant_request_usage"()');
    expect(sql).toContain('AFTER INSERT OR UPDATE OF "request_id" ON "agent_messages"');
    expect(sql).toContain('AND r."quota_counted" = false');
    expect(sql).toContain('LOCK TABLE "agent_messages" IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain("'tenant_request_usage_cutover_v1'");
    expect(sql).not.toContain('WITH counted AS');
    expect(statements.every((statement) => statement.params === undefined)).toBe(true);
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('resets the lock timeout after a failed migration statement', async () => {
    const failure = new Error('lock timeout');
    queryRunner.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes('CREATE TABLE')) throw failure;
    });

    await expect(new AddTenantRequestUsage1801300000000().up(queryRunner as never)).rejects.toBe(
      failure,
    );
    expect(statements.at(-1)?.sql).toContain('RESET lock_timeout');
  });

  it('rolls back cutover publication when trigger installation fails', async () => {
    const failure = new Error('trigger failed');
    queryRunner.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes('CREATE TRIGGER')) throw failure;
    });

    await expect(new AddTenantRequestUsage1801300000000().up(queryRunner as never)).rejects.toBe(
      failure,
    );
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(statements.at(-1)?.sql).toContain('RESET lock_timeout');
  });

  it('removes the trigger before its supporting columns and table', async () => {
    await new AddTenantRequestUsage1801300000000().down(queryRunner as never);

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql.indexOf('DROP TRIGGER')).toBeLessThan(sql.indexOf('DROP FUNCTION'));
    expect(sql).toContain(
      `DELETE FROM "backfill_state" WHERE "name" = 'tenant_request_usage_cutover_v1'`,
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "quota_counted"');
    expect(sql).toContain('DROP TABLE IF EXISTS "tenant_request_usage"');
    expect(statements.at(-1)?.sql).toContain('RESET lock_timeout');
  });
});
