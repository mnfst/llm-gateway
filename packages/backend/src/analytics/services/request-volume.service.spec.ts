import { RequestVolumeService } from './request-volume.service';

describe('RequestVolumeService (#2511 request-level volume)', () => {
  const messageRepo = { query: jest.fn() };
  let service: RequestVolumeService;

  beforeEach(() => {
    jest.clearAllMocks();
    messageRepo.query.mockResolvedValue([]);
    service = new RequestVolumeService(messageRepo as never);
  });

  const lastSql = (): string => messageRepo.query.mock.calls.at(-1)![0] as string;
  const lastParams = (): unknown[] => messageRepo.query.mock.calls.at(-1)![1] as unknown[];

  it('reduces to one row per request via the terminal attempt', async () => {
    await service.getDispositionTimeseries({
      tenantId: 't1',
      range: '7d',
      hourly: false,
    });
    const sql = lastSql();
    // One row per logical request.
    expect(sql).toContain('DISTINCT ON (r.id)');
    // The Requests list's ranking: canonical/legacy success wins, else the terminal failure.
    expect(sql).toContain("pa.status IN ('ok', 'success')");
    expect(sql).toContain("pa.status NOT IN ('fallback_error', 'auto_fixed') THEN 2");
    // In-flight requests have no outcome to chart.
    expect(sql).toContain("r.status NOT IN ('pending', 'cancelled')");
    // Unlinked legacy attempts stay in the universe (KPI parity).
    expect(sql).toContain('pa.request_id IS NULL');
    // Playground traffic excluded on both branches.
    expect(sql).toContain('is_playground = true');
    expect(lastParams()).toHaveLength(2);
    expect(lastParams()[0]).toBe('t1');
  });

  it('maps dispositions from how the request CONCLUDED, one count each', async () => {
    await service.getDispositionTimeseries({ tenantId: 't1', range: '24h', hourly: true });
    const sql = lastSql();
    // Method is the request-level Autofix outcome; a rescued request counts once.
    expect(sql).toContain("t.request_status IN ('ok', 'success')");
    expect(sql).toContain("t.autofix_status = 'retry_succeeded' THEN 'healed'");
    expect(sql).toContain('r.autofix_status');
    expect(sql).toContain("t.fallback_from_model IS NOT NULL THEN 'fallback'");
    expect(sql).toContain("THEN 'success'");
    expect(sql).toContain("ELSE 'error'");
    // Hourly bucket on the request's own timestamp.
    expect(sql).toContain('t.ts');
  });

  it('applies failedOnly as a terminal-error filter', async () => {
    await service.getDispositionTimeseries({
      tenantId: 't1',
      range: '24h',
      hourly: true,
      failedOnly: true,
    });
    expect(lastSql()).toContain("= 'error'");
  });

  it('scopes to the live agent when agentName is provided', async () => {
    await service.getDispositionTimeseries({
      tenantId: 't1',
      range: '7d',
      hourly: false,
      agentName: 'demo-agent',
    });
    const sql = lastSql();
    expect(sql).toContain('deleted_at IS NULL');
    expect(lastParams()).toEqual(['t1', expect.any(String), 'demo-agent']);
  });

  it('keys the harness volume by agent name', async () => {
    await service.getVolumeByAgentTimeseries('24h', 't1', true);
    const sql = lastSql();
    expect(sql).toContain("COALESCE(t.agent_name, 'Unknown') AS agent_name");
    expect(sql).toContain('AS hour');
  });

  it('computes per-dimension request totals with terminal outcomes', async () => {
    messageRepo.query.mockResolvedValue([
      { key: 'openai', requests: '10', failed: '2', succeeded: '8', healed: '1', fallback: '2' },
    ]);
    const rows = await service.getVolumeByDimension('provider', { tenantId: 't1', range: '7d' });
    expect(rows).toEqual([
      { key: 'openai', requests: 10, failed: 2, succeeded: 8, healed: 1, fallback: 2 },
    ]);
    const sql = lastSql();
    // The trio fold: custom:<uuid> providers group as 'custom'.
    expect(sql).toContain("THEN 'custom'");
    expect(sql).toContain("t.request_status NOT IN ('pending', 'cancelled', 'ok', 'success')");
    // Zero-attempt failures remain visible and are attributed to Manifest.
    expect(sql).toContain("COALESCE(t.provider, 'manifest')");
  });

  it('scopes to one connection by terminal attribution', async () => {
    // Preferred: the exact tenant_providers id.
    await service.getDispositionTimeseries({
      tenantId: 't1',
      range: '7d',
      hourly: false,
      connection: { tenantProviderId: 'conn-1', provider: 'openai', authType: 'api_key' },
    });
    expect(lastSql()).toContain('t.tenant_provider_id = $3');
    expect(lastParams()).toEqual(['t1', expect.any(String), 'conn-1']);

    // Fallback: the (provider, auth_type, label) tuple with the legacy fold.
    await service.getDispositionTimeseries({
      tenantId: 't1',
      range: '7d',
      hourly: false,
      connection: { provider: 'openai', authType: 'api_key', label: 'Default' },
    });
    const sql = lastSql();
    expect(sql).toContain('t.provider = $3');
    expect(sql).toContain('(t.auth_type = $4 OR t.auth_type IS NULL)');
    expect(sql).toContain("LOWER(COALESCE(t.provider_key_label, 'Default')) = LOWER($5)");
    expect(lastParams()).toEqual(['t1', expect.any(String), 'openai', 'api_key', 'Default']);
  });

  it('defaults the upper bound and splits at $4 when no agent is scoped', async () => {
    messageRepo.query.mockResolvedValue([
      { dim: 'success', current_count: 3, previous_count: 4 },
      { dim: 'error', current_count: 2, previous_count: 1 },
    ]);
    const windows = await service.getDispositionTotalsForWindows({
      tenantId: 't1',
      from: '2026-01-01',
      splitAt: '2026-01-08',
    });
    expect(windows).toEqual({
      current: { total: 5, success: 3, healed: 0, fallback: 0, error: 2 },
      previous: { total: 5, success: 4, healed: 0, fallback: 0, error: 1 },
    });
    const sql = lastSql();
    // No agent scope: the split is the 4th parameter, after the defaulted `to`.
    expect(sql).toContain('AND r.timestamp < $3');
    expect(sql).toContain('FILTER (WHERE t.ts >= $4)');
    expect(sql).toContain('FILTER (WHERE t.ts < $4)');
    // Still one terminal-CTE execution for both windows.
    expect(messageRepo.query).toHaveBeenCalledTimes(1);
    const params = lastParams();
    expect(params).toHaveLength(4);
    expect(params[0]).toBe('t1');
    expect(params[1]).toBe('2026-01-01');
    expect(typeof params[2]).toBe('string'); // `to` defaulted to now
    expect(params[3]).toBe('2026-01-08');
    // Recovered by Autofix reads the materialized request verdict.
    expect(sql).toContain("t.autofix_status = 'retry_succeeded'");
  });

  it('splits current and previous disposition totals from ONE scan', async () => {
    messageRepo.query.mockResolvedValue([
      { dim: 'success', current_count: 70, previous_count: 60 },
      { dim: 'healed', current_count: 4, previous_count: 3 },
      { dim: 'fallback', current_count: 6, previous_count: 5 },
      { dim: 'error', current_count: 20, previous_count: 30 },
    ]);
    const windows = await service.getDispositionTotalsForWindows({
      tenantId: 't1',
      from: '2026-01-01',
      splitAt: '2026-01-08',
      to: '2026-01-15',
      agentName: 'demo',
    });
    expect(windows).toEqual({
      current: { total: 100, success: 70, healed: 4, fallback: 6, error: 20 },
      previous: { total: 98, success: 60, healed: 3, fallback: 5, error: 30 },
    });
    // A single terminal-CTE execution for both windows.
    expect(messageRepo.query).toHaveBeenCalledTimes(1);
    const sql = lastSql();
    // One scan bounded by [from, to), split at the current-window start.
    expect(sql).toContain('AND r.timestamp < $3');
    expect(sql).toContain('name = $4');
    expect(sql).toContain('FILTER (WHERE t.ts >= $5)');
    expect(sql).toContain('FILTER (WHERE t.ts < $5)');
    expect(lastParams()).toEqual(['t1', '2026-01-01', '2026-01-15', 'demo', '2026-01-08']);
  });

  it('returns empty current and previous windows without a tenant, never querying', async () => {
    await expect(
      service.getDispositionTotalsForWindows({
        tenantId: null,
        from: '2026-01-01',
        splitAt: '2026-01-08',
      }),
    ).resolves.toEqual({
      current: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
      previous: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
    });
    expect(messageRepo.query).not.toHaveBeenCalled();
  });

  it('returns empty without a tenant, never querying', async () => {
    await expect(
      service.getDispositionTimeseries({ tenantId: null, range: '7d', hourly: false }),
    ).resolves.toEqual([]);
    await expect(service.getVolumeByAgentTimeseries('7d', null, false)).resolves.toEqual([]);
    await expect(service.getVolumeByDimension('model', { tenantId: null })).resolves.toEqual([]);
    expect(messageRepo.query).not.toHaveBeenCalled();
  });
});
