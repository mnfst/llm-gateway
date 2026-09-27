import { ExtendDashboardCoveringIndex1801200000000 } from './1801200000000-ExtendDashboardCoveringIndex';

const CONVERGED_INDEXDEF =
  'CREATE INDEX "IDX_agent_messages_provider_usage" ON public.agent_messages USING btree (tenant_id, "timestamp") INCLUDE (model, provider, auth_type, provider_key_label, input_tokens, output_tokens, cost_usd, status, request_id, id)';

const LEGACY_1793_INDEXDEF =
  'CREATE INDEX "IDX_agent_messages_provider_usage" ON public.agent_messages USING btree (tenant_id, "timestamp") INCLUDE (model, provider, auth_type, input_tokens, output_tokens, cost_usd)';

describe('ExtendDashboardCoveringIndex1801200000000', () => {
  const migration = new ExtendDashboardCoveringIndex1801200000000();
  let queries: string[];
  let usageIndexdef: string | null;
  let invalidIndexes: Set<string>;

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string, params?: string[]) => {
      queries.push(sql);
      if (sql.includes('pg_indexes')) {
        return Promise.resolve(usageIndexdef === null ? [] : [{ indexdef: usageIndexdef }]);
      }
      if (sql.includes('pg_index ')) {
        return Promise.resolve(invalidIndexes.has(params?.[0] ?? '') ? [{ '?column?': 1 }] : []);
      }
      return Promise.resolve([]);
    }),
  } as never;

  beforeEach(() => {
    queries = [];
    usageIndexdef = null;
    invalidIndexes = new Set();
    jest.clearAllMocks();
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('ExtendDashboardCoveringIndex1801200000000');
  });

  it('runs outside a transaction so the builds can be CONCURRENT', () => {
    expect(migration.transaction).toBe(false);
  });

  it('swaps in the extended covering index when the canonical one predates the new columns', async () => {
    usageIndexdef = LEGACY_1793_INDEXDEF;

    await migration.up(mockQueryRunner);

    const swapCreate = queries.find((sql) =>
      sql.startsWith(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_provider_usage_swap"',
      ),
    );
    expect(swapCreate).toBeDefined();
    expect(swapCreate).toContain('ON "agent_messages" ("tenant_id", "timestamp")');
    expect(swapCreate).toContain(
      'INCLUDE ("model", "provider", "auth_type", "provider_key_label", "input_tokens", "output_tokens", "cost_usd", "status", "request_id", "id")',
    );

    // Swap order: build new → drop old → rename new into place.
    const buildAt = queries.indexOf(swapCreate as string);
    const dropOldAt = queries.findIndex((sql) =>
      sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_provider_usage"'),
    );
    const renameAt = queries.findIndex((sql) =>
      sql.includes('RENAME TO "IDX_agent_messages_provider_usage"'),
    );
    expect(buildAt).toBeLessThan(dropOldAt);
    expect(dropOldAt).toBeLessThan(renameAt);
  });

  it('runs the swap on a fresh database with no canonical index yet', async () => {
    usageIndexdef = null;

    await migration.up(mockQueryRunner);

    expect(
      queries.some((sql) =>
        sql.startsWith(
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_provider_usage_swap"',
        ),
      ),
    ).toBe(true);
  });

  it('SKIPS the swap when the canonical index already carries every column', async () => {
    usageIndexdef = CONVERGED_INDEXDEF;

    await migration.up(mockQueryRunner);

    expect(queries.some((sql) => sql.includes('_swap'))).toBe(false);
    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_provider_usage"'),
      ),
    ).toBe(false);
  });

  it('runs the swap when the canonical index has every column but is INVALID', async () => {
    usageIndexdef = CONVERGED_INDEXDEF;
    invalidIndexes.add('IDX_agent_messages_provider_usage');

    await migration.up(mockQueryRunner);

    expect(
      queries.some((sql) =>
        sql.startsWith(
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_provider_usage_swap"',
        ),
      ),
    ).toBe(true);
  });

  it('drops the legacy v2 interim index in both branches', async () => {
    usageIndexdef = CONVERGED_INDEXDEF;
    await migration.up(mockQueryRunner);
    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_provider_usage_v2"'),
      ),
    ).toBe(true);

    queries = [];
    usageIndexdef = LEGACY_1793_INDEXDEF;
    await migration.up(mockQueryRunner);
    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_provider_usage_v2"'),
      ),
    ).toBe(true);
  });

  it('creates the skills partial index with the exact production definition', async () => {
    await migration.up(mockQueryRunner);

    const skillsCreate = queries.find((sql) =>
      sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_skill_runs"'),
    );
    expect(skillsCreate).toBeDefined();
    expect(skillsCreate).toContain('ON "agent_messages" ("tenant_id", "timestamp")');
    expect(skillsCreate).toContain('INCLUDE ("skill_name", "agent_name", "agent_id")');
    expect(skillsCreate).toContain('WHERE "skill_name" IS NOT NULL');
  });

  it('keeps a valid pre-existing skills index but clears an INVALID leftover', async () => {
    await migration.up(mockQueryRunner);
    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_skill_runs"'),
      ),
    ).toBe(false);

    queries = [];
    invalidIndexes.add('IDX_agent_messages_skill_runs');
    await migration.up(mockQueryRunner);
    const dropAt = queries.findIndex((sql) =>
      sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_skill_runs"'),
    );
    const createAt = queries.findIndex((sql) =>
      sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_skill_runs"'),
    );
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThan(createAt);
  });

  it('restores the 1793 definition on rollback and drops the skills index', async () => {
    await migration.down(mockQueryRunner);

    const restore = queries.find((sql) =>
      sql.startsWith(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_provider_usage_swap"',
      ),
    );
    expect(restore).toContain(
      'INCLUDE ("model", "provider", "auth_type", "input_tokens", "output_tokens", "cost_usd")',
    );
    expect(
      queries.some((sql) => sql.includes('RENAME TO "IDX_agent_messages_provider_usage"')),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes('DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_skill_runs"'),
      ),
    ).toBe(true);
  });
});
