import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children?: unknown }) => <title>{String(props.children ?? '')}</title>,
  Meta: () => null,
}));

// MCP is on unless the backend says otherwise — an install served over plain
// HTTP from a non-loopback host runs without the endpoint entirely.
let mockMcpEnabled = true;
let mockCheckMcpEnabled: () => Promise<boolean> = () => Promise.resolve(mockMcpEnabled);
vi.mock('../../src/services/setup-status.js', () => ({
  checkMcpEnabled: () => mockCheckMcpEnabled(),
}));

import McpServer, { clientSetups } from '../../src/pages/integrations/McpServer';
import { mcpEndpoint, installOrigin, setupOrigin } from '../../src/services/install-endpoints';

describe('install-endpoints', () => {
  it('uses app for new Cloud setup on either Cloud host', () => {
    expect(setupOrigin('https://app.manifest.build')).toBe('https://app.manifest.build');
    expect(setupOrigin('https://gateway.manifest.build')).toBe('https://app.manifest.build');
    expect(setupOrigin('https://manifest.example.com')).toBe('https://manifest.example.com');
  });

  it('derives the origin from the browser', () => {
    expect(installOrigin()).toBe(window.location.origin);
  });

  it('builds the MCP endpoint under the install origin', () => {
    expect(mcpEndpoint()).toBe(`${window.location.origin}/api/v1/mcp`);
  });
});

describe('MCP server page', () => {
  // The panels wait for the setup status, so render and let it resolve.
  async function renderReady() {
    const result = render(() => <McpServer />);
    await waitFor(() => expect(result.container.querySelector('.panel__tab')).not.toBeNull());
    return result;
  }

  it('shows neither panel until the status is known', async () => {
    let settle!: (enabled: boolean) => void;
    mockCheckMcpEnabled = () => new Promise<boolean>((resolve) => (settle = resolve));
    try {
      const { container } = render(() => <McpServer />);
      // Pending: no endpoint, no client snippets, and no "not available" notice.
      expect(container.querySelector('.panel__tab')).toBeNull();
      expect(container.textContent).not.toContain('/api/v1/mcp');
      expect(container.textContent).not.toContain('Not available on this install');
      settle(true);
      await waitFor(() => expect(container.querySelector('.panel__tab')).not.toBeNull());
      expect(container.textContent).toContain(`${window.location.origin}/api/v1/mcp`);
    } finally {
      mockCheckMcpEnabled = () => Promise.resolve(mockMcpEnabled);
    }
  });

  it('explains why the page is empty when the backend runs without MCP', async () => {
    mockMcpEnabled = false;
    try {
      const { container } = render(() => <McpServer />);
      await waitFor(() => expect(container.textContent).toContain('Not available on this install'));
      // No endpoint and no client snippets are offered.
      expect(container.textContent).not.toContain(`${window.location.origin}/api/v1/mcp`);
      expect(container.querySelectorAll('.panel__tab')).toHaveLength(0);
      expect(container.textContent).toContain('MCP_ENABLED=false');
    } finally {
      mockMcpEnabled = true;
    }
  });

  it('shows this install own endpoint, not a hardcoded host', async () => {
    const { container } = await renderReady();
    expect(container.textContent).toContain(`${window.location.origin}/api/v1/mcp`);
    expect(container.textContent).not.toContain('app.manifest.build');
  });

  it('offers a tab per supported client, with Claude Code selected first', async () => {
    const { container } = await renderReady();
    const tabs = Array.from(container.querySelectorAll('.panel__tab')).map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Other']);
    const active = container.querySelector('.panel__tab--active');
    expect(active?.textContent?.trim()).toBe('Claude Code');
    expect(container.textContent).toContain('claude mcp add --transport http manifest');
  });

  it('swaps the snippet when another client tab is selected', async () => {
    const { container } = await renderReady();
    const byLabel = (label: string) =>
      Array.from(container.querySelectorAll('.panel__tab')).find(
        (t) => t.textContent?.trim() === label,
      ) as HTMLElement;

    fireEvent.click(byLabel('Codex'));
    expect(container.textContent).toContain('codex mcp add manifest --url');
    expect(container.textContent).not.toContain('claude mcp add --transport http');
    expect(byLabel('Codex').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(byLabel('OpenCode'));
    expect(container.textContent).toContain('opencode.ai/config.json');
  });

  it('shows each client logo, sourced from the shared platform map', async () => {
    const { container } = await renderReady();
    const icons = Array.from(container.querySelectorAll('.panel__tab .panel__tab-icon')).map((i) =>
      i.getAttribute('src'),
    );
    expect(icons).toEqual([
      '/icons/providers/claude-code.svg',
      '/icons/providers/codex.svg',
      '/icons/providers/opencode.svg',
      '/icons/other.svg',
    ]);
    // Decorative: the label beside it already names the client.
    for (const i of container.querySelectorAll('.panel__tab-icon')) {
      expect(i.getAttribute('alt')).toBe('');
    }
  });

  it('carries a generic mcpServers block for any other client', async () => {
    const { container } = await renderReady();
    const byLabel = (label: string) =>
      Array.from(container.querySelectorAll('.panel__tab')).find(
        (t) => t.textContent?.trim() === label,
      ) as HTMLElement;

    fireEvent.click(byLabel('Other'));
    expect(container.textContent).toContain('mcpServers');
    expect(container.textContent).toContain(`"url": "${window.location.origin}/api/v1/mcp"`);
  });

  it('builds every client snippet against this install endpoint', () => {
    const endpoint = `${window.location.origin}/api/v1/mcp`;
    for (const setup of clientSetups(endpoint)) {
      expect(setup.code).toContain(endpoint);
    }
  });

  it('explains the read-only scope and links to the tool list', async () => {
    const { container } = await renderReady();
    expect(container.textContent).toContain('never sees the write');
    const link = container.querySelector('a[href="https://manifest.build/llm-gateway/docs/integrations/mcp/"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
