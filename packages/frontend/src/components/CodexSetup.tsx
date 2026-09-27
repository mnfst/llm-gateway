import { createSignal, Show, type Component } from 'solid-js';
import { getCodexConfigSnippet, getCodexKeyExportSnippet } from 'manifest-shared';
import CopyButton from './CopyButton.jsx';
import CodeBlock from './CodeBlock.jsx';

interface Props {
  apiKey: string | null;
  keyPrefix: string | null;
  baseUrl: string;
}

const EyeIcon: Component<{ open: boolean }> = (props) => (
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
    <Show
      when={props.open}
      fallback={
        <>
          <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
          <circle cx="12" cy="12" r="3" />
        </>
      }
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </Show>
  </svg>
);

const CodexSetup: Component<Props> = (props) => {
  const [keyRevealed, setKeyRevealed] = createSignal(false);

  const placeholderKey = 'mnfst_YOUR_KEY';
  const hasFullKey = () => !!props.apiKey;
  const masked = () => (props.keyPrefix ? `${props.keyPrefix}...` : placeholderKey);
  const copyKey = () => props.apiKey ?? placeholderKey;
  const visibleKey = () => {
    if (!props.apiKey) return placeholderKey;
    return keyRevealed() ? props.apiKey : masked();
  };

  const configCopy = () => getCodexConfigSnippet(props.baseUrl);
  const configShown = () => getCodexConfigSnippet(props.baseUrl);
  const keyExportCopy = () => getCodexKeyExportSnippet(copyKey());
  const keyExportShown = () => getCodexKeyExportSnippet(visibleKey());

  return (
    <div class="setup-agents-card">
      <p class="setup-method__hint">
        Add this block to your global{' '}
        <code class="setup-model-hint__code">~/.codex/config.toml</code>. Codex CLI and Desktop both
        read this file. Restart Codex after you save it.
      </p>

      <div class="setup-cli-block">
        <div class="setup-cli-block__actions">
          <CopyButton text={configCopy()} />
        </div>
        <CodeBlock code={configShown()} language="toml" />
      </div>

      <p class="setup-method__hint">
        Export your Manifest key, then launch Codex CLI from the same terminal. For Desktop, make
        this variable available in the environment that launches the app, then fully quit and reopen
        Codex. An export in a separate terminal does not update a running app.
      </p>

      <div class="setup-cli-block">
        <div class="setup-cli-block__actions">
          <Show when={hasFullKey()}>
            <button
              class="modal-terminal__copy"
              onClick={() => setKeyRevealed(!keyRevealed())}
              aria-label={keyRevealed() ? 'Hide API key' : 'Reveal API key'}
              title={keyRevealed() ? 'Hide key' : 'Reveal key'}
            >
              <EyeIcon open={keyRevealed()} />
            </button>
          </Show>
          <CopyButton text={keyExportCopy()} />
        </div>
        <CodeBlock code={keyExportShown()} language="bash" />
      </div>
    </div>
  );
};

export default CodexSetup;
