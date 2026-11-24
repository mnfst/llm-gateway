import { computeTokenCost } from './cost-calculator';
import { PricingEntry } from '../../model-prices/model-pricing-cache.service';

describe('computeTokenCost', () => {
  const pricing: PricingEntry = {
    model_name: 'gpt-4o',
    provider: 'OpenAI',
    input_price_per_token: 0.0000025,
    output_price_per_token: 0.00001,
    display_name: 'GPT-4o',
  };

  it('returns null when model is null', () => {
    expect(
      computeTokenCost({ inputTokens: 100, outputTokens: 50, model: null, pricing }),
    ).toBeNull();
  });

  it('returns null when model is undefined', () => {
    expect(
      computeTokenCost({ inputTokens: 100, outputTokens: 50, model: undefined, pricing }),
    ).toBeNull();
  });

  it('returns null when both token counts are zero', () => {
    expect(
      computeTokenCost({ inputTokens: 0, outputTokens: 0, model: 'gpt-4o', pricing }),
    ).toBeNull();
  });

  it('returns 0 when isSubscription is true', () => {
    expect(
      computeTokenCost({
        inputTokens: 1000,
        outputTokens: 500,
        model: 'gpt-4o',
        pricing,
        isSubscription: true,
      }),
    ).toBe(0);
  });

  it('prefers provider-reported cost for subscription budget providers', () => {
    expect(
      computeTokenCost({
        inputTokens: 1000,
        outputTokens: 500,
        model: 'stepfun/step-3.7-flash:free',
        pricing,
        isSubscription: true,
        reportedCostUsd: 0.00005,
        perRequestCostUsd: 0.01364,
      }),
    ).toBe(0.00005);
  });

  it('returns null when pricing is undefined', () => {
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'unknown-model',
        pricing: undefined,
      }),
    ).toBeNull();
  });

  it('returns null when input_price_per_token is null', () => {
    const partial: PricingEntry = { ...pricing, input_price_per_token: null };
    expect(
      computeTokenCost({ inputTokens: 100, outputTokens: 50, model: 'gpt-4o', pricing: partial }),
    ).toBeNull();
  });

  it('returns null when output_price_per_token is null', () => {
    const partial: PricingEntry = { ...pricing, output_price_per_token: null };
    expect(
      computeTokenCost({ inputTokens: 100, outputTokens: 50, model: 'gpt-4o', pricing: partial }),
    ).toBeNull();
  });

  it('computes cost correctly with both token types', () => {
    const result = computeTokenCost({
      inputTokens: 1000,
      outputTokens: 500,
      model: 'gpt-4o',
      pricing,
    });
    // 1000 * 0.0000025 + 500 * 0.00001 = 0.0025 + 0.005 = 0.0075
    expect(result).toBeCloseTo(0.0075, 10);
  });

  it('prices cache-read input tokens with the cache-read price when available', () => {
    const deepseekPricing: PricingEntry = {
      model_name: 'deepseek-v4-pro',
      provider: 'DeepSeek',
      input_price_per_token: 0.435 / 1_000_000,
      output_price_per_token: 0.87 / 1_000_000,
      cache_read_price_per_token: 0.003625 / 1_000_000,
      display_name: 'DeepSeek V4 Pro',
    };

    const result = computeTokenCost({
      inputTokens: 36_100,
      outputTokens: 1_200,
      cacheReadTokens: 21_600,
      model: 'deepseek-v4-pro',
      pricing: deepseekPricing,
    });

    expect(result).toBeCloseTo(0.0074298, 10);
  });

  it('falls back to input price for cache-read tokens without cache-read pricing', () => {
    const result = computeTokenCost({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 400,
      model: 'gpt-4o',
      pricing,
    });

    expect(result).toBeCloseTo(0.0075, 10);
  });

  it('uses cache-write pricing for cache-creation tokens when available', () => {
    const cachePricing: PricingEntry = {
      model_name: 'claude-opus-4-6',
      provider: 'Anthropic',
      input_price_per_token: 3 / 1_000_000,
      output_price_per_token: 15 / 1_000_000,
      cache_read_price_per_token: 0.3 / 1_000_000,
      cache_write_price_per_token: 3.75 / 1_000_000,
      display_name: 'Claude Opus 4.6',
    };

    const result = computeTokenCost({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 300,
      cacheCreationTokens: 200,
      model: 'claude-opus-4-6',
      pricing: cachePricing,
    });

    expect(result).toBeCloseTo(0.00384, 12);
  });

  it('computes cost with only input tokens', () => {
    const result = computeTokenCost({
      inputTokens: 2000,
      outputTokens: 0,
      model: 'gpt-4o',
      pricing,
    });
    // inputTokens > 0 && outputTokens === 0 → not both zero, so compute
    // 2000 * 0.0000025 + 0 * 0.00001 = 0.005
    expect(result).toBeCloseTo(0.005, 10);
  });

  it('computes cost with only output tokens', () => {
    const result = computeTokenCost({
      inputTokens: 0,
      outputTokens: 300,
      model: 'gpt-4o',
      pricing,
    });
    // 0 * 0.0000025 + 300 * 0.00001 = 0.003
    expect(result).toBeCloseTo(0.003, 10);
  });

  it('handles string-typed price fields via Number() coercion', () => {
    const stringPricing: PricingEntry = {
      model_name: 'test-model',
      provider: 'Test',
      input_price_per_token: '0.000005' as unknown as number,
      output_price_per_token: '0.00002' as unknown as number,
      display_name: null,
    };
    const result = computeTokenCost({
      inputTokens: 100,
      outputTokens: 200,
      model: 'test-model',
      pricing: stringPricing,
    });
    // 100 * 0.000005 + 200 * 0.00002 = 0.0005 + 0.004 = 0.0045
    expect(result).toBeCloseTo(0.0045, 10);
  });

  it('returns 0 for subscription even when pricing has null prices', () => {
    const noPricing: PricingEntry = {
      ...pricing,
      input_price_per_token: null,
      output_price_per_token: null,
    };
    expect(
      computeTokenCost({
        inputTokens: 500,
        outputTokens: 200,
        model: 'gpt-4o',
        pricing: noPricing,
        isSubscription: true,
      }),
    ).toBe(0);
  });

  it('returns null when computed cost would be negative (both prices negative)', () => {
    const negativePricing: PricingEntry = {
      model_name: 'bad-model',
      provider: 'Test',
      input_price_per_token: -1,
      output_price_per_token: -1,
      display_name: null,
    };
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'bad-model',
        pricing: negativePricing,
      }),
    ).toBeNull();
  });

  it('returns null when net cost is negative from mixed positive/negative prices', () => {
    const mixedPricing: PricingEntry = {
      model_name: 'mixed-model',
      provider: 'Test',
      input_price_per_token: -0.01,
      output_price_per_token: 0.000001,
      display_name: null,
    };
    // -0.01 * 1000 + 0.000001 * 10 = -10 + 0.00001 = -9.99999 < 0
    expect(
      computeTokenCost({
        inputTokens: 1000,
        outputTokens: 10,
        model: 'mixed-model',
        pricing: mixedPricing,
      }),
    ).toBeNull();
  });

  it('returns the computed value when cost is exactly zero (free model)', () => {
    const freePricing: PricingEntry = {
      model_name: 'free-model',
      provider: 'Free',
      input_price_per_token: 0,
      output_price_per_token: 0,
      display_name: null,
    };
    // 0 * 500 + 0 * 200 = 0, which is >= 0 so it should return 0
    expect(
      computeTokenCost({
        inputTokens: 500,
        outputTokens: 200,
        model: 'free-model',
        pricing: freePricing,
      }),
    ).toBe(0);
  });

  it('returns null for empty-string model (falsy)', () => {
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: '' as unknown as string,
        pricing,
      }),
    ).toBeNull();
  });

  it('returns 0 for subscription even when tokens are zero', () => {
    expect(
      computeTokenCost({
        inputTokens: 0,
        outputTokens: 0,
        model: 'gpt-4o',
        pricing: undefined,
        isSubscription: true,
      }),
    ).toBe(0);
  });

  it('returns the per-request cost when subscription has a positive perRequestCostUsd', () => {
    expect(
      computeTokenCost({
        inputTokens: 700,
        outputTokens: 150,
        model: 'glm-5.1',
        pricing: undefined,
        isSubscription: true,
        perRequestCostUsd: 0.0136,
      }),
    ).toBeCloseTo(0.0136, 10);
  });

  it('falls back to 0 when subscription perRequestCostUsd is zero', () => {
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'flat-fee-model',
        pricing: undefined,
        isSubscription: true,
        perRequestCostUsd: 0,
      }),
    ).toBe(0);
  });

  it('falls back to 0 when subscription perRequestCostUsd is negative (defensive)', () => {
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'flat-fee-model',
        pricing: undefined,
        isSubscription: true,
        perRequestCostUsd: -1,
      }),
    ).toBe(0);
  });

  it('falls back to 0 when subscription perRequestCostUsd is null', () => {
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'gpt-4o',
        pricing,
        isSubscription: true,
        perRequestCostUsd: null,
      }),
    ).toBe(0);
  });

  it('ignores perRequestCostUsd entirely when isSubscription is false', () => {
    const result = computeTokenCost({
      inputTokens: 1000,
      outputTokens: 500,
      model: 'gpt-4o',
      pricing,
      isSubscription: false,
      perRequestCostUsd: 0.05,
    });
    // 1000 * 0.0000025 + 500 * 0.00001 = 0.0075 — token math applies, not 0.05
    expect(result).toBeCloseTo(0.0075, 10);
  });

  describe('cost source precedence', () => {
    const catalogPricing: PricingEntry = {
      model_name: 'deepseek-v4-pro',
      provider: 'DeepSeek',
      input_price_per_token: 0.66e-6,
      output_price_per_token: 1.98e-6,
      display_name: 'DeepSeek V4 Pro',
    };
    const base = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'deepseek-v4-pro',
      pricing: catalogPricing,
    };

    it('prefers a provider-reported cost over the catalogue for non-subscription usage', () => {
      // The gateway said what it charged. That beats any estimate we can make,
      // and before this it was read only for subscription providers.
      expect(computeTokenCost({ ...base, reportedCostUsd: 0.42 })).toBe(0.42);
    });

    it('prefers a reported cost of zero over the catalogue', () => {
      // Zero is a real answer, not a missing one — a free-tier request.
      expect(computeTokenCost({ ...base, reportedCostUsd: 0 })).toBe(0);
    });

    it('ignores a negative reported cost and falls back to the catalogue', () => {
      expect(computeTokenCost({ ...base, reportedCostUsd: -1 })).toBeCloseTo(0.66 + 1.98, 10);
    });

    it('prefers a reported cost over a matching peak tier', () => {
      const tiered: PricingEntry = {
        ...catalogPricing,
        time_tiers: [
          {
            windows: ['01:00-04:00'],
            days: [1, 2, 3, 4, 5],
            input_price_per_token: 1.32e-6,
            output_price_per_token: 3.96e-6,
          },
        ],
      };
      const cost = computeTokenCost({
        ...base,
        pricing: tiered,
        reportedCostUsd: 0.1,
        at: new Date('2026-08-21T02:00:00Z'),
      });
      expect(cost).toBe(0.1);
    });

    it('still prefers a reported cost for subscription usage', () => {
      const cost = computeTokenCost({
        ...base,
        isSubscription: true,
        reportedCostUsd: 0.07,
        perRequestCostUsd: 0.05,
      });
      expect(cost).toBe(0.07);
    });

    it('ignores a reported cost too large for the cost_usd column', () => {
      // `decimal(10, 6)` tops out at 9999.999999. A bigger number is a
      // provider reporting credits or a session total, not a request price —
      // and persisting it would throw and lose the whole telemetry row.
      const cost = computeTokenCost({ ...base, reportedCostUsd: 25_000 });
      expect(cost).toBeCloseTo(0.66 + 1.98, 10);
    });

    it('accepts a reported cost exactly at the column limit', () => {
      expect(computeTokenCost({ ...base, reportedCostUsd: 9999.999999 })).toBe(9999.999999);
    });

    it('returns null for an unknown model even when a cost was reported', () => {
      // "A cost for a model we cannot name" is not a row worth writing.
      expect(computeTokenCost({ ...base, model: null, reportedCostUsd: 0.42 })).toBeNull();
    });

    it('records zero for local inference instead of an unknown null', () => {
      // Ollama, llama.cpp and LM Studio run on the user's own hardware. There
      // is no bill, and "free" is a different fact from "not known".
      expect(computeTokenCost({ ...base, pricing: undefined, isLocalProvider: true })).toBe(0);
    });

    it('records zero for local inference even when no tokens were counted', () => {
      expect(
        computeTokenCost({
          ...base,
          inputTokens: 0,
          outputTokens: 0,
          pricing: undefined,
          isLocalProvider: true,
        }),
      ).toBe(0);
    });

    it('returns null for a non-local provider with no pricing', () => {
      expect(computeTokenCost({ ...base, pricing: undefined })).toBeNull();
    });
  });

  describe('time-of-day pricing tiers', () => {
    // DeepSeek V4 Flash shape: off-peak base, peak windows at double.
    const peakPricing: PricingEntry = {
      model_name: 'deepseek-v4-flash',
      provider: 'DeepSeek',
      input_price_per_token: 0.22e-6,
      output_price_per_token: 0.66e-6,
      cache_read_price_per_token: 0.007e-6,
      time_tiers: [
        {
          windows: ['01:00-04:00', '06:00-10:00'],
          input_price_per_token: 0.44e-6,
          output_price_per_token: 1.32e-6,
          cache_read_price_per_token: 0.014e-6,
        },
      ],
      display_name: 'DeepSeek V4 Flash',
    };
    const base = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'deepseek-v4-flash',
      pricing: peakPricing,
    };

    it('bills the base rate outside every peak window', () => {
      const cost = computeTokenCost({ ...base, at: new Date('2026-08-17T12:00:00Z') });
      expect(cost).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('bills the tier rate inside a peak window', () => {
      const cost = computeTokenCost({ ...base, at: new Date('2026-08-17T02:30:00Z') });
      expect(cost).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('bills the base rate on a weekend hour inside a weekday-only window', () => {
      // 2026-08-22 is a Saturday; 02:00 UTC sits inside 01:00-04:00, so only
      // the day rule can move it off the peak rate.
      const weekdayOnly: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], days: [1, 2, 3, 4, 5] }],
      };
      const cost = computeTokenCost({
        ...base,
        pricing: weekdayOnly,
        at: new Date('2026-08-22T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('bills the tier rate on a weekday hour inside a weekday-only window', () => {
      // 2026-08-21 is a Friday — same clock time as the Saturday case above.
      const weekdayOnly: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], days: [1, 2, 3, 4, 5] }],
      };
      const cost = computeTokenCost({
        ...base,
        pricing: weekdayOnly,
        at: new Date('2026-08-21T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('bills a Sunday at the tier rate when Sunday is listed', () => {
      // ISO Sunday is 7, not 0 — getUTCDay() would say 0 and miss the match.
      const sundayOnly: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], days: [7] }],
      };
      const cost = computeTokenCost({
        ...base,
        pricing: sundayOnly,
        at: new Date('2026-08-23T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('treats an empty day list as every day', () => {
      const everyDay: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], days: [] }],
      };
      const cost = computeTokenCost({
        ...base,
        pricing: everyDay,
        at: new Date('2026-08-22T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('credits a midnight-crossing window to the day it opened on', () => {
      // 23:00-02:00 opens Friday and runs into Saturday. Saturday 00:30 is
      // inside the Friday band; Saturday 23:30 opens a band Saturday does not
      // have. Judging both by the wall-clock day would get one of them wrong.
      const fridayNight: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], windows: ['23:00-02:00'], days: [5] }],
      };
      expect(
        computeTokenCost({
          ...base,
          pricing: fridayNight,
          at: new Date('2026-08-22T00:30:00Z'),
        }),
      ).toBeCloseTo(0.44 + 1.32, 10);
      expect(
        computeTokenCost({
          ...base,
          pricing: fridayNight,
          at: new Date('2026-08-22T23:30:00Z'),
        }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('bills a window that opens Sunday and runs into Monday on Sunday terms', () => {
      // The week circle has a seam at Monday 00:00. A Sunday-only band that
      // wraps past midnight has to cross it, so this pins that the seam is not
      // a boundary: 2026-08-24 is a Monday, 00:30 of it belongs to Sunday's.
      const sundayNight: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], windows: ['23:00-02:00'], days: [7] }],
      };
      expect(
        computeTokenCost({
          ...base,
          pricing: sundayNight,
          at: new Date('2026-08-24T00:30:00Z'),
        }),
      ).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('treats window starts as inclusive and ends as exclusive', () => {
      expect(computeTokenCost({ ...base, at: new Date('2026-08-17T06:00:00Z') })).toBeCloseTo(
        0.44 + 1.32,
        10,
      );
      expect(computeTokenCost({ ...base, at: new Date('2026-08-17T10:00:00Z') })).toBeCloseTo(
        0.22 + 0.66,
        10,
      );
    });

    it('uses the tier cache-read price for cache hits inside a window', () => {
      const cost = computeTokenCost({
        ...base,
        cacheReadTokens: 1_000_000,
        at: new Date('2026-08-17T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.014 + 1.32, 10);
    });

    it('falls back to the tier input price for cache writes the tier does not price', () => {
      const cost = computeTokenCost({
        ...base,
        cacheCreationTokens: 1_000_000,
        at: new Date('2026-08-17T02:00:00Z'),
      });
      expect(cost).toBeCloseTo(0.44 + 1.32, 10);
    });

    it('matches windows that wrap past midnight', () => {
      const wrapped: PricingEntry = {
        ...peakPricing,
        time_tiers: [
          {
            windows: ['22:00-02:00'],
            input_price_per_token: 0.44e-6,
            output_price_per_token: 1.32e-6,
          },
        ],
      };
      expect(
        computeTokenCost({ ...base, pricing: wrapped, at: new Date('2026-08-17T23:00:00Z') }),
      ).toBeCloseTo(0.44 + 1.32, 10);
      expect(
        computeTokenCost({ ...base, pricing: wrapped, at: new Date('2026-08-17T01:30:00Z') }),
      ).toBeCloseTo(0.44 + 1.32, 10);
      expect(
        computeTokenCost({ ...base, pricing: wrapped, at: new Date('2026-08-17T12:00:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('never matches a zero-length window (start === end)', () => {
      const degenerate: PricingEntry = {
        ...peakPricing,
        time_tiers: [
          {
            windows: ['12:00-12:00'],
            input_price_per_token: 0.44e-6,
            output_price_per_token: 1.32e-6,
          },
        ],
      };
      // Equal endpoints must not fall into the midnight-wrap branch and
      // become a full-day peak band — base rates apply at any hour.
      for (const at of ['2026-08-17T12:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T18:30:00Z']) {
        expect(computeTokenCost({ ...base, pricing: degenerate, at: new Date(at) })).toBeCloseTo(
          0.22 + 0.66,
          10,
        );
      }
    });

    it('defaults the billing timestamp to now', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T02:00:00Z'));
      try {
        expect(computeTokenCost({ ...base })).toBeCloseTo(0.44 + 1.32, 10);
      } finally {
        jest.useRealTimers();
      }
    });

    it('ignores a matching tier that lacks its own input/output prices', () => {
      const incomplete: PricingEntry = {
        ...peakPricing,
        time_tiers: [
          {
            windows: ['01:00-04:00'],
            input_price_per_token: null,
            output_price_per_token: 1.32e-6,
          },
        ],
      };
      expect(
        computeTokenCost({ ...base, pricing: incomplete, at: new Date('2026-08-17T02:00:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('ignores malformed windows instead of matching them', () => {
      const malformed: PricingEntry = {
        ...peakPricing,
        time_tiers: [
          {
            windows: ['nonsense', '01:00-'],
            input_price_per_token: 0.44e-6,
            output_price_per_token: 1.32e-6,
          },
        ],
      };
      expect(
        computeTokenCost({ ...base, pricing: malformed, at: new Date('2026-08-17T02:00:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('ignores an hour outside 00-23 instead of opening a band the next day', () => {
      // As a plain minute count "25:00" was unreachable and harmless. As an arc
      // it would open a real band on the following day, repricing a window
      // nobody wrote. 2026-08-18 is a Tuesday, which is where 25:00 would land.
      const corrupt: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], windows: ['25:00-26:00'], days: [] }],
      };
      expect(
        computeTokenCost({ ...base, pricing: corrupt, at: new Date('2026-08-18T01:30:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('ignores a minute outside 00-59', () => {
      const corrupt: PricingEntry = {
        ...peakPricing,
        time_tiers: [{ ...peakPricing.time_tiers![0], windows: ['01:75-02:00'], days: [] }],
      };
      expect(
        computeTokenCost({ ...base, pricing: corrupt, at: new Date('2026-08-18T01:50:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });

    it('ignores an empty tier list', () => {
      const empty: PricingEntry = { ...peakPricing, time_tiers: [] };
      expect(
        computeTokenCost({ ...base, pricing: empty, at: new Date('2026-08-17T02:00:00Z') }),
      ).toBeCloseTo(0.22 + 0.66, 10);
    });
  });

  it('subscription check takes priority over negative pricing guard', () => {
    const negativePricing: PricingEntry = {
      model_name: 'bad-model',
      provider: 'Test',
      input_price_per_token: -1,
      output_price_per_token: -1,
      display_name: null,
    };
    expect(
      computeTokenCost({
        inputTokens: 100,
        outputTokens: 50,
        model: 'bad-model',
        pricing: negativePricing,
        isSubscription: true,
      }),
    ).toBe(0);
  });
});
