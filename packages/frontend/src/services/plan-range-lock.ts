import { createMemo, type Accessor } from 'solid-js';
import { isFreePlan } from './plan-store.js';

export interface PlanRangeLock<T extends string> {
  /** True for a Free cloud tenant (synchronous read of the plan store). */
  isFreePlan: Accessor<boolean>;
  /** Whether a picker option must be disabled. */
  isProRangeLocked: (value: string) => boolean;
  /** The range to fetch with: the selection, clamped while PRO ranges are locked. */
  effectiveRange: Accessor<T>;
}

/**
 * Shared plan-based range lock for the Overview / Global Overview / Requests
 * dashboards: PRO ranges are Free-tenant-locked and clamp to the fallback.
 *
 * The plan comes from the plan store, which AuthGuard resolves before any
 * page renders — so the lock is synchronous, `effectiveRange` is stable from
 * first paint, and every range-keyed resource fetches exactly once at the
 * right range. No billing fetch, no loading state, nothing to flicker.
 */
export function usePlanRangeLock<T extends string>(
  range: Accessor<T>,
  proRanges: ReadonlySet<string>,
  fallback: T,
): PlanRangeLock<T> {
  const isProRangeLocked = (value: string) => isFreePlan() && proRanges.has(value);
  const effectiveRange = createMemo(() => (isProRangeLocked(range()) ? fallback : range()));
  return { isFreePlan, isProRangeLocked, effectiveRange };
}
