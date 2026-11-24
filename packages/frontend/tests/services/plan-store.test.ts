import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadPlan, isFreePlan, planStatus, resetPlanStore } from '../../src/services/plan-store.js';

const mockGetBillingPlan = vi.fn();
vi.mock('../../src/services/api/billing.js', () => ({
  getBillingPlan: (...args: unknown[]) => mockGetBillingPlan(...args),
}));

describe('plan store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPlanStore();
  });

  it('resolves and caches the plan on first load', async () => {
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'pro' });
    await expect(loadPlan()).resolves.toEqual({ enabled: true, plan: 'pro' });
    await expect(loadPlan()).resolves.toEqual({ enabled: true, plan: 'pro' });
    expect(mockGetBillingPlan).toHaveBeenCalledTimes(1);
    expect(planStatus()).toEqual({ enabled: true, plan: 'pro' });
  });

  it('dedupes concurrent loads onto one request', async () => {
    let resolve!: (v: { enabled: boolean; plan: string }) => void;
    mockGetBillingPlan.mockReturnValue(new Promise((r) => (resolve = r)));
    const [a, b] = [loadPlan(), loadPlan()];
    resolve({ enabled: true, plan: 'free' });
    await expect(a).resolves.toEqual({ enabled: true, plan: 'free' });
    await expect(b).resolves.toEqual({ enabled: true, plan: 'free' });
    expect(mockGetBillingPlan).toHaveBeenCalledTimes(1);
  });

  it('keeps deduping a newer load when an older one settles after a reset', async () => {
    // AuthGuard prefetches at mount; a reset (tests, plan change) can land
    // while that lookup is still pending. The old promise must not clear the
    // slot the replacement lookup now owns, or the next caller fires a third
    // request instead of joining the second.
    let resolveOld!: (v: { enabled: boolean; plan: string }) => void;
    let resolveNew!: (v: { enabled: boolean; plan: string }) => void;
    mockGetBillingPlan
      .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveNew = r)));
    const old = loadPlan();
    resetPlanStore();
    const fresh = loadPlan();
    resolveOld({ enabled: false, plan: 'free' });
    await old;
    const joined = loadPlan();
    resolveNew({ enabled: true, plan: 'pro' });
    await expect(fresh).resolves.toEqual({ enabled: true, plan: 'pro' });
    await expect(joined).resolves.toEqual({ enabled: true, plan: 'pro' });
    expect(mockGetBillingPlan).toHaveBeenCalledTimes(2);
  });

  it('fails open (billing disabled) when the lookup errors, without caching failure', async () => {
    mockGetBillingPlan.mockRejectedValueOnce(new Error('boom'));
    await expect(loadPlan()).resolves.toEqual({ enabled: false, plan: 'free' });
    expect(isFreePlan()).toBe(false);
    // The failed value is never stored: a lookup fired before sign-in (401)
    // must not decide the plan for the session that signs in right after.
    expect(planStatus()).toBeNull();
    // The next load retries instead of serving the failed value.
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'free' });
    await expect(loadPlan()).resolves.toEqual({ enabled: true, plan: 'free' });
  });

  it('derives isFreePlan only for an enabled free plan', () => {
    expect(isFreePlan()).toBe(false); // unresolved
    resetPlanStore({ enabled: false, plan: 'free' });
    expect(isFreePlan()).toBe(false); // billing off (self-hosted)
    resetPlanStore({ enabled: true, plan: 'pro' });
    expect(isFreePlan()).toBe(false);
    resetPlanStore({ enabled: true, plan: 'free' });
    expect(isFreePlan()).toBe(true);
  });
});
