import { QueryRunner } from 'typeorm';
import { MakeAutofixEnabledNullable1799000300000 } from './1799000300000-MakeAutofixEnabledNullable';

describe('MakeAutofixEnabledNullable1799000300000', () => {
  let migration: MakeAutofixEnabledNullable1799000300000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new MakeAutofixEnabledNullable1799000300000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('drops the default and NOT NULL, then resets the old blanket false to NULL', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      const sql = queryRunner.query.mock.calls.map((c) => c[0] as string);
      expect(sql[0]).toContain('DROP DEFAULT');
      expect(sql[1]).toContain('DROP NOT NULL');
      expect(sql[2]).toContain('SET "autofix_enabled" = NULL');
      expect(sql[2]).toContain('WHERE "autofix_enabled" = false');
    });
  });

  describe('down', () => {
    it('collapses NULL back to false, then restores the default and NOT NULL', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      const sql = queryRunner.query.mock.calls.map((c) => c[0] as string);
      expect(sql[0]).toContain('SET "autofix_enabled" = false');
      expect(sql[0]).toContain('WHERE "autofix_enabled" IS NULL');
      expect(sql[1]).toContain('SET DEFAULT false');
      expect(sql[2]).toContain('SET NOT NULL');
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('MakeAutofixEnabledNullable1799000300000');
  });
});
