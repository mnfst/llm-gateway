import { EnableRecordingForNewAgents1801500000000 } from './1801500000000-EnableRecordingForNewAgents';

describe('EnableRecordingForNewAgents1801500000000', () => {
  const migration = new EnableRecordingForNewAgents1801500000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('enables recording only through the default for newly inserted agents', async () => {
    await migration.up(queryRunner);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "agents" ALTER COLUMN "record_messages" SET DEFAULT true`,
    );
    expect(query.mock.calls.flat().join(' ')).not.toMatch(/\bUPDATE\b/i);
  });

  it('restores the disabled default without changing existing agents', async () => {
    await migration.down(queryRunner);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "agents" ALTER COLUMN "record_messages" SET DEFAULT false`,
    );
    expect(query.mock.calls.flat().join(' ')).not.toMatch(/\bUPDATE\b/i);
  });
});
