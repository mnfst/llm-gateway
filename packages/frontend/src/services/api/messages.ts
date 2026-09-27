import { fetchJson, fetchMutate, type FetchJsonOptions } from './core.js';
import type { AutofixStatus } from 'manifest-shared';

/** A deterministic edit Phoenix applied to heal a request. */
export interface AutofixOperation {
  type: string;
  from?: string;
  to?: string;
}

export interface AutofixDecision {
  status: string | null;
  issueId: string | null;
  patchId: string | null;
  healAttemptId: string | null;
  /** Phoenix's human-readable "why" for the fix (null for pre-explanation rows). */
  explanation?: {
    summary: string;
    operations: Array<{ type: string; detail: string }>;
    source: string;
  } | null;
}

export interface AttemptRecording {
  request_body: Record<string, unknown>;
  response_body: {
    type: 'json' | 'stream';
    body?: unknown;
    raw_sse?: string;
  } | null;
  wire_format: string;
}

export interface MessageDetailResponse {
  message: {
    id: string;
    timestamp: string;
    agent_name: string | null;
    model: string | null;
    status: string;
    autofix_status: AutofixStatus | null;
    error_message: string | null;
    /** Documented Manifest error code ('M100', 'M300', …). Null for provider failures. */
    error_code: string | null;
    /** WHO caused a failure: provider | transport | config | policy | internal | request. Null on success. */
    error_origin: string | null;
    /** WHAT kind of failure (rate_limit, auth, billing, no_provider_key, timeout, …). Null on success. */
    error_class: string | null;
    /** HTTP status code of the error response. Null on success. */
    error_http_status: number | null;
    /** True when this row is a recovered (retried / fell-back-away-from) attempt, not the outcome. */
    superseded: boolean;
    description: string | null;
    service_type: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number | null;
    duration_ms: number | null;
    trace_id: string | null;
    routing_tier: string | null;
    routing_reason: string | null;
    specificity_category: string | null;
    specificity_miscategorized: boolean;
    auth_type: string | null;
    /** Provider-key label that handled the request, when the user has 2+
     *  keys configured for (provider, auth_type). `null` (or `'Default'` in
     *  the legacy single-key case) means the priority-0 key was used. */
    provider_key_label: string | null;
    skill_name: string | null;
    fallback_from_model: string | null;
    fallback_index: number | null;
    session_key: string | null;
    feedback_rating: string | null;
    feedback_tags: string[] | null;
    feedback_details: string | null;
    request_headers: Record<string, string> | null;
    request_params: { [key: string]: unknown } | null;
    header_tier_id: string | null;
    header_tier_name: string | null;
    header_tier_color: string | null;
    caller_attribution: {
      sdk?: string;
      sdkVersion?: string;
      runtime?: string;
      runtimeVersion?: string;
      os?: string;
      arch?: string;
      userAgent?: string;
      appName?: string;
      appUrl?: string;
      categories?: string[];
    } | null;
    autofix_applied: boolean;
    autofix_role: string | null;
    autofix_operations: AutofixOperation[] | null;
    /** Phoenix's decision behind this provider attempt. */
    autofix_decision: AutofixDecision | null;
    /** The paired row (failed original ↔ successful retry), for the visual link. */
    autofix_sibling: { id: string; role: string | null; status: string } | null;
    attempts?: Array<{
      id: string;
      model: string | null;
      provider: string | null;
      status: string;
      auth_type: string | null;
      error_message: string | null;
      error_origin: string | null;
      error_class: string | null;
      error_http_status: number | null;
      duration_ms: number | null;
      cost_usd: number | null;
      input_tokens: number;
      output_tokens: number;
      fallback_from_model: string | null;
      fallback_index: number | null;
      request_headers: Record<string, string> | null;
      request_params: Record<string, unknown> | null;
      autofix_applied: boolean;
      autofix_role: string | null;
      autofix_operations: AutofixOperation[] | null;
      autofix_decision: AutofixDecision | null;
      /** Exact provider-facing payload for this Provider Attempt. */
      recording: AttemptRecording | null;
    }>;
  };
}

export interface MessageListParams extends Record<string, string | undefined> {
  range?: string;
  provider?: string;
  /** Comma-separated tenant_providers ids (connection filter). */
  connections?: string;
  /** Comma-separated attempt-status facets: has_failed, has_succeeded. */
  attempts?: string;
  /** Comma-separated model names (model filter). */
  model?: string;
  service_type?: string;
  cursor?: string;
  limit?: string;
  agent_name?: string;
  cost_min?: string;
  cost_max?: string;
  status?: string;
  trigger?: string;
  routing_tier?: string;
  specificity_category?: string;
  header_tier_id?: string;
  include_total?: string;
  cache_total?: string;
  include_filter_options?: string;
}

export function getMessages(params: MessageListParams = {}, options?: FetchJsonOptions) {
  return fetchJson('/messages', params, options);
}

export function getMessageCount(
  params: Omit<
    MessageListParams,
    'cursor' | 'limit' | 'include_total' | 'cache_total' | 'include_filter_options'
  > = {},
) {
  return fetchJson('/messages', {
    ...params,
    limit: '1',
    include_total: 'true',
    cache_total: 'true',
    include_filter_options: 'false',
  });
}

export function getMessageFilterOptions(
  params: {
    range?: string;
    agent_name?: string;
  } = {},
) {
  return fetchJson('/messages/filter-options', params);
}

export function getMessageDetails(id: string) {
  return fetchJson<MessageDetailResponse>(`/messages/${encodeURIComponent(id)}/details`);
}

export function setMessageFeedback(
  id: string,
  body: { rating: 'like' | 'dislike'; tags?: string[]; details?: string },
) {
  return fetchMutate<void>(`/messages/${encodeURIComponent(id)}/feedback`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function clearMessageFeedback(id: string) {
  return fetchMutate<void>(`/messages/${encodeURIComponent(id)}/feedback`, {
    method: 'DELETE',
  });
}

export function flagMessageMiscategorized(id: string) {
  return fetchMutate<void>(`/messages/${encodeURIComponent(id)}/miscategorized`, {
    method: 'PATCH',
  });
}

export function clearMessageMiscategorized(id: string) {
  return fetchMutate<void>(`/messages/${encodeURIComponent(id)}/miscategorized`, {
    method: 'DELETE',
  });
}
