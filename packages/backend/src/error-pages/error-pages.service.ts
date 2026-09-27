import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PublicErrorPage } from '../entities/public-error-page.entity';
import { scrubSecrets } from '../common/utils/secret-scrub';
import { UpsertErrorPageDto } from './dto/upsert-error-page.dto';

/**
 * k-anonymity floor: a cluster is never published as a public page unless it
 * affected at least this many distinct tenants. Enforced here (defensively) in
 * addition to the Peacock CMS, so even a CMS bug can't leak a sub-threshold
 * cluster through the push endpoint.
 */
export const MIN_TENANTS_FOR_PUBLIC = 10;

// Public valve scrub: provider-credential redaction (shared util) PLUS email
// redaction. This is the single choke point — every sample reaching
// `public_error_pages` passes through here regardless of which source pushed it.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
function scrubForPublic(text: string | null | undefined): string {
  return scrubSecrets(text ?? '').replace(EMAIL_RE, '[email]');
}

// A `custom:<id>` provider is a single tenant's private endpoint — its errors
// are tenant-specific and can never become a public page. Rejected here at the
// valve (the single choke point) no matter what the caller pushes, mirroring the
// `custom:%` exclusion already applied in discovery.
function isCustomProvider(provider: string): boolean {
  return /^custom($|[:/])/i.test(provider);
}

@Injectable()
export class ErrorPagesService {
  constructor(
    @InjectRepository(PublicErrorPage)
    private readonly repo: Repository<PublicErrorPage>,
  ) {}

  listPublished(): Promise<PublicErrorPage[]> {
    return this.repo.find({ order: { published_at: 'DESC' } });
  }

  getBySlug(slug: string): Promise<PublicErrorPage | null> {
    return this.repo.findOne({ where: { slug } });
  }

  /**
   * Publish or refresh a page. Re-validates the k-anonymity floor and re-scrubs
   * the public sample message before persisting, regardless of what the caller
   * sent — the public table must never hold an un-vetted row.
   */
  async upsert(dto: UpsertErrorPageDto): Promise<{ ok: true; slug: string }> {
    if (isCustomProvider(dto.provider)) {
      throw new BadRequestException(
        `Refusing to publish "${dto.slug}": custom providers are tenant-specific and cannot be public pages.`,
      );
    }

    const tenants = Number(dto.stats?.tenants ?? 0);
    if (!Number.isFinite(tenants) || tenants < MIN_TENANTS_FOR_PUBLIC) {
      throw new BadRequestException(
        `Refusing to publish "${dto.slug}": cluster affects ${tenants} tenants, below the k-anonymity floor of ${MIN_TENANTS_FOR_PUBLIC}.`,
      );
    }

    const now = new Date().toISOString();
    const existing = await this.repo.findOne({ where: { slug: dto.slug } });

    const row: PublicErrorPage = {
      slug: dto.slug,
      cluster_key: dto.cluster_key,
      provider: dto.provider,
      provider_label: dto.provider_label ?? dto.provider,
      http_status: dto.http_status ?? null,
      category: dto.category ?? 'unknown',
      category_label: dto.category_label ?? '',
      title: dto.title,
      meta_description: dto.meta_description,
      h1: dto.h1,
      body_what: dto.body_what ?? '',
      body_fix: dto.body_fix ?? '',
      body_manifest: dto.body_manifest ?? '',
      sample_message: scrubForPublic(dto.sample_message),
      faq: dto.faq ?? [],
      stats: dto.stats,
      related: dto.related ?? [],
      noindex: dto.noindex ?? false,
      published_at: existing?.published_at ?? now,
      updated_at: now,
    };

    await this.repo.save(row);
    return { ok: true, slug: dto.slug };
  }

  async remove(slug: string): Promise<{ ok: true; slug: string }> {
    await this.repo.delete({ slug });
    return { ok: true, slug };
  }
}
