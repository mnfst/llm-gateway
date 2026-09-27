import { QueryRunner } from 'typeorm';
import { AddAutofixWaitlist1796000000000 } from './1796000000000-AddAutofixWaitlist';

describe('AddAutofixWaitlist1796000000000', () => {
  let migration: AddAutofixWaitlist1796000000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixWaitlist1796000000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the autofix_waitlist_at column to tenants', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ADD COLUMN "autofix_waitlist_at"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('TIMESTAMP WITH TIME ZONE'),
      );
    });
  });

  describe('down', () => {
    it('drops the autofix_waitlist_at column', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP COLUMN "autofix_waitlist_at"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixWaitlist1796000000000');
  });
});
