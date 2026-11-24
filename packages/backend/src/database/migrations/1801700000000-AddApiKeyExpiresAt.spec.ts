import { QueryRunner } from 'typeorm';
import { AddApiKeyExpiresAt1801700000000 } from './1801700000000-AddApiKeyExpiresAt';

function fakeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('AddApiKeyExpiresAt1801700000000', () => {
  it('up adds a nullable naive-timestamp expires_at column and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddApiKeyExpiresAt1801700000000().up(runner);
    // The column type must match the entity's timestampType() (naive `timestamp`).
    // A `TIMESTAMP WITH TIME ZONE` column would diverge from every other
    // timestamp in the schema and from toLocalSqlTimestamp() writes.
    expect(queries).toContain(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP`,
    );
    expect(queries.join(' ')).not.toMatch(/WITH TIME ZONE/i);
    expect(queries[queries.length - 1]).toContain('RESET lock_timeout');
  });

  it('down drops the column and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddApiKeyExpiresAt1801700000000().down(runner);
    expect(queries.some((q) => q.includes('DROP COLUMN IF EXISTS "expires_at"'))).toBe(true);
    expect(queries[queries.length - 1]).toContain('RESET lock_timeout');
  });

  it('resets lock_timeout even when the ALTER fails', async () => {
    const runner = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockRejectedValueOnce(new Error('boom')) // ALTER
        .mockResolvedValueOnce(undefined), // RESET
    } as unknown as QueryRunner;
    await expect(new AddApiKeyExpiresAt1801700000000().up(runner)).rejects.toThrow('boom');
    expect((runner.query as jest.Mock).mock.calls[2][0]).toContain('RESET lock_timeout');
  });

  it('resets lock_timeout even when the DROP fails', async () => {
    const runner = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockRejectedValueOnce(new Error('kaboom')) // DROP
        .mockResolvedValueOnce(undefined), // RESET
    } as unknown as QueryRunner;
    await expect(new AddApiKeyExpiresAt1801700000000().down(runner)).rejects.toThrow('kaboom');
    expect((runner.query as jest.Mock).mock.calls[2][0]).toContain('RESET lock_timeout');
  });
});
