import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

@Entity('api_keys')
export class ApiKey {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar', { nullable: true })
  key!: string | null;

  @Index({ unique: true })
  @Column('varchar', { length: 128 })
  key_hash!: string;

  @Column('varchar', { length: 12 })
  key_prefix!: string;

  @Index()
  @Column('varchar')
  tenant_id!: string;

  /** Audit-only: which user created the key. Never used for scoping. */
  @Column('varchar', { nullable: true })
  created_by_user_id!: string | null;

  @Column('varchar')
  name!: string;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { nullable: true, default: null })
  last_used_at!: string | null;

  /** NULL = non-expiring (dashboard/CI keys). CLI-minted PATs slide on use. */
  @Column(timestampType(), { nullable: true, default: null })
  expires_at!: string | null;

  /**
   * Hard ceiling for CLI PATs: the sliding renewal on each request never pushes
   * `expires_at` past this instant, so a token in constant use still dies at
   * the absolute cap. NULL = no cap (dashboard/CI keys).
   */
  @Column(timestampType(), { nullable: true, default: null })
  absolute_expires_at!: string | null;
}
