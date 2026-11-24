import { QueryRunner } from 'typeorm';
import { CreateCliAuthCodes1801710000000 } from './1801710000000-CreateCliAuthCodes';

function fakeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('CreateCliAuthCodes1801710000000', () => {
  it('up creates the table with a unique index on code_hash', async () => {
    const { runner, queries } = fakeRunner();
    await new CreateCliAuthCodes1801710000000().up(runner);
    const sql = queries.join(' ');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "cli_auth_codes"');
    expect(sql).toContain('CONSTRAINT "PK_cli_auth_codes" PRIMARY KEY ("id")');
    expect(sql).toContain('"code_hash" character varying(64) NOT NULL');
    expect(sql).toContain('"state" character varying(128) NOT NULL');
    expect(sql).toContain('"tenant_id" character varying NOT NULL');
    expect(sql).toContain('"user_id" character varying');
    expect(queries).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cli_auth_codes_code_hash" ON "cli_auth_codes" ("code_hash")`,
    );
    expect(queries).toContain(
      `CREATE INDEX IF NOT EXISTS "IDX_cli_auth_codes_expires_at" ON "cli_auth_codes" ("expires_at")`,
    );
  });

  it('up creates naive timestamp columns', async () => {
    const { runner, queries } = fakeRunner();
    await new CreateCliAuthCodes1801710000000().up(runner);
    const sql = queries.join(' ');
    // The column types must match the entity's timestampType() (naive
    // `timestamp`). A `TIMESTAMP WITH TIME ZONE` column would diverge from
    // every other timestamp in the schema and from toLocalSqlTimestamp() writes.
    expect(sql).toContain('"created_at" TIMESTAMP NOT NULL DEFAULT now()');
    expect(sql).toContain('"expires_at" TIMESTAMP NOT NULL');
    expect(sql).not.toMatch(/WITH TIME ZONE/i);
  });

  it('down drops the table', async () => {
    const { runner, queries } = fakeRunner();
    await new CreateCliAuthCodes1801710000000().down(runner);
    expect(queries).toEqual([`DROP TABLE IF EXISTS "cli_auth_codes"`]);
  });
});
