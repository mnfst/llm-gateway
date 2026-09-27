import {
  Show,
  createEffect,
  createSignal,
  onMount,
  onCleanup,
  type Component,
  type JSX,
} from 'solid-js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onRecallPrevious: () => void;
  disabled: boolean;
  running: boolean;
  headersSlot?: JSX.Element;
  historyOpen?: boolean;
  onHeightChange?: (height: number) => void;
  ref?: (el: HTMLTextAreaElement) => void;
}

const MAX_PROMPT_LINES = 15;
const PROMPT_LINE_HEIGHT_PX = 22;

const PlaygroundPrompt: Component<Props> = (props) => {
  const [ref, setRef] = createSignal<HTMLTextAreaElement | undefined>();
  let wrapperRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!wrapperRef || !props.onHeightChange) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        props.onHeightChange?.(entry.contentRect.height);
      }
    });
    ro.observe(wrapperRef);
    onCleanup(() => ro.disconnect());
  });

  const autoGrow = () => {
    const el = ref();
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_PROMPT_LINES * PROMPT_LINE_HEIGHT_PX)}px`;
  };

  // Recalled / history-loaded prompts set `value` programmatically without an
  // input event, so resize whenever the value changes. autoGrow() reads ref()
  // internally, so the effect also re-runs once the textarea mounts.
  createEffect(() => {
    void props.value;
    autoGrow();
  });

  const submit = () => {
    if (props.disabled || props.running) return;
    if (props.value.trim().length === 0) return;
    props.onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const composing =
      (event as KeyboardEvent & { isComposing?: boolean }).isComposing || event.keyCode === 229;
    if (composing) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'ArrowUp' && props.value.length === 0) {
      event.preventDefault();
      props.onRecallPrevious();
    }
  };

  return (
    <div
      ref={wrapperRef}
      class="playground-prompt-wrapper"
      classList={{ 'playground-prompt-wrapper--history-open': props.historyOpen }}
    >
      <form
        class="playground-prompt"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={(el) => {
            setRef(el);
            props.ref?.(el);
          }}
          class="playground-prompt__textarea"
          placeholder="Send a prompt to compare models..."
          value={props.value}
          rows={1}
          disabled={props.disabled && !props.running}
          onInput={(event) => {
            props.onChange(event.currentTarget.value);
            autoGrow();
          }}
          onKeyDown={handleKeyDown}
          aria-label="Run prompt"
        />
        <div class="playground-prompt__toolbar">
          <div class="playground-prompt__toolbar-left">
            <Show when={props.headersSlot}>{props.headersSlot}</Show>
          </div>
          <button
            type="submit"
            class="playground-prompt__send"
            disabled={props.disabled || props.value.trim().length === 0}
            aria-label={props.running ? 'Running' : 'Send prompt'}
          >
            <Show
              when={!props.running}
              fallback={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-dasharray="28"
                    stroke-dashoffset="8"
                  >
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 8 8"
                      to="360 8 8"
                      dur="0.8s"
                      repeatCount="indefinite"
                    />
                  </circle>
                </svg>
              }
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path
                  d="M8 3L8 13M8 3L4 7M8 3L12 7"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  fill="none"
                />
              </svg>
            </Show>
          </button>
        </div>
      </form>
    </div>
  );
};

export default PlaygroundPrompt;
