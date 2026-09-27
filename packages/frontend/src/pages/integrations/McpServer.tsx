import { createMemo, createResource, createSignal, For, Show, type Component } from 'solid-js';
import { Title, Meta } from '@solidjs/meta';
import { PLATFORM_ICONS } from 'manifest-shared';
import CodeBlock from '../../components/CodeBlock.jsx';
import { mcpEndpoint } from '../../services/install-endpoints.js';
import { checkMcpEnabled } from '../../services/setup-status.js';

const DOCS_URL = 'https://manifest.build/llm-gateway/docs/integrations/mcp/';

interface ClientSetup {
  id: string;
  label: string;
  icon?: string;
  language: string;
  code: string;
}

/**
 * One client, one snippet: data, so the page stays a tab list rather than a
 * wall. Typed non-empty so the active-tab fallback to [0] is always defined.
 */
export function clientSetups(endpoint: string): [ClientSetup, ...ClientSetup[]] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      icon: PLATFORM_ICONS['claude-code'],
      language: 'bash',
      code: `claude mcp add --transport http manifest ${endpoint}`,
    },
    {
      id: 'codex',
      label: 'Codex',
      icon: PLATFORM_ICONS.codex,
      language: 'bash',
      code: `codex mcp add manifest --url ${endpoint}\ncodex mcp login manifest`,
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      icon: PLATFORM_ICONS.opencode,
      language: 'json',
      code: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "manifest": {
      "type": "remote",
      "url": "${endpoint}",
      "enabled": true
    }
  }
}`,
    },
    {
      id: 'other',
      label: 'Other',
      icon: PLATFORM_ICONS.other,
      language: 'json',
      code: `{
  "mcpServers": {
    "manifest": {
      "url": "${endpoint}"
    }
  }
}`,
    },
  ];
}

const McpServer: Component = () => {
  const endpoint = createMemo(() => mcpEndpoint());
  const clients = createMemo(() => clientSetups(endpoint()));
  const [activeId, setActiveId] = createSignal('claude-code');
  const active = createMemo(() => clients().find((c) => c.id === activeId()) ?? clients()[0]);
  // The nav entry is already hidden when MCP is off, but a bookmark still lands
  // here. Say why rather than handing out an endpoint that answers 404 — and
  // show neither panel until the answer is in, so a disabled install never
  // flashes the endpoint first.
  const [enabled] = createResource(checkMcpEnabled);

  return (
    <div class="container--lg">
      <Title>MCP server - Manifest</Title>
      <Meta
        name="description"
        content="Connect Claude, Cursor, Codex and other MCP clients to this Manifest install over OAuth."
      />
      <div class="page-header">
        <div>
          <h1 class="page-header__title">MCP server</h1>
          <p class="page-header__subtitle">
            Manage harnesses, providers, routing and the request log from any MCP client
          </p>
        </div>
      </div>

      <Show when={enabled() === false}>
        <div class="panel">
          <div class="panel__title">Not available on this install</div>
          <p class="integration-panel__desc" style="margin-bottom: 0;">
            The MCP server needs this install to be reachable over HTTPS, because MCP clients
            authorize against an HTTPS resource URL. It is switched off here, either because{' '}
            <code>BETTER_AUTH_URL</code> is a plain-HTTP address or because{' '}
            <code>MCP_ENABLED=false</code> is set. The dashboard, the gateway and the CLI are
            unaffected.
          </p>
        </div>
      </Show>

      <Show when={enabled() === true}>
        <div class="panel">
          <div class="panel__title">Your endpoint</div>
          <p class="integration-panel__desc">
            Point any MCP client here. It signs in with OAuth, so the first connection opens a
            consent screen in your browser and keeps a short-lived, revocable token.
          </p>
          <CodeBlock code={endpoint()} language="bash" />
        </div>

        <div class="panel">
          <div class="panel__title">Connect your client</div>
          <div class="integration-panel__tabs">
            <div class="panel__tabs" role="tablist" aria-label="MCP client">
              <For each={clients()}>
                {(client) => (
                  <button
                    type="button"
                    class="panel__tab"
                    classList={{ 'panel__tab--active': activeId() === client.id }}
                    role="tab"
                    aria-selected={activeId() === client.id}
                    onClick={() => setActiveId(client.id)}
                  >
                    <Show when={client.icon}>
                      <img
                        class="panel__tab-icon"
                        src={client.icon}
                        alt=""
                        width="16"
                        height="16"
                      />
                    </Show>
                    {client.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <CodeBlock code={active().code} language={active().language} />
        </div>

        <div class="panel">
          <div class="integration-panel__header">
            <div class="panel__title">Read-only or read-and-write</div>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn--outline btn--sm"
              style="text-decoration: none;"
            >
              Full tool list
            </a>
          </div>
          <p class="integration-panel__desc" style="margin-bottom: 0;">
            The consent screen asks which you want. A read-only connection never sees the write
            tools at all, so it can look but not touch.
          </p>
        </div>
      </Show>
    </div>
  );
};

export default McpServer;
