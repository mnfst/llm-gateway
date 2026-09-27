import { Entity, Column, PrimaryColumn } from 'typeorm';
import { timestampType } from '../common/utils/postgres-sql';

/** A single question/answer pair rendered into FAQPage structured data. */
export interface ErrorPageFaqItem {
  q: string;
  a: string;
}

/** One day of the occurrence sparkline shown on the public page. */
export interface ErrorPageTrendPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * Aggregate, non-identifying stats snapshot for the cluster. Pushed from the
 * Peacock CMS and refreshed on its hourly rollup. `tenants` is the k-anonymity
 * signal — a page is never published below MIN_TENANTS_FOR_PUBLIC distinct teams.
 */
export interface ErrorPageStats {
  tenants: number;
  volume_7d: number;
  volume_30d: number;
  recovery_rate: number | null; // 0..1 — share auto-recovered by a Manifest fallback
  last_seen: string | null; // ISO timestamp
  trend: ErrorPageTrendPoint[];
  variants?: string[]; // distinct message wordings for the same cluster ("Also seen as")
}

export interface ErrorPageRelatedLink {
  slug: string;
  title: string;
}

/**
 * A published, operator-approved error-cluster page served to the public
 * marketing site. This table is a READ-OPTIMISED MIRROR: it only ever holds
 * rows that an operator explicitly published from the Peacock CMS (pushed via
 * the secret-guarded internal endpoint). There is no code path from raw
 * `agent_messages` to this table — that is the trust boundary that keeps
 * un-curated error data private.
 */
@Entity('public_error_pages')
export class PublicErrorPage {
  @PrimaryColumn('varchar')
  slug!: string;

  @Column('varchar')
  cluster_key!: string;

  @Column('varchar')
  provider!: string;

  @Column('varchar', { default: '' })
  provider_label!: string;

  @Column('integer', { nullable: true })
  http_status!: number | null;

  @Column('varchar', { default: 'unknown' })
  category!: string;

  @Column('varchar', { default: '' })
  category_label!: string;

  @Column('varchar')
  title!: string;

  @Column('varchar')
  meta_description!: string;

  @Column('varchar')
  h1!: string;

  @Column('text', { default: '' })
  body_what!: string;

  @Column('text', { default: '' })
  body_fix!: string;

  @Column('text', { default: '' })
  body_manifest!: string;

  @Column('text', { default: '' })
  sample_message!: string;

  @Column('jsonb')
  faq!: ErrorPageFaqItem[];

  @Column('jsonb')
  stats!: ErrorPageStats;

  @Column('jsonb')
  related!: ErrorPageRelatedLink[];

  @Column('boolean', { default: false })
  noindex!: boolean;

  @Column(timestampType())
  published_at!: string;

  @Column(timestampType())
  updated_at!: string;
}
