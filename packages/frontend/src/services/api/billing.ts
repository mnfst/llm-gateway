import { fetchJson, fetchMutate, type FetchJsonOptions } from './core';
import type { BillingEmailPreferences, BillingPlanStatus, BillingStatus } from 'manifest-shared';

// Re-export so UI components can import the type from the API module they
// already use, instead of reaching across package boundaries for it.
export type { BillingEmailPreferences, BillingPlanStatus, BillingStatus };

export function getBillingStatus(options?: FetchJsonOptions): Promise<BillingStatus> {
  if (options) {
    return fetchJson<BillingStatus>('/billing/status', undefined, options);
  }
  return fetchJson<BillingStatus>('/billing/status');
}

/**
 * Light plan lookup — no usage counter, no Stripe price. See plan-store.ts.
 * AuthGuard fires it before the session is known, so a signed-out 401 must
 * reject quietly rather than hard-navigate to /login and lose the requested
 * path the guard is about to preserve.
 */
export function getBillingPlan(): Promise<BillingPlanStatus> {
  return fetchJson<BillingPlanStatus>('/billing/plan', undefined, { loginRedirect: false });
}

export function updateBillingEmailPreferences(
  preferences: BillingEmailPreferences,
): Promise<BillingEmailPreferences> {
  return fetchMutate<BillingEmailPreferences>('/billing/email-preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  });
}
