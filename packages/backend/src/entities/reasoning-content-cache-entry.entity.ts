import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

/**
 * Short-lived shared cache for OpenAI-compatible reasoning traces that must be
 * replayed on follow-up turns.
 */
@Entity('reasoning_content_cache')
@Index(['expires_at'])
export class ReasoningContentCacheEntry {
  @PrimaryColumn('varchar')
  session_key!: string;

  @PrimaryColumn('varchar')
  first_tool_call_id!: string;

  @Column('text')
  content!: string;

  @Column(timestampType())
  expires_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;
}
