import { createSignal, For, type Component } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../styles/reliability-card.css';
import ChartHoverTooltip, {
  HIDDEN_TOOLTIP,
  formatTooltipDate,
  snapToBucket,
  type HoverTooltipState,
} from './ChartHoverTooltip.jsx';
import { getHslA } from '../services/theme.js';
import { formatNumber } from '../services/formatters.js';
import {
  useChartLifecycle,
  createBaseAxes,
  parseTimestamps,
  createTimeScaleRange,
  createFormatLegendTimestamp,
  isMultiDayRange,
  fillDailyGaps,
} from '../services/chart-utils.js';
import type { AutofixTimeseries } from '../services/api/analytics.js';

// ---------------------------------------------------------------------------
// Colors per series mode
// ---------------------------------------------------------------------------
const OUTCOME_COLORS: Record<string, string> = {
  success: '#1cc4bf', // --success teal — direct success
  healed: '#2632ef', // blue — recovered by Autofix (must not read as success)
  autofix: '#2632ef', // blue — recovered by autofix
  fallback: '#f2c79c', // warm yellow — recovered by fallback
  error: '#EF4444', // --destructive red
  no_fix_found: '#F59E0B', // amber
  resolving: '#D1D5DB',
  ineffective: '#DC2626',
};

function colorFor(key: string, mode: string, idx: number): string {
  if (mode === 'disposition') return OUTCOME_COLORS[key] ?? '#888';
  if (mode === 'autofix') {
    if (key === 'auto-fixed') return '#1cc4bf';
    return '#EF4444';
  }
  if (mode === 'http_status') {
    if (key.startsWith('2')) return '#1cc4bf'; // success teal, like every chart
    if (key.startsWith('4')) return '#F59E0B';
    if (key.startsWith('5')) return '#EF4444';
    return '#9CA3AF'; // 'No response' and other non-codes: neutral grey
  }
  // error_kind: use a palette
  const palette = [
    '#EF4444',
    '#F59E0B',
    '#3B82F6',
    '#8B5CF6',
    '#EC4899',
    '#06B6D4',
    '#84CC16',
    '#D946EF',
  ];
  if (key === 'none') return '#9CA3AF';
  return palette[idx % palette.length] ?? '#888';
}

function keyLabel(key: string): string {
  if (key === 'none') return 'No error';
  if (key === 'success') return 'Success';
  if (key === 'healed') return 'Success - recovered by Autofix';
  if (key === 'error') return 'Error';
  if (key === 'no_fix_found') return 'No fix found';
  if (key === 'autofix') return 'Success - recovered by Autofix';
  if (key === 'auto-fixed') return 'Autofixed';
  if (key === 'fallback') return 'Success - recovered by Fallback';
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export interface ReliabilityChartProps {
  timeseries: AutofixTimeseries;
  range: string;
  seriesMode: string;
}

/**
 * Fixed reading order for the disposition series — legend AND bar stacking
 * (bottom to top): Success, then healed via Autofix, then healed via
 * Fallback, then Error. Unknown keys keep their incoming order, after these.
 */
const SERIES_ORDER: Record<string, number> = {
  success: 0,
  healed: 1,
  autofix: 1,
  fallback: 2,
  error: 3,
};

function orderTimeseries(d: AutofixTimeseries | undefined): AutofixTimeseries | undefined {
  if (!d) return d;
  const picked = d.keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => (SERIES_ORDER[a.k] ?? 99) - (SERIES_ORDER[b.k] ?? 99) || a.i - b.i);
  return {
    ...d,
    keys: picked.map(({ k }) => k),
    buckets: d.buckets.map((b) => ({
      bucket: b.bucket,
      counts: picked.map(({ i }) => b.counts[i] ?? 0),
    })),
  };
}

const ReliabilityChart: Component<ReliabilityChartProps> = (props) => {
  let el!: HTMLDivElement;
  let rawSeries: number[][] = [];
  const [tooltip, setTooltip] = createSignal<HoverTooltipState>(HIDDEN_TOOLTIP);

  const bucketKey = () => (props.range === '24h' ? 'hour' : 'date');
  const ordered = () => orderTimeseries(props.timeseries);

  const buildData = (): uPlot.AlignedData => {
    const d = ordered();
    if (!d || d.buckets.length === 0) return [new Float64Array(0)];

    const mapped = d.buckets.map((b) => {
      const row: Record<string, number | string> = { [bucketKey()]: b.bucket };
      d.keys.forEach((k, i) => {
        row[k] = b.counts[i] ?? 0;
      });
      return row;
    });

    const filled = fillDailyGaps(mapped as any[], props.range, bucketKey(), (k) => {
      const row: Record<string, number | string> = { [bucketKey()]: k };
      for (const key of d.keys) row[key] = 0;
      return row;
    });

    const timestamps = parseTimestamps(filled as any[]);
    rawSeries = d.keys.map((key) => filled.map((r: any) => Math.max(0, Number(r[key] ?? 0))));

    // Cumulative stacking (bottom to top)
    const cumulative: number[][] = [];
    for (let i = 0; i < d.keys.length; i++) {
      const prev = i > 0 ? cumulative[i - 1]! : timestamps.map(() => 0);
      cumulative.push(rawSeries[i]!.map((v, j) => v + (prev[j] ?? 0)));
    }
    return [timestamps, ...[...cumulative].reverse()];
  };

  useChartLifecycle({
    el: () => el,
    data: () => props.timeseries?.buckets,
    buildData,
    structureKey: () => `${props.range}::${props.seriesMode}::${ordered()?.keys.join(',')}`,
    buildChart() {
      if (!el || !props.timeseries || props.timeseries.buckets.length === 0) return null;

      const d = ordered()!;
      const w = el.clientWidth || el.getBoundingClientRect().width;
      if (w === 0) return null;

      const axisColor = getHslA('--foreground', 0.55);
      const gridColor = getHslA('--foreground', 0.05);
      const bars = uPlot.paths.bars!({ size: [1, 20], gap: 2 });
      const reversed = [...d.keys].reverse();
      const mode = props.seriesMode;

      const series: uPlot.Series[] = [
        { value: createFormatLegendTimestamp(props.range) },
        ...reversed.map((key, idx) => ({
          label: keyLabel(key),
          scale: 'y' as const,
          stroke: colorFor(key, mode, d.keys.length - 1 - idx),
          fill: colorFor(key, mode, d.keys.length - 1 - idx),
          width: 0,
          paths: bars,
          points: { show: false },
          value: (_u: uPlot, v: number) => formatNumber(v),
        })),
      ];

      const multiDay = isMultiDayRange(props.range);
      const data = buildData();
      return new uPlot(
        {
          width: w,
          height: 260,
          padding: [16, 16, 0, 16],
          legend: { show: false },
          cursor: {
            x: true,
            y: false,
            points: { show: false },
            drag: { x: false, y: false },
            move: snapToBucket,
          },
          hooks: {
            setCursor: [
              (u) => {
                const idx = u.cursor.idx;
                if (idx == null || idx < 0) {
                  setTooltip((prev) => ({ ...prev, visible: false }));
                  return;
                }
                // One row per series, in the fixed legend/stacking order
                // (Success, healed via Autofix, via Fallback, Error) — NOT
                // value-sorted like the per-agent charts.
                const entries: HoverTooltipState['entries'] = [];
                let total = 0;
                d.keys.forEach((key, i) => {
                  const v = rawSeries[i]?.[idx] ?? 0;
                  entries.push({ label: keyLabel(key), value: v, color: colorFor(key, mode, i) });
                  total += v;
                });
                const timestamp = u.data[0]?.[idx];
                const barLeft = timestamp != null ? Math.round(u.valToPos(timestamp, 'x')) : 0;
                const chartWidth = u.bbox.width / devicePixelRatio;
                setTooltip({
                  visible: true,
                  left: barLeft,
                  top: 16,
                  alignRight: barLeft > chartWidth / 2,
                  date: timestamp != null ? formatTooltipDate(timestamp, multiDay) : '',
                  entries,
                  total,
                });
              },
            ],
          },
          axes: createBaseAxes(axisColor, gridColor, props.range),
          scales: {
            x: { range: createTimeScaleRange(props.range, true) },
            y: { range: (_u: uPlot, _min: number, max: number) => [0, max * 1.1 || 10] },
          },
          series,
        },
        data,
        el,
      );
    },
  });

  const legendItems = () => {
    const d = ordered();
    if (!d) return [];
    return d.keys.map((key, i) => ({
      key,
      label: keyLabel(key),
      color: colorFor(key, props.seriesMode, i),
    }));
  };

  return (
    <>
      <div
        style="position: relative; overflow: visible;"
        onMouseLeave={() => setTooltip((prev) => ({ ...prev, visible: false }))}
      >
        <div ref={el!} />
        <ChartHoverTooltip
          state={tooltip()}
          fmtVal={formatNumber}
          hostWidth={() => el?.clientWidth ?? 0}
        />
      </div>
      <div class="rel-chart__legend">
        <For each={legendItems()}>
          {(item) => (
            <span class="rel-chart__legend-item">
              <span class="rel-chart__legend-dot" style={{ background: item.color }} />
              {item.label}
            </span>
          )}
        </For>
      </div>
    </>
  );
};

export default ReliabilityChart;
