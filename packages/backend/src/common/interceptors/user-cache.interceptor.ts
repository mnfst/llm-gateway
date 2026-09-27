import { CacheInterceptor } from '@nestjs/cache-manager';
import { CallHandler, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { defer, finalize, mergeAll, Observable, shareReplay } from 'rxjs';
import { RequestWithTenantContext } from '../decorators/tenant-context.decorator';

@Injectable()
export class UserCacheInterceptor extends CacheInterceptor {
  private readonly inFlightResponses = new Map<string, Observable<unknown>>();

  constructor(@Inject('CACHE_MANAGER') cacheManager: unknown, reflector: Reflector) {
    super(cacheManager, reflector);
  }

  /**
   * Share one cache lookup/handler execution between concurrent requests for
   * the same tenant and URL. Nest's stock CacheInterceptor caches only after a
   * handler resolves, so simultaneous misses otherwise all run the same query.
   */
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const key = await this.trackBy(context);
    if (!key) return super.intercept(context, next);

    const existing = this.inFlightResponses.get(key);
    if (existing) return existing;

    const response = defer(() => super.intercept(context, next)).pipe(
      mergeAll(),
      finalize(() => {
        this.inFlightResponses.delete(key);
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.inFlightResponses.set(key, response);
    return response;
  }

  /**
   * Shared precondition gate for cacheable per-tenant GET responses. Returns
   * the resolved tenant id when the request is a GET carrying an authenticated
   * tenant context, or undefined (skip caching) otherwise. Subclasses build
   * their cache key on top of this so the GET/auth preconditions live in
   * exactly one place. Keyed by tenant — never by user — so the cache scope
   * matches the data scope.
   */
  protected resolveTenantId(context: ExecutionContext): string | undefined {
    const request = context.switchToHttp().getRequest<RequestWithTenantContext>();
    if (request.method !== 'GET') return undefined;
    return request.tenantContext?.tenantId ?? undefined;
  }

  protected trackBy(context: ExecutionContext): string | undefined {
    const tenantId = this.resolveTenantId(context);
    if (!tenantId) return undefined;

    const request = context.switchToHttp().getRequest<Request>();
    return `${tenantId}:${request.originalUrl}`;
  }
}
