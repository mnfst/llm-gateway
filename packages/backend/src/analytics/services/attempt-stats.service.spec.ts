import { AttemptStatsService } from './attempt-stats.service';
import { EXCLUDE_PLAYGROUND_AGENTS_PREDICATE } from './query-helpers';

function mockQueryBuilder(options: { rawOne?: unknown; rawMany?: unknown[] } = {}) {
  const qb = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    addGroupBy: jest.fn(),
    orderBy: jest.fn(),
    getRawOne: jest.fn().mockResolvedValue(options.rawOne),
    getRawMany: jest.fn().mockResolvedValue(options.rawMany ?? []),
  };
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
  ] as const) {
    qb[method].mockReturnValue(qb);
  }
  return qb;
}

function makeService(qbs: unknown[]) {
  const repo = { createQueryBuilder: jest.fn().mockImplementation(() => qbs.shift()) };
  return new AttemptStatsService(repo as never);
}

describe('AttemptStatsService', () => {
  it('returns current and previous attempt and fallback totals', async () => {
    const current = mockQueryBuilder({
      rawOne: { attempts: '8', fallbacked_attempts: '3' },
    });
    const previous = mockQueryBuilder({
      rawOne: { attempts: '5', fallbacked_attempts: '1' },
    });
    const service = makeService([current, previous]);

    await expect(
      service.getStats({ tenantId: 'tenant-1', range: '7d', agentName: 'bot-1' }),
    ).resolves.toEqual({
      total_attempts: { value: 8, previous: 5 },
      fallbacked_attempts: { value: 3, previous: 1 },
    });
    expect(current.addSelect).toHaveBeenCalledWith(
      'COUNT(*) FILTER (WHERE at.fallback_from_model IS NOT NULL)',
      'fallbacked_attempts',
    );
    expect(previous.andWhere).toHaveBeenCalledWith('at.timestamp < :to', {
      to: expect.any(String),
    });
    for (const qb of [current, previous]) {
      expect(qb.andWhere).toHaveBeenCalledWith('at.tenant_id = :tenantId', {
        tenantId: 'tenant-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
      expect(
        qb.andWhere.mock.calls.some(([clause]) => String(clause).includes('liveAgentName')),
      ).toBe(true);
      expect(qb.addSelect.mock.calls.flat()).not.toContain('autofix_role');
    }
  });

  it('defaults to seven days and returns zeros without a tenant', async () => {
    const current = mockQueryBuilder();
    const previous = mockQueryBuilder();
    const service = makeService([current, previous]);

    await expect(service.getStats({ tenantId: null })).resolves.toEqual({
      total_attempts: { value: 0, previous: 0 },
      fallbacked_attempts: { value: 0, previous: 0 },
    });
    expect(current.andWhere).toHaveBeenCalledWith('1 = 0');
    expect(previous.andWhere).toHaveBeenCalledWith('1 = 0');
  });

  it('returns daily pivoted buckets in the #2485 timeseries shape', async () => {
    const qb = mockQueryBuilder({
      rawMany: [
        { bucket: '2026-07-14', attempts: '4', fallbacked_attempts: '1' },
        { bucket: '2026-07-15', attempts: '2', fallbacked_attempts: null },
      ],
    });
    const service = makeService([qb]);

    await expect(service.getTimeseries({ tenantId: 'tenant-1', range: '7d' })).resolves.toEqual({
      range: '7d',
      by: 'metric',
      keys: ['total_attempts', 'fallbacked_attempts'],
      buckets: [
        { bucket: '2026-07-14', counts: [4, 1] },
        { bucket: '2026-07-15', counts: [2, 0] },
      ],
    });
    expect(qb.select.mock.calls[0][0]).toContain('YYYY-MM-DD');
  });

  it('uses hourly buckets and forwards live-agent scoping', async () => {
    const qb = mockQueryBuilder();
    const service = makeService([qb]);

    const result = await service.getTimeseries({
      tenantId: 'tenant-1',
      range: '24h',
      agentName: 'bot-1',
    });

    expect(result.buckets).toEqual([]);
    expect(qb.select.mock.calls[0][0]).toContain("date_trunc('hour'");
    expect(
      qb.andWhere.mock.calls.some(([clause]) => String(clause).includes('liveAgentName')),
    ).toBe(true);
  });

  it('buckets a connection attempt-status timeseries as success/error', async () => {
    const qb = mockQueryBuilder({
      rawMany: [
        { bucket: '2026-06-04', success: '9', error: '1' },
        { bucket: '2026-06-05', success: '4', error: '2' },
      ],
    });
    const service = makeService([qb]);

    const out = await service.getConnectionStatusTimeseries({
      tenantId: 't1',
      range: '7d',
      authType: 'api_key',
      provider: 'openai',
      label: 'Default',
      tenantProviderId: 'conn-1',
    });

    expect(out).toEqual({
      range: '7d',
      by: 'metric',
      keys: ['success', 'error'],
      buckets: [
        { bucket: '2026-06-04', counts: [9, 1] },
        { bucket: '2026-06-05', counts: [4, 2] },
      ],
    });
    const selects = qb.addSelect.mock.calls.flat().join(' ');
    // Every completed attempt counts by its own outcome; legacy NULL/ok remain compatible.
    expect(selects).toContain("at.status IN ('ok', 'success')");
    expect(selects).toContain("at.status NOT IN ('pending', 'cancelled', 'ok', 'success')");
    const wheres = qb.andWhere.mock.calls.flat().filter((w) => typeof w === 'string');
    // Same legacy folds as the usage list rows: NULL auth_type reads api_key,
    // and orphan attempts (NULL tenant_provider_id) fold onto the connection
    // whose label matches (NULL label reads 'Default').
    expect(wheres.join(' ')).toContain('at.auth_type = :authType OR at.auth_type IS NULL');
    expect(wheres.join(' ')).toContain(
      'at.tenant_provider_id = :tenantProviderId OR (at.tenant_provider_id IS NULL',
    );
    expect(wheres).toContain(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
  });

  it('pivots connection attempts per harness', async () => {
    const qb = mockQueryBuilder({
      rawMany: [
        { bucket: '2026-06-04', agent_name: 'demo-agent', attempts: '7' },
        { bucket: '2026-06-04', agent_name: 'other', attempts: '2' },
        { bucket: '2026-06-05', agent_name: 'demo-agent', attempts: '3' },
      ],
    });
    const service = makeService([qb]);

    const out = await service.getConnectionAttemptsByAgentTimeseries({
      tenantId: 't1',
      range: '7d',
      provider: 'openai',
    });

    expect(out.agents).toEqual(['demo-agent', 'other']);
    expect(out.timeseries).toEqual([
      { date: '2026-06-04', 'demo-agent': 7, other: 2 },
      { date: '2026-06-05', 'demo-agent': 3 },
    ]);
  });

  it('answers empty without a tenant', async () => {
    const service = makeService([]);
    await expect(
      service.getConnectionStatusTimeseries({ tenantId: null, range: '7d' }),
    ).resolves.toEqual({ range: '7d', by: 'metric', keys: [], buckets: [] });
    await expect(
      service.getConnectionAttemptsByAgentTimeseries({ tenantId: null, range: '7d' }),
    ).resolves.toEqual({ agents: [], timeseries: [] });
  });

  it('buckets attempts by HTTP status, success reading 200 by convention', async () => {
    const qb = mockQueryBuilder({
      rawMany: [
        { bucket: '2026-06-04', code: '200', attempts: '9' },
        { bucket: '2026-06-04', code: '429', attempts: '2' },
        { bucket: '2026-06-04', code: 'No response', attempts: '1' },
        { bucket: '2026-06-05', code: '400', attempts: '3' },
      ],
    });
    const service = makeService([qb]);

    const out = await service.getConnectionHttpStatusTimeseries({
      tenantId: 't1',
      range: '7d',
      provider: 'openai',
    });
    // Success first, numeric codes ascending, No response last.
    expect(out.keys).toEqual(['200', '400', '429', 'No response']);
    expect(out.buckets).toEqual([
      { bucket: '2026-06-04', counts: [9, 0, 2, 1] },
      { bucket: '2026-06-05', counts: [0, 3, 0, 0] },
    ]);
  });

  it('computes the connection breakdown with both retry families', async () => {
    const qb = mockQueryBuilder({
      rawOne: {
        attempts: '216',
        succeeded: '162',
        fallback_retries: '10',
        fallback_retries_succeeded: '8',
        autofix_attempts: '12',
        autofix_attempts_succeeded: '10',
      },
    });
    const service = makeService([qb]);
    await expect(
      service.getConnectionBreakdown({ tenantId: 't1', range: '7d', provider: 'openai' }),
    ).resolves.toEqual({
      attempts: 216,
      succeeded: 162,
      failed: 54,
      fallback_retries: 10,
      fallback_retries_succeeded: 8,
      autofix_attempts: 12,
      autofix_attempts_succeeded: 10,
    });
    const selects = qb.addSelect.mock.calls.flat().join(' ');
    // A fallback is a retry; an autofix produces an attempt (autofix_role).
    expect(selects).toContain('at.fallback_from_model IS NOT NULL');
    expect(selects).toContain("at.autofix_role = 'retry'");
  });
});
