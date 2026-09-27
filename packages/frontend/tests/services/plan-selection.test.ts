import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPlanChosen,
  hasPlanBeenChosen,
  markPlanChosen,
} from '../../src/services/plan-selection';

describe('plan-selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('stores, reads, and clears the chosen plan flag per user', () => {
    expect(hasPlanBeenChosen('u1')).toBe(false);

    markPlanChosen('u1');

    expect(hasPlanBeenChosen('u1')).toBe(true);
    expect(hasPlanBeenChosen('u2')).toBe(false);

    clearPlanChosen('u1');

    expect(hasPlanBeenChosen('u1')).toBe(false);
  });

  it('fails closed when storage reads are unavailable and does not throw on writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => markPlanChosen('u1')).not.toThrow();
    expect(hasPlanBeenChosen('u1')).toBe(false);
    expect(() => clearPlanChosen('u1')).not.toThrow();
  });
});
