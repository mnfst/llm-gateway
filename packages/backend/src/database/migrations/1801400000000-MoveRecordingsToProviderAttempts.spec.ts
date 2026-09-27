import { MoveRecordingsToProviderAttempts1801400000000 } from './1801400000000-MoveRecordingsToProviderAttempts';

describe('MoveRecordingsToProviderAttempts1801400000000', () => {
  const migration = new MoveRecordingsToProviderAttempts1801400000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('replaces ambiguous request metadata with one pointer on each Provider Attempt', async () => {
    await migration.up(queryRunner);

    const sql = query.mock.calls.map(([statement]) => statement).join(' ');
    expect(sql).toContain('DROP TABLE IF EXISTS "request_recordings"');
    expect(sql).toContain(
      'ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "recording_key" varchar',
    );
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS "attempt_recordings"');
    expect(sql).not.toContain('"request_body" jsonb');
    expect(sql).not.toContain('"response_body" jsonb');
  });

  it('restores the previous request-owned metadata shape on rollback', async () => {
    await migration.down(queryRunner);

    const sql = query.mock.calls.map(([statement]) => statement).join(' ');
    expect(sql).toContain('ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "recording_key"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "request_recordings"');
  });
});
