import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

/** Used until the scroller has a real layout height, so the first paint is windowed. */
export const VIRTUAL_LIST_DEFAULT_VIEWPORT = 480;
const DEFAULT_OVERSCAN = 8;
const RESET_UNSET = Symbol('virtual-list-reset-unset');

export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight: (item: T, index: number) => number;
  overscan?: number;
  class?: string;
  /** When this value changes, the scroller returns to the top. */
  resetKey?: unknown;
  children: (item: T, index: number) => JSX.Element;
}

const VirtualList = <T,>(props: VirtualListProps<T>): JSX.Element => {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(VIRTUAL_LIST_DEFAULT_VIEWPORT);
  let scroller: HTMLDivElement | undefined;

  const applyScrollTop = (next: number) => {
    setScrollTop(next);
    if (scroller) scroller.scrollTop = next;
  };

  const measure = () => {
    const height = scroller?.clientHeight ?? 0;
    if (height > 0) setViewport(height);
  };

  onMount(() => {
    measure();
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  createEffect((previous: unknown) => {
    const key = props.resetKey;
    if (previous !== RESET_UNSET && key !== previous) applyScrollTop(0);
    return key;
  }, RESET_UNSET);

  const layout = createMemo(() => {
    const items = props.items;
    const heights = items.map((item, index) => props.itemHeight(item, index));
    const offsets = new Array<number>(items.length);
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      offsets[i] = acc;
      acc += heights[i]!;
    }
    return { heights, offsets, total: acc };
  });

  createEffect(() => {
    const max = Math.max(0, layout().total - viewport());
    if (untrack(scrollTop) > max) applyScrollTop(max);
  });

  const visible = createMemo(() => {
    const items = props.items;
    const { heights, offsets, total } = layout();
    const overscan = props.overscan ?? DEFAULT_OVERSCAN;
    const top = scrollTop();
    const bottom = top + viewport();

    let lo = 0;
    let hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! + heights[mid]! <= top) lo = mid + 1;
      else hi = mid - 1;
    }
    const start = Math.max(0, lo - overscan);

    lo = start;
    hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! < bottom) lo = mid + 1;
      else hi = mid - 1;
    }
    const end = Math.min(items.length, lo + overscan);
    const slice: T[] = [];
    for (let i = start; i < end; i++) slice.push(items[i]!);
    const last = end - 1;
    return {
      start,
      slice,
      padTop: offsets[start] ?? 0,
      padBottom: total - (last < 0 ? 0 : (offsets[last] ?? 0) + (heights[last] ?? 0)),
    };
  });

  return (
    <div
      class={props.class}
      ref={(el) => {
        scroller = el;
      }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        style={{
          'padding-top': `${visible().padTop}px`,
          'padding-bottom': `${visible().padBottom}px`,
        }}
      >
        <For each={visible().slice}>
          {(item, index) => props.children(item, visible().start + index())}
        </For>
      </div>
    </div>
  );
};

export default VirtualList;
