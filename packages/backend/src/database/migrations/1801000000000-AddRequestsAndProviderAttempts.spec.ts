import { AddRequestsAndProviderAttempts1801000000000 } from './1801000000000-AddRequestsAndProviderAttempts';

describe('AddRequestsAndProviderAttempts1801000000000', () => {
  const migration = new AddRequestsAndProviderAttempts1801000000000();
  let queries: string[];
  const runner = {
    query: jest.fn().mockImplementation((sql: string) => {
      queries.push(sql);
      return Promise.resolve();
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    jest.clearAllMocks();
  });

  it('keeps historical data work out of the deploy migration', async () => {
    await migration.up(runner);

    const sql = queries.join('\n');
    expect(migration.transaction).toBe(false);
    expect(queries[0]).toContain("SET lock_timeout = '5s'");
    expect(queries.at(-1)).toContain('RESET lock_timeout');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "requests"');
    expect(sql).toContain('"autofix_status" varchar');
    expect(sql).toContain('CONSTRAINT "CHK_requests_autofix_status"');
    for (const status of [
      'no_patch',
      'resolving',
      'retry_succeeded',
      'retry_failed',
      'service_error',
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).not.toMatch(/ALTER TABLE\s+"agent_messages"\s+RENAME/i);
    expect(sql).not.toMatch(/CREATE\s+VIEW/i);
    expect(sql).not.toMatch(/RENAME\s+COLUMN/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "request_id"');
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain("conrelid = 'agent_messages'::regclass");
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(sql).toContain(
      '"IDX_agent_messages_request_id" ON "agent_messages" ("request_id", "id")',
    );
    expect(sql).toContain('"IDX_agent_messages_unlinked_fallback"');
    expect(sql).toContain(`"IDX_requests_pending" ON "requests" ("id") WHERE "status" = 'pending'`);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"requests"/i);
    expect(sql).not.toMatch(/UPDATE\s+"agent_messages"/i);
  });

  it('is restart-safe after a partially completed non-transactional run', async () => {
    await migration.up(runner);
    const sql = queries.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "request_id"');
    expect(sql).toContain('IF NOT EXISTS (');
    expect(sql).toContain('IF NOT EXISTS "IDX_agent_messages_request_id"');
  });

  it('keeps agent_messages as the physical relation for rolling-deploy compatibility', async () => {
    await migration.up(runner);

    const sql = queries.join('\n');
    expect(sql).toContain('ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "request_id"');
    expect(sql).not.toContain('DROP TABLE "agent_messages"');
    expect(sql).not.toContain('DROP VIEW "agent_messages"');
    expect(sql).not.toContain('RENAME TO');
  });

  it('preserves every legacy column name', async () => {
    await migration.up(runner);

    const sql = queries.join('\n');
    expect(sql).not.toContain('autofix_phoenix');
    expect(sql).not.toContain('autofix_decision');
  });

  it('drops an invalid concurrent index before rebuilding it', async () => {
    (runner as { query: jest.Mock }).query.mockImplementation((sql: string) => {
      queries.push(sql);
      return Promise.resolve(sql.includes('i.indisvalid') ? [{ valid: false }] : undefined);
    });

    await migration.up(runner);

    const drop = queries.findIndex((sql) => sql.includes('DROP INDEX CONCURRENTLY'));
    const create = queries.findIndex((sql) => sql.includes('CREATE INDEX CONCURRENTLY'));
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('checks index validity on agent_messages rather than by global name alone', async () => {
    await migration.up(runner);

    const validityQuery = queries.find((sql) => sql.includes('i.indisvalid'));
    expect(validityQuery).toContain("i.indrelid = 'agent_messages'::regclass");
  });

  it('rebuilds a valid fallback index whose key order cannot support the bounded lookup', async () => {
    (runner as { query: jest.Mock }).query.mockImplementation((sql: string) => {
      queries.push(sql);
      if (sql.includes("c.relname = 'IDX_agent_messages_request_id'")) {
        return Promise.resolve([{ valid: true, definition: '(request_id, id)' }]);
      }
      if (sql.includes("c.relname = 'IDX_agent_messages_unlinked_fallback'")) {
        return Promise.resolve([
          {
            valid: true,
            definition: '(tenant_id, agent_id, fallback_from_model, "timestamp")',
          },
        ]);
      }
      return Promise.resolve();
    });

    await migration.up(runner);

    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"'),
      ),
    ).toBe(true);
  });

  it('rebuilds a fallback index missing its covering columns or predicate', async () => {
    (runner as { query: jest.Mock }).query.mockImplementation((sql: string) => {
      queries.push(sql);
      if (sql.includes("c.relname = 'IDX_agent_messages_request_id'")) {
        return Promise.resolve([{ valid: true, definition: '(request_id, id)' }]);
      }
      if (sql.includes("c.relname = 'IDX_agent_messages_unlinked_fallback'")) {
        return Promise.resolve([
          {
            valid: true,
            definition: '(fallback_from_model, "timestamp", tenant_id, agent_id)',
          },
        ]);
      }
      return Promise.resolve();
    });

    await migration.up(runner);

    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"'),
      ),
    ).toBe(true);
  });

  it('keeps a valid fallback index with the expected covering predicate', async () => {
    (runner as { query: jest.Mock }).query.mockImplementation((sql: string) => {
      queries.push(sql);
      if (sql.includes("c.relname = 'IDX_agent_messages_request_id'")) {
        return Promise.resolve([{ valid: true, definition: '(request_id, id)' }]);
      }
      if (sql.includes("c.relname = 'IDX_agent_messages_unlinked_fallback'")) {
        return Promise.resolve([
          {
            valid: true,
            definition:
              '(fallback_from_model, "timestamp", tenant_id, agent_id) INCLUDE (fallback_index, status, superseded) WHERE ((request_id IS NULL) AND (fallback_from_model IS NOT NULL))',
          },
        ]);
      }
      return Promise.resolve();
    });

    await migration.up(runner);

    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_unlinked_fallback"'),
      ),
    ).toBe(false);
  });

  it('resets the lock timeout when the migration fails', async () => {
    const failure = new Error('lock timeout');
    (runner as { query: jest.Mock }).query.mockImplementation((sql: string) => {
      queries.push(sql);
      if (sql.includes('CREATE TABLE')) return Promise.reject(failure);
      return Promise.resolve();
    });

    await expect(migration.up(runner)).rejects.toBe(failure);
    expect(queries.at(-1)).toContain('RESET lock_timeout');
  });

  it('rolls back only the additive request schema', async () => {
    await migration.down(runner);

    const sql = queries.join('\n');
    expect(sql.indexOf('DROP TRIGGER')).toBeLessThan(sql.indexOf('DROP COLUMN'));
    expect(sql).toContain('DROP COLUMN IF EXISTS "request_id"');
    expect(sql).toContain('DROP TABLE IF EXISTS "request_recordings"');
    expect(sql).toContain('DROP TABLE IF EXISTS "requests"');
    expect(
      queries.findIndex((query) => query.includes('DROP TABLE IF EXISTS "request_recordings"')),
    ).toBeLessThan(queries.findIndex((query) => query.includes('DROP TABLE IF EXISTS "requests"')));
    expect(sql).not.toContain('DROP VIEW');
    expect(sql).not.toContain('RENAME');
  });
});
