import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';

/**
 * Cheap identity probe for CLI/API clients. `@TenantCtx()` fails closed with
 * a 401 when no credential attached a tenant context, so the env `API_KEY`
 * operator fallback (which attaches none) is rejected here by design — the
 * CLI contract promises a tenant identity, not just "some credential worked".
 */
@Controller('api/v1/me')
export class MeController {
  @Get()
  me(@TenantCtx() ctx: TenantContext, @Req() request: Request) {
    const r = request as Request & { authMethod?: string; apiKeyExpiresAt?: string | null };
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      authMethod: r.authMethod ?? null,
      expiresAt: r.apiKeyExpiresAt ?? null,
    };
  }
}
