import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import { Request } from 'express';
import { UserCacheInterceptor } from './user-cache.interceptor';
import { AgentListCacheService } from '../services/agent-list-cache.service';
import { agentUsageDailyReadsEnabled } from '../utils/agent-usage-daily-flags';

/**
 * Cache interceptor for GET /agents. Unlike the generic URL-keyed
 * UserCacheInterceptor, it collapses every query-string variant (no param,
 * ?includePlayground=true, ?includePlayground=false, anything else) onto one of two
 * canonical keys based on the normalized `includePlayground` boolean. That keeps the
 * cached key set bounded to exactly two entries per tenant, so mutation handlers
 * can invalidate it exhaustively (see AgentListCacheService) without a stray URL
 * variant being left stale.
 */
@Injectable()
export class AgentListCacheInterceptor extends UserCacheInterceptor {
  constructor(
    @Inject(CACHE_MANAGER) agentListCache: Cache,
    reflector: Reflector,
    private readonly keys: AgentListCacheService,
  ) {
    super(agentListCache, reflector);
  }

  protected trackBy(context: ExecutionContext): string | undefined {
    const tenantId = this.resolveTenantId(context);
    if (!tenantId) return undefined;
    if (agentUsageDailyReadsEnabled(tenantId)) return undefined;

    const request = context.switchToHttp().getRequest<Request>();
    const includePlayground =
      (request.query as { includePlayground?: string } | undefined)?.includePlayground === 'true';
    return this.keys.key(tenantId, includePlayground);
  }
}
