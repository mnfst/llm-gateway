import { createSignal } from 'solid-js';
import { COMPACT_COLUMNS } from '../components/message-table-types.js';

export const RANGE_STORAGE_KEY = 'manifest_chart_range';
export const VALID_RANGES = new Set(['24h', '7d', '30d', '90d', '365d']);

/**
 * Shared range signal + localStorage persistence for Overview pages.
 * Returns `range`, `setRange`, and `handleRangeChange`.
 * `handleRangeChange` persists the new value and, when `markUserSelected` is
 * provided, calls it so the smart-range cascade in the per-agent Overview knows
 * the user made an explicit choice.
 */
export function useOverviewRange(options?: { markUserSelected?: () => void }) {
  const saved = localStorage.getItem(RANGE_STORAGE_KEY);
  const [range, setRange] = createSignal(saved && VALID_RANGES.has(saved) ? saved : '30d');

  const handleRangeChange = (value: string) => {
    setRange(value);
    options?.markUserSelected?.();
    localStorage.setItem(RANGE_STORAGE_KEY, value);
  };

  return { range, setRange, handleRangeChange };
}

/**
 * Shared Messages-table columns for the Overview pages. Kept as a hook so callers
 * stay stable, though the column set is now the same everywhere.
 */
export function useOverviewColumns() {
  const columns = () => COMPACT_COLUMNS;
  return { columns };
}
