import { AutofixStatsService } from './autofix-stats.service';

const queryBuilder = () => {
  const qb = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    leftJoin: jest.fn(),
    groupBy: jest.fn(),
    addGroupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    getRawOne: jest.fn(),
    getRawMany: jest.fn(),
  };
  for (const key of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'leftJoin',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'limit',
  ] as const) {
    qb[key].mockReturnValue(qb);
  }
  return qb;
};

const ORIGINAL_MANIFEST_MODE = process.env.MANIFEST_MODE;

describe('AutofixStatsService', () => {
  beforeAll(() => {
    // Pin cloud mode so consented:true assertions hold regardless of the
    // shell's MANIFEST_MODE (dev often exports selfhosted).
    process.env.MANIFEST_MODE = 'cloud';
  });
  afterAll(() => {
    if (ORIGINAL_MANIFEST_MODE === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = ORIGINAL_MANIFEST_MODE;
  });

  const agentRepo = { find: jest.fn(), update: jest.fn() };
  const messageRepo = { createQueryBuilder: jest.fn() };
  const autofix = {
    resolveEnabled: jest.fn((stored: boolean | null) => stored ?? true),
  };
  const requestVolume = {
    getDispositionTimeseries: jest.fn().mockResolvedValue([]),
    getDispositionTotalsForWindows: jest.fn().mockResolvedValue({
      current: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
      previous: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
    }),
    getVolumeByDimension: jest.fn().mockResolvedValue([]),
    getVolumeByProviderTimeseries: jest.fn().mockResolvedValue([]),
    getVolumeByAgentTimeseries: jest.fn().mockResolvedValue([]),
  };
  let service: AutofixStatsService;

  beforeEach(() => {
    jest.clearAllMocks();
    messageRepo.createQueryBuilder.mockReset();
    autofix.resolveEnabled.mockImplementation((stored: boolean | null) => stored ?? true);
    requestVolume.getDispositionTimeseries.mockResolvedValue([]);
    requestVolume.getDispositionTotalsForWindows.mockResolvedValue({
      current: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
      previous: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
    });
    requestVolume.getVolumeByDimension.mockResolvedValue([]);
    service = new AutofixStatsService(
      agentRepo as never,
      messageRepo as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      autofix as never,
      requestVolume as never,
    );
  });

  it('returns an empty status without a tenant', async () => {
    await expect(service.getWorkspaceStatus(null)).resolves.toEqual({
      any_enabled: false,
      consented: true,
      enabled_agents: [],
      disabled_agents: [],
      needs_enable_all: false,
    });
    expect(agentRepo.find).not.toHaveBeenCalled();
  });

  it('returns effectively enabled agent names for a cloud workspace', async () => {
    agentRepo.find.mockResolvedValue([
      { name: 'inherited', autofix_enabled: null },
      { name: 'disabled', autofix_enabled: false },
      { name: 'enabled', autofix_enabled: true },
    ]);
    await expect(service.getWorkspaceStatus('tenant')).resolves.toEqual({
      any_enabled: true,
      enabled_agents: ['inherited', 'enabled'],
      disabled_agents: ['disabled'],
      needs_enable_all: false,
      consented: true,
    });
    expect(agentRepo.find).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant', deleted_at: expect.anything(), is_playground: false },
      select: ['name', 'autofix_enabled'],
    });
  });

  it('keeps inherited agents disabled under the self-hosted default', async () => {
    autofix.resolveEnabled.mockImplementation((stored: boolean | null) => stored ?? false);
    agentRepo.find.mockResolvedValue([
      { name: 'inherited', autofix_enabled: null },
      { name: 'enabled', autofix_enabled: true },
    ]);

    await expect(service.getWorkspaceStatus('tenant')).resolves.toEqual({
      any_enabled: true,
      enabled_agents: ['enabled'],
      disabled_agents: ['inherited'],
      needs_enable_all: false,
      consented: true,
    });
  });

  describe('fleet-enable CTA (self-hosted)', () => {
    // The CTA only exists on self-hosted: cloud is always "consented" and NULL
    // resolves to enabled there, so the condition can never hold. Build the
    // service against a real self-hosted consent lookup rather than mixing a
    // self-hosted resolveEnabled with cloud's implicit consent.
    const selfHostedService = (consentedAt: string | null) => {
      process.env.MANIFEST_MODE = 'selfhosted';
      autofix.resolveEnabled.mockImplementation((stored: boolean | null) => stored ?? false);
      return new AutofixStatsService(
        agentRepo as never,
        messageRepo as never,
        {
          findOne: jest
            .fn()
            .mockResolvedValue(consentedAt ? { autofix_consented_at: consentedAt } : null),
        } as never,
        autofix as never,
        requestVolume as never,
      );
    };
    afterEach(() => {
      process.env.MANIFEST_MODE = 'cloud';
    });

    it('offers fleet enable for an unconsented install with unconfigured agents', async () => {
      agentRepo.find.mockResolvedValue([
        { name: 'legacy', autofix_enabled: null },
        { name: 'explicitly-disabled', autofix_enabled: false },
      ]);

      await expect(selfHostedService(null).getWorkspaceStatus('tenant')).resolves.toMatchObject({
        any_enabled: false,
        enabled_agents: [],
        needs_enable_all: true,
      });
    });

    it('does not offer it when every agent already made an explicit choice', async () => {
      // Pins the NULL term specifically: this install is self-hosted AND
      // unconsented, so it clears both other gates. Only "no agent is
      // unconfigured" keeps the CTA away from someone who deliberately turned
      // Autofix off everywhere.
      agentRepo.find.mockResolvedValue([
        { name: 'chose-off', autofix_enabled: false },
        { name: 'also-chose-off', autofix_enabled: false },
      ]);

      await expect(selfHostedService(null).getWorkspaceStatus('tenant')).resolves.toMatchObject({
        any_enabled: false,
        enabled_agents: [],
        needs_enable_all: false,
        consented: false,
      });
    });

    it('stops offering it once the install has consented', async () => {
      // NULL is the "inherit the mode default" state, not a legacy marker — an
      // OTLP-onboarded agent stores it too. Keying the one-time CTA on NULL
      // alone re-prompted installs that had already decided.
      agentRepo.find.mockResolvedValue([{ name: 'inherited', autofix_enabled: null }]);

      await expect(
        selfHostedService('2026-08-05T00:00:00.000Z').getWorkspaceStatus('tenant'),
      ).resolves.toMatchObject({
        any_enabled: false,
        enabled_agents: [],
        needs_enable_all: false,
        consented: true,
      });
    });
  });

  it.each([
    ['an empty workspace', []],
    ['only explicitly disabled new agents', [{ name: 'new-agent', autofix_enabled: false }]],
  ])('does not offer fleet enable for %s', async (_label, agents) => {
    autofix.resolveEnabled.mockImplementation((stored: boolean | null) => stored ?? false);
    agentRepo.find.mockResolvedValue(agents);

    await expect(service.getWorkspaceStatus('tenant')).resolves.toMatchObject({
      any_enabled: false,
      enabled_agents: [],
      needs_enable_all: false,
    });
  });

  it('computes Autofix-only stats for current and previous windows', async () => {
    const internals = service as unknown as {
      queryNeedsAttention: jest.Mock;
    };
    // ONE terminal-CTE scan yields both windows; getStats derives the KPI
    // counts from that single result instead of scanning twice.
    requestVolume.getDispositionTotalsForWindows.mockResolvedValue({
      current: { total: 10, success: 5, healed: 2, fallback: 1, error: 2 },
      previous: { total: 0, success: 0, healed: 0, fallback: 0, error: 0 },
    });
    internals.queryNeedsAttention = jest.fn().mockResolvedValue([{ error_message: 'bad' }]);

    await expect(
      service.getStats({ tenantId: 'tenant', range: '30d', agentName: 'agent' }),
    ).resolves.toEqual({
      success_rate: { value: 0.8, previous: 0 },
      autofix_saves: { value: 2, previous: 0 },
      fallback_saves: { value: 1, previous: 0 },
      total_requests: { value: 10, previous: 0 },
      errors_remaining: { value: 2, previous: 0 },
      coverage: { rate: 0.5, previous_rate: 0 },
      dispositions: { healed: 2, no_fix_found: 2, resolving: 0, ineffective: 0 },
      needs_attention: [{ error_message: 'bad' }],
    });
    expect(requestVolume.getDispositionTotalsForWindows).toHaveBeenCalledTimes(1);
    expect(requestVolume.getDispositionTotalsForWindows).toHaveBeenCalledWith({
      tenantId: 'tenant',
      from: expect.any(String),
      splitAt: expect.any(String),
      to: expect.any(String),
      agentName: 'agent',
    });
  });

  it('maps per-provider, per-agent and per-model reliability rows', async () => {
    // Provider and model tables live in the ATTEMPT world: every provider
    // call counts by its own outcome, no retry exclusion, no healing fields.
    const providerQb = queryBuilder();
    providerQb.getRawMany.mockResolvedValue([
      {
        provider: 'openai',
        auth_type: 'subscription',
        key_label: 'Default',
        attempts: '12',
        failed: '3',
        succeeded: '9',
      },
    ]);
    requestVolume.getVolumeByDimension.mockResolvedValue([
      {
        key: 'demo',
        requests: 8,
        failed: 2,
        healed: 1,
        fallback: 2,
        succeeded: 7,
      },
    ]);
    messageRepo.createQueryBuilder.mockReturnValueOnce(providerQb);

    await expect(
      service.getPerProviderStats({ tenantId: 'tenant', agentName: 'demo' }),
    ).resolves.toEqual([
      {
        provider: 'openai',
        auth_type: 'subscription',
        key_label: 'Default',
        attempts: 12,
        failed: 3,
        succeeded: 9,
      },
    ]);
    // Connection grain: grouped by provider + folded auth_type + folded label.
    const providerGroupSql = providerQb.addGroupBy.mock.calls.flat().join(' ');
    expect(providerGroupSql).toContain("COALESCE(at.auth_type, 'api_key')");
    expect(providerGroupSql).toContain("COALESCE(at.provider_key_label, 'Default')");
    const providerSql = providerQb.addSelect.mock.calls.flat().join(' ');
    // Canonical success and legacy NULL/ok remain compatible.
    expect(providerSql).toContain("at.status IN ('ok', 'success')");
    expect(providerSql).toContain("at.status NOT IN ('pending', 'cancelled', 'ok', 'success')");
    // No retry exclusion: an autofix retry is a real provider call here.
    expect(providerQb.andWhere.mock.calls.flat()).not.toContain(
      "(at.autofix_role IS NULL OR at.autofix_role != 'retry')",
    );

    // The harness table stays in the REQUEST world (unchanged shape).
    await expect(service.getPerAgentStats({ tenantId: 'tenant' })).resolves.toEqual([
      { agent_name: 'demo', requests: 8, failed: 2, autofixed: 1, fallback_saves: 2, succeeded: 7 },
    ]);
    expect(requestVolume.getVolumeByDimension).toHaveBeenCalledWith('agent_name', {
      tenantId: 'tenant',
    });

    const modelQb = queryBuilder();
    modelQb.getRawMany.mockResolvedValue([
      { model: 'gpt-4o', attempts: '6', failed: '1', succeeded: '5' },
    ]);
    messageRepo.createQueryBuilder.mockReturnValueOnce(modelQb);
    await expect(
      service.getPerModelStats({ tenantId: 'tenant', agentName: 'demo' }),
    ).resolves.toEqual([{ model: 'gpt-4o', attempts: 6, failed: 1, succeeded: 5 }]);
  });

  it('builds hourly failed-only timeseries and preserves disposition order', async () => {
    // #2511: the disposition dimension counts logical requests via the
    // request-volume service (terminal-attempt attribution), not attempts.
    requestVolume.getDispositionTimeseries.mockResolvedValue([
      { bucket: '2026-01-01 10:00:00', dim: 'error', count: '2' },
      { bucket: '2026-01-01 10:00:00', dim: 'success', count: '5' },
      { bucket: '2026-01-01 11:00:00', dim: 'success', count: '1' },
      { bucket: '2026-01-01 10:00:00', dim: null, count: '3' },
    ]);

    await expect(
      service.getTimeseries({
        tenantId: 'tenant',
        range: '24h',
        by: 'invalid',
        failedOnly: true,
      }),
    ).resolves.toEqual({
      range: '24h',
      by: 'disposition',
      keys: ['success', 'error', 'unknown'],
      buckets: [
        { bucket: '2026-01-01 10:00:00', counts: [5, 2, 3] },
        { bucket: '2026-01-01 11:00:00', counts: [1, 0, 0] },
      ],
    });
    expect(requestVolume.getDispositionTimeseries).toHaveBeenCalledWith({
      tenantId: 'tenant',
      range: '24h',
      hourly: true,
      agentName: undefined,
      failedOnly: true,
    });
    // The disposition path never scans attempts directly anymore.
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it.each(['http_status', 'provider', 'error_kind', 'autofix'])(
    'supports the %s timeseries dimension',
    async (by) => {
      const qb = queryBuilder();
      qb.getRawMany.mockResolvedValue([
        { bucket: '2026-01-02', dim: 'zeta', count: '1' },
        { bucket: '2026-01-01', dim: 'alpha', count: '2' },
      ]);
      messageRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getTimeseries({ tenantId: null, range: '7d', by });
      expect(result.keys).toEqual(['alpha', 'zeta']);
      expect(result.buckets[0]!.bucket).toBe('2026-01-01');
      expect(qb.addSelect.mock.calls[0]![0]).toEqual(expect.any(String));
    },
  );

  it('derives window counts from the request-level disposition totals', () => {
    const internals = service as unknown as {
      windowCounts: (t: {
        total: number;
        success: number;
        healed: number;
        fallback: number;
        error: number;
      }) => unknown;
    };
    // ONE definition: the KPI window reads the same reducer as the chart.
    expect(
      internals.windowCounts({ total: 100, success: 70, healed: 4, fallback: 6, error: 20 }),
    ).toEqual({
      total: 100,
      successes: 80, // success + recovered by Autofix + recovered by fallback
      saves: 4, // autofix_status = retry_succeeded
      fallback_saves: 6,
      errors: 20,
      healed: 4,
      no_fix_found: 20,
      resolving: 0,
      ineffective: 0,
    });
    // No attempt-table scan and no sibling join anymore.
    expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('maps needs-attention failures and defaults nullable fields', async () => {
    const internals = service as unknown as {
      queryNeedsAttention: (
        cutoff: string,
        tenantId: string | null,
        agentName?: string,
      ) => Promise<unknown>;
    };
    const qb = queryBuilder();
    qb.getRawMany.mockResolvedValue([
      {
        error_message: null,
        provider: 'openai',
        model: 'gpt',
        count: '4',
        phoenix_issue_id: null,
      },
    ]);
    messageRepo.createQueryBuilder.mockReturnValue(qb);
    await expect(internals.queryNeedsAttention('cutoff', 'tenant', 'demo')).resolves.toEqual([
      {
        error_message: '',
        provider: 'openai',
        model: 'gpt',
        count: 4,
        phoenix_issue_id: null,
      },
    ]);
    const filterSql = qb.andWhere.mock.calls.flat().join(' ');
    expect(qb.leftJoin).toHaveBeenCalled();
    expect(filterSql).toContain("r.autofix_status <> 'retry_succeeded'");
    expect(filterSql).toContain('FROM agent_messages sib');
    expect(filterSql).not.toContain('FROM provider_attempts sib');
  });

  describe('enableAll', () => {
    it('updates only live non-playground agents and records consent', async () => {
      agentRepo.update.mockResolvedValue({ affected: 2 });
      agentRepo.find.mockResolvedValue([{ name: 'a', autofix_enabled: true }]);
      await expect(service.enableAll('tenant')).resolves.toMatchObject({
        any_enabled: true,
        enabled_agents: ['a'],
      });
      expect(agentRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant',
          is_playground: false,
          deleted_at: expect.objectContaining({ _type: 'isNull' }),
        }),
        { autofix_enabled: true },
      );
    });
  });
});
