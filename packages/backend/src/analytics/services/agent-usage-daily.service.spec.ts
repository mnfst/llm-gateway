import { AgentUsageDailyService } from './agent-usage-daily.service';
import { computeCutoff, toLocalSqlTimestamp } from '../../common/utils/postgres-sql';
import { setAgentUsageDailyAutomaticReadsReady } from '../../common/utils/agent-usage-daily-flags';

describe('AgentUsageDailyService', () => {
  const originalReads = process.env['AGENT_USAGE_DAILY_READS'];
  const originalTenants = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
  const originalWorker = process.env['AGENT_USAGE_DAILY_WORKER'];
  const originalBatchSize = process.env['AGENT_USAGE_DAILY_BATCH_SIZE'];
  const originalRunBudget = process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'];

  afterEach(() => {
    setAgentUsageDailyAutomaticReadsReady(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalReads === undefined) delete process.env['AGENT_USAGE_DAILY_READS'];
    else process.env['AGENT_USAGE_DAILY_READS'] = originalReads;
    if (originalTenants === undefined) delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    else process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = originalTenants;
    if (originalWorker === undefined) delete process.env['AGENT_USAGE_DAILY_WORKER'];
    else process.env['AGENT_USAGE_DAILY_WORKER'] = originalWorker;
    if (originalBatchSize === undefined) delete process.env['AGENT_USAGE_DAILY_BATCH_SIZE'];
    else process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = originalBatchSize;
    if (originalRunBudget === undefined) delete process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'];
    else process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = originalRunBudget;
  });

  it('keeps reads off before automatic cutover and supports a selected-tenant rollout', () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = 'tenant-a, tenant-b';
    const service = new AgentUsageDailyService({} as never);

    expect(service.readsEnabledFor('tenant-a')).toBe(true);
    expect(service.readsEnabledFor('tenant-c')).toBe(false);
    expect(service.readsEnabledFor(null)).toBe(false);
  });

  it('supports the global read cutover', () => {
    process.env['AGENT_USAGE_DAILY_READS'] = 'true';
    const service = new AgentUsageDailyService({} as never);
    expect(service.readsEnabledFor('tenant-c')).toBe(true);
  });

  it('enables reads automatically after the supported history is backfilled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    const query = jest.fn().mockResolvedValue([{ ready: true }]);
    const service = new AgentUsageDailyService({ query } as never);

    expect(service.readsEnabledFor('tenant-a')).toBe(false);
    await service.onModuleInit();

    expect(service.readsEnabledFor('tenant-a')).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('pending_request AS'), [
      computeCutoff('730 days'),
      toLocalSqlTimestamp(new Date(Date.now() - 2 * 60_000)),
    ]);
    expect(query.mock.calls[0][0]).toContain('pending_attempt AS');
    expect(query.mock.calls[0][0]).toContain("to_regclass('agent_usage_daily') IS NOT NULL");
    expect(query.mock.calls[0][0]).toContain('ORDER BY r."timestamp" ASC, r."id" ASC');
    expect(query.mock.calls[0][0]).toContain('ORDER BY pa."timestamp" ASC, pa."id" ASC');
  });

  it('returns to raw reads when historical rows remain', async () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    setAgentUsageDailyAutomaticReadsReady(true);
    const service = new AgentUsageDailyService({
      query: jest.fn().mockResolvedValue([{ ready: false }]),
    } as never);

    await service.refreshAutomaticReads();

    expect(service.readsEnabledFor('tenant-a')).toBe(false);
  });

  it('lets operators force the raw path after automatic cutover', async () => {
    process.env['AGENT_USAGE_DAILY_READS'] = 'false';
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    const service = new AgentUsageDailyService({
      query: jest.fn().mockResolvedValue([{ ready: true }]),
    } as never);

    await service.refreshAutomaticReads();

    expect(service.readsEnabledFor('tenant-a')).toBe(false);
  });

  it('fails closed when the automatic readiness check fails', async () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    setAgentUsageDailyAutomaticReadsReady(true);
    const service = new AgentUsageDailyService({
      query: jest.fn().mockRejectedValue(new Error('db unavailable')),
    } as never);
    const logger = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation();

    await service.refreshAutomaticReads();

    expect(service.readsEnabledFor('tenant-a')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db unavailable'));
  });

  it('reads only the bounded tenant window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    const query = jest.fn().mockResolvedValue([]);
    const service = new AgentUsageDailyService({ query } as never);

    await service.getRows('tenant-a');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FROM "agent_usage_daily"');
    expect(query.mock.calls[0][0]).toContain('"tenant_id" = $1');
    expect(query.mock.calls[0][0]).toContain('"day" >= $2::date');
    expect(query.mock.calls[0][1][0]).toBe('tenant-a');
    expect(query.mock.calls[0][1][1]).toBe('2026-08-23');
  });

  it('supports only enabled daily dashboard ranges', () => {
    process.env['AGENT_USAGE_DAILY_READS'] = 'true';
    const service = new AgentUsageDailyService({} as never);

    expect(service.supportsRange('tenant-a', '7d')).toBe(true);
    expect(service.supportsRange('tenant-a', '365d')).toBe(true);
    expect(service.supportsRange('tenant-a', '24h')).toBe(false);
    expect(service.supportsRange(null, '30d')).toBe(false);
  });

  it('reads the selected UTC range and subtracts rolled-up direct usage', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          agent_id: 'agent-1',
          agent_name: 'bot-1',
          day: '2026-09-21',
          request_count: '10',
          successful_request_count: '9',
          failed_request_count: '1',
          input_tokens: '100',
          output_tokens: '50',
          cost_usd: '2.5',
          last_active_at: '2026-09-21T10:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          day: '2026-09-21',
          request_count: '2',
          successful_request_count: '2',
          failed_request_count: '0',
          input_tokens: '20',
          output_tokens: '5',
          cost_usd: '0.5',
        },
      ]);
    const service = new AgentUsageDailyService({ query } as never);

    await expect(
      service.getRangeRows('tenant-a', '30d', {
        agentName: 'bot-1',
        excludeDirect: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        request_count: '8',
        successful_request_count: '7',
        failed_request_count: '1',
        input_tokens: '80',
        output_tokens: '45',
        cost_usd: '2',
      }),
    ]);
    expect(query.mock.calls[0][1]).toEqual(['tenant-a', '2026-08-23', null, 'bot-1']);
    expect(query.mock.calls[0][0]).toContain('a."deleted_at" IS NULL');
    expect(query.mock.calls[1][0]).toContain('pa."agent_usage_rolled_up_at" IS NOT NULL');
    expect(query.mock.calls[1][0]).toContain(`AT TIME ZONE 'UTC'`);
    expect(query.mock.calls[1][0]).toContain('pa."timestamp" >= (($2::date::timestamp');
    expect(query.mock.calls[1][0]).not.toContain('pa."timestamp"::date >=');
    expect(query.mock.calls[1][0]).toContain('pa."request_id" = r."id"');
    expect(query.mock.calls[1][1].slice(0, 4)).toEqual(['tenant-a', '2026-08-23', null, 'bot-1']);
    expect(query.mock.calls[1][1][4]).toEqual(expect.any(String));
  });

  it('uses the preceding calendar window for trend totals', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    const query = jest.fn().mockResolvedValue([]);
    const service = new AgentUsageDailyService({ query } as never);

    await service.getRangeRows('tenant-a', '7d', { previous: true });

    expect(query.mock.calls[0][1]).toEqual(['tenant-a', '2026-09-08', '2026-09-15', null]);
  });

  it('skips scheduled work when disabled or already running', async () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    const service = new AgentUsageDailyService({} as never);
    const processBatch = jest.spyOn(service, 'processBatch');

    process.env['AGENT_USAGE_DAILY_WORKER'] = 'false';
    setAgentUsageDailyAutomaticReadsReady(true);
    await service.runScheduled();
    expect(service.readsEnabledFor('tenant-a')).toBe(false);

    delete process.env['AGENT_USAGE_DAILY_WORKER'];
    (service as unknown as { running: boolean }).running = true;
    await service.runScheduled();

    expect(processBatch).not.toHaveBeenCalled();
  });

  it('keeps automatic reads off at startup when the worker is disabled', async () => {
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    process.env['AGENT_USAGE_DAILY_WORKER'] = 'false';
    const query = jest.fn();
    const service = new AgentUsageDailyService({ query } as never);

    await service.onModuleInit();

    expect(query).not.toHaveBeenCalled();
    expect(service.readsEnabledFor('tenant-a')).toBe(false);
  });

  it('runs scheduled batches until the queue returns a partial batch', async () => {
    process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = '2';
    process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = '5000';
    const service = new AgentUsageDailyService({} as never);
    const refreshAutomaticReads = jest.spyOn(service, 'refreshAutomaticReads').mockResolvedValue();
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockResolvedValueOnce({ acquired: true, processed: 2, rollups: 1 })
      .mockResolvedValueOnce({ acquired: true, processed: 1, rollups: 1 });
    const logger = (service as unknown as { logger: { log: (message: string) => void } }).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation();

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(processBatch).toHaveBeenCalledWith(2);
    expect(refreshAutomaticReads).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('processed 3 request(s)'));
    expect((service as unknown as { running: boolean }).running).toBe(false);
  });

  it('stops scheduled work when another replica owns the lock', async () => {
    const service = new AgentUsageDailyService({} as never);
    jest.spyOn(service, 'refreshAutomaticReads').mockResolvedValue();
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockResolvedValue({ acquired: false, processed: 0, rollups: 0 });

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledTimes(1);
    expect((service as unknown as { running: boolean }).running).toBe(false);
  });

  it('logs scheduled failures, uses safe defaults, and releases the runner', async () => {
    process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = '1e3';
    process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = '1.5';
    const service = new AgentUsageDailyService({} as never);
    jest.spyOn(service, 'refreshAutomaticReads').mockResolvedValue();
    const processBatch = jest
      .spyOn(service, 'processBatch')
      .mockRejectedValue(new Error('db down'));
    const logger = (service as unknown as { logger: { error: (message: string) => void } }).logger;
    const error = jest.spyOn(logger, 'error').mockImplementation();

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledWith(250);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect((service as unknown as { running: boolean }).running).toBe(false);
  });

  it('falls back for non-positive limits and non-Error failures', async () => {
    process.env['AGENT_USAGE_DAILY_BATCH_SIZE'] = '0';
    process.env['AGENT_USAGE_DAILY_RUN_BUDGET_MS'] = '0';
    const service = new AgentUsageDailyService({} as never);
    jest.spyOn(service, 'refreshAutomaticReads').mockResolvedValue();
    const processBatch = jest.spyOn(service, 'processBatch').mockRejectedValue('db unavailable');
    const logger = (service as unknown as { logger: { error: (message: string) => void } }).logger;
    const error = jest.spyOn(logger, 'error').mockImplementation();

    await service.runScheduled();

    expect(processBatch).toHaveBeenCalledWith(250);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db unavailable'));
  });

  it('does no work when another replica owns the transaction lock', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ acquired: false }]),
    };
    const dataSource = { transaction: (run: (value: unknown) => unknown) => run(manager) };
    const service = new AgentUsageDailyService(dataSource as never);

    await expect(service.processBatch()).resolves.toEqual({
      acquired: false,
      processed: 0,
      rollups: 0,
    });
    expect(manager.query).toHaveBeenCalledTimes(3);
  });

  it('upserts increments and marks the same locked Requests in one transaction', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ processed: 2, rollups: 3 }]),
    };
    const dataSource = { transaction: (run: (value: unknown) => unknown) => run(manager) };
    const service = new AgentUsageDailyService(dataSource as never);

    await expect(service.processBatch(2)).resolves.toEqual({
      acquired: true,
      processed: 2,
      rollups: 3,
    });
    const sql = manager.query.mock.calls[3][0] as string;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ON CONFLICT ("tenant_id", "agent_id", "day") DO UPDATE');
    expect(sql).toContain('FROM "agent_messages" pa');
    expect(sql).toContain('pa."agent_usage_rolled_up_at" IS NULL');
    expect(sql).toContain('pa."request_id" IS NULL');
    expect(sql).toContain('EXISTS (SELECT 1 FROM "agents"');
    expect(sql).toContain('SET "agent_usage_rolled_up_at" = NOW()');
    expect(sql.indexOf('upserted AS')).toBeLessThan(sql.indexOf('marked_requests AS'));
    expect(manager.query.mock.calls[3][1][0]).toBe(2);
  });

  it('uses UTC and zero counts when the database returns no aggregate row', async () => {
    jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: '',
    } as Intl.ResolvedDateTimeFormatOptions);
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([]),
    };
    const dataSource = { transaction: (run: (value: unknown) => unknown) => run(manager) };
    const service = new AgentUsageDailyService(dataSource as never);

    await expect(service.processBatch()).resolves.toEqual({
      acquired: true,
      processed: 0,
      rollups: 0,
    });
    expect(manager.query.mock.calls[3][1][1]).toBe('UTC');
    expect(manager.query.mock.calls[3][1][0]).toBe(250);
  });
});
