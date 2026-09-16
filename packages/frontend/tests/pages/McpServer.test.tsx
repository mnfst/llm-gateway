import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children?: unknown }) => <title>{String(props.children ?? '')}</title>,
  Meta: () => null,
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
  it('shows this install own endpoint, not a hardcoded host', () => {
    const { container } = render(() => <McpServer />);
    expect(container.textContent).toContain(`${window.location.origin}/api/v1/mcp`);
    expect(container.textContent).not.toContain('app.manifest.build');
  });

  it('offers a tab per supported client, with Claude Code selected first', () => {
    const { container } = render(() => <McpServer />);
    const tabs = Array.from(container.querySelectorAll('.panel__tab')).map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Other']);
    const active = container.querySelector('.panel__tab--active');
    expect(active?.textContent?.trim()).toBe('Claude Code');
    expect(container.textContent).toContain('claude mcp add --transport http manifest');
  });

  it('swaps the snippet when another client tab is selected', () => {
    const { container } = render(() => <McpServer />);
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

  it('shows each client logo, sourced from the shared platform map', () => {
    const { container } = render(() => <McpServer />);
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

  it('carries a generic mcpServers block for any other client', () => {
    const { container } = render(() => <McpServer />);
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

  it('explains the read-only scope and links to the tool list', () => {
    const { container } = render(() => <McpServer />);
    expect(container.textContent).toContain('never sees the write');
    const link = container.querySelector('a[href="https://manifest.build/docs/integrations/mcp/"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
