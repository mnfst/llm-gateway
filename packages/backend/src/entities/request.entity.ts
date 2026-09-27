import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { timestampType } from '../common/utils/postgres-sql';
import type { CallerAttribution } from '../routing/proxy/caller-classifier';
import type { ProxyApiMode } from '../routing/proxy/proxy-types';
import type { AutofixStatus } from 'manifest-shared';

/**
 * One request made by a caller to Manifest.
 *
 * Provider work belongs in agent_messages. A row with no attempts is valid:
 * Manifest may reject a request before choosing or contacting a provider.
 */
@Entity('requests')
@Index(['tenant_id', 'agent_id', 'timestamp'])
@Index(['tenant_id', 'timestamp'])
@Index(['tenant_id', 'trace_id'])
@Index(['tenant_id', 'status', 'timestamp'])
export class ManifestRequest {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar', { nullable: true })
  tenant_id!: string | null;

  @Column('varchar', { nullable: true })
  agent_id!: string | null;

  /** Deprecated attribution metadata; tenant_id remains the scope boundary. */
  @Column('varchar', { nullable: true })
  user_id!: string | null;

  @Column('varchar', { nullable: true })
  agent_name!: string | null;

  @Column('varchar', { nullable: true })
  trace_id!: string | null;

  @Column('varchar', { nullable: true })
  session_key!: string | null;

  @Column('varchar', { nullable: true })
  session_id!: string | null;

  @Column(timestampType())
  timestamp!: string;

  /** End-to-end latency experienced by the caller. */
  @Column('integer', { nullable: true })
  duration_ms!: number | null;

  /** The terminal outcome experienced by the caller. */
  @Column('varchar')
  status!: string;

  /** Set after this completed Request has been added to agent_usage_daily. */
  @Column(timestampType(), { nullable: true })
  agent_usage_rolled_up_at?: string | null;

  /** How Autofix ended for this request. NULL means it was not recorded. */
  @Column('varchar', { nullable: true })
  autofix_status!: AutofixStatus | null;

  @Column('varchar', { nullable: true })
  error_message!: string | null;

  @Column('integer', { nullable: true })
  error_http_status!: number | null;

  @Column('varchar', { length: 8, nullable: true })
  error_code!: string | null;

  @Column('varchar', { nullable: true })
  error_origin!: string | null;

  @Column('varchar', { nullable: true })
  error_class!: string | null;

  /** Model requested by the caller, before routing and fallbacks. */
  @Column('varchar', { nullable: true })
  requested_model!: string | null;

  /**
   * Which Manifest API surface the caller used: 'chat_completions'
   * (/v1/chat/completions), 'responses' (/v1/responses), or 'messages'
   * (/v1/messages). NULL when the surface was not known at write time.
   */
  @Column('varchar', { nullable: true })
  api_mode!: ProxyApiMode | null;

  @Column('simple-json', { nullable: true })
  caller_attribution!: CallerAttribution | null;

  @Column('simple-json', { nullable: true })
  request_headers!: Record<string, string> | null;

  @Column('jsonb', { nullable: true })
  request_params!: object | null;

  @Column('varchar', { nullable: true })
  feedback_rating!: string | null;

  @Column('varchar', { nullable: true })
  feedback_tags!: string | null;

  @Column('text', { nullable: true })
  feedback_details!: string | null;
}
