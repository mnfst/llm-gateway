import { QueryRunner } from 'typeorm';
import { RemoveMessageRecording1795000000000 } from './1795000000000-RemoveMessageRecording';

describe('RemoveMessageRecording1795000000000', () => {
  let migration: RemoveMessageRecording1795000000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new RemoveMessageRecording1795000000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('drops the recording tables and the dead detail tables', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE IF EXISTS "message_recordings"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE IF EXISTS "llm_calls"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE IF EXISTS "tool_executions"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP TABLE IF EXISTS "agent_logs"'),
      );
    });

    it('drops the recorded flag and its partial index', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('DROP INDEX IF EXISTS "IDX_agent_messages_recorded"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "recorded"'),
      );
    });

    it('drops the per-agent record_messages toggle', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE "agents" DROP COLUMN IF EXISTS "record_messages"'),
      );
    });

    it('never touches request_headers or request_params', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      for (const call of queryRunner.query.mock.calls) {
        const sql = call[0] as string;
        expect(sql).not.toContain('request_headers');
        expect(sql).not.toContain('request_params');
      }
    });
  });

  describe('down', () => {
    it('recreates the record_messages and recorded columns', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "record_messages"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "recorded"'),
      );
    });

    it('recreates the recording and dead detail tables', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "message_recordings"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "tool_executions"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "llm_calls"'),
      );
      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "agent_logs"'),
      );
    });

    it('recreates the recorded partial index', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('"IDX_agent_messages_recorded"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('RemoveMessageRecording1795000000000');
  });
});
