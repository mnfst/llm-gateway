import { ConfigService } from '@nestjs/config';
import type { AutofixService } from './autofix.service';
import { ObservationReporter } from './observation-reporter';
import type { HealingClient } from './healing-client';
import type { ObservationInput } from './observation-payload';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Autofix consent gate. Active by default; each test overrides what it needs. */
function makeAutofix(
  getHealingContext: jest.Mock = jest.fn().mockResolvedValue({ harness: 'other' }),
): AutofixService {
  return { getHealingContext } as unknown as AutofixService;
}

function makeClient(): jest.Mocked<HealingClient> {
  return {
    observe: jest.fn().mockResolvedValue(undefined),
    heal: jest.fn(),
    reportOutcome: jest.fn(),
  } as unknown as jest.Mocked<HealingClient>;
}

const input: ObservationInput = {
  traceId: 'trace-1',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  provider: 'openai',
  model: 'gpt-5.1',
  authType: 'api_key',
  apiMode: 'chat_completions',
  requestBody: { model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }] },
  status: 400,
  errorBody: '{"error":{"message":"bad request"}}',
};

function enabledReporter(
  client: HealingClient,
  autofix: AutofixService = makeAutofix(),
): ObservationReporter {
  return new ObservationReporter(client, autofix, makeConfig({ AUTOFIX_REPORT_ALL_4XX: 'true' }));
}

/**
 * `report()` returns before its gate resolves. Drain the microtask queue so the
 * detached chain finishes — works under fake timers, which `setImmediate` doesn't.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Queue `count` reports, letting each clear the gate before the next. Real traffic
 * arrives over time; firing them all synchronously would instead saturate the
 * in-flight cap and drop most of them.
 */
async function reportMany(reporter: ObservationReporter, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    reporter.report({ ...input, traceId: `trace-${i}` });
    await settle();
  }
}

describe('ObservationReporter', () => {
  afterEach(() => jest.useRealTimers());

  describe('gating', () => {
    it('does nothing when the deployment switch is off', async () => {
      const client = makeClient();
      const autofix = makeAutofix();
      const reporter = new ObservationReporter(client, autofix, makeConfig());

      reporter.report(input);
      await settle();
      await reporter.flush();

      expect(client.observe).not.toHaveBeenCalled();
      expect(autofix.getHealingContext).not.toHaveBeenCalled();
    });

    it('does not ship a body for an agent without Autofix on', async () => {
      const client = makeClient();
      const reporter = enabledReporter(client, makeAutofix(jest.fn().mockResolvedValue(false)));

      reporter.report(input);
      await settle();
      await reporter.flush();

      expect(client.observe).not.toHaveBeenCalled();
    });

    it("resolves the gate against the request's own tenant and agent", async () => {
      const client = makeClient();
      const getHealingContext = jest.fn().mockResolvedValue({ harness: 'other' });
      const reporter = enabledReporter(client, makeAutofix(getHealingContext));

      reporter.report(input);
      await settle();

      expect(getHealingContext).toHaveBeenCalledWith('tenant-1', 'agent-1');
    });

    it('fails closed when the gate itself throws', async () => {
      const client = makeClient();
      const gate = jest.fn().mockRejectedValue(new Error('db down'));
      const reporter = enabledReporter(client, makeAutofix(gate));

      reporter.report(input);
      await settle();
      await reporter.flush();

      // No consent proven → no body sent, and nothing propagates to the proxy.
      expect(client.observe).not.toHaveBeenCalled();
    });

    it('drops a report rather than let consent checks pile up unbounded', async () => {
      const client = makeClient();
      // A gate that never answers: every report stays in flight.
      const reporter = enabledReporter(client, makeAutofix(jest.fn(() => new Promise(() => {}))));

      for (let i = 0; i < 150; i++) reporter.report({ ...input, traceId: `trace-${i}` });
      await settle();

      // Bodies are retained per in-flight check, so the cap bounds them before the
      // queue cap (which only applies once a check has cleared) ever gets to.
      expect(reporter['inFlight'].size).toBe(100);
      expect(client.observe).not.toHaveBeenCalled();
    });

    it('waits for an in-flight consent check before draining on shutdown', async () => {
      const client = makeClient();
      let allow!: () => void;
      const gate = jest.fn(() => new Promise<boolean>((resolve) => (allow = () => resolve(true))));
      const reporter = enabledReporter(client, makeAutofix(gate));

      reporter.report(input);
      const shutdown = reporter.onModuleDestroy();
      allow();
      await shutdown;

      // The observation was still inside its gate when shutdown began.
      expect(client.observe).toHaveBeenCalledTimes(1);
    });

    it('never consults the gate for a failure it would not report anyway', async () => {
      const client = makeClient();
      const autofix = makeAutofix();
      const reporter = enabledReporter(client, autofix);

      reporter.report({ ...input, status: 401 });
      await settle();

      // Rejecting on status first keeps a 4xx storm off the gate's DB read.
      expect(autofix.getHealingContext).not.toHaveBeenCalled();
      expect(client.observe).not.toHaveBeenCalled();
    });
  });

  it('sends a queued observation with the full body on flush', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);

    reporter.report(input);
    await settle();
    await reporter.flush();

    expect(client.observe).toHaveBeenCalledTimes(1);
    const [batch] = client.observe.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].request.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(client.observe.mock.calls[0][1]).toEqual({ harness: 'other' });
  });

  it('keeps different harnesses in separate authenticated batches', async () => {
    const client = makeClient();
    const contexts = jest
      .fn()
      .mockResolvedValueOnce({ harness: 'claude-code' })
      .mockResolvedValueOnce({ harness: 'openclaw' });
    const reporter = enabledReporter(client, makeAutofix(contexts));

    reporter.report({ ...input, traceId: 'coding' });
    reporter.report({ ...input, traceId: 'personal' });
    await settle();
    await reporter.flush();
    await reporter.flush();

    expect(client.observe).toHaveBeenCalledTimes(2);
    expect(client.observe.mock.calls[0][0][0].traceId).toBe('coding');
    expect(client.observe.mock.calls[0][1]).toEqual({ harness: 'claude-code' });
    expect(client.observe.mock.calls[1][0][0].traceId).toBe('personal');
    expect(client.observe.mock.calls[1][1]).toEqual({ harness: 'openclaw' });
  });

  it('flushes automatically once a full batch accumulates', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);

    await reportMany(reporter, 50);

    expect(client.observe).toHaveBeenCalledTimes(1);
    expect(client.observe.mock.calls[0][0]).toHaveLength(50);
  });

  it('flushes on the timer when the batch never fills', async () => {
    jest.useFakeTimers();
    const client = makeClient();
    const reporter = enabledReporter(client);

    reporter.report(input);
    await settle();
    expect(client.observe).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2_000);
    expect(client.observe).toHaveBeenCalledTimes(1);
  });

  it('bounds the queue at 500, dropping the oldest observations first', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);
    // Stub the drain so the queue actually reaches the cap; otherwise the
    // batch-full auto-flush empties it long before any observation is dropped.
    jest.spyOn(reporter, 'flush').mockResolvedValue(undefined);

    await reportMany(reporter, 601);

    const queue = reporter['queue'];
    expect(queue).toHaveLength(500);
    // 101 dropped off the front; the newest is still there.
    expect(queue[0].observation.traceId).toBe('trace-101');
    expect(queue[queue.length - 1].observation.traceId).toBe('trace-600');
  });

  it('keeps flushing while more than one batch is queued', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);
    // Fill past one batch without letting the batch-full auto-flush drain it.
    const drain = jest.spyOn(reporter, 'flush').mockResolvedValue(undefined);
    await reportMany(reporter, 120);
    drain.mockRestore();

    jest.useFakeTimers();
    await reporter.flush();
    expect(client.observe).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2_000);
    expect(client.observe).toHaveBeenCalledTimes(2);
  });

  it('never throws when a body cannot be serialized', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);
    const circular: Record<string, unknown> = { model: 'gpt-5.1' };
    circular.self = circular;

    expect(() => reporter.report({ ...input, requestBody: circular })).not.toThrow();
    await settle();

    expect(client.observe).not.toHaveBeenCalled();
  });

  it('swallows a healer failure so the proxy never sees it', async () => {
    const client = makeClient();
    client.observe.mockRejectedValue(new Error('phoenix down'));
    const reporter = enabledReporter(client);

    reporter.report(input);
    await settle();

    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('drains the queue on shutdown', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);

    reporter.report(input);
    await settle();
    await reporter.onModuleDestroy();

    expect(client.observe).toHaveBeenCalledTimes(1);
  });

  it('drains every queued batch on shutdown, not just the first', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);
    // Hold the queue at 120 so shutdown faces a multi-batch backlog.
    const drain = jest.spyOn(reporter, 'flush').mockResolvedValue(undefined);
    await reportMany(reporter, 120);
    drain.mockRestore();

    await reporter.onModuleDestroy();

    expect(client.observe).toHaveBeenCalledTimes(3);
    expect(reporter['queue']).toHaveLength(0);
  });

  it('is a no-op flush when nothing is queued', async () => {
    const client = makeClient();
    const reporter = enabledReporter(client);

    await reporter.flush();

    expect(client.observe).not.toHaveBeenCalled();
  });
});
