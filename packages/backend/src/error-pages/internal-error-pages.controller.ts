import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';
import { ErrorPagesService } from './error-pages.service';
import { ErrorDiscoveryService } from './error-discovery.service';
import { UpsertErrorPageDto } from './dto/upsert-error-page.dto';

/**
 * Internal write API. The Peacock CMS pushes published pages here (and deletes
 * on unpublish). Marked @Public() to skip the session/api-key guards, then
 * gated by a shared secret in the `x-internal-secret` header — this is the only
 * way a row reaches `public_error_pages`. Lives under /api/* so the SPA static
 * fallback never shadows it.
 */
@Controller('api/v1/internal/error-pages')
export class InternalErrorPagesController {
  constructor(
    private readonly service: ErrorPagesService,
    private readonly discovery: ErrorDiscoveryService,
    private readonly config: ConfigService,
  ) {}

  private assertSecret(provided: string | undefined): void {
    const expected = this.config.get<string>('app.errorPagePushSecret') ?? '';
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('Invalid or missing push secret');
    }
  }

  // Live cross-tenant cluster rollup the Peacock CMS pulls from to discover and
  // refresh clusters. Same secret as the push endpoints.
  @Public()
  @Get('clusters')
  async clusters(@Headers('x-internal-secret') secret: string) {
    this.assertSecret(secret);
    return this.discovery.discover();
  }

  @Public()
  @Post()
  async upsert(@Headers('x-internal-secret') secret: string, @Body() dto: UpsertErrorPageDto) {
    this.assertSecret(secret);
    return this.service.upsert(dto);
  }

  @Public()
  @Delete(':slug')
  async remove(@Headers('x-internal-secret') secret: string, @Param('slug') slug: string) {
    this.assertSecret(secret);
    return this.service.remove(slug);
  }
}
