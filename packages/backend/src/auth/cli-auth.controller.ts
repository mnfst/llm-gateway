import { Body, Controller, Delete, ForbiddenException, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { Public } from '../common/decorators/public.decorator';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { CliAuthService } from './cli-auth.service';

const STATE_MESSAGE =
  'state must be 16-128 URL-safe characters (letters, numbers, dashes, underscores)';
const PKCE_MESSAGE = 'must be 43-128 URL-safe characters (letters, numbers, dashes, underscores)';

class AuthorizeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/, { message: STATE_MESSAGE })
  state!: string;

  /** PKCE S256 challenge: base64url(SHA-256(verifier)), always exactly 43 chars. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, {
    message: 'code_challenge must be exactly 43 URL-safe characters (S256 output)',
  })
  code_challenge!: string;

  @IsOptional()
  @IsIn(['S256'], { message: 'code_challenge_method must be S256' })
  code_challenge_method?: 'S256';
}

class ExchangeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,100}$/, {
    message: 'code must be 20-100 URL-safe characters (letters, numbers, dashes, underscores)',
  })
  code!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/, { message: STATE_MESSAGE })
  state!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43,128}$/, { message: `code_verifier ${PKCE_MESSAGE}` })
  code_verifier!: string;
}

@Controller('api/v1/cli')
export class CliAuthController {
  constructor(private readonly cliAuth: CliAuthService) {}

  /** Session-only: the browser Authorize page is the sole caller. */
  @Post('authorize')
  async authorize(
    @Body() dto: AuthorizeDto,
    @TenantCtx() ctx: TenantContext,
    @Req() request: Request,
  ) {
    const authMethod = (request as Request & { authMethod?: string }).authMethod;
    if (authMethod !== 'session') {
      throw new ForbiddenException('CLI authorization requires a browser session');
    }
    if (!ctx.tenantId) {
      throw new ForbiddenException('No workspace yet — create your first agent in the dashboard');
    }
    return this.cliAuth.createAuthorization(
      ctx,
      dto.state,
      dto.code_challenge,
      dto.code_challenge_method ?? 'S256',
    );
  }

  /**
   * Public: the CLI calls this without a credential — the code IS the credential.
   * `expiresAt` is ISO-8601 in UTC, so the CLI never has to guess the server's
   * timezone.
   */
  @Public()
  @Post('token')
  @HttpCode(200)
  async token(@Body() dto: ExchangeDto) {
    return this.cliAuth.exchange(dto.code, dto.state, dto.code_verifier);
  }

  /** Best-effort logout revocation of the calling cli PAT. */
  @Delete('token')
  async revoke(@Req() request: Request) {
    const raw = request.headers['x-api-key'];
    if (typeof raw !== 'string' || raw.length === 0) return { revoked: false };
    return this.cliAuth.revokeByRawKey(raw);
  }
}
