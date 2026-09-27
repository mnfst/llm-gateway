import { ErrorDiscoveryService } from './error-discovery.service';

type AggRow = {
  provider: string;
  http: number | null;
  volume_30d: number;
  volume_7d: number;
  tenants: number;
  first_seen: string | null;
  last_seen: string | null;
  recovery: number | null;
  sample: string | null;
};

type TrendRow = { provider: string; http: number | null; day: string; cnt: number };

type VariantRow = { provider: string; http: number | null; msg: string | null; cnt: number };

function makeAgg(overrides: Partial<AggRow> = {}): AggRow {
  return {
    provider: 'gemini',
    http: 429,
    volume_30d: 400,
    volume_7d: 100,
    tenants: 42,
    first_seen: '2026-05-01T00:00:00.000Z',
    last_seen: '2026-06-01T00:00:00.000Z',
    recovery: 0.74,
    sample: 'quota exceeded',
    ...overrides,
  };
}

describe('ErrorDiscoveryService', () => {
  let service: ErrorDiscoveryService;
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    service = new ErrorDiscoveryService({ query } as never);
  });

  /** Wire the three sequential `this.repo.query` calls: agg, trend, variants. */
  function setup(aggRows: AggRow[], trendRows: TrendRow[] = [], variantRows: VariantRow[] = []) {
    query
      .mockResolvedValueOnce(aggRows)
      .mockResolvedValueOnce(trendRows)
      .mockResolvedValueOnce(variantRows);
  }

  it('issues exactly three queries (aggregate, trend, variants)', async () => {
    setup([], []);

    await service.discover();

    expect(query).toHaveBeenCalledTimes(3);
  });

  it('excludes rows without a tenant from every public aggregate', async () => {
    setup([], []);

    await service.discover();

    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('AND e.tenant_id IS NOT NULL');
    }
  });

  it('returns an empty list when there are no clusters', async () => {
    setup([], []);

    expect(await service.discover()).toEqual([]);
  });

  describe('categoryFor mapping', () => {
    const cases: Array<[number | null, string, string]> = [
      [429, 'rate_limit', 'Rate limit'],
      [401, 'auth', 'Authentication'],
      [403, 'auth', 'Authentication'],
      [402, 'billing', 'Billing / quota'],
      [404, 'model_unavailable', 'Model unavailable'],
      [500, 'server', 'Server error'],
      [503, 'server', 'Server error'],
      [400, 'bad_request', 'Bad request'],
      [422, 'bad_request', 'Bad request'],
      [null, 'unknown', 'Unknown'],
    ];

    it.each(cases)('maps http %p to category %s', async (http, id, label) => {
      setup([makeAgg({ http })], []);

      const [cluster] = await service.discover();

      expect(cluster.category).toBe(id);
      expect(cluster.category_label).toBe(label);
    });
  });

  describe('cluster_key and suggested_slug', () => {
    it('builds key as provider|http and a hyphenated slug', async () => {
      setup([makeAgg({ provider: 'gemini', http: 429 })], []);

      const [cluster] = await service.discover();

      expect(cluster.cluster_key).toBe('gemini|429');
      expect(cluster.suggested_slug).toBe('gemini-429-rate-limit');
    });

    it('uses |none and -error- in the slug when http is null', async () => {
      setup([makeAgg({ provider: 'openrouter', http: null })], []);

      const [cluster] = await service.discover();

      expect(cluster.cluster_key).toBe('openrouter|none');
      expect(cluster.suggested_slug).toBe('openrouter-error-unknown');
    });

    it('replaces all underscores in the category id with hyphens', async () => {
      setup([makeAgg({ provider: 'openrouter', http: 404 })], []);

      const [cluster] = await service.discover();

      // model_unavailable → model-unavailable
      expect(cluster.suggested_slug).toBe('openrouter-404-model-unavailable');
    });
  });

  describe('numeric coercion and passthrough', () => {
    it('coerces string-y numbers and passes recovery through', async () => {
      setup(
        [
          makeAgg({
            http: '429' as unknown as number,
            tenants: '42' as unknown as number,
            volume_7d: '100' as unknown as number,
            volume_30d: '400' as unknown as number,
            recovery: 0.74,
          }),
        ],
        [],
      );

      const [cluster] = await service.discover();

      expect(cluster.http_status).toBe(429);
      expect(cluster.tenants).toBe(42);
      expect(cluster.volume_7d).toBe(100);
      expect(cluster.volume_30d).toBe(400);
      expect(cluster.recovery_rate).toBe(0.74);
      expect(cluster.first_seen).toBe('2026-05-01T00:00:00.000Z');
      expect(cluster.last_seen).toBe('2026-06-01T00:00:00.000Z');
    });

    it('passes a null recovery rate through as null', async () => {
      setup([makeAgg({ recovery: null })], []);

      const [cluster] = await service.discover();

      expect(cluster.recovery_rate).toBeNull();
    });

    it('preserves null first_seen / last_seen', async () => {
      setup([makeAgg({ first_seen: null, last_seen: null })], []);

      const [cluster] = await service.discover();

      expect(cluster.first_seen).toBeNull();
      expect(cluster.last_seen).toBeNull();
    });
  });

  describe('sample scrubbing', () => {
    it('scrubs secrets in the sample message', async () => {
      setup([makeAgg({ sample: 'key=sk-ant-ABCDEF1234567890 boom' })], []);

      const [cluster] = await service.discover();

      expect(cluster.sample_message).toContain('[REDACTED]');
      expect(cluster.sample_message).not.toContain('sk-ant-ABCDEF1234567890');
    });

    it('treats a null sample as an empty string', async () => {
      setup([makeAgg({ sample: null })], []);

      const [cluster] = await service.discover();

      expect(cluster.sample_message).toBe('');
    });
  });

  describe('trend assembly', () => {
    it('attaches the trend rows matching a cluster key', async () => {
      setup(
        [makeAgg({ provider: 'gemini', http: 429 })],
        [
          { provider: 'gemini', http: 429, day: '2026-05-30', cnt: 5 },
          { provider: 'gemini', http: 429, day: '2026-05-31', cnt: 8 },
          // Different key — must NOT leak into the gemini|429 trend.
          { provider: 'openai', http: 401, day: '2026-05-31', cnt: 3 },
        ],
      );

      const [cluster] = await service.discover();

      expect(cluster.trend).toEqual([
        { date: '2026-05-30', count: 5 },
        { date: '2026-05-31', count: 8 },
      ]);
    });

    it('assembles a trend keyed by provider|none for null http', async () => {
      setup(
        [makeAgg({ provider: 'openrouter', http: null })],
        [{ provider: 'openrouter', http: null, day: '2026-05-31', cnt: 9 }],
      );

      const [cluster] = await service.discover();

      expect(cluster.trend).toEqual([{ date: '2026-05-31', count: 9 }]);
    });

    it('coerces string trend counts to numbers', async () => {
      setup(
        [makeAgg({ provider: 'gemini', http: 429 })],
        [{ provider: 'gemini', http: 429, day: '2026-05-31', cnt: '7' as unknown as number }],
      );

      const [cluster] = await service.discover();

      expect(cluster.trend).toEqual([{ date: '2026-05-31', count: 7 }]);
    });

    it('defaults to an empty trend when no trend rows match the key', async () => {
      setup([makeAgg({ provider: 'gemini', http: 429 })], []);

      const [cluster] = await service.discover();

      expect(cluster.trend).toEqual([]);
    });
  });

  describe('variants assembly', () => {
    it('attaches up to 5 distinct scrubbed variants by key, isolating other keys', async () => {
      const vrows: VariantRow[] = [
        { provider: 'gemini', http: 429, msg: 'You exceeded your current quota', cnt: 10 },
        { provider: 'gemini', http: 429, msg: 'Resource has been exhausted', cnt: 8 },
        { provider: 'gemini', http: 429, msg: 'v3', cnt: 7 },
        { provider: 'gemini', http: 429, msg: 'v4', cnt: 6 },
        { provider: 'gemini', http: 429, msg: 'v5', cnt: 5 },
        { provider: 'gemini', http: 429, msg: 'v6-overflow', cnt: 4 },
        { provider: 'openai', http: 401, msg: 'other-key', cnt: 9 },
      ];
      setup([makeAgg({ provider: 'gemini', http: 429 })], [], vrows);

      const [cluster] = await service.discover();

      expect(cluster.variants).toHaveLength(5);
      expect(cluster.variants).toContain('You exceeded your current quota');
      expect(cluster.variants).not.toContain('v6-overflow');
      expect(cluster.variants).not.toContain('other-key');
    });

    it('scrubs secrets and truncates each variant to 160 chars', async () => {
      const long = 'x'.repeat(200);
      setup(
        [makeAgg({ provider: 'gemini', http: 429 })],
        [],
        [{ provider: 'gemini', http: 429, msg: `key=sk-ant-ABCDEF1234567890 ${long}`, cnt: 1 }],
      );

      const [cluster] = await service.discover();

      expect(cluster.variants[0]).toContain('[REDACTED]');
      expect(cluster.variants[0].length).toBeLessThanOrEqual(160);
    });

    it('treats a null variant message as empty and keys by provider|none', async () => {
      setup(
        [makeAgg({ provider: 'openrouter', http: null })],
        [],
        [{ provider: 'openrouter', http: null, msg: null, cnt: 2 }],
      );

      const [cluster] = await service.discover();

      expect(cluster.variants).toEqual(['']);
    });

    it('defaults to empty variants when none match', async () => {
      setup([makeAgg({ provider: 'gemini', http: 429 })], [], []);

      const [cluster] = await service.discover();

      expect(cluster.variants).toEqual([]);
    });
  });

  it('maps multiple clusters preserving aggregate row order', async () => {
    setup(
      [
        makeAgg({ provider: 'gemini', http: 429, tenants: 120 }),
        makeAgg({ provider: 'openai', http: 401, tenants: 55 }),
      ],
      [],
    );

    const result = await service.discover();

    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe('gemini');
    expect(result[0].category).toBe('rate_limit');
    expect(result[1].provider).toBe('openai');
    expect(result[1].category).toBe('auth');
  });
});
