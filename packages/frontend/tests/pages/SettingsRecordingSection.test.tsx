import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRecording = vi.fn();
const updateRecording = vi.fn();
const toastSuccess = vi.fn();
let mockIsSelfHosted = true;
vi.mock('../../src/services/api.js', () => ({
  getRecording: (...args: unknown[]) => getRecording(...args),
  updateRecording: (...args: unknown[]) => updateRecording(...args),
}));
vi.mock('../../src/services/toast-store.js', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}));
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => Promise.resolve(mockIsSelfHosted),
}));

import SettingsRecordingSection from '../../src/pages/SettingsRecordingSection';

describe('SettingsRecordingSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSelfHosted = true;
  });
  afterEach(cleanup);

  it('renders the disabled state with the self-hosted storage note', async () => {
    getRecording.mockResolvedValue({ enabled: false });
    const { getByRole, getByText, container } = render(() => (
      <SettingsRecordingSection agentName={() => 'demo'} />
    ));
    const toggle = getByRole('switch');

    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(getByText('Logs')).toBeTruthy();
    expect(container.textContent).toContain('see what your agent sends');
    await waitFor(() =>
      expect(container.textContent).toContain(
        'logs stay in your own database and never reach',
      ),
    );
    expect(getRecording).toHaveBeenCalledWith('demo', expect.anything());
  });

  it('shows the workspace storage note on cloud', async () => {
    mockIsSelfHosted = false;
    getRecording.mockResolvedValue({ enabled: false });
    const { container } = render(() => <SettingsRecordingSection agentName={() => 'demo'} />);
    await waitFor(() =>
      expect(container.textContent).toContain('Logs are stored in your Manifest workspace.'),
    );
    expect(container.textContent).not.toContain('your own database');
  });

  it('enables logs for the current agent', async () => {
    getRecording.mockResolvedValue({ enabled: false });
    updateRecording.mockResolvedValue({ enabled: true });
    const { getByRole } = render(() => <SettingsRecordingSection agentName={() => 'demo'} />);
    const toggle = getByRole('switch');

    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);

    expect(updateRecording).toHaveBeenCalledWith('demo', { enabled: true });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(toastSuccess).toHaveBeenCalledWith('Logs enabled');
  });

  it('disables logs for the current agent', async () => {
    getRecording.mockResolvedValue({ enabled: true });
    updateRecording.mockResolvedValue({ enabled: false });
    const { getByRole } = render(() => <SettingsRecordingSection agentName={() => 'demo'} />);
    const toggle = getByRole('switch');

    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);

    expect(updateRecording).toHaveBeenCalledWith('demo', { enabled: false });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(toastSuccess).toHaveBeenCalledWith('Logs disabled');
  });

  it('restores the toggle after an update fails', async () => {
    getRecording.mockResolvedValue({ enabled: false });
    updateRecording.mockRejectedValue(new Error('save failed'));
    const { getByRole } = render(() => <SettingsRecordingSection agentName={() => 'demo'} />);
    const toggle = getByRole('switch');

    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);

    expect(updateRecording).toHaveBeenCalledWith('demo', { enabled: true });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
