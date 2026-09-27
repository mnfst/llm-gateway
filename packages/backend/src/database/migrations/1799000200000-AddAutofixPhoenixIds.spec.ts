import { QueryRunner } from 'typeorm';
import { AddAutofixPhoenixIds1799000200000 } from './1799000200000-AddAutofixPhoenixIds';

describe('AddAutofixPhoenixIds1799000200000', () => {
  let migration: AddAutofixPhoenixIds1799000200000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixPhoenixIds1799000200000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the autofix_phoenix column to agent_messages', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ADD COLUMN "autofix_phoenix" jsonb'),
      );
    });
  });

  describe('down', () => {
    it('drops the autofix_phoenix column', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP COLUMN "autofix_phoenix"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixPhoenixIds1799000200000');
  });
});
