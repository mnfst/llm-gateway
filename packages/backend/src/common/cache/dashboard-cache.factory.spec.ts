import { buildDashboardCacheStore } from './dashboard-cache.factory';
import { DASHBOARD_CACHE_MAX_ENTRIES } from '../constants/cache.constants';

describe('buildDashboardCacheStore', () => {
  it('stores and retrieves values', async () => {
    const store = buildDashboardCacheStore();

    await store.set('/api/v1/overview', { ok: true });

    expect(await store.get('/api/v1/overview')).toEqual({ ok: true });
  });

  it('enforces the LRU cap so write-once unique keys cannot grow unbounded', async () => {
    const store = buildDashboardCacheStore();

    // Simulate the dashboard pattern: many unique URL keys, each written once.
    // Insert sequentially so least-recently-used order is deterministic.
    const overflow = 100;
    for (let i = 0; i < DASHBOARD_CACHE_MAX_ENTRIES + overflow; i++) {
      await store.set(`/api/v1/costs?cursor=${i}`, i);
    }

    // The oldest keys are LRU-evicted once the cap is exceeded; recent ones stay.
    expect(await store.get('/api/v1/costs?cursor=0')).toBeUndefined();
    expect(
      await store.get(`/api/v1/costs?cursor=${DASHBOARD_CACHE_MAX_ENTRIES + overflow - 1}`),
    ).toBe(DASHBOARD_CACHE_MAX_ENTRIES + overflow - 1);
  }, 20000);
});
