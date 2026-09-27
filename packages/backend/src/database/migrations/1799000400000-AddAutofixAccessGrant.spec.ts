import { QueryRunner } from 'typeorm';
import { AddAutofixAccessGrant1799000400000 } from './1799000400000-AddAutofixAccessGrant';

describe('AddAutofixAccessGrant1799000400000', () => {
  let migration: AddAutofixAccessGrant1799000400000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixAccessGrant1799000400000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  it('adds the autofix_access_granted_at column to tenants', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('ADD COLUMN "autofix_access_granted_at"'),
    );
  });

  it('drops the autofix_access_granted_at column', async () => {
    await migration.down(queryRunner as unknown as QueryRunner);
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('DROP COLUMN "autofix_access_granted_at"'),
    );
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixAccessGrant1799000400000');
  });
});
