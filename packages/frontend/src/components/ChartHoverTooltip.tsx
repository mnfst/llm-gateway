import { For, Show, type Component } from 'solid-js';
import type uPlot from 'uplot';
import '../styles/agent-chart-tooltip.css';

/**
 * Shared column-hover tooltip for the stacked bar charts (Cost / Tokens /
 * Requests by provider-harness via MultiAgentTokenChart, and Requests by
 * status / Healed requests via ReliabilityChart). One implementation so the
 * hover reads the same everywhere: snapped cursor, date header, one row per
 * series (swatch, name, value), underlined Total.
 */

export interface HoverEntry {
  label: string;
  value: number;
  color: string;
}

export interface HoverTooltipState {
  visible: boolean;
  left: number;
  top: number;
  alignRight: boolean;
  date: string;
  entries: HoverEntry[];
  total: number;
}

export const HIDDEN_TOOLTIP: HoverTooltipState = {
  visible: false,
  left: 0,
  top: 0,
  alignRight: false,
  date: '',
  entries: [],
  total: 0,
};

/**
 * `cursor.move` hook: snap the vertical cursor line to the nearest data
 * column instead of following the pointer pixel by pixel.
 */
export function snapToBucket(u: uPlot, left: number, top: number): [number, number] {
  const idx = u.posToIdx(left);
  const snappedLeft =
    idx != null && u.data[0]?.[idx] != null ? Math.round(u.valToPos(u.data[0][idx]!, 'x')) : left;
  return [snappedLeft, top];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTooltipDate(epochSec: number, multiDay: boolean): string {
  const d = new Date(epochSec * 1000);
  const day = d.getDate();
  const mon = MONTHS[d.getMonth()]!;
  const year = d.getFullYear();
  if (multiDay) return `${day} ${mon} ${year}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${year}, ${hh}:${mm}`;
}

const ROWS_PER_COL = 16;

export interface ChartHoverTooltipProps {
  state: HoverTooltipState;
  fmtVal: (v: number) => string;
  /** Host width, used to anchor from the right past the chart's midpoint. */
  hostWidth: () => number;
}

const ChartHoverTooltip: Component<ChartHoverTooltipProps> = (props) => {
  const visibleEntries = () => props.state.entries.filter((e) => e.value > 0);
  const columns = () => {
    const items = visibleEntries();
    const cols: Array<typeof items> = [];
    for (let i = 0; i < items.length; i += ROWS_PER_COL) {
      cols.push(items.slice(i, i + ROWS_PER_COL));
    }
    return cols;
  };

  return (
    <Show when={props.state.visible && visibleEntries().length > 0}>
      <div
        class="agent-chart-tooltip"
        style={{
          left: props.state.alignRight ? 'auto' : `${props.state.left + 2}px`,
          right: props.state.alignRight ? `${props.hostWidth() - props.state.left + 2}px` : 'auto',
          top: `${props.state.top}px`,
        }}
      >
        <div class="agent-chart-tooltip__date">{props.state.date}</div>
        <div class="agent-chart-tooltip__columns">
          <For each={columns()}>
            {(col) => (
              <div class="agent-chart-tooltip__list">
                <For each={col}>
                  {(entry) => (
                    <div class="agent-chart-tooltip__row">
                      <span
                        class="agent-chart-tooltip__swatch"
                        style={{ background: entry.color }}
                      />
                      <span class="agent-chart-tooltip__name">{entry.label}</span>
                      <span class="agent-chart-tooltip__value">{props.fmtVal(entry.value)}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <div class="agent-chart-tooltip__total">
          <span>Total</span>
          <span class="agent-chart-tooltip__total-value">{props.fmtVal(props.state.total)}</span>
        </div>
      </div>
    </Show>
  );
};

export default ChartHoverTooltip;
