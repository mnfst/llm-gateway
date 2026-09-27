import { TuneFactTableAutovacuum1802400000000 } from './1802400000000-TuneFactTableAutovacuum';

describe('TuneFactTableAutovacuum1802400000000', () => {
  const migration = new TuneFactTableAutovacuum1802400000000();
  let queries: string[];

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string) => {
      queries.push(sql);
      return Promise.resolve([]);
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    jest.clearAllMocks();
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('TuneFactTableAutovacuum1802400000000');
  });

  it('runs inside the normal migration transaction', () => {
    // ALTER TABLE ... SET (...) takes only SHARE UPDATE EXCLUSIVE and rewrites
    // nothing, so unlike the CONCURRENTLY index migrations this needs no
    // transaction opt-out.
    expect((migration as { transaction?: boolean }).transaction).toBeUndefined();
  });

  it('tunes both fact tables', async () => {
    await migration.up(mockQueryRunner);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('ALTER TABLE "requests" SET (');
    expect(queries[1]).toContain('ALTER TABLE "agent_messages" SET (');
  });

  it('scales requests analyze tighter than vacuum, both far below the defaults', async () => {
    // Defaults are 0.1 / 0.2, which on 7.45M `requests` rows mean 745k changes
    // before a re-analyze and 1.49M dead tuples before a vacuum — the reason
    // `last_autovacuum` was NULL on production and the planner estimated 2
    // rows where 13,164 came back.
    await migration.up(mockQueryRunner);

    expect(queries[0]).toContain('autovacuum_analyze_scale_factor = 0.01');
    expect(queries[0]).toContain('autovacuum_vacuum_scale_factor = 0.02');
  });

  it('leaves the agent_messages scale factors to the migration that owns them', async () => {
    // 1792900000000 already set them to 0.01/0.02. Re-setting is a no-op, but
    // the paired RESET in down() would drop them to the Postgres defaults and
    // silently undo that migration.
    await migration.up(mockQueryRunner);

    expect(queries[1]).not.toContain('autovacuum_analyze_scale_factor');
    expect(queries[1]).not.toContain('autovacuum_vacuum_scale_factor');
  });

  it('sets absolute floors so small installs do not analyze on every write', async () => {
    // A scale factor alone would make a fresh self-hosted database re-analyze
    // constantly while it holds a handful of rows.
    await migration.up(mockQueryRunner);

    for (const sql of queries) {
      expect(sql).toContain('autovacuum_analyze_threshold = 5000');
      expect(sql).toContain('autovacuum_vacuum_threshold = 5000');
    }
  });

  it('never issues a VACUUM itself', async () => {
    // VACUUM cannot run inside a transaction block, and a multi-GB vacuum has
    // no business blocking a deploy. Clearing the existing backlog is a
    // separate out-of-band step.
    await migration.up(mockQueryRunner);

    expect(queries.some((sql) => /\bVACUUM\b/.test(sql))).toBe(false);
  });

  it('resets exactly what it set, and nothing it did not', async () => {
    await migration.down(mockQueryRunner);

    expect(queries).toEqual([
      'ALTER TABLE "requests" RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)',
      'ALTER TABLE "agent_messages" RESET (autovacuum_analyze_threshold, autovacuum_vacuum_threshold)',
    ]);
  });

  it('does not regress the agent_messages tuning owned by 1792900000000', async () => {
    // Reverting only this migration must leave that table's 0.01/0.02 scale
    // factors in place. A blanket RESET here would hand them back to the
    // Postgres defaults (0.1/0.2) on a routine `migration:revert`.
    await migration.down(mockQueryRunner);

    expect(queries[1]).not.toContain('autovacuum_analyze_scale_factor');
    expect(queries[1]).not.toContain('autovacuum_vacuum_scale_factor');
  });
});
