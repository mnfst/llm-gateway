import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';
import { ErrorPagesService } from './error-pages.service';

/**
 * Public, unauthenticated read API consumed by the marketing site
 * (manifest.build/errors/...). Gated by MANIFEST_PUBLIC_STATS, 404 (not 403)
 * when disabled so probes can't distinguish "off" from "absent".
 */
@Controller('api/v1/public/error-pages')
export class PublicErrorPagesController {
  constructor(
    private readonly service: ErrorPagesService,
    private readonly config: ConfigService,
  ) {}

  private assertEnabled(): void {
    if (!this.config.get<boolean>('app.publicErrorPagesEnabled')) {
      throw new NotFoundException();
    }
  }

  @Public()
  @Get()
  async list() {
    this.assertEnabled();
    const pages = await this.service.listPublished();
    return {
      pages: pages.map((p) => ({
        slug: p.slug,
        title: p.title,
        h1: p.h1,
        meta_description: p.meta_description,
        provider: p.provider,
        provider_label: p.provider_label,
        http_status: p.http_status,
        category: p.category,
        category_label: p.category_label,
        stats: p.stats,
        noindex: p.noindex,
        published_at: p.published_at,
        updated_at: p.updated_at,
      })),
      cached_at: new Date().toISOString(),
    };
  }

  @Public()
  @Get(':slug')
  async detail(@Param('slug') slug: string) {
    this.assertEnabled();
    const page = await this.service.getBySlug(slug);
    if (!page) throw new NotFoundException();
    return page;
  }
}
