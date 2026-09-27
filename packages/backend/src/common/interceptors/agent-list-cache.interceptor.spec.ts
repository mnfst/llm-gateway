import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import { firstValueFrom, ReplaySubject } from 'rxjs';
import { AgentListCacheInterceptor } from './agent-list-cache.interceptor';
import { AgentListCacheService } from '../services/agent-list-cache.service';
import { setAgentUsageDailyAutomaticReadsReady } from '../utils/agent-usage-daily-flags';

function createMockContext(
  tenantContext: { tenantId?: string } | undefined,
  query: Record<string, string> | undefined,
  method = 'GET',
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ tenantContext, query, method, originalUrl: '/api/v1/agents' }),
      getResponse: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
    getArgs: () => [],
    getArgByIndex: () => ({}),
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

/** Let the interceptor's own awaits (the cache lookup) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AgentListCacheInterceptor', () => {
  let interceptor: AgentListCacheInterceptor;
  let keys: AgentListCacheService;
  let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  const originalReads = process.env['AGENT_USAGE_DAILY_READS'];
  const originalTenants = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];

  beforeEach(() => {
    setAgentUsageDailyAutomaticReadsReady(false);
    delete process.env['AGENT_USAGE_DAILY_READS'];
    delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    cacheManager = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(true),
    };
    keys = new AgentListCacheService(cacheManager as unknown as Cache);
    interceptor = new AgentListCacheInterceptor(cacheManager as never, new Reflector(), keys);
  });

  afterAll(() => {
    setAgentUsageDailyAutomaticReadsReady(false);
    if (originalReads === undefined) delete process.env['AGENT_USAGE_DAILY_READS'];
    else process.env['AGENT_USAGE_DAILY_READS'] = originalReads;
    if (originalTenants === undefined) delete process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
    else process.env['AGENT_USAGE_DAILY_READ_TENANTS'] = originalTenants;
  });

  it('never hands a request that arrives after invalidation the response already in flight', async () => {
    const context = createMockContext({ tenantId: 't1' }, undefined);
    const source = new ReplaySubject<{ agents: unknown[] }>(1);
    const next: CallHandler = { handle: jest.fn(() => source) };

    // In flight under the pre-event generation, and subscribed: it has read the
    // database and is waiting on the handler.
    const inFlight = await interceptor.intercept(context, next);
    const inFlightResult = firstValueFrom(inFlight);
    await flush();
    expect(next.handle).toHaveBeenCalledTimes(1);

    await keys.invalidate('t1');

    // The post-event caller must run its own query, not replay the older one.
    const afterEvent = await interceptor.intercept(context, next);
    expect(afterEvent).not.toBe(inFlight);
    const afterEventResult = firstValueFrom(afterEvent);
    await flush();
    expect(next.handle).toHaveBeenCalledTimes(2);

    source.next({ agents: [] });
    source.complete();
    await Promise.all([inFlightResult, afterEventResult]);
    await flush();

    // The older response wrote back under the retired generation, which no
    // reader looks at any more; only the post-event key is served.
    expect(cacheManager.set).toHaveBeenCalledWith('t1:/api/v1/agents:playground=false:g0', {
      agents: [],
    });
    expect(cacheManager.set).toHaveBeenCalledWith('t1:/api/v1/agents:playground=false:g1', {
      agents: [],
    });
    expect(interceptor['trackBy'](context)).toBe('t1:/api/v1/agents:playground=false:g1');
  });

  describe('trackBy', () => {
    it('keys on the playground=true canonical variant for ?includePlayground=true', () => {
      const key = interceptor['trackBy'](
        createMockContext({ tenantId: 't1' }, { includePlayground: 'true' }),
      );
      expect(key).toBe('t1:/api/v1/agents:playground=true:g0');
    });

    it('keys on the playground=false canonical variant when no query param is present', () => {
      const key = interceptor['trackBy'](createMockContext({ tenantId: 't1' }, undefined));
      expect(key).toBe('t1:/api/v1/agents:playground=false:g0');
    });

    it('collapses ?includePlayground=false onto the same playground=false key (no stranded variant)', () => {
      const key = interceptor['trackBy'](
        createMockContext({ tenantId: 't1' }, { includePlayground: 'false' }),
      );
      expect(key).toBe('t1:/api/v1/agents:playground=false:g0');
    });

    it('collapses any non-"true" value onto the playground=false key', () => {
      const key = interceptor['trackBy'](
        createMockContext({ tenantId: 't1' }, { includePlayground: '1' }),
      );
      expect(key).toBe('t1:/api/v1/agents:playground=false:g0');
    });

    it('returns undefined for non-GET requests', () => {
      const key = interceptor['trackBy'](
        createMockContext({ tenantId: 't1' }, { includePlayground: 'true' }, 'POST'),
      );
      expect(key).toBeUndefined();
    });

    it('returns undefined when tenant context is not present', () => {
      const key = interceptor['trackBy'](createMockContext(undefined, undefined));
      expect(key).toBeUndefined();
    });

    it('returns undefined when tenant context has no tenantId', () => {
      const key = interceptor['trackBy'](createMockContext({}, undefined));
      expect(key).toBeUndefined();
    });

    it('bypasses the response cache after the automatic rollup cutover', () => {
      setAgentUsageDailyAutomaticReadsReady(true);
      const key = interceptor['trackBy'](createMockContext({ tenantId: 't1' }, undefined));
      expect(key).toBeUndefined();
    });
  });
});
