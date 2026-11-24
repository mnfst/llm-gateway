import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { usePlanRangeLock } from '../../src/services/plan-range-lock.js';
import { resetPlanStore } from '../../src/services/plan-store.js';

const PRO_RANGES = new Set(['30d', '90d', '365d']);

const withLock = (
  initialRange: string,
  body: (
    lock: ReturnType<typeof usePlanRangeLock<string>>,
    setRange: (v: string) => void,
  ) => void,
) => {
  createRoot((dispose) => {
    const [range, setRange] = createSignal(initialRange);
    const lock = usePlanRangeLock(range, PRO_RANGES, '7d');
    try {
      body(lock, setRange);
    } finally {
      dispose();
    }
  });
};

describe('usePlanRangeLock', () => {
  beforeEach(() => {
    resetPlanStore();
  });

  it('locks PRO ranges and clamps to the fallback for a free plan', () => {
    resetPlanStore({ enabled: true, plan: 'free' });
    withLock('90d', (lock) => {
      expect(lock.isFreePlan()).toBe(true);
      expect(lock.isProRangeLocked('90d')).toBe(true);
      expect(lock.isProRangeLocked('7d')).toBe(false);
      expect(lock.effectiveRange()).toBe('7d');
    });
  });

  it('leaves PRO ranges unlocked for a paid plan', () => {
    resetPlanStore({ enabled: true, plan: 'pro' });
    withLock('30d', (lock) => {
      expect(lock.isFreePlan()).toBe(false);
      expect(lock.isProRangeLocked('30d')).toBe(false);
      expect(lock.effectiveRange()).toBe('30d');
    });
  });

  it('leaves PRO ranges unlocked when billing is disabled or unresolved', () => {
    resetPlanStore({ enabled: false, plan: 'free' });
    withLock('365d', (lock) => {
      expect(lock.effectiveRange()).toBe('365d');
    });
    resetPlanStore();
    withLock('365d', (lock) => {
      expect(lock.isFreePlan()).toBe(false);
      expect(lock.effectiveRange()).toBe('365d');
    });
  });

  it('reacts to range changes and never clamps non-PRO ranges', () => {
    resetPlanStore({ enabled: true, plan: 'free' });
    withLock('24h', (lock, setRange) => {
      expect(lock.effectiveRange()).toBe('24h');
      setRange('30d');
      expect(lock.effectiveRange()).toBe('7d');
      setRange('7d');
      expect(lock.effectiveRange()).toBe('7d');
    });
  });

  it('re-clamps reactively when the plan store updates mid-session', () => {
    withLock('30d', (lock) => {
      expect(lock.effectiveRange()).toBe('30d');
      resetPlanStore({ enabled: true, plan: 'free' });
      expect(lock.effectiveRange()).toBe('7d');
    });
  });
});
