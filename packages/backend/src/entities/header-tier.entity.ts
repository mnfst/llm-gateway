import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';
import type { ModelRoute, ResponseMode, OutputModality, TierColor } from 'manifest-shared';

@Entity('header_tiers')
@Index(['agent_id', 'sort_order'])
// The unique (agent_id, LOWER(name)) index is declared in the migration so it
// can be case-insensitive. Don't re-declare it here with a case-sensitive
// collation — schema sync would drop the migration's index in dev.
export class HeaderTier {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  tenant_id!: string;

  @Column('varchar')
  agent_id!: string;

  @Column('varchar')
  name!: string;

  @Column('varchar')
  header_key!: string;

  @Column('varchar')
  header_value!: string;

  @Column('varchar')
  badge_color!: TierColor;

  @Column('integer', { default: 0 })
  sort_order!: number;

  @Column('boolean', { default: true })
  enabled!: boolean;

  // Header tiers don't have an auto-assigned slot — always user-configured.
  @Column('jsonb', { nullable: true })
  override_route!: ModelRoute | null;

  @Column('jsonb', { nullable: true })
  fallback_routes!: ModelRoute[] | null;

  @Column('varchar', { default: 'text' })
  output_modality!: OutputModality;

  @Column('varchar', { default: 'buffered' })
  response_mode!: ResponseMode;

  /** Per-tier stream warmup override (ms). null => provider/global default applies. */
  @Column('integer', { nullable: true })
  stream_warmup_ms!: number | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}
