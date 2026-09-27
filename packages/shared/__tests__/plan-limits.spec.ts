import {
  FREE_PLAN_REQUESTS_PER_MONTH,
  PLANS,
  PLAN_LIMITS,
  UNLIMITED_PLAN_LIMITS,
} from '../src/plan-limits';

describe('plan-limits', () => {
  it('defines limits for every plan', () => {
    for (const plan of PLANS) {
      expect(PLAN_LIMITS[plan]).toBeDefined();
    }
  });

  it('pins the launch values', () => {
    expect(FREE_PLAN_REQUESTS_PER_MONTH).toBe(10_000);
    expect(PLAN_LIMITS.free).toEqual({ requestsPerMonth: FREE_PLAN_REQUESTS_PER_MONTH });
    expect(PLAN_LIMITS.pro).toEqual({ requestsPerMonth: null });
    expect(UNLIMITED_PLAN_LIMITS).toEqual({ requestsPerMonth: null });
  });
});
