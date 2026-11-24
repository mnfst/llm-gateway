import { QueryRunner } from 'typeorm';
import { AddApiKeyAbsoluteExpiresAt1801740000000 } from './1801740000000-AddApiKeyAbsoluteExpiresAt';

function fakeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('AddApiKeyAbsoluteExpiresAt1801740000000', () => {
  it('up adds a nullable naive-timestamp absolute_expires_at column and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddApiKeyAbsoluteExpiresAt1801740000000().up(runner);
    // The column type must match the entity's timestampType() (naive `timestamp`).
    expect(queries).toContain(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "absolute_expires_at" TIMESTAMP`,
    );
    expect(queries.join(' ')).not.toMatch(/WITH TIME ZONE/i);
    expect(queries[queries.length - 1]).toContain('RESET lock_timeout');
  });

  it('down drops the column and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddApiKeyAbsoluteExpiresAt1801740000000().down(runner);
    expect(queries.some((q) => q.includes('DROP COLUMN IF EXISTS "absolute_expires_at"'))).toBe(
      true,
    );
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
    await expect(new AddApiKeyAbsoluteExpiresAt1801740000000().up(runner)).rejects.toThrow('boom');
    expect((runner.query as jest.Mock).mock.calls[2][0]).toContain('RESET lock_timeout');
  });
});
