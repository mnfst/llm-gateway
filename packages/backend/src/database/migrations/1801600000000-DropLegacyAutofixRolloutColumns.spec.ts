import { DropLegacyAutofixRolloutColumns1801600000000 } from './1801600000000-DropLegacyAutofixRolloutColumns';

describe('DropLegacyAutofixRolloutColumns1801600000000', () => {
  const migration = new DropLegacyAutofixRolloutColumns1801600000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('drops both obsolete tenant rollout columns under a bounded lock wait', async () => {
    await migration.up(queryRunner);

    expect(query).toHaveBeenCalledTimes(3);
    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET lock_timeout = '5s'");
    expect(statements.at(-1)).toContain('RESET lock_timeout');
    expect(sql).toContain('ALTER TABLE "tenants"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "autofix_waitlist_at"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "autofix_access_granted_at"');
    expect(sql).not.toContain('waitlist_claims');
  });

  it('restores nullable rollout columns on rollback', async () => {
    await migration.down(queryRunner);

    expect(query).toHaveBeenCalledTimes(3);
    const statements = query.mock.calls.map(([sql]) => sql);
    const sql = statements.join(' ');
    expect(statements[0]).toContain("SET lock_timeout = '5s'");
    expect(statements.at(-1)).toContain('RESET lock_timeout');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "autofix_waitlist_at" TIMESTAMP WITH TIME ZONE',
    );
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "autofix_access_granted_at" TIMESTAMP WITH TIME ZONE',
    );
    expect(sql).not.toContain('waitlist_claims');
  });

  it('restores the session lock timeout when the schema change fails', async () => {
    const failure = new Error('lock timeout');
    query
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw failure;
      });

    await expect(migration.up(queryRunner)).rejects.toBe(failure);
    expect(query.mock.calls.at(-1)?.[0]).toContain('RESET lock_timeout');
  });
});
