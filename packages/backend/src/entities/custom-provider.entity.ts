import { Entity, Column, PrimaryColumn } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

export interface CustomProviderModel {
  model_name: string;
  input_price_per_million_tokens?: number;
  output_price_per_million_tokens?: number;
  context_window?: number;
  price_estimated?: boolean;
}

export type CustomProviderApiKind = 'openai' | 'anthropic';

// Uniqueness is owned by the migration as a case-insensitive index on
// (tenant_id, LOWER(name)) — which a column-list @Index can't express. Declaring a
// case-sensitive @Index here would drift from the real schema (synchronize ≠
// migrations), so it's intentionally omitted (same pattern as tenant_providers).
@Entity('custom_providers')
export class CustomProvider {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  tenant_id!: string;

  /** Audit-only: which user created the provider. Never used for scoping. */
  @Column('varchar', { nullable: true })
  created_by_user_id!: string | null;

  @Column('varchar')
  name!: string;

  /**
   * Public prefix of this provider's model ids in `/v1/models`
   * (`<alias>/<model_name>`). Null means the models publish under the
   * internal `custom:<uuid>/<model_name>` key. Uniqueness is a
   * case-insensitive partial index on (tenant_id, LOWER(alias)) owned by
   * the migration, same as `name`.
   */
  @Column('varchar', { nullable: true })
  alias!: string | null;

  @Column('varchar')
  base_url!: string;

  @Column('varchar', { default: 'openai' })
  api_kind!: CustomProviderApiKind;

  @Column('simple-json')
  models!: CustomProviderModel[];

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
