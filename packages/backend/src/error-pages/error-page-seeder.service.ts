import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ErrorPagesService } from './error-pages.service';
import { ERROR_PAGE_SEEDS, seedTrend } from './error-page-seed-data';
import type { ErrorPageStats } from '../entities/public-error-page.entity';

/**
 * Publishes the curated demo error pages (dev/test only) through the same
 * `ErrorPagesService.upsert` valve a real Peacock CMS push uses — so the
 * marketing `/errors/` catalog renders a full, chart-rich set (sparkline trends
 * included) without a live CMS. Gated by `SEED_DATA=true`; idempotent (skips if
 * the first demo page is already published, so an operator can unpublish freely).
 */
@Injectable()
export class ErrorPageSeederService implements OnModuleInit {
  private readonly logger = new Logger(ErrorPageSeederService.name);

  constructor(private readonly pages: ErrorPagesService) {}

  async onModuleInit(): Promise<void> {
    if (process.env['SEED_DATA'] !== 'true') return;
    if (await this.pages.getBySlug(ERROR_PAGE_SEEDS[0].slug)) return;

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    for (let i = 0; i < ERROR_PAGE_SEEDS.length; i++) {
      const s = ERROR_PAGE_SEEDS[i];
      const stats: ErrorPageStats = {
        tenants: s.tenants,
        volume_7d: s.volume_7d,
        volume_30d: s.volume_30d,
        recovery_rate: s.recovery_rate,
        last_seen: nowIso,
        trend: seedTrend(s.volume_30d, i, now),
        variants: s.variants ?? [],
      };
      await this.pages.upsert({
        slug: s.slug,
        cluster_key: s.cluster_key,
        provider: s.provider,
        provider_label: s.provider_label,
        http_status: s.http_status,
        category: s.category,
        category_label: s.category_label,
        title: s.title,
        meta_description: s.meta_description,
        h1: s.h1,
        body_what: s.body_what,
        body_fix: s.body_fix,
        sample_message: s.sample_message,
        faq: s.faq,
        stats,
      });
    }
    this.logger.log(`Seeded ${ERROR_PAGE_SEEDS.length} public error pages (dev demo, with trends)`);
  }
}
