import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { ApiKey } from '../../entities/api-key.entity';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestWithTenantContext } from '../decorators/tenant-context.decorator';
import { verifyKey, keyPrefix as computePrefix } from '../utils/hash.util';
import { toLocalSqlTimestamp } from '../utils/postgres-sql';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Skip if already authenticated via session (explicit flag prevents accidental bypass)
    if ((request as Request & { authMethod?: string }).authMethod === 'session') return true;

    const apiKey = request.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      this.logger.warn(`Rejected request without API key from ${request.ip}`);
      throw new UnauthorizedException('X-API-Key header required');
    }

    // Try DB-based API key lookup first (multi-tenant)
    const prefix = computePrefix(apiKey);
    const candidates = await this.apiKeyRepo.find({ where: { key_prefix: prefix } });
    const found = candidates.find((c) => verifyKey(apiKey, c.key_hash));

    if (found) {
      const now = Date.now();
      const absoluteExpiryAt = found.absolute_expires_at
        ? new Date(found.absolute_expires_at).getTime()
        : null;
      // Two independent deadlines: the sliding window (`expires_at`) and the
      // hard ceiling (`absolute_expires_at`). A token in constant use keeps the
      // window alive forever, so the ceiling is what ultimately retires it.
      const expired =
        (found.expires_at && new Date(found.expires_at).getTime() <= now) ||
        (absoluteExpiryAt !== null && absoluteExpiryAt <= now);
      if (expired) {
        this.logger.warn(`Rejected expired API key from ${request.ip}`);
        throw new UnauthorizedException('API key expired — run mnfst login');
      }
      // Keys are tenant credentials: the tenant comes straight off the key
      // row — no key → user → tenant indirection. The creating user is kept
      // as attribution so @CurrentUser-scoped controllers (and audit writes)
      // still see a user when one exists.
      (request as RequestWithTenantContext).tenantContext = {
        tenantId: found.tenant_id,
        userId: found.created_by_user_id,
      };
      if (found.created_by_user_id) {
        (request as Request & { user: { id: string } }).user = {
          id: String(found.created_by_user_id),
        };
      }
      (request as Request & { authMethod: string }).authMethod = 'api_key';
      const ttlDays = this.configService.get<number>('app.cliTokenTtlDays', 30);
      const slidExpiryAt = now + ttlDays * 86_400_000;
      const nextExpiryAt =
        absoluteExpiryAt !== null && absoluteExpiryAt < slidExpiryAt
          ? absoluteExpiryAt
          : slidExpiryAt;
      // Stamp the REFRESHED deadline, not the pre-refresh one, so /me reports
      // what the next request will actually enforce. ISO UTC on the wire (like
      // the mint response), while the DB update keeps the naive-local form.
      (request as Request & { apiKeyExpiresAt?: string | null }).apiKeyExpiresAt = found.expires_at
        ? new Date(nextExpiryAt).toISOString()
        : null;
      this.apiKeyRepo
        .createQueryBuilder()
        .update(ApiKey)
        .set(
          found.expires_at
            ? {
                last_used_at: () => 'CURRENT_TIMESTAMP',
                // Node clock, not CURRENT_TIMESTAMP: CliAuthService mints
                // expiries with toLocalSqlTimestamp, and one column must not
                // be written by two different clocks. Never past the ceiling.
                expires_at: toLocalSqlTimestamp(new Date(nextExpiryAt)),
              }
            : { last_used_at: () => 'CURRENT_TIMESTAMP' },
        )
        .where('id = :id', { id: found.id })
        .execute()
        .catch((err: Error) =>
          this.logger.warn(`Failed to update last_used_at/expires_at: ${err.message}`),
        );
      return true;
    }

    // Fall back to env-based API key (for simple setups). The env key is a
    // shared operator credential not tied to any user; controllers that
    // depend on @CurrentUser will reject the request when `request.user`
    // is unset (see CurrentUser decorator).
    const validKey = this.configService.get<string>('app.apiKey', '');
    if (validKey && this.safeCompare(apiKey, validKey)) {
      (request as Request & { authMethod: string }).authMethod = 'env_api_key';
      return true;
    }

    this.logger.warn(`Rejected invalid API key from ${request.ip}`);
    throw new UnauthorizedException('Invalid API key');
  }

  private safeCompare(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    // timingSafeEqual requires equal-length inputs. A length mismatch is
    // a definite mismatch, and the length of the configured env-based
    // API_KEY is not a secret worth hiding. Real agent ingest keys take
    // the scrypt path via hash.util.verifyKey further up.
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  }
}
