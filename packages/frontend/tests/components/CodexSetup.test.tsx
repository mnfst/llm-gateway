import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';

import CodexSetup from '../../src/components/CodexSetup';

const writeText = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal('navigator', {
  clipboard: { writeText },
});

describe('CodexSetup', () => {
  beforeEach(() => {
    writeText.mockClear();
  });

  it('renders a paste-ready config.toml and a placeholder key export when the full key is unavailable', async () => {
    const { container } = render(() => (
      <CodexSetup apiKey={null} keyPrefix="mnfst_live" baseUrl="http://localhost:38240/v1" />
    ));

    expect(container.textContent).toContain('~/.codex/config.toml');
    expect(container.textContent).toContain('launch Codex CLI from the same terminal');
    expect(container.textContent).toContain('fully quit and reopen');
    expect(container.textContent).toContain('model = "auto"');
    expect(container.textContent).toContain('model_provider = "manifest"');
    expect(container.textContent).toContain('base_url = "http://localhost:38240/v1"');
    expect(container.textContent).toContain('wire_api = "responses"');
    expect(container.textContent).toContain('env_key = "MANIFEST_API_KEY"');
    expect(container.textContent).not.toContain('[profiles.manifest]');
    expect(container.textContent).not.toContain('codex --profile');
    expect(container.textContent).toContain('export MANIFEST_API_KEY="mnfst_YOUR_KEY"');
    expect(container.textContent).not.toContain('mnfst_live...');
    expect(screen.queryByLabelText('Reveal API key')).toBeNull();

    const copyButtons = container.querySelectorAll(
      '.setup-cli-block__actions [aria-label="Copy to clipboard"]',
    );
    expect(copyButtons.length).toBe(2);

    fireEvent.click(copyButtons[0]!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('model_provider = "manifest"'),
      );
    });

    fireEvent.click(copyButtons[1]!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('export MANIFEST_API_KEY="mnfst_YOUR_KEY"');
    });
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('mnfst_live...'));
  });

  it('reveals and hides the full API key without changing the copy payload', async () => {
    const { container } = render(() => (
      <CodexSetup
        apiKey="mnfst_secret"
        keyPrefix="mnfst_live"
        baseUrl="http://localhost:38240/v1"
      />
    ));

    expect(container.textContent).toContain('export MANIFEST_API_KEY="mnfst_live..."');
    expect(container.textContent).not.toContain('mnfst_secret');

    fireEvent.click(screen.getByLabelText('Reveal API key'));
    expect(container.textContent).toContain('export MANIFEST_API_KEY="mnfst_secret"');

    fireEvent.click(screen.getByLabelText('Hide API key'));
    expect(container.textContent).toContain('export MANIFEST_API_KEY="mnfst_live..."');

    const copyButtons = container.querySelectorAll(
      '.setup-cli-block__actions [aria-label="Copy to clipboard"]',
    );
    fireEvent.click(copyButtons[1]!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('export MANIFEST_API_KEY="mnfst_secret"');
    });
  });
});
