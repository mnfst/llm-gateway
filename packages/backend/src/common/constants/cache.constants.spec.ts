import {
  DASHBOARD_CACHE_TTL_MS,
  AGENT_LIST_CACHE_TTL_MS,
  MODEL_PRICES_CACHE_TTL_MS,
} from './cache.constants';

describe('Cache constants', () => {
  it('DASHBOARD_CACHE_TTL_MS is 30 seconds', () => {
    expect(DASHBOARD_CACHE_TTL_MS).toBe(30_000);
  });

  it('AGENT_LIST_CACHE_TTL_MS is 60 seconds', () => {
    expect(AGENT_LIST_CACHE_TTL_MS).toBe(60_000);
  });

  it('MODEL_PRICES_CACHE_TTL_MS is 5 minutes', () => {
    expect(MODEL_PRICES_CACHE_TTL_MS).toBe(300_000);
  });
});
