import { onMount, onCleanup, createEffect, on } from 'solid-js';
import type { Accessor } from 'solid-js';
import uPlot from 'uplot';

interface UseChartLifecycleOptions<T> {
  el: () => HTMLDivElement;
  data: Accessor<T[] | undefined>;
  buildChart: () => uPlot | null;
  /**
   * Optional builder for the chart's aligned data. When provided, a data change
   * that does not alter the chart structure (see `structureKey`) updates the
   * existing uPlot instance in place via `setData` instead of destroying and
   * recreating it — far cheaper on every refetch/range-unchanged update.
   */
  buildData?: () => uPlot.AlignedData;
  /**
   * Identifies the chart's structural configuration (e.g. the selected range,
   * which drives axes/scales). When it changes between data updates the chart
   * is rebuilt; when it stays the same `setData` is used. Defaults to a constant
   * so charts without structural variation always reuse the instance.
   */
  structureKey?: () => unknown;
}

export function useChartLifecycle<T>(opts: UseChartLifecycleOptions<T>): void {
  let chart: uPlot | null = null;
  let ro: ResizeObserver | null = null;
  let lastStructureKey: unknown = opts.structureKey?.();

  const CHART_HEIGHT = 260;

  function tryCreate() {
    if (chart) return;
    const built = opts.buildChart();
    if (built) {
      chart = built;
      chart.setCursor({ left: -1, top: -1 });
    }
  }

  onMount(() => {
    if (!opts.data()?.length) return;

    ro = new ResizeObserver(() => {
      if (!chart) {
        tryCreate();
      } else {
        chart.setSize({ width: opts.el().clientWidth, height: CHART_HEIGHT });
      }
    });
    ro.observe(opts.el());

    setTimeout(tryCreate, 50);
  });

  createEffect(
    on(
      opts.data,
      () => {
        const key = opts.structureKey?.();
        const sameStructure = key === lastStructureKey;
        lastStructureKey = key;

        if (chart && opts.buildData && sameStructure) {
          chart.setData(opts.buildData());
          return;
        }
        if (chart) {
          chart.destroy();
          chart = null;
        }
        if (opts.data()?.length) setTimeout(tryCreate, 0);
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    ro?.disconnect();
    chart?.destroy();
    chart = null;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function createFormatLegendTimestamp(
  range?: string,
): (_u: uPlot, epochSec: number) => string {
  const multiDay = MULTI_DAY_RANGES.has(range ?? '');
  return (_u: uPlot, epochSec: number): string => {
    if (epochSec == null || isNaN(epochSec)) return '';
    const d = new Date(epochSec * 1000);
    const mon = MONTHS[d.getMonth()]!;
    const day = d.getDate();
    if (multiDay) return `${mon} ${day}`;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${mon} ${day}, ${hh}:${mm}`;
  };
}

export function formatLegendTokens(_u: uPlot, val: number): string {
  if (val == null || isNaN(val)) return '';
  val = Math.round(val);
  if (val >= 1_000_000) {
    const v = val / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (val >= 1_000) {
    const v = val / 1_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`;
  }
  return val.toString();
}

const RANGE_MAP: Record<string, number> = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
  '90d': 7776000,
  '365d': 31536000,
};

const MULTI_DAY_RANGES = new Set(['7d', '30d', '90d', '365d']);
const INTRADAY_RANGES = new Set(['1h', '6h', '24h']);
const MAX_MULTIDAY_AXIS_LABELS = 10;

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const RANGE_HOURS: Record<string, number> = { '6h': 6, '24h': 24 };

export function rangeToSeconds(range: string): number {
  return RANGE_MAP[range] ?? 86400;
}

/** Slot width in seconds. Daily for multi-day ranges, hourly otherwise. */
export function binWidthSeconds(range: string | undefined): number {
  return MULTI_DAY_RANGES.has(range ?? '') ? 86400 : 3600;
}

/**
 * Fill missing days/hours in sparse backend data so charts have
 * evenly spaced data points. For multi-day ranges, fills one point per
 * calendar day. For hourly ranges, fills one point per hour up to the current
 * hour.
 */
export function fillDailyGaps<T extends Record<string, unknown>>(
  data: T[],
  range: string,
  dateField: string,
  zeroEntry: (date: string) => T,
): T[] {
  const hours = RANGE_HOURS[range];
  if (hours) {
    // Use local time to match the backend, which stores timestamps in the
    // Node process's local timezone via the pg driver.
    const now = new Date();
    now.setMinutes(0, 0, 0);

    const hourMap = new Map<string, T>();
    for (let i = hours; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600000);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const key = `${y}-${mo}-${da}T${hh}:00:00`;
      hourMap.set(key, zeroEntry(key));
    }

    for (const row of data) {
      const key = String(row[dateField] ?? '');
      if (hourMap.has(key)) {
        hourMap.set(key, row);
      }
    }

    return Array.from(hourMap.values());
  }

  const days = RANGE_DAYS[range];
  if (!days) return data;

  // Use local midnight so date labels match the user's calendar
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dateMap = new Map<string, T>();
  for (let i = days; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${mo}-${da}`;
    dateMap.set(key, zeroEntry(key));
  }

  for (const row of data) {
    const key = String(row[dateField] ?? '');
    if (dateMap.has(key)) {
      dateMap.set(key, row);
    }
  }

  return Array.from(dateMap.values());
}

export function formatAxisTimestamp(epochSec: number, range: string): string {
  const d = new Date(epochSec * 1000);
  if (INTRADAY_RANGES.has(range)) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  const mon = MONTHS[d.getMonth()]!;
  const day = d.getDate();
  return `${mon} ${day}`;
}

export function isMultiDayRange(range?: string): boolean {
  return MULTI_DAY_RANGES.has(range ?? '');
}

export function createBaseAxes(axisColor: string, gridColor: string, range?: string): uPlot.Axis[] {
  const multiDay = MULTI_DAY_RANGES.has(range ?? '');
  // Resolve the effective range label for axis formatting: if an explicit range
  // is provided use it; otherwise fall back to a dynamic span-based label so
  // formatAxisTimestamp still receives a valid range string.
  const effectiveRange = range ?? '';
  const xAxis: uPlot.Axis = {
    stroke: axisColor,
    grid: { stroke: gridColor, width: 1 },
    ticks: { stroke: gridColor, width: 1 },
    font: '11px "DM Sans", sans-serif',
    gap: 8,
    // For multi-day ranges, place grid lines exactly at each data point
    ...(multiDay ? { splits: (u: uPlot) => Array.from(u.data[0]) } : {}),
    values: (u: uPlot, vals: number[]) => {
      // When no explicit range was provided, derive one from the visible span
      let labelRange = effectiveRange;
      if (!labelRange) {
        const span =
          (u.scales.x?.max ?? vals[vals.length - 1] ?? 0) - (u.scales.x?.min ?? vals[0] ?? 0);
        labelRange = span > 86400 ? '7d' : '24h';
      }
      const labels = vals.map((v) => formatAxisTimestamp(v, labelRange));
      // Dedup consecutive identical labels
      const deduped = labels.map((l, i) => (i > 0 && l === labels[i - 1] ? '' : l));
      // Thin labels for multi-day ranges so they don't overlap
      if (multiDay) {
        const uniqueLabels = deduped.filter((l) => l !== '');
        const step =
          uniqueLabels.length > MAX_MULTIDAY_AXIS_LABELS
            ? Math.ceil(uniqueLabels.length / MAX_MULTIDAY_AXIS_LABELS)
            : 1;
        if (step > 1) {
          let count = 0;
          return deduped.map((l) => {
            if (l === '') return '';
            return count++ % step === 0 ? l : '';
          });
        }
      }
      return deduped;
    },
  };

  return [
    xAxis,
    {
      stroke: axisColor,
      grid: { stroke: gridColor, width: 1 },
      ticks: { show: false },
      font: '11px "DM Sans", sans-serif',
      size: 54,
      gap: 8,
    },
  ];
}

export function parseTimestamps(
  data: Array<{ hour?: string; date?: string } & Record<string, unknown>>,
): number[] {
  return data.map((d) => {
    if (d.hour) {
      // Hour strings from the backend are in local time (the pg driver
      // serialises JS Dates using the Node process's local timezone).
      // Parse without appending 'Z' so they stay in local time.
      const iso = d.hour.replace(' ', 'T');
      return new Date(iso).getTime() / 1000;
    }
    const dateStr = (d.date as string) ?? '';
    const [y, m, day] = dateStr.split('-').map(Number);
    return new Date(y!, m! - 1, day!).getTime() / 1000;
  });
}

const MIN_SPAN = 6 * 3600; // 6 hours in seconds

export function createTimeScaleRange(
  range?: string,
  bars: boolean = false,
): (_u: uPlot, min: number, max: number) => [number, number] {
  const multiDay = MULTI_DAY_RANGES.has(range ?? '');
  const intraday = INTRADAY_RANGES.has(range ?? '');
  const rangeSec = range ? rangeToSeconds(range) : 0;
  // Bars are slot-centered; pad half a slot so the last bar fits.
  const halfBin = bars ? binWidthSeconds(range) / 2 : 0;
  return (_u: uPlot, min: number, max: number): [number, number] => {
    const now = Date.now() / 1000;
    if (multiDay) {
      return [min - halfBin, max + halfBin];
    }
    if (intraday) {
      return [now - rangeSec - halfBin, now + halfBin];
    }
    const clampedMax = Math.min(max, now);
    const span = clampedMax - min;
    if (span < MIN_SPAN) {
      return [clampedMax - MIN_SPAN - halfBin, clampedMax + halfBin];
    }
    return [min - halfBin, clampedMax + halfBin];
  };
}
