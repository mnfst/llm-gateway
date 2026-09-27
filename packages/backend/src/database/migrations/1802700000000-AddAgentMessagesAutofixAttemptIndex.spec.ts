import { AddAgentMessagesAutofixAttemptIndex1802700000000 } from './1802700000000-AddAgentMessagesAutofixAttemptIndex';

describe('AddAgentMessagesAutofixAttemptIndex1802700000000', () => {
  const createQueryRunner = () => ({ query: jest.fn().mockResolvedValue([]) });

  it('builds the partial Autofix-attempt index concurrently and refreshes planner statistics', async () => {
    const queryRunner = createQueryRunner();
    const migration = new AddAgentMessagesAutofixAttemptIndex1802700000000();

    await migration.up(queryRunner as never);

    expect(migration.transaction).toBe(false);
    expect(queryRunner.query).toHaveBeenNthCalledWith(1, expect.stringContaining('FROM pg_index'), [
      'IDX_agent_messages_autofix_request',
    ]);
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_autofix_request" ON "agent_messages" ("request_id") WHERE "autofix_applied" = true',
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(3, 'ANALYZE "agent_messages"');
  });

  it('removes an invalid concurrent-build shell before retrying the create', async () => {
    const queryRunner = createQueryRunner();
    queryRunner.query.mockResolvedValueOnce([{ exists: true }]);
    const migration = new AddAgentMessagesAutofixAttemptIndex1802700000000();

    await migration.up(queryRunner as never);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_autofix_request"',
    );
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('CREATE INDEX CONCURRENTLY'),
    );
  });

  it('drops the index concurrently on revert', async () => {
    const queryRunner = createQueryRunner();
    const migration = new AddAgentMessagesAutofixAttemptIndex1802700000000();

    await migration.down(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_autofix_request"',
    );
  });
});
