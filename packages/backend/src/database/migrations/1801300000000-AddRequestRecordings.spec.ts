import { AddRequestRecordings1801300000000 } from './1801300000000-AddRequestRecordings';

describe('AddRequestRecordings1801300000000', () => {
  const migration = new AddRequestRecordings1801300000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('adds an opt-in agent flag and request-owned recording table', async () => {
    await migration.up(queryRunner);

    const sql = query.mock.calls.map(([statement]) => statement).join(' ');
    expect(sql).toContain('"record_messages" boolean NOT NULL DEFAULT false');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "request_recordings"');
    expect(sql).toContain('"storage_key" varchar NOT NULL');
    expect(sql).toContain('"storage_backend" varchar NOT NULL');
    expect(sql).toContain('"status" varchar NOT NULL DEFAULT \'pending\'');
    expect(sql).toContain('"content_encoding" varchar NOT NULL DEFAULT \'gzip\'');
    expect(sql).not.toContain('"request_body" jsonb');
    expect(sql).not.toContain('"response_body" jsonb');
    expect(sql).toContain(
      'FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE RESTRICT',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_request_recordings_created_at" ON "request_recordings" ("created_at")',
    );
  });

  it('removes the recording table before the agent flag', async () => {
    await migration.down(queryRunner);

    expect(query.mock.calls[0][0]).toContain('DROP TABLE IF EXISTS "request_recordings"');
    expect(query.mock.calls[1][0]).toContain('DROP COLUMN IF EXISTS "record_messages"');
  });
});
