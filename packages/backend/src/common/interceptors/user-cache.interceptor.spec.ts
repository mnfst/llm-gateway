import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, Observable, of, ReplaySubject, throwError } from 'rxjs';
import { UserCacheInterceptor } from './user-cache.interceptor';

function createMockContext(
  tenantContext: { tenantId?: string } | undefined,
  originalUrl: string,
  method = 'GET',
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ tenantContext, originalUrl, method }),
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

describe('UserCacheInterceptor', () => {
  let interceptor: UserCacheInterceptor;
  let cacheManager: { get: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    cacheManager = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const mockReflector = new Reflector();

    interceptor = new UserCacheInterceptor(cacheManager, mockReflector);
  });

  describe('intercept', () => {
    it('forwards uncacheable requests without reading the cache', async () => {
      const context = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview', 'POST');
      const next: CallHandler = { handle: jest.fn(() => of({ ok: true })) };

      const response = await interceptor.intercept(context, next);

      await expect(firstValueFrom(response)).resolves.toEqual({ ok: true });
      expect(cacheManager.get).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('shares one handler execution between concurrent misses for the same key', async () => {
      const context = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview');
      const source = new ReplaySubject<{ total: number }>(1);
      const next: CallHandler = { handle: jest.fn(() => source) };

      const first = await interceptor.intercept(context, next);
      const second = await interceptor.intercept(context, next);
      const firstResult = firstValueFrom(first);
      const secondResult = firstValueFrom(second);

      source.next({ total: 42 });
      source.complete();

      await expect(firstResult).resolves.toEqual({ total: 42 });
      await expect(secondResult).resolves.toEqual({ total: 42 });
      expect(cacheManager.get).toHaveBeenCalledTimes(1);
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('does not coalesce different cache keys', async () => {
      const firstContext = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview');
      const secondContext = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/tokens');
      const next: CallHandler = { handle: jest.fn(() => of({ ok: true })) };

      const first = await interceptor.intercept(firstContext, next);
      const second = await interceptor.intercept(secondContext, next);

      await Promise.all([firstValueFrom(first), firstValueFrom(second)]);
      expect(next.handle).toHaveBeenCalledTimes(2);
    });

    it('clears a failed response so the next request can retry', async () => {
      const context = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview');
      const failure = new Error('query failed');
      const next: CallHandler = {
        handle: jest
          .fn<Observable<{ ok: boolean }>, []>()
          .mockReturnValueOnce(throwError(() => failure))
          .mockReturnValueOnce(of({ ok: true })),
      };

      const first = await interceptor.intercept(context, next);
      await expect(firstValueFrom(first)).rejects.toThrow('query failed');

      const retry = await interceptor.intercept(context, next);
      await expect(firstValueFrom(retry)).resolves.toEqual({ ok: true });
      expect(next.handle).toHaveBeenCalledTimes(2);
    });
  });

  describe('trackBy', () => {
    it('should return tenantId:originalUrl when tenant context is present', () => {
      const context = createMockContext({ tenantId: 'tenant-abc' }, '/api/v1/overview');

      const key = interceptor['trackBy'](context);

      expect(key).toBe('tenant-abc:/api/v1/overview');
    });

    it('should include query parameters in the cache key', () => {
      const context = createMockContext(
        { tenantId: 'tenant-1' },
        '/api/v1/tokens?range=7d&agent=demo',
      );

      const key = interceptor['trackBy'](context);

      expect(key).toBe('tenant-1:/api/v1/tokens?range=7d&agent=demo');
    });

    it('should return undefined for non-GET requests', () => {
      const context = createMockContext({ tenantId: 'tenant-abc' }, '/api/v1/overview', 'POST');

      const key = interceptor['trackBy'](context);

      expect(key).toBeUndefined();
    });

    it('should return undefined when tenant context is not present', () => {
      const context = createMockContext(undefined, '/api/v1/overview');

      const key = interceptor['trackBy'](context);

      expect(key).toBeUndefined();
    });

    it('should return undefined when tenant context has no tenantId', () => {
      const context = createMockContext({}, '/api/v1/overview');

      const key = interceptor['trackBy'](context);

      expect(key).toBeUndefined();
    });

    it('should generate distinct keys for different URLs', () => {
      const ctx1 = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview');
      const ctx2 = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/tokens');

      const key1 = interceptor['trackBy'](ctx1);
      const key2 = interceptor['trackBy'](ctx2);

      expect(key1).not.toBe(key2);
      expect(key1).toBe('tenant-1:/api/v1/overview');
      expect(key2).toBe('tenant-1:/api/v1/tokens');
    });

    it('should generate distinct keys for different tenants on the same URL', () => {
      const ctx1 = createMockContext({ tenantId: 'tenant-1' }, '/api/v1/overview');
      const ctx2 = createMockContext({ tenantId: 'tenant-2' }, '/api/v1/overview');

      const key1 = interceptor['trackBy'](ctx1);
      const key2 = interceptor['trackBy'](ctx2);

      expect(key1).toBe('tenant-1:/api/v1/overview');
      expect(key2).toBe('tenant-2:/api/v1/overview');
    });
  });
});
