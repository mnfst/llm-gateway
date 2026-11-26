import { QueryRunner } from 'typeorm';
import { CreateCacheInvalidations1803200000000 } from './1803200000000-CreateCacheInvalidations';

function fakeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('CreateCacheInvalidations1803200000000', () => {
  it('up creates the table and its created_at index', async () => {
    const { runner, queries } = fakeRunner();
    await new CreateCacheInvalidations1803200000000().up(runner);
    const sql = queries.join(' ');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "cache_invalidations"');
    expect(sql).toContain('"id" BIGSERIAL NOT NULL');
    expect(sql).toContain('"scope" character varying(16) NOT NULL');
    expect(sql).toContain('"target_id" character varying NOT NULL');
    expect(sql).toContain('"created_at" TIMESTAMP NOT NULL DEFAULT now()');
    expect(sql).not.toMatch(/WITH TIME ZONE/i);
    expect(queries).toContain(
      `CREATE INDEX IF NOT EXISTS "IDX_cache_invalidations_created_at" ON "cache_invalidations" ("created_at")`,
    );
  });

  it('down drops the table', async () => {
    const { runner, queries } = fakeRunner();
    await new CreateCacheInvalidations1803200000000().down(runner);
    expect(queries).toEqual([`DROP TABLE IF EXISTS "cache_invalidations"`]);
  });
});
