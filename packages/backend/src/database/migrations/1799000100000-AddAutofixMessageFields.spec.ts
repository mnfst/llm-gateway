import { QueryRunner } from 'typeorm';
import { AddAutofixMessageFields1799000100000 } from './1799000100000-AddAutofixMessageFields';

describe('AddAutofixMessageFields1799000100000', () => {
  let migration: AddAutofixMessageFields1799000100000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddAutofixMessageFields1799000100000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the autofix columns and the group-id index to agent_messages', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      for (const col of [
        'autofix_applied',
        'autofix_group_id',
        'autofix_role',
        'autofix_operations',
      ]) {
        expect(queryRunner.query).toHaveBeenCalledWith(
          expect.stringContaining(`ADD COLUMN "${col}"`),
        );
      }
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX "IDX_agent_messages_autofix_group"'),
      );
      // Partial index: excludes the NULL-group_id majority (normal messages).
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringMatching(/CREATE INDEX .*WHERE "autofix_group_id" IS NOT NULL/s),
      );
    });
  });

  describe('down', () => {
    it('drops the index and the autofix columns', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP INDEX "IDX_agent_messages_autofix_group"'),
      );
      for (const col of [
        'autofix_operations',
        'autofix_role',
        'autofix_group_id',
        'autofix_applied',
      ]) {
        expect(queryRunner.query).toHaveBeenCalledWith(
          expect.stringContaining(`DROP COLUMN "${col}"`),
        );
      }
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddAutofixMessageFields1799000100000');
  });
});
