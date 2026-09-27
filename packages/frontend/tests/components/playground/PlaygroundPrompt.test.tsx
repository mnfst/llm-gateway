import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

/* ── Mock ResizeObserver ─────────────────────────────────────── */

type ROCallback = (entries: Array<{ contentRect: { height: number } }>) => void;
let roCallback: ROCallback | null = null;
const roDisconnect = vi.fn();

class MockResizeObserver {
  constructor(cb: ROCallback) {
    roCallback = cb;
  }
  observe() {}
  disconnect() {
    roDisconnect();
  }
  unobserve() {}
}

vi.stubGlobal('ResizeObserver', MockResizeObserver);

import PlaygroundPrompt from '../../../src/components/playground/PlaygroundPrompt';

/* ── Helper ──────────────────────────────────────────────────── */

interface PropsOverride {
  value?: string;
  disabled?: boolean;
  running?: boolean;
  onSubmit?: () => void;
  onChange?: (v: string) => void;
  onRecallPrevious?: () => void;
  onHeightChange?: (h: number) => void;
  historyOpen?: boolean;
  ref?: (el: HTMLTextAreaElement) => void;
}

function setup(o: PropsOverride = {}) {
  const onSubmit = o.onSubmit ?? vi.fn();
  const onChange = o.onChange ?? vi.fn();
  const onRecallPrevious = o.onRecallPrevious ?? vi.fn();
  const utils = render(() => (
    <PlaygroundPrompt
      value={o.value ?? 'hello'}
      disabled={o.disabled ?? false}
      running={o.running ?? false}
      onChange={onChange}
      onSubmit={onSubmit}
      onRecallPrevious={onRecallPrevious}
      onHeightChange={o.onHeightChange}
      historyOpen={o.historyOpen}
      ref={o.ref}
    />
  ));
  const textarea = utils.container.querySelector('textarea') as HTMLTextAreaElement;
  const button = utils.container.querySelector(
    '.playground-prompt__send'
  ) as HTMLButtonElement;
  return { ...utils, textarea, button, onSubmit, onChange, onRecallPrevious };
}

/* ── Existing tests ──────────────────────────────────────────── */

describe('PlaygroundPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roCallback = null;
  });

  it('adds the --history-open class when historyOpen is true', () => {
    const { container } = setup({ historyOpen: true });
    const wrapper = container.querySelector('.playground-prompt-wrapper');
    expect(wrapper!.classList.contains('playground-prompt-wrapper--history-open')).toBe(true);
  });

  it('does NOT add the --history-open class when historyOpen is false', () => {
    const { container } = setup({ historyOpen: false });
    const wrapper = container.querySelector('.playground-prompt-wrapper');
    expect(wrapper!.classList.contains('playground-prompt-wrapper--history-open')).toBe(false);
  });

  it('calls onHeightChange when the ResizeObserver fires and disconnects on cleanup', () => {
    const onHeightChange = vi.fn();
    const { unmount } = setup({ onHeightChange });

    // Simulate a resize observation
    expect(roCallback).not.toBeNull();
    roCallback!([{ contentRect: { height: 200 } }]);
    expect(onHeightChange).toHaveBeenCalledWith(200);

    // Unmount triggers onCleanup which calls ro.disconnect()
    unmount();
    expect(roDisconnect).toHaveBeenCalled();
  });

  it('mounts without error when onHeightChange is not provided (ResizeObserver not created)', () => {
    roCallback = null;
    setup({ value: '' });
    // No ResizeObserver created because onHeightChange is undefined
    expect(roCallback).toBeNull();
  });
});

/* ── Button disabled state ───────────────────────────────────── */

describe('PlaygroundPrompt button disabled state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables send button when disabled=true (non-empty value)', () => {
    const { button } = setup({ value: 'test prompt', disabled: true, running: false });
    expect(button.hasAttribute('disabled')).toBe(true);
    // aria-label depends on `running` only, not `disabled`
    expect(button.getAttribute('aria-label')).toBe('Send prompt');
  });

  it('disables send button when value is empty (disabled=false)', () => {
    const { button } = setup({ value: '', disabled: false, running: false });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('disables send button when value is whitespace-only', () => {
    const { button } = setup({ value: '   \n  ', disabled: false, running: false });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('changes aria-label to "Running" when running=true (button stays enabled)', () => {
    // Source line 117 only flips `disabled` on `props.disabled || empty value` —
    // `running` alone does NOT disable the button, it only changes the aria-label.
    const { button } = setup({ value: 'test prompt', disabled: false, running: true });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Running');
  });

  it('enables send button when disabled=false, value non-empty, running=false', () => {
    const { button } = setup({ value: 'test prompt', disabled: false, running: false });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Send prompt');
  });
});

/* ── Keyboard submission ─────────────────────────────────────── */

describe('PlaygroundPrompt keyboard submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits on plain Enter key', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Cmd+Enter (metaKey) — Mac shortcut', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Ctrl+Enter (ctrlKey) — Windows/Linux shortcut', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does NOT submit on Shift+Enter (multiline / line break)', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT submit when value is empty', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: '', onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT submit when disabled=true', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', disabled: true, onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT submit when running=true', () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: 'test prompt', running: true, onSubmit });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('recalls previous prompt on ArrowUp when value is empty', () => {
    const onRecallPrevious = vi.fn();
    const { textarea } = setup({ value: '', onRecallPrevious });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(onRecallPrevious).toHaveBeenCalledTimes(1);
  });

  it('does NOT recall on ArrowUp when value is non-empty (cursor nav wins)', () => {
    const onRecallPrevious = vi.fn();
    const { textarea } = setup({ value: 'some text', onRecallPrevious });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(onRecallPrevious).not.toHaveBeenCalled();
  });
});

/* ── onChange rapid typing ───────────────────────────────────── */

describe('PlaygroundPrompt onChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards each onInput to onChange with correct value during rapid typing', () => {
    const onChange = vi.fn();
    const { textarea } = setup({ value: '', onChange });
    fireEvent.input(textarea, { target: { value: 'a' } });
    fireEvent.input(textarea, { target: { value: 'ab' } });
    fireEvent.input(textarea, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenNthCalledWith(1, 'a');
    expect(onChange).toHaveBeenNthCalledWith(2, 'ab');
    expect(onChange).toHaveBeenNthCalledWith(3, 'abc');
  });
});

/* ── autoGrow / MAX_PROMPT_LINES cap ─────────────────────────── */

describe('PlaygroundPrompt autoGrow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caps height at MAX_PROMPT_LINES * PROMPT_LINE_HEIGHT_PX (15 * 22 = 330px) when scrollHeight exceeds it', () => {
    const { textarea } = setup({ value: '' });
    // jsdom has no layout; define scrollHeight manually to simulate overflow
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 1000 });
    fireEvent.input(textarea, { target: { value: 'lots\nof\nlines' } });
    expect(textarea.style.height).toBe('330px');
  });

  it('grows textarea to scrollHeight when below the cap', () => {
    const { textarea } = setup({ value: '' });
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 88 });
    fireEvent.input(textarea, { target: { value: 'line1\nline2' } });
    expect(textarea.style.height).toBe('88px');
  });
});

/* ── ref forwarding ────────────────────────────────────────────── */

describe('PlaygroundPrompt ref forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the ref callback with the textarea element on mount', () => {
    const refFn = vi.fn();
    const { textarea } = setup({ ref: refFn });
    expect(refFn).toHaveBeenCalledTimes(1);
    expect(refFn).toHaveBeenCalledWith(textarea);
  });

  it('does not throw when ref prop is not provided', () => {
    expect(() => setup()).not.toThrow();
  });
});
