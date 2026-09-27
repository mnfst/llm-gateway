import { AddAgentMessagesDirectUsageIndex1802900000000 } from './1802900000000-AddAgentMessagesDirectUsageIndex';

describe('AddAgentMessagesDirectUsageIndex1802900000000', () => {
  const createQueryRunner = () => ({ query: jest.fn().mockResolvedValue([]) });

  it('builds a concurrent partial index for direct usage subtraction', async () => {
    const queryRunner = createQueryRunner();
    const migration = new AddAgentMessagesDirectUsageIndex1802900000000();

    await migration.up(queryRunner as never);

    expect(migration.transaction).toBe(false);
    expect(queryRunner.query).toHaveBeenNthCalledWith(1, expect.stringContaining('FROM pg_index'), [
      'IDX_agent_messages_direct_usage',
    ]);
    expect(queryRunner.query.mock.calls[1][0]).toContain('CREATE INDEX CONCURRENTLY');
    expect(queryRunner.query.mock.calls[1][0]).toContain(
      'ON "agent_messages" ("tenant_id", "agent_id", "timestamp")',
    );
    expect(queryRunner.query.mock.calls[1][0]).toContain('INCLUDE (');
    expect(queryRunner.query.mock.calls[1][0]).toContain('"agent_usage_rolled_up_at"');
    expect(queryRunner.query.mock.calls[1][0]).toContain(`WHERE "routing_reason" = 'direct'`);
    expect(queryRunner.query).toHaveBeenCalledTimes(2);
  });

  it('removes an invalid index shell before retrying', async () => {
    const queryRunner = createQueryRunner();
    queryRunner.query.mockResolvedValueOnce([{}]);
    const migration = new AddAgentMessagesDirectUsageIndex1802900000000();

    await migration.up(queryRunner as never);

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      2,
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_direct_usage"',
    );
  });

  it('drops the index concurrently on revert', async () => {
    const queryRunner = createQueryRunner();
    const migration = new AddAgentMessagesDirectUsageIndex1802900000000();

    await migration.down(queryRunner as never);

    expect(queryRunner.query).toHaveBeenCalledWith(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_direct_usage"',
    );
  });
});
