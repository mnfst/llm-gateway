import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockGetAutofix = vi.fn();
const mockUpdateAutofix = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getAutofix: (...args: unknown[]) => mockGetAutofix(...args),
  updateAutofix: (...args: unknown[]) => mockUpdateAutofix(...args),
}));

const mockToastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

let mockSearchParams: Record<string, string> = {};
vi.mock('@solidjs/router', () => ({
  useSearchParams: () => [mockSearchParams],
}));

import SettingsAutofixSection from '../../src/pages/SettingsAutofixSection';

/** Wait for the initial `getAutofix` resource to settle so the switch's
 *  `disabled={... || config.loading}` binding flips to enabled. */
async function waitForLoaded(container: HTMLElement): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const btn = container.querySelector('.settings-switch') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.hasAttribute('disabled')).toBe(false);
    return btn!;
  });
}

describe('SettingsAutofixSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the Autofix title and switch', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: false });
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    expect(container.textContent).toContain('Autofix');

    // Exposed as an accessible switch, fetched against the current agent name.
    expect(btn.getAttribute('role')).toBe('switch');
    expect(mockGetAutofix).toHaveBeenCalledWith('demo', expect.anything());
    // Disabled config → the switch is not in its "on" state.
    expect(btn.classList.contains('settings-switch--on')).toBe(false);
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the switch in its on state when Autofix is enabled', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: true });
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    expect(btn.classList.contains('settings-switch--on')).toBe(true);
    expect(btn.getAttribute('aria-checked')).toBe('true');
  });

  it('defaults the switch to off when the fetched config omits enabled', async () => {
    mockGetAutofix.mockResolvedValue({});
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    expect(btn.classList.contains('settings-switch--on')).toBe(false);
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('renders a disabled switch while the config is still loading', () => {
    mockGetAutofix.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = container.querySelector('.settings-switch') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('Autofix');
  });

  it('toggles Autofix on when currently disabled', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: false });
    mockUpdateAutofix.mockResolvedValue({ enabled: true });
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    fireEvent.click(btn);

    expect(mockUpdateAutofix).toHaveBeenCalledWith('demo', { enabled: true });
    // After the update resolves, the mutated config flips the switch on.
    await waitFor(() => {
      expect(btn.classList.contains('settings-switch--on')).toBe(true);
    });
  });

  it('enables directly with the legal line as the consent act (no dialog)', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: false, consented: false });
    mockUpdateAutofix.mockResolvedValue({ enabled: true, consented: true });
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    // The Terms/Privacy legal line sits under the card, no dialog anywhere.
    expect(container.textContent).toContain('you agree to Manifest');
    const terms = screen.getByRole('link', { name: 'Terms' });
    const privacy = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(terms.getAttribute('href')).toBe('https://manifest.build/terms');
    expect(privacy.getAttribute('href')).toBe('https://manifest.build/privacy');

    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockUpdateAutofix).toHaveBeenCalledWith('demo', { enabled: true });
    await waitFor(() => expect(btn.getAttribute('aria-checked')).toBe('true'));
  });

  it('flashes the card when arriving with ?highlight=autofix, then settles', async () => {
    mockSearchParams = { highlight: 'autofix' };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetAutofix.mockResolvedValue({ enabled: false });
      const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);
      expect(container.querySelector('.settings-card--highlight')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      await waitFor(() =>
        expect(container.querySelector('.settings-card--highlight')).toBeNull(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles Autofix off when currently enabled', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: true });
    mockUpdateAutofix.mockResolvedValue({ enabled: false });
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    fireEvent.click(btn);

    expect(mockUpdateAutofix).toHaveBeenCalledWith('demo', { enabled: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(btn.classList.contains('settings-switch--on')).toBe(false);
    });
  });

  it('ignores clicks while a save is already in flight', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: false });
    // Keep the first update pending so `busy()` stays true for the second click.
    mockUpdateAutofix.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(mockUpdateAutofix).toHaveBeenCalledTimes(1);
  });

  it('keeps the switch visible but disabled when the initial read fails', async () => {
    mockGetAutofix.mockRejectedValue(new Error('read failed'));
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    await waitFor(() => expect(mockGetAutofix).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    const btn = container.querySelector('.settings-switch') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('Autofix');
    expect(mockUpdateAutofix).not.toHaveBeenCalled();
  });

  it('keeps the section disabled when a later refetch fails', async () => {
    const [name, setName] = createSignal('a');
    mockGetAutofix.mockResolvedValueOnce({ enabled: true });
    mockGetAutofix.mockRejectedValueOnce(new Error('refetch failed'));
    const { container } = render(() => <SettingsAutofixSection agentName={name} />);

    // First load renders the switch in its on state.
    const btn = await waitForLoaded(container);
    expect(btn.classList.contains('settings-switch--on')).toBe(true);

    setName('b');
    await waitFor(() => {
      const el = container.querySelector('.settings-switch') as HTMLButtonElement;
      expect(el.hasAttribute('disabled')).toBe(true);
    });
    expect(container.textContent).toContain('Autofix');
  });

  it('shows the switch off (not the previous agent state) while a harness switch is loading', async () => {
    const [name, setName] = createSignal('a');
    mockGetAutofix.mockResolvedValueOnce({ enabled: true });
    // The second agent's read never resolves → config.loading stays true, but
    // Solid keeps the previous value while loading. Without the loading gate the
    // switch would show 'a's ON state.
    mockGetAutofix.mockReturnValueOnce(new Promise(() => {}));
    const { container } = render(() => <SettingsAutofixSection agentName={name} />);

    const btn = await waitForLoaded(container);
    expect(btn.classList.contains('settings-switch--on')).toBe(true);

    setName('b');
    await waitFor(() => {
      const el = container.querySelector('.settings-switch') as HTMLButtonElement;
      expect(el.hasAttribute('disabled')).toBe(true);
    });
    expect(btn.classList.contains('settings-switch--on')).toBe(false);
  });

  it('does not apply a stale save after the harness switches mid-request', async () => {
    const [name, setName] = createSignal('a');
    mockGetAutofix.mockResolvedValue({ enabled: false });
    let resolveUpdate: (v: { enabled: boolean }) => void = () => {};
    mockUpdateAutofix.mockReturnValue(
      new Promise<{ enabled: boolean }>((r) => {
        resolveUpdate = r;
      }),
    );
    const { container } = render(() => <SettingsAutofixSection agentName={name} />);

    const btn = await waitForLoaded(container);
    fireEvent.click(btn); // targets 'a'
    expect(mockUpdateAutofix).toHaveBeenCalledWith('a', { enabled: true });

    // Switch harness before the save resolves; the resource refetches for 'b'.
    setName('b');
    await waitFor(() => expect(mockGetAutofix).toHaveBeenCalledWith('b', expect.anything()));

    // Resolve the stale 'a' update as ON, then let the toggle chain settle (the
    // save's finally re-enables the switch). The guard must drop the stale
    // response so the current 'b' harness stays OFF.
    resolveUpdate({ enabled: true });
    await waitFor(() => {
      const el = container.querySelector('.settings-switch') as HTMLButtonElement;
      expect(el.hasAttribute('disabled')).toBe(false);
    });
    expect(btn.classList.contains('settings-switch--on')).toBe(false);
  });

  it('raises no toast of its own on update failure and re-enables the switch', async () => {
    mockGetAutofix.mockResolvedValue({ enabled: false });
    mockUpdateAutofix.mockRejectedValue(new Error('boom'));
    const { container } = render(() => <SettingsAutofixSection agentName={() => 'demo'} />);

    const btn = await waitForLoaded(container);
    fireEvent.click(btn);

    // The rejected save must not crash the component and must re-enable the switch
    // (spinner reset in `finally`). It raises no generic toast of its own — the
    // real `updateAutofix` (via `fetchMutate`) already surfaces the backend error,
    // so a second toast here would be a duplicate.
    await waitFor(() => {
      expect(btn.hasAttribute('disabled')).toBe(false);
    });
    expect(mockToastError).not.toHaveBeenCalled();
    expect(btn.classList.contains('settings-switch--on')).toBe(false);
  });
});
