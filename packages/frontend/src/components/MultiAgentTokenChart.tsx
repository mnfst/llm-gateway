import { createSignal, type Component } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import ChartHoverTooltip, {
  HIDDEN_TOOLTIP,
  formatTooltipDate,
  snapToBucket,
  type HoverTooltipState,
} from './ChartHoverTooltip.jsx';
import { getHslA } from '../services/theme.js';
import { formatNumber, formatCost } from '../services/formatters.js';
import {
  useChartLifecycle,
  createBaseAxes,
  parseTimestamps,
  createTimeScaleRange,
  createFormatLegendTimestamp,
  formatLegendTokens,
  isMultiDayRange,
  fillDailyGaps,
} from '../services/chart-utils.js';

export const AGENT_COLORS = [
  '#1cc4bf',
  '#2430F0',
  '#FE076E',
  '#9531F9',
  '#FDCF3B',
  '#0F1683',
  '#26d9d3',
  '#F97316',
  '#10B981',
  '#EC4899',
  '#8B5CF6',
  '#06B6D4',
  '#F59E0B',
  '#6366F1',
  '#14B8A6',
  '#E11D48',
  '#7C3AED',
  '#0EA5E9',
  '#84CC16',
  '#D946EF',
];

interface MultiAgentTokenChartProps {
  agents: string[];
  timeseries: Array<Record<string, number | string>>;
  range: string;
  colorMap?: Record<string, string>;
  onHoverValues?: (values: Record<string, number> | null) => void;
  /** When set (e.g. "Requests"), y-axis formats as plain numbers instead of token suffixes. */
  label?: string;
}

const MultiAgentTokenChart: Component<MultiAgentTokenChartProps> = (props) => {
  let el!: HTMLDivElement;
  let rawData: number[][] = [];
  const isCost = () => props.label === 'Cost';
  const fmtVal = (v: number) => (isCost() ? (formatCost(v) ?? '$0.00') : formatNumber(v));

  const [tooltip, setTooltip] = createSignal<HoverTooltipState>(HIDDEN_TOOLTIP);

  const bucketKey = () => (props.range === '24h' ? 'hour' : 'date');

  const buildData = (): uPlot.AlignedData => {
    const key = bucketKey();
    const filled = fillDailyGaps(props.timeseries as any[], props.range, key, (k) => {
      const row: Record<string, number | string> = { [key]: k };
      for (const agent of props.agents) row[agent] = 0;
      return row;
    });

    const timestamps = parseTimestamps(filled as any[]);

    rawData = props.agents.map((agent) =>
      filled.map((d: any) => Math.max(0, Number(d[agent] ?? 0))),
    );

    const cumulative: number[][] = [];
    for (let i = 0; i < props.agents.length; i++) {
      const prev = i > 0 ? cumulative[i - 1]! : timestamps.map(() => 0);
      cumulative.push(rawData[i]!.map((v, j) => v + (prev[j] ?? 0)));
    }

    const reversed = [...cumulative].reverse();
    return [timestamps, ...reversed];
  };

  useChartLifecycle({
    el: () => el,
    data: () => props.timeseries,
    buildData,
    structureKey: () => `${props.range}::${props.agents.join(',')}`,
    buildChart() {
      if (!el) return null;
      const w = el.clientWidth || el.getBoundingClientRect().width;
      if (w === 0) return null;

      const axisColor = getHslA('--foreground', 0.55);
      const gridColor = getHslA('--foreground', 0.05);

      const bars = uPlot.paths.bars!({ size: [1, 20], gap: 2 });
      const reversedAgents = [...props.agents].reverse();
      const multiDay = isMultiDayRange(props.range);

      // Per-agent fallback color, keyed on the agent's ORIGINAL index in
      // props.agents (not the reversed render order), so each series gets a
      // distinct color instead of all collapsing onto AGENT_COLORS[0]. An
      // explicit colorMap entry still takes precedence.
      const colorFor = (agent: string) => {
        const i = props.agents.indexOf(agent);
        return props.colorMap?.[agent] ?? AGENT_COLORS[i % AGENT_COLORS.length] ?? '#888';
      };

      const series: uPlot.Series[] = [
        { value: createFormatLegendTimestamp(props.range) },
        ...reversedAgents.map((agent) => ({
          label: agent,
          scale: 'y' as const,
          stroke: colorFor(agent),
          fill: colorFor(agent),
          width: 0,
          paths: bars,
          points: { show: false },
          value: formatLegendTokens,
        })),
      ];

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
                  props.onHoverValues?.(null);
                  setTooltip((prev) => ({ ...prev, visible: false }));
                  return;
                }

                // Raw (un-stacked) values
                const vals: Record<string, number> = {};
                const entries: HoverTooltipState['entries'] = [];
                let total = 0;
                for (let i = 0; i < props.agents.length; i++) {
                  const agentName = props.agents[i]!;
                  const v = rawData[i]?.[idx] ?? 0;
                  vals[agentName] = v;
                  const color =
                    props.colorMap?.[agentName] ?? AGENT_COLORS[i % AGENT_COLORS.length] ?? '#888';
                  entries.push({ label: agentName, value: v, color });
                  total += v;
                }
                props.onHoverValues?.(vals);

                // Sort entries by value descending
                entries.sort((a, b) => b.value - a.value);

                // Bar x position (pixel space)
                const timestamp = u.data[0]?.[idx];
                const barLeft = timestamp != null ? Math.round(u.valToPos(timestamp, 'x')) : 0;
                const chartWidth = u.bbox.width / devicePixelRatio;
                const pastHalf = barLeft > chartWidth / 2;

                const date = timestamp != null ? formatTooltipDate(timestamp, multiDay) : '';

                setTooltip({
                  visible: true,
                  left: barLeft,
                  top: 16,
                  alignRight: pastHalf,
                  date,
                  entries,
                  total,
                });
              },
            ],
          },
          scales: {
            x: {
              time: !multiDay,
              range: createTimeScaleRange(props.range, true),
            },
            y: {
              auto: true,
              range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 100] as [number, number],
            },
          },
          axes: (() => {
            const a = createBaseAxes(axisColor, gridColor, props.range);
            a[1] = {
              ...a[1]!,
              values: (u: uPlot, vals: number[]) =>
                vals.map((v) =>
                  // formatCost surfaces sub-cent values as "< $0.01" instead of
                  // rounding them to "$0.00".
                  isCost() ? (formatCost(v) ?? '$0.00') : formatLegendTokens(u, v),
                ),
            };
            return a;
          })(),
          series,
        },
        buildData(),
        el,
      );
    },
  });

  const hideTooltip = () => {
    setTooltip((prev) => ({ ...prev, visible: false }));
    props.onHoverValues?.(null);
  };

  return (
    <div style="position: relative; overflow: visible;" onMouseLeave={hideTooltip}>
      <div ref={el} style="width: 100%; min-height: 260px;" />
      <ChartHoverTooltip state={tooltip()} fmtVal={fmtVal} hostWidth={() => el?.clientWidth ?? 0} />
    </div>
  );
};

export default MultiAgentTokenChart;
