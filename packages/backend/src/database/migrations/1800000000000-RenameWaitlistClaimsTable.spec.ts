import { QueryRunner } from 'typeorm';
import { RenameWaitlistClaimsTable1800000000000 } from './1800000000000-RenameWaitlistClaimsTable';

describe('RenameWaitlistClaimsTable1800000000000', () => {
  let migration: RenameWaitlistClaimsTable1800000000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new RenameWaitlistClaimsTable1800000000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('renames the table, column, and constraints', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('RENAME TO "waitlist_claims"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('RENAME COLUMN "signed_up_at" TO "claimed_at"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'RENAME CONSTRAINT "PK_autofix_waitlist_signups" TO "PK_waitlist_claims"',
        ),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'RENAME CONSTRAINT "UQ_autofix_waitlist_signups_email" TO "UQ_waitlist_claims_email"',
        ),
      );
    });
  });

  describe('down', () => {
    it('reverts the rename', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'RENAME CONSTRAINT "UQ_waitlist_claims_email" TO "UQ_autofix_waitlist_signups_email"',
        ),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'RENAME CONSTRAINT "PK_waitlist_claims" TO "PK_autofix_waitlist_signups"',
        ),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('RENAME COLUMN "claimed_at" TO "signed_up_at"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('RENAME TO "autofix_waitlist_signups"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('RenameWaitlistClaimsTable1800000000000');
  });
});
