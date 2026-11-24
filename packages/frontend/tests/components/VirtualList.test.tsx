import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import VirtualList from '../../src/components/VirtualList';

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));

describe('VirtualList', () => {
  it('does not mount items that sit far below the default viewport', () => {
    const { container } = render(() => (
      <VirtualList items={rows(100)} itemHeight={() => 20} class="vl">
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));

    expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-99"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid^="row-"]').length).toBeLessThan(50);
  });

  it('mounts later items after the scroller moves down', () => {
    const { container } = render(() => (
      <VirtualList items={rows(100)} itemHeight={() => 20} class="vl">
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));
    const scroller = container.querySelector('.vl') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1600 });
    fireEvent.scroll(scroller);

    expect(container.querySelector('[data-testid="row-80"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-0"]')).toBeNull();
  });

  it('renders every item when the catalog fits in the viewport', () => {
    const { container } = render(() => (
      <VirtualList items={rows(3)} itemHeight={() => 20} class="vl">
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));

    expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-2"]')).not.toBeNull();
  });

  it('renders an empty spacer when there are no items', () => {
    const { container } = render(() => (
      <VirtualList items={[]} itemHeight={() => 20} class="vl">
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));

    expect(container.querySelector('.vl')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="row-"]').length).toBe(0);
  });

  it('narrows the window after ResizeObserver reports a real scroller height', () => {
    const callbacks: ResizeObserverCallback[] = [];
    class FakeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;

    try {
      const { container, unmount } = render(() => (
        <VirtualList items={rows(100)} itemHeight={() => 20} class="vl">
          {(item) => <div data-testid={item.id}>{item.id}</div>}
        </VirtualList>
      ));
      const scroller = container.querySelector('.vl') as HTMLElement;
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 80 });
      callbacks[0]?.([], {} as ResizeObserver);

      expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="row-20"]')).toBeNull();
      unmount();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('clamps the window when the list shrinks under the current scroll offset', () => {
    const [items, setItems] = createSignal(rows(100));
    const { container } = render(() => (
      <VirtualList items={items()} itemHeight={() => 20} class="vl">
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));
    const scroller = container.querySelector('.vl') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 1600 });
    fireEvent.scroll(scroller);
    setItems(rows(5));

    expect(scroller.scrollTop).toBe(0);
    expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-80"]')).toBeNull();
  });

  it('returns to the top when resetKey changes', () => {
    const [resetKey, setResetKey] = createSignal('all');
    const { container } = render(() => (
      <VirtualList items={rows(100)} itemHeight={() => 20} class="vl" resetKey={resetKey()}>
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));
    const scroller = container.querySelector('.vl') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 1600 });
    fireEvent.scroll(scroller);
    expect(container.querySelector('[data-testid="row-0"]')).toBeNull();

    setResetKey('filtered');

    expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-80"]')).toBeNull();
  });

  it('resets when resetKey goes from unset to a value', () => {
    const [resetKey, setResetKey] = createSignal<string | undefined>(undefined);
    const { container } = render(() => (
      <VirtualList items={rows(100)} itemHeight={() => 20} class="vl" resetKey={resetKey()}>
        {(item) => <div data-testid={item.id}>{item.id}</div>}
      </VirtualList>
    ));
    const scroller = container.querySelector('.vl') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 1600 });
    fireEvent.scroll(scroller);
    expect(container.querySelector('[data-testid="row-0"]')).toBeNull();

    setResetKey('now');

    expect(scroller.scrollTop).toBe(0);
    expect(container.querySelector('[data-testid="row-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-80"]')).toBeNull();
  });
});
