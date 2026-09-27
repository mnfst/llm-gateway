import { fetchJson } from './core.js';

export type PivotedTimeseries = Promise<{
  agents: string[];
  timeseries: Array<Record<string, number | string>>;
}>;

export type UsageTimeseries = Promise<{
  tokenUsage: Awaited<PivotedTimeseries>;
  messageUsage: Awaited<PivotedTimeseries>;
  costUsage: Awaited<PivotedTimeseries>;
}>;

export function getProviderAnalytics(
  authType: string,
  range = '24h',
  agentName?: string,
  provider?: string,
  label?: string,
  // The exact connection (tenant_providers id). When set, the backend scopes the
  // summary cards + chart to this key instead of the provider/auth/label tuple.
  connectionId?: string,
) {
  return fetchJson('/provider-analytics', {
    auth_type: authType,
    range,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(provider ? { provider } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  });
}

export function getProviderAnalyticsAgents(authType: string): Promise<{ agents: string[] }> {
  return fetchJson('/provider-analytics/agents', { auth_type: authType }) as Promise<{
    agents: string[];
  }>;
}

export function getPerAgentTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): PivotedTimeseries {
  return fetchJson('/provider-analytics/per-agent-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as PivotedTimeseries;
}

/**
 * Attempt-status timeseries for ONE connection: every provider call counts
 * where it ran, keyed by its own outcome (success / error). The Attempts
 * chart's default view on ConnectionDetail.
 */
export function getConnectionAttemptStatusTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): Promise<AutofixTimeseries> {
  return fetchJson('/provider-analytics/attempt-status-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as Promise<AutofixTimeseries>;
}

/** Attempts by HTTP status over time for ONE connection. */
export function getConnectionAttemptHttpStatusTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): Promise<AutofixTimeseries> {
  return fetchJson('/provider-analytics/attempt-http-status-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as Promise<AutofixTimeseries>;
}

export interface ConnectionAttemptBreakdown {
  attempts: number;
  succeeded: number;
  failed: number;
  fallback_retries: number;
  fallback_retries_succeeded: number;
  autofix_attempts: number;
  autofix_attempts_succeeded: number;
}

/** Header-card breakdown for ONE connection (totals + retry families). */
export function getConnectionAttemptBreakdown(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): Promise<ConnectionAttemptBreakdown> {
  return fetchJson('/provider-analytics/attempt-breakdown', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as Promise<ConnectionAttemptBreakdown>;
}

/** Attempts per harness over time for ONE connection (By harness view). */
export function getConnectionAttemptsByAgentTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): Promise<{ agents: string[]; timeseries: Array<Record<string, number | string>> }> {
  return fetchJson('/provider-analytics/attempts-by-agent-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as Promise<{ agents: string[]; timeseries: Array<Record<string, number | string>> }>;
}

export function getPerAgentMessageTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): PivotedTimeseries {
  return fetchJson('/provider-analytics/per-agent-message-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as PivotedTimeseries;
}

export function getPerAgentCostTimeseries(
  authType: string,
  provider: string,
  range = '24h',
  label?: string,
  connectionId?: string,
): PivotedTimeseries {
  return fetchJson('/provider-analytics/per-agent-cost-timeseries', {
    auth_type: authType,
    provider,
    range,
    ...(label !== undefined ? { label } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }) as PivotedTimeseries;
}

export function getConnectionDetail(connectionId: string) {
  return fetchJson('/provider-analytics/connection-detail', { connection_id: connectionId });
}

export function getGlobalPerAgentTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-agent-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerAgentMessageTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-agent-message-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerAgentCostTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-agent-cost-timeseries', { range }) as PivotedTimeseries;
}

export function getOverviewAgentUsage(range = '24h'): UsageTimeseries {
  return fetchJson('/overview/agents/usage', { range }) as UsageTimeseries;
}

export function getGlobalPerProviderTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-provider-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerProviderMessageTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-provider-message-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerProviderCostTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-provider-cost-timeseries', { range }) as PivotedTimeseries;
}

export function getOverviewProviderUsage(range = '24h'): UsageTimeseries {
  return fetchJson('/overview/providers/usage', { range }) as UsageTimeseries;
}

export function getGlobalPerModelTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-model-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerModelMessageTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-model-message-timeseries', { range }) as PivotedTimeseries;
}

export function getGlobalPerModelCostTimeseries(range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-model-cost-timeseries', { range }) as PivotedTimeseries;
}

export function getPerProviderTimeseries(agentName: string, range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-provider-timeseries', {
    agent_name: agentName,
    range,
  }) as PivotedTimeseries;
}

export function getPerProviderMessageTimeseries(
  agentName: string,
  range = '24h',
): PivotedTimeseries {
  return fetchJson('/overview/per-provider-message-timeseries', {
    agent_name: agentName,
    range,
  }) as PivotedTimeseries;
}

export function getPerProviderCostTimeseries(agentName: string, range = '24h'): PivotedTimeseries {
  return fetchJson('/overview/per-provider-cost-timeseries', {
    agent_name: agentName,
    range,
  }) as PivotedTimeseries;
}

export function getOverview(range = '24h', agentName?: string, fast = false) {
  return fetchJson('/overview', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(fast ? { fast: 'true' } : {}),
  });
}

export function getOverviewDetails(range = '24h', agentName?: string) {
  return fetchJson('/overview/details', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  });
}

export interface AttemptMetric {
  value: number;
  previous: number;
}

export interface AttemptStats {
  /** Completed, non-Playground rows in the scoped `agent_messages` window. */
  total_attempts: AttemptMetric;
  /** Attempts whose `fallback_from_model` is non-null. */
  fallbacked_attempts: AttemptMetric;
}

export interface AttemptTimeseries {
  range: string;
  by: 'metric';
  keys: string[];
  buckets: Array<{ bucket: string; counts: number[] }>;
}

// ---------------------------------------------------------------------------
// Autofix analytics
// ---------------------------------------------------------------------------

export interface AutofixStatus {
  any_enabled: boolean;
  enabled_agents: string[];
  /** Agents effectively running without Autofix after deployment-mode defaults. */
  disabled_agents: string[];
  /** True only when legacy/unconfigured agents need the fleet enable action. */
  needs_enable_all: boolean;
  /** Self-hosted consent-once; cloud always true. */
  consented: boolean;
}

export interface AutofixStats {
  success_rate: { value: number; previous: number };
  autofix_saves: { value: number; previous: number };
  /** Requests recovered by a successful fallback attempt (additive field). */
  fallback_saves: { value: number; previous: number };
  /** Window total — denominator for the self-healed share (additive field). */
  total_requests: { value: number; previous: number };
  errors_remaining: { value: number; previous: number };
  coverage: { rate: number; previous_rate: number };
  dispositions: {
    healed: number;
    no_fix_found: number;
    resolving: number;
    ineffective: number;
  };
  needs_attention: Array<{
    error_message: string;
    provider: string;
    model: string;
    count: number;
    phoenix_issue_id: string | null;
  }>;
}

export interface AutofixTimeseries {
  range: string;
  by: string;
  keys: string[];
  buckets: Array<{ bucket: string; counts: number[] }>;
}

export function getAttemptStats(range = '7d', agentName?: string): Promise<AttemptStats> {
  return fetchJson('/overview/attempt-stats', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<AttemptStats>;
}

export function getAttemptTimeseries(range = '7d', agentName?: string): Promise<AttemptTimeseries> {
  return fetchJson('/overview/attempt-timeseries', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<AttemptTimeseries>;
}

export function getWorkspaceAutofixStatus(): Promise<AutofixStatus> {
  return fetchJson('/autofix/status') as Promise<AutofixStatus>;
}

export function getAutofixStats(range = '7d', agentName?: string): Promise<AutofixStats> {
  return fetchJson('/overview/autofix-stats', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<AutofixStats>;
}

export function getAutofixTimeseries(
  range = '7d',
  by = 'disposition',
  agentName?: string,
  failedOnly?: boolean,
): Promise<AutofixTimeseries> {
  return fetchJson('/overview/autofix-timeseries', {
    range,
    by,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(failedOnly ? { failed_only: 'true' } : {}),
  }) as Promise<AutofixTimeseries>;
}

/**
 * Attempt-world reliability for a provider: every provider call counts where
 * it ran (retries and fallback attempts included), by its own outcome.
 */
export interface ProviderReliabilityRow {
  provider: string;
  /** Folded auth type (NULL reads api_key): half of the connection identity. */
  auth_type: string;
  /** Folded key label (NULL reads Default): the other half. */
  key_label: string;
  attempts: number;
  failed: number;
  succeeded: number;
}

/** One-line definition surfaced by the ⓘ tooltips next to "Recovered requests". */
export const RECOVERED_REQUESTS_TOOLTIP =
  'Successful requests that were recovered by Autofix or fallback.';

/** Self-healed = recovered by Autofix + recovered by fallback. */
export function selfHealedCount(row: { autofixed: number; fallback_saves?: number }): number {
  return row.autofixed + (row.fallback_saves ?? 0);
}

/** Request success rate over the row's window; null when there is no traffic. */
export function successRate(row: { requests: number; succeeded?: number }): number | null {
  if (!row.requests || row.succeeded == null) return null;
  return row.succeeded / row.requests;
}

/** Attempt success rate: successful attempts over all attempts; null when idle. */
export function attemptSuccessRate(row: { attempts: number; succeeded?: number }): number | null {
  if (!row.attempts || row.succeeded == null) return null;
  return row.succeeded / row.attempts;
}

/**
 * Total attempts ⓘ: the Doctor version (Autofix) owns the autofixed
 * vocabulary, so tenants without it get the same sentence minus Autofix.
 * House vocabulary: a FALLBACK is a retry; an AUTOFIX produces an attempt.
 */
export function totalAttemptsTooltip(doctorAvailable: boolean): string {
  return doctorAvailable
    ? 'Every provider call counts here, including fallback retries and autofixed attempts. One request can produce several attempts.'
    : 'Every provider call counts here, including fallback retries. One request can produce several attempts.';
}

/** Success rate ⓘ texts, one per surface grain. */
export const MODEL_SUCCESS_RATE_TOOLTIP = 'Successful attempts over all attempts for this model.';
export const PROVIDER_SUCCESS_RATE_TOOLTIP =
  'Successful attempts over all attempts for this provider.';
export const CONNECTION_SUCCESS_RATE_TOOLTIP_30D =
  'Successful attempts over all attempts for this connection, over the last 30 days.';
export const CONNECTION_SUCCESS_RATE_TOOLTIP =
  'Successful attempts over all attempts for this connection, on the filtered period.';
export const CONNECTION_HARNESS_SUCCESS_RATE_TOOLTIP =
  'Successful attempts over all attempts for this harness on this connection.';
export const HARNESS_SUCCESS_RATE_TOOLTIP =
  'Successful requests over all requests for this harness.';
export const HARNESS_TOTAL_REQUESTS_TOOLTIP =
  'Logical requests from this harness, one per call, whatever the number of attempts.';
export const REQUEST_SUCCESS_RATE_TOOLTIP =
  'Successful requests over all requests. Recovered requests count as successful.';

export function getPerProviderReliability(
  range = '7d',
  agentName?: string,
): Promise<ProviderReliabilityRow[]> {
  return fetchJson('/overview/autofix-per-provider', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<ProviderReliabilityRow[]>;
}

export interface AgentReliabilityRow {
  agent_name: string;
  requests: number;
  failed: number;
  autofixed: number;
  /** Requests recovered by a successful fallback attempt (additive field). */
  fallback_saves: number;
  /** Same success definition as the global Success rate KPI (additive field). */
  succeeded: number;
}

export function getPerAgentReliability(range = '7d'): Promise<AgentReliabilityRow[]> {
  return fetchJson('/overview/autofix-per-agent', { range }) as Promise<AgentReliabilityRow[]>;
}

/** Attempt-world reliability for a model: a model is not healed, it acts. */
export interface ModelReliabilityRow {
  model: string;
  attempts: number;
  failed: number;
  succeeded: number;
}

export function getPerModelReliability(
  range = '7d',
  agentName?: string,
): Promise<ModelReliabilityRow[]> {
  return fetchJson('/overview/autofix-per-model', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<ModelReliabilityRow[]>;
}

export interface ErrorBreakdownResponse {
  range: string;
  successful: number;
  total_errors: number;
  provider_errors: number;
  transport_errors: number;
  manifest_errors: number;
  auto_fixed: number;
  by_origin: Record<string, number>;
  by_class: Record<string, number>;
  provider_error_rate: number;
}

export function getErrorBreakdown(
  range = '24h',
  agentName?: string,
): Promise<ErrorBreakdownResponse> {
  return fetchJson('/errors/breakdown', {
    range,
    ...(agentName ? { agent_name: agentName } : {}),
  }) as Promise<ErrorBreakdownResponse>;
}

export function getHealth() {
  return fetchJson('/health');
}

export function getModelPrices() {
  return fetchJson('/model-prices');
}
