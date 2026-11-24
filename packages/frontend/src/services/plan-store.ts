import { createSignal } from 'solid-js';
import { getBillingPlan, type BillingPlanStatus } from './api/billing.js';

/**
 * The tenant's billing plan, resolved once per app boot behind AuthGuard and
 * read synchronously everywhere after. Plan is session-scoped data (it only
 * changes on upgrade/downgrade, which round-trips through Stripe checkout and
 * reboots the app), so it rides the bootstrap instead of the live
 * /billing/status endpoint — pages never wait on billing to decide range
 * locks, and nothing can flicker or double-fetch.
 */

/** Fail-open default: on a fetch error the UI behaves as if billing is off. */
const FAIL_OPEN: BillingPlanStatus = { enabled: false, plan: 'free' };

const [planStatus, setPlanStatus] = createSignal<BillingPlanStatus | null>(null);

let inflight: Promise<BillingPlanStatus> | null = null;
/** Bumped by every reset so a lookup started before it cannot write back. */
let generation = 0;

/**
 * Resolve the plan once per boot (deduped). Never rejects — a failed lookup
 * falls open so a billing hiccup can't block the dashboard.
 */
export function loadPlan(): Promise<BillingPlanStatus> {
  const current = planStatus();
  if (current) return Promise.resolve(current);
  if (inflight) return inflight;
  // Only a real answer is remembered, and only by the lookup that still owns
  // the store: a failed lookup (a 401 from a probe that fired before sign-in,
  // a billing hiccup) falls open for this caller but is retried by the next
  // one, and a lookup that was outlived by a reset neither writes its stale
  // answer nor clears the slot the replacement lookup now holds.
  const owner = generation;
  const request: Promise<BillingPlanStatus> = getBillingPlan()
    .then((status) => {
      if (generation === owner) setPlanStatus(status);
      return status;
    })
    .catch(() => FAIL_OPEN)
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/**
 * True for a Free cloud tenant. Synchronous: AuthGuard awaits {@link loadPlan}
 * before rendering any page, so by the time a consumer runs this is settled.
 * (Reactive anyway, so a late resolution still propagates.)
 */
export const isFreePlan = (): boolean => {
  const status = planStatus();
  return !!status && status.enabled && status.plan === 'free';
};

export { planStatus };

/** Reset the store (tests, or forcing a re-resolve after a plan change). */
export function resetPlanStore(next: BillingPlanStatus | null = null): void {
  setPlanStatus(next);
  inflight = null;
  generation += 1;
}
