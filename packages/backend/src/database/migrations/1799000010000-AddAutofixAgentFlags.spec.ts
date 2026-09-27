import { QueryRunner } from 'typeorm';
import { AddAutofixAgentFlags1799000010000 } from './1799000010000-AddAutofixAgentFlags';

describe('AddAutofixAgentFlags1799000010000', () => {
  let migration: AddAutofixAgentFlags1799000010000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixAgentFlags1799000010000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the autofix_enabled column to agents', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ADD COLUMN "autofix_enabled"'),
      );
    });
  });

  describe('down', () => {
    it('drops the autofix_enabled column', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP COLUMN "autofix_enabled"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixAgentFlags1799000010000');
  });
});
