import { QueryRunner } from 'typeorm';
import { AddAutofixWaitlistSignups1799000000000 } from './1799000000000-AddAutofixWaitlistSignups';

describe('AddAutofixWaitlistSignups1799000000000', () => {
  let migration: AddAutofixWaitlistSignups1799000000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixWaitlistSignups1799000000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('creates the autofix_waitlist_signups table', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE "autofix_waitlist_signups"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('"email" varchar'));
      expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('"source" varchar'));
      expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('UNIQUE ("email")'));
    });
  });

  describe('down', () => {
    it('drops the autofix_waitlist_signups table', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE "autofix_waitlist_signups"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixWaitlistSignups1799000000000');
  });
});
