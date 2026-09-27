import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { TenantCacheService } from '../../common/services/tenant-cache.service';
import { ManagedFreeProviderService } from './managed-free-provider.service';

class EnsureManagedFreeProviderBody {
  /** Optional LiteLLM virtual key for a manually provisioned connection. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;
}

@Controller('api/v1/providers')
export class ManagedFreeProviderController {
  constructor(
    private readonly managedFreeProvider: ManagedFreeProviderService,
    private readonly tenantCache: TenantCacheService,
  ) {}

  /** Ensure a provider-scoped LiteLLM connection without returning the raw key. */
  @Post(':providerId/ensure')
  async ensure(
    @Param('providerId') providerId: string,
    @TenantCtx() ctx: TenantContext,
    @CurrentUser() user: { id?: string; email?: string },
    @Body() body: EnsureManagedFreeProviderBody,
  ) {
    const tenantId =
      ctx.tenantId ?? (user.id ? await this.tenantCache.ensureForUser(user.id) : null);
    if (!tenantId) {
      return {
        connected: false,
        connection_id: null,
        source: 'none' as const,
        auto_available: false,
      };
    }

    return this.managedFreeProvider.ensureConnection(providerId, {
      tenantId,
      userId: ctx.userId ?? user.id ?? null,
      userEmail: user.email ?? null,
      apiKey: body?.apiKey,
    });
  }
}
