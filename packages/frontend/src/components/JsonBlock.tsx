import { Show, type Component } from 'solid-js';
import { highlight } from '../services/syntax-highlight.js';

const MAX_HIGHLIGHT_BYTES = 50_000;

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface Props {
  value: unknown;
  class?: string;
}

const JsonBlock: Component<Props> = (props) => {
  const json = () => serialize(props.value);
  const tooLarge = () => json().length > MAX_HIGHLIGHT_BYTES;
  const html = () => (tooLarge() ? null : highlight(json(), 'json'));
  const kb = () => Math.round(json().length / 1024);

  return (
    <div class={`json-block-wrap${props.class ? ` ${props.class}` : ''}`}>
      <Show when={tooLarge()}>
        <div class="json-block__size-notice">
          Highlighting skipped — payload is {kb()} KB. Showing plain text.
        </div>
      </Show>
      <pre class="json-block">
        {html() != null ? (
          <code class="hljs language-json" innerHTML={html()!} />
        ) : (
          <code class="hljs">{json()}</code>
        )}
      </pre>
    </div>
  );
};

export default JsonBlock;
