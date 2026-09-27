import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ALL_TIERS,
  ERROR_CLASSES,
  ERROR_ORIGINS,
  SPECIFICITY_CATEGORIES,
  type ErrorClass,
  type MessageTier,
  type SpecificityCategory,
} from 'manifest-shared';

// `success` / `failed` are the canonical filter values; `ok` and the specific
// legacy error values (`error` / `rate_limited` / `fallback_error`) plus `errors`
// stay accepted so links and saved filters minted before the status normalization
// keep working. The query service maps them onto the canonical vocabulary.
export const MESSAGE_STATUS_FILTER_VALUES = [
  'success',
  'ok',
  'failed',
  // The caller hung up: neither Manifest nor the provider failed, so it is its
  // own outcome rather than a flavour of `failed`.
  'cancelled',
  'error',
  'rate_limited',
  'fallback_error',
  'errors',
] as const;
export type MessageStatusFilter = (typeof MESSAGE_STATUS_FILTER_VALUES)[number];

export const MESSAGE_TRIGGER_FILTER_VALUES = ['none', 'fallback', 'autofix'] as const;
export type MessageTriggerFilter = (typeof MESSAGE_TRIGGER_FILTER_VALUES)[number];

/**
 * Error-origin filter for the Messages log. The real origins plus a `manifest`
 * shorthand for "all of config/policy/internal" (the HTTP-200 Manifest stubs
 * that are hidden from the log by default).
 */
export const MESSAGE_ORIGIN_FILTER_VALUES = [...ERROR_ORIGINS, 'manifest'] as const;
export type MessageOriginFilter = (typeof MESSAGE_ORIGIN_FILTER_VALUES)[number];

export class MessagesQueryDto {
  @IsOptional()
  @IsString()
  range?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  /**
   * Comma-separated tenant_providers ids. Filters the log to requests that
   * touched at least one of these provider connections (legacy attempts with
   * no stamped connection fold onto the Default-label connection, matching
   * the dashboard's connection scoping).
   */
  @IsOptional()
  @IsString()
  connections?: string;

  /**
   * Comma-separated model names. A request matches when any of its provider
   * attempts ran on one of these models — the same "any attempt" semantics the
   * provider filter uses, so filtering by the primary of a fallback chain still
   * surfaces the request it was recovered on. A request that never reached a
   * provider is matched on `requests.requested_model` instead, which is what
   * the Model column renders for those rows.
   */
  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  service_type?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  cost_min?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999999)
  @Type(() => Number)
  cost_max?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  agent_name?: string;

  @IsOptional()
  @IsIn(MESSAGE_STATUS_FILTER_VALUES, {
    message: `status must be one of: ${MESSAGE_STATUS_FILTER_VALUES.join(', ')}`,
  })
  status?: MessageStatusFilter;

  /**
   * Attempt-status facet, AND semantics: `has_failed` keeps requests holding
   * at least one failed attempt, `has_succeeded` at least one succeeded
   * attempt; both together require both. Scoped to `connections` when set.
   */
  @IsOptional()
  @Matches(/^(has_failed|has_succeeded)(,(has_failed|has_succeeded))*$/, {
    message: 'attempts must be a comma-separated list of: has_failed, has_succeeded',
  })
  attempts?: string;

  /** One or several (comma-separated) of: none, fallback, autofix. */
  @IsOptional()
  @Matches(/^(none|fallback|autofix)(,(none|fallback|autofix))*$/, {
    message: `trigger must be a comma-separated list of: ${MESSAGE_TRIGGER_FILTER_VALUES.join(', ')}`,
  })
  trigger?: string;

  @IsOptional()
  @IsIn(MESSAGE_ORIGIN_FILTER_VALUES, {
    message: `origin must be one of: ${MESSAGE_ORIGIN_FILTER_VALUES.join(', ')}`,
  })
  origin?: MessageOriginFilter;

  @IsOptional()
  @IsIn(ERROR_CLASSES, {
    message: `error_class must be one of: ${ERROR_CLASSES.join(', ')}`,
  })
  error_class?: ErrorClass;

  @IsOptional()
  @IsIn(ALL_TIERS, {
    message: `routing_tier must be one of: ${ALL_TIERS.join(', ')}`,
  })
  routing_tier?: MessageTier;

  @IsOptional()
  @IsIn(SPECIFICITY_CATEGORIES, {
    message: `specificity_category must be one of: ${SPECIFICITY_CATEGORIES.join(', ')}`,
  })
  specificity_category?: SpecificityCategory;

  @IsOptional()
  @IsString()
  header_tier_id?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  include_total?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  cache_total?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  include_filter_options?: boolean;
}
