import { createSignal, For, Show, onCleanup, type Component } from 'solid-js';
import '../styles/filter-select.css';

interface FilterSelectProps {
  /** Plural noun for the trigger label, e.g. "providers" or "harnesses". */
  noun: string;
  /** All selectable item keys, in display order. */
  items: string[];
  /** Effective selected set (empty set semantics are the caller's business). */
  selected: Set<string>;
  /** Swatch color per item key. */
  colorMap: Record<string, string>;
  /** Optional display name resolver; defaults to the raw item key. */
  displayName?: (item: string) => string;
  onToggle: (item: string) => void;
  onSelectAll: () => void;
  onUnselectAll: () => void;
}

/**
 * Multi-select dropdown used to filter chart series (providers on the agent
 * Overview / ConnectionDetail, harnesses on the global Overview). Owns its
 * open state, outside-click/Escape dismissal, and stylesheet.
 */
const FilterSelect: Component<FilterSelectProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  if (typeof document !== 'undefined') {
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onClickOutside);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    });
  }

  const selectedCount = () => props.items.filter((item) => props.selected.has(item)).length;
  const label = () =>
    selectedCount() === props.items.length
      ? `All ${props.noun} (${props.items.length})`
      : `${selectedCount()} of ${props.items.length} ${props.noun}`;

  return (
    <div class="agent-filter-select" ref={rootRef}>
      <button class="agent-filter-select__trigger" onClick={() => setOpen(!open())} type="button">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        {label()}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="agent-filter-select__dropdown">
          <div class="agent-filter-select__actions">
            <button
              class="agent-filter-select__action-btn"
              type="button"
              disabled={selectedCount() === props.items.length}
              onClick={() => props.onSelectAll()}
            >
              Select all
            </button>
          </div>
          <For each={props.items}>
            {(item) => {
              const isOn = () => props.selected.has(item);
              return (
                <button
                  class="agent-filter-select__item"
                  onClick={() => props.onToggle(item)}
                  type="button"
                  disabled={props.items.length <= 1}
                >
                  <span
                    class="agent-filter-select__swatch"
                    style={{ background: props.colorMap[item] }}
                  />
                  <span class="agent-filter-select__name">
                    {props.displayName ? props.displayName(item) : item}
                  </span>
                  <span
                    class="agent-filter-select__toggle"
                    classList={{ 'agent-filter-select__toggle--on': isOn() }}
                  >
                    <span class="agent-filter-select__toggle-thumb" />
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default FilterSelect;
