import { QueryRunner } from 'typeorm';
import { AddCliAuthCodeChallenge1801730000000 } from './1801730000000-AddCliAuthCodeChallenge';

function fakeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('AddCliAuthCodeChallenge1801730000000', () => {
  it('up adds nullable code_challenge columns and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddCliAuthCodeChallenge1801730000000().up(runner);
    expect(queries).toContain(
      `ALTER TABLE "cli_auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge" character varying(128)`,
    );
    expect(queries).toContain(
      `ALTER TABLE "cli_auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge_method" character varying(10)`,
    );
    expect(queries[queries.length - 1]).toContain('RESET lock_timeout');
  });

  it('down drops the columns and resets lock_timeout', async () => {
    const { runner, queries } = fakeRunner();
    await new AddCliAuthCodeChallenge1801730000000().down(runner);
    expect(queries.some((q) => q.includes('DROP COLUMN IF EXISTS "code_challenge"'))).toBe(true);
    expect(queries.some((q) => q.includes('DROP COLUMN IF EXISTS "code_challenge_method"'))).toBe(
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
    await expect(new AddCliAuthCodeChallenge1801730000000().up(runner)).rejects.toThrow('boom');
    expect((runner.query as jest.Mock).mock.calls[2][0]).toContain('RESET lock_timeout');
  });
});
