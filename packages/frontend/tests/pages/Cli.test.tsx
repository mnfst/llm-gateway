import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children?: unknown }) => <title>{String(props.children ?? '')}</title>,
  Meta: () => null,
}));

let mockIsSelfHosted = false;
let mockPending: Promise<boolean> | null = null;
let mockRejects = false;
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => {
    if (mockRejects) return Promise.reject(new Error('status unavailable'));
    if (mockPending) return mockPending;
    return Promise.resolve(mockIsSelfHosted);
  },
}));

import Cli, { loginCommand } from '../../src/pages/integrations/Cli';

describe('loginCommand', () => {
  it('pins the host when asked, where only the dashboard knows it', () => {
    expect(loginCommand(true, 'https://llm.acme.internal')).toBe(
      'mnfst login --url https://llm.acme.internal',
    );
  });

  it('omits the flag on cloud, where the CLI already defaults there', () => {
    expect(loginCommand(false, 'https://app.manifest.build')).toBe('mnfst login');
  });
});

describe('CLI page', () => {
  beforeEach(() => {
    mockIsSelfHosted = false;
    mockPending = null;
    mockRejects = false;
  });

  it('shows the npm install for the published package', () => {
    const { container } = render(() => <Cli />);
    expect(container.textContent).toContain('npm install -g mnfst-gateway-cli');
  });

  it('shows a bare login on cloud', async () => {
    const { container } = render(() => <Cli />);
    // Wait for the flag to disappear, not for 'mnfst login' to appear: the
    // pinned form contains that substring too, so it would match immediately
    // and assert before the deployment check resolved.
    await waitFor(() => expect(container.textContent).not.toContain('--url'));
    expect(container.textContent).toContain('mnfst login');
  });

  it('adds the host flag on self-hosted', async () => {
    mockIsSelfHosted = true;
    const { container } = render(() => <Cli />);
    await waitFor(() =>
      expect(container.textContent).toContain(`mnfst login --url ${window.location.origin}`),
    );
  });

  it('keeps the host flag while the deployment check is still in flight', async () => {
    let release: (v: boolean) => void = () => {};
    mockPending = new Promise<boolean>((r) => {
      release = r;
    });
    const { container } = render(() => <Cli />);
    // Nothing has resolved yet: the explicit form is the one that works either way.
    expect(container.textContent).toContain(`mnfst login --url ${window.location.origin}`);
    release(false);
    await waitFor(() => expect(container.textContent).not.toContain('--url'));
  });

  it('keeps the host flag when the deployment check fails', async () => {
    mockRejects = true;
    const { container } = render(() => <Cli />);
    await waitFor(() =>
      expect(container.textContent).toContain(`mnfst login --url ${window.location.origin}`),
    );
  });

  it('links to the command reference', () => {
    const { container } = render(() => <Cli />);
    const link = container.querySelector('a[href="https://manifest.build/docs/cli/"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
