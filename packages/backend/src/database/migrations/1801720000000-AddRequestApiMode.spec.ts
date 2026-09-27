import { AddRequestApiMode1801720000000 } from './1801720000000-AddRequestApiMode';

describe('AddRequestApiMode1801720000000', () => {
  const migration = new AddRequestApiMode1801720000000();
  const query = jest.fn().mockResolvedValue([]);
  const transactionalQueryRunner = { query, isTransactionActive: true } as never;
  const nonTransactionalQueryRunner = { query, isTransactionActive: false } as never;

  beforeEach(() => jest.clearAllMocks());

  it('adds the nullable api_mode column under a bounded lock wait', async () => {
    await migration.up(transactionalQueryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain('ALTER TABLE "requests"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "api_mode" character varying');
    expect(sql).not.toContain('service_type');
  });

  it('drops the column on rollback', async () => {
    await migration.down(nonTransactionalQueryRunner);

    expect(query).toHaveBeenCalledTimes(3);
    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET lock_timeout = '5s'");
    expect(sql).toContain('DROP COLUMN IF EXISTS "api_mode"');
    expect(sql).not.toContain('service_type');
    expect(statements.at(-1)).toContain('RESET lock_timeout');
  });

  it('preserves the schema-change error without querying the aborted transaction', async () => {
    const failure = new Error('lock timeout');
    query
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw failure;
      });

    await expect(migration.up(transactionalQueryRunner)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resets a session lock timeout after a rollback error', async () => {
    const failure = new Error('lock timeout');
    query
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw failure;
      });

    await expect(migration.down(nonTransactionalQueryRunner)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.at(-1)?.[0]).toContain('RESET lock_timeout');
  });
});
