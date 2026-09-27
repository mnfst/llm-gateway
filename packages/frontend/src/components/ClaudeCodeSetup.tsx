import { createSignal, Show, type Component } from 'solid-js';
import CopyButton from './CopyButton.jsx';
import CodeBlock from './CodeBlock.jsx';
import { getClaudeCodeSettingsSnippet } from '../services/framework-snippets.js';

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

const ClaudeCodeSetup: Component<Props> = (props) => {
  const [keyRevealed, setKeyRevealed] = createSignal(false);

  const hasFullKey = () => !!props.apiKey;
  const masked = () => (props.keyPrefix ? `${props.keyPrefix}...` : 'mnfst_YOUR_KEY');
  const copyKey = () => props.apiKey ?? masked();
  const visibleKey = () => (keyRevealed() && props.apiKey ? props.apiKey : masked());

  const settingsCopy = () => getClaudeCodeSettingsSnippet(props.baseUrl, copyKey());
  const settingsShown = () => getClaudeCodeSettingsSnippet(props.baseUrl, visibleKey());

  return (
    <div class="setup-agents-card">
      <p class="setup-method__hint">
        Add this block to <code class="setup-model-hint__code">~/.claude/settings.json</code>. Every{' '}
        <code class="setup-model-hint__code">claude</code> run will route through Manifest with{' '}
        <code class="setup-model-hint__code">auto</code>.
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
          <CopyButton text={settingsCopy()} />
        </div>
        <CodeBlock code={settingsShown()} language="json" />
      </div>

      <p class="setup-method__hint">
        Through a gateway, Claude Code assumes a 200k context window and compacts long sessions
        early. For long-context work, pin a 1M model instead of{' '}
        <code class="setup-model-hint__code">auto</code>, for example{' '}
        <code class="setup-model-hint__code">/model claude-opus-5-5[1m]</code>.
      </p>
    </div>
  );
};

export default ClaudeCodeSetup;
