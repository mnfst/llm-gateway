export const DEFAULT_REQUEST_QUOTA_RESET_AT = '2026-07-09T09:06:52Z';
export const REQUEST_QUOTA_RESET_AT_ENV = 'PLAN_REQUEST_QUOTA_RESET_AT';
export const REQUEST_USAGE_CUTOVER_STATE = 'tenant_request_usage_cutover_v1';

export function requestQuotaResetAtMs(): number {
  const raw = process.env[REQUEST_QUOTA_RESET_AT_ENV]?.trim() || DEFAULT_REQUEST_QUOTA_RESET_AT;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse(DEFAULT_REQUEST_QUOTA_RESET_AT);
}

export function requestQuotaWindowStartMs(monthStartMs: number): number {
  return Math.max(monthStartMs, requestQuotaResetAtMs());
}
