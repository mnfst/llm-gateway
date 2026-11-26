import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { RoutingCacheFlushInterceptor } from './routing-cache-flush.interceptor';
import { RoutingCacheSyncService } from './routing-cache-sync.service';

function httpContext(method: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

describe('RoutingCacheFlushInterceptor', () => {
  let flushPending: jest.Mock;
  let interceptor: RoutingCacheFlushInterceptor;
  const handler: CallHandler = { handle: () => of('body') };

  beforeEach(() => {
    flushPending = jest.fn().mockResolvedValue(undefined);
    interceptor = new RoutingCacheFlushInterceptor({
      flushPending,
    } as unknown as RoutingCacheSyncService);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'waits for queued invalidations before a %s responds',
    async (method) => {
      let release!: () => void;
      flushPending.mockReturnValue(new Promise<void>((r) => (release = r)));

      let settled = false;
      const result = firstValueFrom(interceptor.intercept(httpContext(method), handler)).then(
        (v) => {
          settled = true;
          return v;
        },
      );
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
      release();
      await expect(result).resolves.toBe('body');
    },
  );

  it('publishes before an error responds and rethrows it', async () => {
    const failure = new Error('write failed');
    const failing: CallHandler = { handle: () => throwError(() => failure) };
    await expect(firstValueFrom(interceptor.intercept(httpContext('PUT'), failing))).rejects.toBe(
      failure,
    );
    expect(flushPending).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('passes a %s straight through', async (method) => {
    await expect(firstValueFrom(interceptor.intercept(httpContext(method), handler))).resolves.toBe(
      'body',
    );
    expect(flushPending).not.toHaveBeenCalled();
  });

  it('ignores non-HTTP contexts', async () => {
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await expect(firstValueFrom(interceptor.intercept(ctx, handler))).resolves.toBe('body');
    expect(flushPending).not.toHaveBeenCalled();
  });
});
