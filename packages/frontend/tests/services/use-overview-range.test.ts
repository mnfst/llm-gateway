import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'solid-js';
import {
  RANGE_STORAGE_KEY,
  VALID_RANGES,
  useOverviewRange,
  useOverviewColumns,
} from '../../src/services/use-overview-range';

const mockCheckIsSelfHosted = vi.fn(() => Promise.resolve(false));
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

vi.mock('../../src/components/message-table-types.js', () => ({
  COMPACT_COLUMNS: ['status', 'trigger', 'date', 'model'],
}));

describe('use-overview-range', () => {
  beforeEach(() => {
    localStorage.clear();
    mockCheckIsSelfHosted.mockResolvedValue(false);
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('RANGE_STORAGE_KEY', () => {
    it('is the expected localStorage key string', () => {
      expect(RANGE_STORAGE_KEY).toBe('manifest_chart_range');
    });
  });

  describe('VALID_RANGES', () => {
    it('contains the supported dashboard ranges', () => {
      expect(VALID_RANGES.has('24h')).toBe(true);
      expect(VALID_RANGES.has('7d')).toBe(true);
      expect(VALID_RANGES.has('30d')).toBe(true);
      expect(VALID_RANGES.has('90d')).toBe(true);
      expect(VALID_RANGES.has('365d')).toBe(true);
    });

    it('does not contain invalid values', () => {
      expect(VALID_RANGES.has('1y')).toBe(false);
      expect(VALID_RANGES.has('')).toBe(false);
    });
  });

  describe('useOverviewRange', () => {
    it('defaults to 30d when localStorage is empty', () => {
      let rangeValue: string | undefined;
      const dispose = createRoot((d) => {
        const { range } = useOverviewRange();
        rangeValue = range();
        return d;
      });
      expect(rangeValue).toBe('30d');
      dispose();
    });

    it('reads saved range from localStorage when valid', () => {
      localStorage.setItem(RANGE_STORAGE_KEY, '365d');
      let rangeValue: string | undefined;
      const dispose = createRoot((d) => {
        const { range } = useOverviewRange();
        rangeValue = range();
        return d;
      });
      expect(rangeValue).toBe('365d');
      dispose();
    });

    it('falls back to 30d when localStorage contains an invalid value', () => {
      localStorage.setItem(RANGE_STORAGE_KEY, 'invalid-range');
      let rangeValue: string | undefined;
      const dispose = createRoot((d) => {
        const { range } = useOverviewRange();
        rangeValue = range();
        return d;
      });
      expect(rangeValue).toBe('30d');
      dispose();
    });

    it('handleRangeChange updates the signal and persists to localStorage', () => {
      let rangeValue: (() => string) | undefined;
      let handleChange: ((v: string) => void) | undefined;
      const dispose = createRoot((d) => {
        const { range, handleRangeChange } = useOverviewRange();
        rangeValue = range;
        handleChange = handleRangeChange;
        return d;
      });

      handleChange!('24h');

      expect(rangeValue!()).toBe('24h');
      expect(localStorage.getItem(RANGE_STORAGE_KEY)).toBe('24h');
      dispose();
    });

    it('handleRangeChange calls markUserSelected when provided', () => {
      const markUserSelected = vi.fn();
      let handleChange: ((v: string) => void) | undefined;
      const dispose = createRoot((d) => {
        const { handleRangeChange } = useOverviewRange({ markUserSelected });
        handleChange = handleRangeChange;
        return d;
      });

      handleChange!('7d');

      expect(markUserSelected).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('handleRangeChange does not throw when markUserSelected is not provided', () => {
      let handleChange: ((v: string) => void) | undefined;
      const dispose = createRoot((d) => {
        const { handleRangeChange } = useOverviewRange();
        handleChange = handleRangeChange;
        return d;
      });

      expect(() => handleChange!('24h')).not.toThrow();
      dispose();
    });

    it('exposes setRange for direct signal mutation', () => {
      let rangeValue: (() => string) | undefined;
      let setRangeFunc: ((v: string) => void) | undefined;
      const dispose = createRoot((d) => {
        const { range, setRange } = useOverviewRange();
        rangeValue = range;
        setRangeFunc = setRange;
        return d;
      });

      setRangeFunc!('7d');
      expect(rangeValue!()).toBe('7d');
      dispose();
    });
  });

  describe('useOverviewColumns', () => {
    it('returns COMPACT_COLUMNS (the same set everywhere now that feedback is gone)', () => {
      let cols: (() => string[]) | undefined;
      const dispose = createRoot((d) => {
        const { columns } = useOverviewColumns();
        cols = columns;
        return d;
      });
      expect(cols!()).toEqual(['status', 'trigger', 'date', 'model']);
      dispose();
    });
  });
});
