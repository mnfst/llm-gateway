import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { timestampDefault, timestampType } from '../common/utils/postgres-sql';

/**
 * Short-lived feed of routing-cache invalidations, shared by every backend
 * process. Routing config is cached in each process's memory, so a write
 * served by one Cloud Run instance used to leave the others on their cached
 * copy until it expired (up to two minutes). Each instance appends the
 * invalidations it performs here and polls for the others'; see
 * RoutingCacheSyncService. Rows are pruned after a few minutes.
 */
@Entity('cache_invalidations')
export class CacheInvalidation {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  /** `agent` (target_id is an agent id) or `tenant` (target_id is a tenant id). */
  @Column('varchar', { length: 16 })
  scope!: string;

  @Column('varchar')
  target_id!: string;

  @Index('IDX_cache_invalidations_created_at')
  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
