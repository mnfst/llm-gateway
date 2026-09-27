import { createSignal, Show, type Component } from 'solid-js';
import CopyButton from './CopyButton.jsx';

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

const SetupField: Component<{ label: string; value: string; copyable?: boolean }> = (props) => (
  <div class="setup-onboard-fields__row" role="listitem">
    <span class="setup-onboard-fields__label">{props.label}</span>
    <span class="setup-onboard-fields__value">
      <code>{props.value}</code>
      <Show when={props.copyable}>
        <CopyButton text={props.value} />
      </Show>
    </span>
  </div>
);

const N8nSetup: Component<Props> = (props) => {
  const [keyRevealed, setKeyRevealed] = createSignal(false);

  const credentialBaseUrl = () => props.baseUrl.replace(/\/v1\/?$/, '');
  const hasFullKey = () => !!props.apiKey;
  const masked = () => (props.keyPrefix ? `${props.keyPrefix}...` : 'mnfst_YOUR_KEY');
  const copyKey = () => props.apiKey ?? masked();
  const visibleKey = () => (keyRevealed() && props.apiKey ? props.apiKey : masked());

  return (
    <div class="setup-agents-card">
      <p class="setup-step__desc">
        In n8n, install <code>n8n-nodes-manifest</code>, then add the Manifest Chat Model node to
        your AI Agent or Basic LLM Chain, or the Manifest node for direct calls. Create or select
        Manifest credentials, paste the values below, and set the node model to <code>auto</code>.
      </p>

      <p class="setup-method__hint">
        Reference:{' '}
        <a href="https://www.npmjs.com/package/n8n-nodes-manifest" target="_blank" rel="noreferrer">
          npm package
        </a>{' '}
        and{' '}
        <a
          href="https://docs.n8n.io/integrations/community-nodes/installation-and-management/"
          target="_blank"
          rel="noreferrer"
        >
          n8n community node installation docs
        </a>
      </p>

      <div class="setup-onboard-fields" role="list" aria-label="n8n credential values">
        <SetupField label="Base URL" value={credentialBaseUrl()} copyable />
        <div class="setup-onboard-fields__row" role="listitem">
          <span class="setup-onboard-fields__label">API Key</span>
          <span class="setup-onboard-fields__value">
            <code>{visibleKey()}</code>
            <Show when={hasFullKey()}>
              <button
                class="setup-onboard-fields__eye"
                onClick={() => setKeyRevealed(!keyRevealed())}
                aria-label={keyRevealed() ? 'Hide API key' : 'Reveal API key'}
                title={keyRevealed() ? 'Hide key' : 'Reveal key'}
              >
                <EyeIcon open={keyRevealed()} />
              </button>
            </Show>
            <CopyButton text={copyKey()} />
          </span>
        </div>
        <SetupField label="Model" value="auto" copyable />
      </div>
    </div>
  );
};

export default N8nSetup;
