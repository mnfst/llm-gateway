import { AddCustomProviderAlias1802100000000 } from './1802100000000-AddCustomProviderAlias';

describe('AddCustomProviderAlias1802100000000', () => {
  const migration = new AddCustomProviderAlias1802100000000();
  let queries: string[];
  let args: unknown[][];
  let rows: { id: string; tenant_id: string; name: string; alias: string | null }[];

  const mockQueryRunner = {
    query: jest.fn().mockImplementation((sql: string, ...params: unknown[]) => {
      queries.push(sql);
      args.push(params);
      if (sql.startsWith('SELECT')) return Promise.resolve(rows);
      return Promise.resolve([]);
    }),
  } as never;

  const updates = () => args.filter((_, i) => queries[i].startsWith('UPDATE'));

  beforeEach(() => {
    queries = [];
    args = [];
    rows = [];
    jest.clearAllMocks();
  });

  it('exposes the expected migration name', () => {
    expect(migration.name).toBe('AddCustomProviderAlias1802100000000');
  });

  it('adds the nullable column and the case-insensitive partial unique index', async () => {
    await migration.up(mockQueryRunner);
    expect(queries[0]).toContain('ADD COLUMN IF NOT EXISTS "alias" varchar');
    expect(queries[1]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_custom_providers_tenant_alias"',
    );
    expect(queries[1]).toContain('("tenant_id", LOWER("alias")) WHERE "alias" IS NOT NULL');
    expect(queries[2]).toMatch(/^SELECT .* ORDER BY "created_at" ASC, "id" ASC$/);
  });

  it('backfills each row from its name', async () => {
    rows = [
      { id: 'cp-1', tenant_id: 't1', name: 'Vercel AI Gateway', alias: null },
      { id: 'cp-2', tenant_id: 't1', name: 'llama.cpp', alias: null },
    ];
    await migration.up(mockQueryRunner);
    expect(updates()).toEqual([[['vercel-ai-gateway', 'cp-1']], [['llama.cpp', 'cp-2']]]);
  });

  it('skips rows whose name yields no usable or a reserved alias', async () => {
    rows = [
      { id: 'cp-1', tenant_id: 't1', name: '***', alias: null },
      { id: 'cp-2', tenant_id: 't1', name: 'OpenAI', alias: null },
    ];
    await migration.up(mockQueryRunner);
    expect(updates()).toEqual([]);
  });

  it('gives a contested alias to the oldest row only, per tenant', async () => {
    rows = [
      { id: 'cp-1', tenant_id: 't1', name: 'My Provider', alias: null },
      { id: 'cp-2', tenant_id: 't1', name: 'My-Provider', alias: null },
      { id: 'cp-3', tenant_id: 't2', name: 'my provider', alias: null },
    ];
    await migration.up(mockQueryRunner);
    expect(updates()).toEqual([[['my-provider', 'cp-1']], [['my-provider', 'cp-3']]]);
  });

  it('leaves rows that already carry an alias alone and reserves their value', async () => {
    rows = [
      { id: 'cp-1', tenant_id: 't1', name: 'Something Else', alias: 'My-Provider' },
      { id: 'cp-2', tenant_id: 't1', name: 'My Provider', alias: null },
    ];
    await migration.up(mockQueryRunner);
    expect(updates()).toEqual([]);
  });

  it('drops the index and the column on down', async () => {
    await migration.down(mockQueryRunner);
    expect(queries).toEqual([
      'DROP INDEX IF EXISTS "IDX_custom_providers_tenant_alias"',
      'ALTER TABLE "custom_providers" DROP COLUMN IF EXISTS "alias"',
    ]);
  });
});
