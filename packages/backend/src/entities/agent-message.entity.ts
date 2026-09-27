import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType } from '../common/utils/postgres-sql';
import type { CallerAttribution } from '../routing/proxy/caller-classifier';

@Entity('agent_messages')
@Index(['tenant_id', 'agent_id', 'timestamp'])
// No index on `user_id`: it is deprecated attribution-only metadata, never
// scoped or filtered on (see query-helpers.ts). Its index cost 715 MB and was
// dropped in migration 1800300000000.
@Index(['tenant_id', 'agent_name', 'timestamp'])
@Index(['tenant_id', 'timestamp'])
@Index(['tenant_id', 'trace_id'])
@Index(['tenant_id', 'model'])
@Index(['tenant_id', 'agent_id', 'status'])
// Originally (tenant_id, agent_id, model, status, timestamp) for the
// per-completion success dedup, which is gone. The per-agent "cost by model"
// read (agent-analytics.service.ts) only needs the leading three columns, so
// the trailing status/timestamp were dropped in 1802000000000.
@Index(['tenant_id', 'agent_id', 'model'])
// Per-connection analytics scope by the exact key that served each message
// (tenant_provider_id) ordered by recency, and the FK below resolves its
// ON DELETE SET NULL against the same column. tenant_provider_id leads so one
// index serves both the connection-detail reads and the parent-delete cleanup.
@Index(['tenant_provider_id', 'tenant_id', 'timestamp'])
// Resolve the sibling row (failed original ↔ successful retry) of a healed
// request by shared group id within the tenant.
@Index(['tenant_id', 'autofix_group_id'])
export class AgentMessage {
  @PrimaryColumn('varchar')
  id!: string;

  /** Parent caller request. NULL only while the historical backfill is running. */
  @Column('varchar', { nullable: true })
  request_id!: string | null;

  /**
   * Positive route-attempt order within the parent Request. NULL only for legacy
   * rows that have not been assigned an unambiguous order.
   */
  @Column('integer', { nullable: true })
  attempt_number!: number | null;

  /** External S3/filesystem object for this Provider Attempt's exact payload. */
  @Column('varchar', { nullable: true })
  recording_key!: string | null;

  @Column('varchar', { nullable: true })
  tenant_id!: string | null;

  @Column('varchar', { nullable: true })
  agent_id!: string | null;

  @Column('varchar', { nullable: true })
  trace_id!: string | null;

  @Column('varchar', { nullable: true })
  session_key!: string | null;

  @Column('varchar', { nullable: true })
  session_id!: string | null;

  @Column(timestampType())
  timestamp!: string;

  @Column('integer', { nullable: true })
  duration_ms!: number | null;

  @Column('integer', { default: 0 })
  input_tokens!: number;

  @Column('integer', { default: 0 })
  output_tokens!: number;

  @Column('integer', { default: 0 })
  cache_read_tokens!: number;

  @Column('integer', { default: 0 })
  cache_creation_tokens!: number;

  @Column('decimal', { precision: 10, scale: 6, nullable: true })
  cost_usd!: number | null;

  @Column('varchar', { default: 'pending' })
  status!: string;

  /** Set after this completed Provider Attempt has been added to agent_usage_daily. */
  @Column(timestampType(), { nullable: true })
  agent_usage_rolled_up_at?: string | null;

  @Column('varchar', { nullable: true })
  error_message!: string | null;

  @Column('integer', { nullable: true })
  error_http_status!: number | null;

  /**
   * The documented Manifest error code behind this row ('M100', 'M300', …),
   * NULL for provider/transport failures and successes. Lets the dashboard deep
   * link to https://manifest.build/llm-gateway/docs/errors/<code>. The catalogue lives in
   * common/errors/error-codes.ts.
   */
  @Column('varchar', { length: 8, nullable: true })
  error_code!: string | null;

  /**
   * WHO caused a failed row: 'provider' | 'transport' | 'config' | 'policy' |
   * 'internal' | 'request'. NULL on successful rows. Separates a provider's own
   * error (a reliability event) from Manifest's own config/policy/internal
   * rejections and the caller's malformed requests (`request`) — none of which
   * are provider failures. Derived by classifyMessageError() in manifest-shared,
   * the single source of truth shared with the backfill migration.
   */
  @Column('varchar', { nullable: true })
  error_origin!: string | null;

  /**
   * WHAT kind of failure it was (normalized): 'rate_limit' | 'auth' |
   * 'invalid_request' | 'billing' | 'server_error' | 'timeout' | 'network' |
   * 'no_provider' | 'no_provider_key' | 'local_provider_unavailable' |
   * 'limit_exceeded' | 'plan_request_limit_exceeded' | 'internal' | … A rate
   * limit is a *class*
   * of error here, not a top-level status. NULL on success.
   */
  @Column('varchar', { nullable: true })
  error_class!: string | null;

  @Column('varchar', { nullable: true })
  description!: string | null;

  @Column('varchar', { nullable: true })
  service_type!: string | null;

  @Column('varchar', { nullable: true })
  agent_name!: string | null;

  @Column('varchar', { nullable: true })
  model!: string | null;

  @Column('varchar', { nullable: true })
  provider!: string | null;

  @Column('varchar', { nullable: true })
  routing_tier!: string | null;

  @Column('varchar', { nullable: true })
  routing_reason!: string | null;

  @Column('varchar', { nullable: true })
  skill_name!: string | null;

  @Column('varchar', { nullable: true })
  auth_type!: string | null;

  @Column('varchar', { nullable: true })
  fallback_from_model!: string | null;

  @Column('integer', { nullable: true })
  fallback_index!: number | null;

  /**
   * True when this row is a superseded attempt — one that failed but was
   * recovered by a later attempt (retry / fallback). It is the failed hop, not
   * the request's terminal outcome, so it must never count as a message. Splits
   * the "was this handled?" axis out of the legacy `status = 'fallback_error'`
   * value (which is still written this phase for back-compat).
   */
  @Column('boolean', { default: false })
  superseded!: boolean;

  /**
   * DEPRECATED — informational attribution only, written by the proxy
   * recorder. Never filter, scope, key, or authorize by this column; all
   * scoping goes through `tenant_id`. Kept because agent_messages is the
   * big hot table and a column drop isn't worth the rewrite.
   */
  @Column('varchar', { nullable: true })
  user_id!: string | null;

  @Column('varchar', { nullable: true })
  specificity_category!: string | null;

  @Column('boolean', { default: false })
  specificity_miscategorized!: boolean;

  @Column('simple-json', { nullable: true })
  caller_attribution!: CallerAttribution | null;

  @Column('simple-json', { nullable: true })
  request_headers!: Record<string, string> | null;

  @Column('jsonb', { nullable: true })
  request_params!: object | null;

  @Column('varchar', { nullable: true })
  header_tier_id!: string | null;

  @Column('varchar', { nullable: true })
  header_tier_name!: string | null;

  @Column('varchar', { nullable: true })
  header_tier_color!: string | null;

  @Column('varchar', { nullable: true })
  feedback_rating!: string | null;

  @Column('varchar', { nullable: true })
  feedback_tags!: string | null;

  @Column('text', { nullable: true })
  feedback_details!: string | null;

  @Column('varchar', { nullable: true })
  provider_key_label!: string | null;

  // The exact tenant_providers row (connection/key) that served this message.
  // Stamped at proxy time from the selected CachedProviderKey.id so per-connection
  // analytics filter on identity rather than the (provider, auth_type, label)
  // tuple — which is not unique per key (default label 'Default'; NULL coerces to
  // it). NULL for pre-upgrade history, local/Ollama, and blind-proxy paths.
  @Column('varchar', { nullable: true })
  tenant_provider_id!: string | null;

  // Autofix (self-healing) audit. A healed request is recorded as TWO rows:
  // the failed original (status='auto_fixed') and the successful retry
  // (status='ok'), both sharing `autofix_group_id`. `autofix_role` distinguishes
  // them; `autofix_operations` holds the Phoenix edits that fixed it.
  @Column('boolean', { default: false })
  autofix_applied!: boolean;

  // Links the failed original row and the successful retry row of one healed
  // request (same value on both). NULL for non-autofix rows.
  @Column('varchar', { nullable: true })
  autofix_group_id!: string | null;

  // 'original' (the failed request that was autofixed) or 'retry' (the
  // successful re-send). NULL for non-autofix rows.
  @Column('varchar', { nullable: true })
  autofix_role!: string | null;

  // The deterministic edits Phoenix applied to heal the request (e.g.
  // rename_param max_tokens -> max_output_tokens). Typed `object` (like
  // request_params) so TypeORM's deep-partial insert type stays simple.
  @Column('jsonb', { nullable: true })
  autofix_operations!: object | null;

  // Phoenix's decision behind this attempt ({ status, issueId, patchId,
  // healAttemptId, explanation }). Keep the physical legacy column name so
  // replicas from the previous release can keep writing during a rolling deploy.
  @Column('jsonb', { name: 'autofix_phoenix', nullable: true })
  autofix_decision!: object | null;
}
