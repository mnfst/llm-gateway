import { ProviderUsageService } from './provider-usage.service';

/**
 * Build a chainable QueryBuilder mock whose terminal `getRawMany` resolves to
 * `rows`. Captures every SQL fragment passed to select/addSelect/where/andWhere/
 * groupBy/addGroupBy so tests can assert the UTC pinning and grouping.
 */
function makeQb(rows: unknown[]) {
  const sql: string[] = [];
  const capture =
    () =>
    (...args: unknown[]) => {
      for (const a of args) if (typeof a === 'string') sql.push(a);
      return qb;
    };
  const qb: Record<string, unknown> = {
    select: capture(),
    addSelect: capture(),
    where: capture(),
    andWhere: capture(),
    groupBy: capture(),
    addGroupBy: capture(),
    getRawMany: jest.fn().mockResolvedValue(rows),
    sql,
  };
  return qb;
}

function makeRepo(rows: unknown[]) {
  const qb = makeQb(rows);
  return {
    repo: { createQueryBuilder: jest.fn().mockReturnValue(qb) },
    qb,
  };
}

/** Today's and an offset day's UTC `YYYY-MM-DD` label, matching the service. */
function utcDay(offset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe('ProviderUsageService', () => {
  it('returns [] without touching the DB when tenant is null', async () => {
    const { repo } = makeRepo([]);
    const service = new ProviderUsageService(repo as never);

    await expect(service.getUsage(null)).resolves.toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('scopes the query to the tenant (tenant isolation)', async () => {
    const { repo, qb } = makeRepo([]);
    const service = new ProviderUsageService(repo as never);

    await service.getUsage('tenant-7');

    // addTenantFilter appends `at.tenant_id = :tenantId`.
    expect((qb.sql as string[]).some((s) => s.includes('at.tenant_id = :tenantId'))).toBe(true);
  });

  it('pins all day bucketing to UTC and groups by provider/auth_type/day', async () => {
    const { repo, qb } = makeRepo([]);
    const service = new ProviderUsageService(repo as never);

    await service.getUsage('tenant-1');

    const joined = (qb.sql as string[]).join(' | ');
    // Both the SELECT and GROUP BY use AT TIME ZONE 'UTC' twice (read-as-UTC,
    // truncate, convert-back) — never a bare date_trunc.
    expect(joined).toContain(
      "date_trunc('day', at.timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    );
    expect(joined).toContain('to_char(');
    expect(qb.sql as string[]).toContain('at.provider');
    expect(qb.sql as string[]).toContain('at.auth_type');
    expect(qb.sql as string[]).toContain('day');
    // 30-day window.
    expect(joined).toContain("at.timestamp >= NOW() - INTERVAL '30 days'");
  });

  it('aggregates 30d totals across daily buckets and builds a dense 7d sparkline', async () => {
    const today = utcDay(0);
    const yesterday = utcDay(-1);
    // A bucket 10 days ago is inside the 30d window but outside the 7d sparkline.
    const tenDaysAgo = utcDay(-10);
    const rows = [
      {
        provider: 'openai',
        auth_type: 'api_key',
        day: today,
        tokens: '100',
        cost: '0.30',
        messages: '3',
        last_used_at: new Date('2026-06-16T10:00:00.000Z'),
      },
      {
        provider: 'openai',
        auth_type: 'api_key',
        day: yesterday,
        tokens: '50',
        cost: '0.10',
        messages: '2',
        last_used_at: new Date('2026-06-15T10:00:00.000Z'),
      },
      {
        provider: 'openai',
        auth_type: 'api_key',
        day: tenDaysAgo,
        tokens: '7',
        cost: '0.01',
        messages: '1',
        last_used_at: new Date('2026-06-06T10:00:00.000Z'),
      },
    ];
    const { repo } = makeRepo(rows);
    const service = new ProviderUsageService(repo as never);

    const [summary] = await service.getUsage('tenant-1');

    // 30d totals sum ALL buckets (incl. the day-10 one).
    expect(summary.consumption_tokens).toBe(157);
    expect(summary.consumption_messages).toBe(6);
    expect(summary.consumption_cost).toBeCloseTo(0.41, 10);
    // last_used_at is the max timestamp in the window.
    expect(summary.last_used_at).toBe('2026-06-16T10:00:00.000Z');
    // Dense, 7 long, zero-filled. Today/yesterday carry tokens; the day-10
    // bucket falls outside the 7d window so it never lands in a slot.
    expect(summary.sparkline_7d).toHaveLength(7);
    expect(summary.sparkline_7d[6]).toBe(100); // today (last slot)
    expect(summary.sparkline_7d[5]).toBe(50); // yesterday
    expect(summary.sparkline_7d.reduce((a, b) => a + b, 0)).toBe(150);
  });

  it('keys by (provider, auth_type) and defaults a NULL auth_type to api_key', async () => {
    const today = utcDay(0);
    const rows = [
      {
        provider: 'openai',
        auth_type: 'subscription',
        day: today,
        tokens: '10',
        cost: '0',
        messages: '1',
        last_used_at: null,
      },
      {
        provider: 'openai',
        auth_type: null,
        day: today,
        tokens: '20',
        cost: '0',
        messages: '1',
        last_used_at: null,
      },
    ];
    const { repo } = makeRepo(rows);
    const service = new ProviderUsageService(repo as never);

    const result = await service.getUsage('tenant-1');

    const keys = result.map((r) => `${r.provider}::${r.auth_type}`).sort();
    expect(keys).toEqual(['openai::api_key', 'openai::subscription']);
    const apiKey = result.find((r) => r.auth_type === 'api_key')!;
    expect(apiKey.consumption_tokens).toBe(20);
    // No timestamps → last_used_at stays null.
    expect(apiKey.last_used_at).toBeNull();
  });

  it('drops rows with a NULL provider', async () => {
    const today = utcDay(0);
    const rows = [
      {
        provider: null,
        auth_type: 'api_key',
        day: today,
        tokens: '999',
        cost: '9',
        messages: '9',
        last_used_at: new Date('2026-06-16T10:00:00.000Z'),
      },
      {
        provider: 'anthropic',
        auth_type: 'api_key',
        day: today,
        tokens: '5',
        cost: '0',
        messages: '1',
        last_used_at: new Date('2026-06-16T09:00:00.000Z'),
      },
    ];
    const { repo } = makeRepo(rows);
    const service = new ProviderUsageService(repo as never);

    const result = await service.getUsage('tenant-1');

    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('anthropic');
  });

  it('parses string-typed last_used_at and tolerates nullish numeric columns', async () => {
    const today = utcDay(0);
    const rows = [
      {
        provider: 'gemini',
        auth_type: 'api_key',
        day: today,
        // Driver may hand back strings or nulls; both must coerce safely.
        tokens: null,
        cost: null,
        messages: null,
        last_used_at: '2026-06-16T08:30:00.000Z',
      },
    ];
    const { repo } = makeRepo(rows);
    const service = new ProviderUsageService(repo as never);

    const [summary] = await service.getUsage('tenant-1');

    expect(summary.consumption_tokens).toBe(0);
    expect(summary.consumption_cost).toBe(0);
    expect(summary.consumption_messages).toBe(0);
    expect(summary.last_used_at).toBe('2026-06-16T08:30:00.000Z');
    expect(summary.sparkline_7d[6]).toBe(0);
  });

  it('sums per-row attempt reliability at the (provider, auth_type) grain', async () => {
    // Two auth types of the same provider must NOT blend: the subscription
    // row keeps its own rate, the api_key row keeps its own.
    const { repo, qb } = makeRepo([
      {
        provider: 'openai',
        auth_type: 'subscription',
        day: utcDay(),
        tokens: '10',
        cost: '0',
        messages: '1',
        attempts: '100',
        succeeded: '92',
        last_used_at: null,
      },
      {
        provider: 'openai',
        auth_type: 'subscription',
        day: utcDay(-1),
        tokens: '10',
        cost: '0',
        messages: '1',
        attempts: '29',
        succeeded: '27',
        last_used_at: null,
      },
      {
        provider: 'openai',
        auth_type: 'api_key',
        day: utcDay(),
        tokens: '10',
        cost: '0',
        messages: '1',
        attempts: '188',
        succeeded: '148',
        last_used_at: null,
      },
    ]);
    const service = new ProviderUsageService(repo as never);

    const out = await service.getUsage('tenant-1');
    const sub = out.find((r) => r.auth_type === 'subscription')!;
    const byok = out.find((r) => r.auth_type === 'api_key')!;
    expect(sub.attempts_30d).toBe(129);
    expect(sub.succeeded_30d).toBe(119);
    expect(byok.attempts_30d).toBe(188);
    expect(byok.succeeded_30d).toBe(148);
    // Canonical success and legacy NULL/ok all read as successful attempts.
    const selects = (qb.sql as string[]).join(' ');
    expect(selects).toContain("at.status IN ('ok', 'success')");
    expect(selects).toContain("at.status NOT IN ('pending', 'cancelled')");
  });
});
