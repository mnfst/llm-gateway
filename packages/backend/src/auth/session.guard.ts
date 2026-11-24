import { CanActivate, ExecutionContext, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { createHash } from 'crypto';
import { auth } from './auth.instance';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { TenantCacheService } from '../common/services/tenant-cache.service';
import { RequestWithTenantContext } from '../common/decorators/tenant-context.decorator';

interface CachedSession {
  user: unknown;
  session: unknown;
  expiresAt: number;
}

@Injectable()
export class SessionGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(SessionGuard.name);
  private readonly cache = new Map<string, CachedSession>();
  private readonly CACHE_TTL_MS = 60_000;
  private readonly MAX_CACHE_SIZE = 5_000;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly reflector: Reflector,
    private readonly tenantCache: TenantCacheService,
  ) {
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60_000);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Let API-key authenticated requests be handled by ApiKeyGuard
    if (request.headers['x-api-key']) return true;

    // In the self-hosted version without Better Auth, skip session lookup
    if (!auth) return true;

    const cookieHeader = request.headers['cookie'];
    const cacheKey =
      typeof cookieHeader === 'string' && cookieHeader.length > 0
        ? this.hashCookie(cookieHeader)
        : null;

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        // LRU touch — re-insert to move to tail of insertion order
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        (request as Request & { user: unknown }).user = cached.user;
        (request as Request & { session: unknown }).session = cached.session;
        (request as Request & { authMethod: string }).authMethod = 'session';
        await this.attachTenantContext(request, cached.user);
        return true;
      }
    }

    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });

      if (session) {
        (request as Request & { user: unknown }).user = session.user;
        (request as Request & { session: unknown }).session = session.session;
        (request as Request & { authMethod: string }).authMethod = 'session';
        if (cacheKey) this.storeInCache(cacheKey, session.user, session.session);
        await this.attachTenantContext(request, session.user);
        return true;
      }
    } catch (err) {
      this.logger.warn(`Session lookup failed: ${(err as Error).message}`);
    }

    // Always pass — let ApiKeyGuard handle unauthenticated requests
    return true;
  }

  /**
   * Resolve the user's tenant once at the auth boundary so controllers can
   * scope by tenantId without ever touching the user id. Resolution is
   * cached (TtlFifoCache) so this adds no per-request DB cost in steady state.
   */
  private async attachTenantContext(request: Request, user: unknown): Promise<void> {
    const userId = (user as { id?: unknown } | null)?.id;
    if (typeof userId !== 'string' || userId.length === 0) return;
    try {
      const tenantId = await this.tenantCache.resolve(userId);
      (request as RequestWithTenantContext).tenantContext = { tenantId, userId };
    } catch (err) {
      // Fail soft: a transient resolution failure (e.g. DB hiccup) must not
      // crash every authenticated request — especially the cached-session
      // fast path, which never touched the DB before tenant scoping. A null
      // tenant means read endpoints return empty and mutations 404.
      this.logger.warn(`Tenant resolution failed for session user: ${(err as Error).message}`);
      (request as RequestWithTenantContext).tenantContext = { tenantId: null, userId };
    }
  }

  invalidateCache(cookieHeader?: string): void {
    if (cookieHeader) {
      this.cache.delete(this.hashCookie(cookieHeader));
      return;
    }
    this.cache.clear();
  }

  private hashCookie(cookieHeader: string): string {
    return createHash('sha256').update(cookieHeader).digest('hex');
  }

  private storeInCache(key: string, user: unknown, session: unknown): void {
    this.evictExpired();
    while (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      user,
      session,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
