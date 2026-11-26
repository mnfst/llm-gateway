import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, catchError, concatMap, from, mergeMap, throwError } from 'rxjs';
import { RoutingCacheSyncService } from './routing-cache-sync.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Holds the response of a mutating request until the routing-cache
 * invalidations it caused are committed to the shared feed. Without it the
 * dashboard's refetch right after a save could reach another instance before
 * that instance can learn about the write, and show the old routing.
 * Requests that invalidated nothing pass straight through.
 */
@Injectable()
export class RoutingCacheFlushInterceptor implements NestInterceptor {
  constructor(private readonly cacheSync: RoutingCacheSyncService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const { method } = context.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(method)) return next.handle();
    return next.handle().pipe(
      concatMap(async (value: unknown) => {
        await this.cacheSync.flushPending();
        return value;
      }),
      // A write can invalidate and then fail; publish before the error responds too.
      catchError((error: unknown) =>
        from(this.cacheSync.flushPending()).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }
}
