import { ERROR_PAGE_SEEDS, seedTrend } from './error-page-seed-data';
import { MIN_TENANTS_FOR_PUBLIC } from './error-pages.service';

describe('seedTrend', () => {
  const END = Date.UTC(2026, 6, 1); // 2026-07-01

  it('returns 14 ascending daily points ending on the end date, never zero', () => {
    const trend = seedTrend(720, 0, END);
    expect(trend).toHaveLength(14);
    expect(trend[0].date).toBe('2026-06-18');
    expect(trend[13].date).toBe('2026-07-01');
    for (const p of trend) expect(p.count).toBeGreaterThanOrEqual(1);
    const dates = trend.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates); // already ascending
  });

  it('is deterministic and scales with volume + salt', () => {
    expect(seedTrend(720, 0, END)).toEqual(seedTrend(720, 0, END));
    const big = seedTrend(3000, 1, END).reduce((a, p) => a + p.count, 0);
    const small = seedTrend(300, 1, END).reduce((a, p) => a + p.count, 0);
    expect(big).toBeGreaterThan(small);
  });

  it('still emits a non-zero line for a tiny volume', () => {
    const trend = seedTrend(1, 3, END);
    expect(trend).toHaveLength(14);
    for (const p of trend) expect(p.count).toBeGreaterThanOrEqual(1);
  });
});

describe('ERROR_PAGE_SEEDS', () => {
  it('has unique slugs, each prefixed with its provider, above the k-anon floor', () => {
    const slugs = ERROR_PAGE_SEEDS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of ERROR_PAGE_SEEDS) {
      expect(s.slug.startsWith(`${s.provider}-`)).toBe(true);
      expect(s.tenants).toBeGreaterThanOrEqual(MIN_TENANTS_FOR_PUBLIC);
      expect(s.http_status).toBeGreaterThan(0);
      expect(s.category).toBeTruthy();
      expect(s.title).toBeTruthy();
    }
  });

  it('covers several providers and categories for rich hubs', () => {
    expect(new Set(ERROR_PAGE_SEEDS.map((s) => s.provider)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(ERROR_PAGE_SEEDS.map((s) => s.category)).size).toBeGreaterThanOrEqual(4);
  });
});
