import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Each test does `vi.resetModules()` + `await import(...)`, which re-transforms
// the sse module; under heavy parallel-suite load that occasionally exceeds the
// default 5s test timeout. Give the suite headroom so it doesn't flake on load.
describe('sse', { timeout: 20000 }, () => {
  let mockEventSource: any;

  function getHandler(type: string) {
    return mockEventSource.addEventListener.mock.calls.find((c: any[]) => c[0] === type)?.[1];
  }

  beforeEach(() => {
    mockEventSource = {
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    // Must be a `function` (not an arrow): the source does `new EventSource(...)`,
    // and vitest 4 constructs the mock implementation — arrows can't be `new`ed.
    vi.stubGlobal(
      'EventSource',
      vi.fn(function (this: unknown) {
        return mockEventSource;
      }),
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates EventSource with correct URL', async () => {
    const { connectSse } = await import('../../src/services/sse');
    connectSse();
    expect(EventSource).toHaveBeenCalledWith('/api/v1/events');
  });

  it('returns a cleanup function that closes the connection', async () => {
    const { connectSse } = await import('../../src/services/sse');
    const cleanup = connectSse();
    cleanup();
    expect(mockEventSource.close).toHaveBeenCalled();
  });

  it("bumps pingCount immediately but debounces messagePing on legacy 'ping'", async () => {
    vi.useFakeTimers();
    const { connectSse, pingCount, messagePing } = await import('../../src/services/sse');
    connectSse();
    const pingHandler = getHandler('ping');
    expect(pingHandler).toBeDefined();
    const beforePing = pingCount();
    const beforeMessage = messagePing();
    pingHandler();
    // pingCount is the legacy counter — bumped synchronously.
    expect(pingCount()).toBe(beforePing + 1);
    // messagePing is coalesced — nothing until the 500ms window elapses.
    expect(messagePing()).toBe(beforeMessage);
    vi.advanceTimersByTime(500);
    expect(messagePing()).toBe(beforeMessage + 1);
  });

  it('refreshes messages after 500ms and analytics after the 30s cache TTL', async () => {
    vi.useFakeTimers();
    const { connectSse, pingCount, messagePing, analyticsPing } =
      await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('message');
    expect(handler).toBeDefined();
    const beforePing = pingCount();
    const beforeMessage = messagePing();
    const beforeAnalytics = analyticsPing();
    handler();
    expect(pingCount()).toBe(beforePing + 1);
    expect(messagePing()).toBe(beforeMessage);
    expect(analyticsPing()).toBe(beforeAnalytics);
    vi.advanceTimersByTime(500);
    expect(messagePing()).toBe(beforeMessage + 1);
    expect(analyticsPing()).toBe(beforeAnalytics);
    vi.advanceTimersByTime(29_500);
    expect(analyticsPing()).toBe(beforeAnalytics + 1);
  });

  it('coalesces message and analytics bursts at their separate cadences', async () => {
    vi.useFakeTimers();
    const { connectSse, messagePing, analyticsPing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('message');
    const beforeMessage = messagePing();
    const beforeAnalytics = analyticsPing();
    // Five events inside 100ms collapse into one scheduled bump.
    for (let i = 0; i < 5; i++) handler();
    vi.advanceTimersByTime(100);
    expect(messagePing()).toBe(beforeMessage);
    vi.advanceTimersByTime(400);
    expect(messagePing()).toBe(beforeMessage + 1);
    // A later event opens a fresh window.
    handler();
    vi.advanceTimersByTime(500);
    expect(messagePing()).toBe(beforeMessage + 2);
    expect(analyticsPing()).toBe(beforeAnalytics);
    vi.advanceTimersByTime(29_000);
    expect(analyticsPing()).toBe(beforeAnalytics + 1);
  });

  it('clears pending message and analytics bump timers on cleanup', async () => {
    vi.useFakeTimers();
    const { connectSse, messagePing, analyticsPing } = await import('../../src/services/sse');
    const cleanup = connectSse();
    const handler = getHandler('message');
    const beforeMessage = messagePing();
    const beforeAnalytics = analyticsPing();
    handler();
    cleanup();
    vi.advanceTimersByTime(30_000);
    // Neither scheduled bump may fire after cleanup.
    expect(messagePing()).toBe(beforeMessage);
    expect(analyticsPing()).toBe(beforeAnalytics);
    expect(mockEventSource.close).toHaveBeenCalled();
  });

  it('increments agentPing AND pingCount without scheduling message analytics', async () => {
    vi.useFakeTimers();
    const { connectSse, pingCount, agentPing, messagePing, analyticsPing } =
      await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('agent');
    expect(handler).toBeDefined();
    const beforePing = pingCount();
    const beforeAgent = agentPing();
    const beforeMessage = messagePing();
    const beforeAnalytics = analyticsPing();
    handler();
    expect(agentPing()).toBe(beforeAgent + 1);
    expect(pingCount()).toBe(beforePing + 1);
    // 'agent' must NOT schedule either message-derived bump.
    vi.advanceTimersByTime(30_000);
    expect(messagePing()).toBe(beforeMessage);
    expect(analyticsPing()).toBe(beforeAnalytics);
  });

  it("increments routingPing AND pingCount on 'routing' event", async () => {
    const { connectSse, pingCount, routingPing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('routing');
    expect(handler).toBeDefined();
    const beforePing = pingCount();
    const beforeRouting = routingPing();
    handler();
    expect(routingPing()).toBe(beforeRouting + 1);
    expect(pingCount()).toBe(beforePing + 1);
  });
});

// SSE-driven SWR cache invalidation. These tests mock the cache + routing modules
// so they can assert (a) the right key group is invalidated for each event and
// (b) the invalidation runs BEFORE the corresponding ping signal is bumped — the
// ordering that keeps live dashboard updates working with caching in place.
describe('sse cache invalidation', () => {
  let mockEventSource: any;
  const invalidateGroup = vi.fn();
  const invalidateCustomProvidersCache = vi.fn();
  // Records the order of invalidateGroup vs ping-bump observations.
  let order: string[] = [];

  function getHandler(type: string) {
    return mockEventSource.addEventListener.mock.calls.find((c: any[]) => c[0] === type)?.[1];
  }

  beforeEach(() => {
    order = [];
    mockEventSource = { addEventListener: vi.fn(), close: vi.fn() };
    // Must be a `function` (not an arrow): the source does `new EventSource(...)`,
    // and vitest 4 constructs the mock implementation — arrows can't be `new`ed.
    vi.stubGlobal(
      'EventSource',
      vi.fn(function (this: unknown) {
        return mockEventSource;
      }),
    );
    vi.resetModules();
    invalidateGroup.mockReset();
    invalidateCustomProvidersCache.mockReset();
    invalidateGroup.mockImplementation((g: string) => order.push(`invalidate:${g}`));
    vi.doMock('../../src/services/api/cache.js', () => ({
      DEFAULT_TTL_MS: 30_000,
      invalidateGroup,
    }));
    vi.doMock('../../src/services/api/routing.js', () => ({
      invalidateCustomProvidersCache,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../src/services/api/cache.js');
    vi.doUnmock('../../src/services/api/routing.js');
  });

  it("invalidates the 'message' group BEFORE bumping messagePing", async () => {
    vi.useFakeTimers();
    const { connectSse, messagePing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('message');
    const before = messagePing();
    handler();
    // The coalesced bump (and its invalidation) fire after 500ms.
    vi.advanceTimersByTime(500);
    expect(messagePing()).toBe(before + 1);
    // Invalidation happened, targeting the message group.
    expect(invalidateGroup).toHaveBeenCalledWith('message');
    // And it happened inside the same tick, before the signal observers run.
    expect(order[0]).toBe('invalidate:message');
  });

  it("invalidates the 'analytics' group BEFORE the slower analyticsPing", async () => {
    vi.useFakeTimers();
    const { connectSse, analyticsPing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('message');
    const before = analyticsPing();
    handler();
    vi.advanceTimersByTime(29_999);
    expect(analyticsPing()).toBe(before);
    expect(invalidateGroup).not.toHaveBeenCalledWith('analytics');
    vi.advanceTimersByTime(1);
    expect(analyticsPing()).toBe(before + 1);
    expect(invalidateGroup).toHaveBeenCalledWith('analytics');
    expect(order.at(-1)).toBe('invalidate:analytics');
  });

  it("invalidates the 'agent' group BEFORE bumping agentPing", async () => {
    const { connectSse, agentPing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('agent');
    const before = agentPing();
    // The invalidate spy records its call; capture the ping value at call time.
    invalidateGroup.mockImplementation((g: string) => {
      order.push(`invalidate:${g}@ping=${agentPing()}`);
    });
    handler();
    expect(agentPing()).toBe(before + 1);
    // Invalidation observed the pre-bump ping value → it ran first.
    expect(order[0]).toBe(`invalidate:agent@ping=${before}`);
  });

  it('invalidates routing group AND custom-providers cache BEFORE bumping routingPing', async () => {
    const { connectSse, routingPing } = await import('../../src/services/sse');
    connectSse();
    const handler = getHandler('routing');
    const before = routingPing();
    invalidateGroup.mockImplementation((g: string) => {
      order.push(`invalidate:${g}@ping=${routingPing()}`);
    });
    invalidateCustomProvidersCache.mockImplementation(() => {
      order.push(`custom@ping=${routingPing()}`);
    });
    handler();
    expect(routingPing()).toBe(before + 1);
    // Both invalidations ran before the ping bump.
    expect(invalidateGroup).toHaveBeenCalledWith('routing');
    expect(invalidateCustomProvidersCache).toHaveBeenCalled();
    expect(order).toEqual([`invalidate:routing@ping=${before}`, `custom@ping=${before}`]);
  });

  it('clears pending message and analytics timers on cleanup without invalidating', async () => {
    vi.useFakeTimers();
    const { connectSse, messagePing, analyticsPing } = await import('../../src/services/sse');
    const cleanup = connectSse();
    const handler = getHandler('message');
    const before = messagePing();
    const beforeAnalytics = analyticsPing();
    handler();
    cleanup();
    vi.advanceTimersByTime(30_000);
    // Neither the bump nor its invalidation fire after cleanup.
    expect(messagePing()).toBe(before);
    expect(analyticsPing()).toBe(beforeAnalytics);
    expect(invalidateGroup).not.toHaveBeenCalled();
  });
});
