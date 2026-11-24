import { createMemo, createResource, type Component } from 'solid-js';
import { Title, Meta } from '@solidjs/meta';
import CodeBlock from '../../components/CodeBlock.jsx';
import { installOrigin } from '../../services/install-endpoints.js';
import { checkIsSelfHosted } from '../../services/setup-status.js';

const DOCS_URL = 'https://manifest.build/llm-gateway/docs/cli/';
const PACKAGE = 'mnfst-gateway-cli';

/**
 * On a self-hosted install the CLI has to be told which host to talk to, and
 * this dashboard is the only place that knows it. On Cloud the CLI already
 * defaults there, so the flag would be noise.
 *
 * `pinHost` is deliberately "not known to be Cloud" rather than "known to be
 * self-hosted". While the deployment check is in flight, or if it fails, the
 * honest fallback is the explicit form: `--url` is merely redundant on Cloud,
 * whereas a bare `mnfst login` is plain wrong on a self-hosted install and the
 * user would copy it before the check resolved.
 */
export function loginCommand(pinHost: boolean, origin: string): string {
  return pinHost ? `mnfst login --url ${origin}` : 'mnfst login';
}

const EXAMPLE = `mnfst agent create --name coding-assistant --platform openclaw
mnfst provider connect xai --auth-type api_key --credential-env XAI_API_KEY
mnfst agent configure coding-assistant --models grok-4.5,grok-4 --provider xai
mnfst routing test coding-assistant`;

const Cli: Component = () => {
  // A failed deployment check must not throw into the render tree: this page
  // has a correct answer for "unknown" and nothing to escalate. Swallowing it
  // here keeps the failure indistinguishable from still-loading, which is what
  // the memo below already handles.
  const [selfHosted] = createResource(() => checkIsSelfHosted().catch(() => undefined));
  // Only a confirmed Cloud install drops the flag; unresolved and errored both
  // keep it, so a self-hosted user never sees a command that targets Cloud.
  const login = createMemo(() => loginCommand(selfHosted() !== false, installOrigin()));

  return (
    <div class="container--lg">
      <Title>CLI - Manifest</Title>
      <Meta
        name="description"
        content="Install the mnfst CLI and manage harnesses, providers, routing and request logs from the terminal."
      />
      <div class="page-header">
        <div>
          <h1 class="page-header__title">CLI</h1>
          <p class="page-header__subtitle">
            Everything the dashboard does, from a terminal, a script, or a coding agent
          </p>
        </div>
      </div>

      <div class="integration-grid">
        <div class="panel">
          <div class="panel__title">1. Install</div>
          <p class="integration-panel__desc">
            The package is <code>mnfst-gateway-cli</code>, but the command you type is{' '}
            <code>mnfst</code>. Its version tracks the Manifest release it ships with.
          </p>
          <CodeBlock code={`npm install -g ${PACKAGE}`} language="bash" />
        </div>

        <div class="panel">
          <div class="panel__title">2. Sign in</div>
          <p class="integration-panel__desc">
            This opens your browser, you approve, and the CLI stores a token for this host. The
            token never travels through the URL.
          </p>
          <CodeBlock code={login()} language="bash" />
        </div>
      </div>

      <div class="panel" style="margin-top: var(--gap-lg);">
        <div class="integration-panel__header">
          <div class="panel__title">3. Drive it</div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn--outline btn--sm"
            style="text-decoration: none;"
          >
            All commands
          </a>
        </div>
        <p class="integration-panel__desc">
          Create a harness, connect a provider, set a route, and prove it works with one real
          request.
        </p>
        <CodeBlock code={EXAMPLE} language="bash" />
      </div>
    </div>
  );
};

export default Cli;
