import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@solidjs/testing-library';
import VersionIndicator, {
  UPDATE_DISMISSED_STORAGE_KEY,
} from '../../src/components/VersionIndicator';
import { getVersionInfo, type VersionInfo } from '../../src/services/api/version.js';

vi.mock('../../src/services/api/version.js', () => ({
  getVersionInfo: vi.fn(),
}));

const mockGetVersionInfo = vi.mocked(getVersionInfo);

function info(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: __MANIFEST_VERSION__,
    latest: __MANIFEST_VERSION__,
    update_available: false,
    releases_behind: 0,
    release_url: `https://manifest.build/changelog/#v${__MANIFEST_VERSION__.replace(/\./g, '-')}`,
    github_release_url: null,
    upgrade_docs_url: 'https://manifest.build/llm-gateway/docs/self-hosted/#upgrading',
    upgrade_command: 'docker compose pull && docker compose up -d',
    check_enabled: true,
    checked_at: '2026-09-04T09:00:00.000Z',
    ...overrides,
  };
}

const newer = () =>
  info({
    latest: '9.9.9',
    update_available: true,
    releases_behind: 9,
    release_url: 'https://manifest.build/changelog/#v9-9-9',
  });

describe('VersionIndicator', () => {
  beforeEach(() => {
    mockGetVersionInfo.mockReset();
    mockGetVersionInfo.mockResolvedValue(info());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('renders nothing when not self-hosted', () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', '');
    const { container } = render(() => <VersionIndicator />);
    expect(container.querySelector('.version-indicator')).toBeNull();
  });

  it("renders nothing when the flag is anything other than 'true'", () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'false');
    const { container } = render(() => <VersionIndicator />);
    expect(container.querySelector('.version-indicator')).toBeNull();
  });

  it('does not ask the backend for version info when not self-hosted', () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', '');
    render(() => <VersionIndicator />);
    expect(mockGetVersionInfo).not.toHaveBeenCalled();
  });

  it('renders v{version} when self-hosted', () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    const { container } = render(() => <VersionIndicator />);
    const badge = container.querySelector('.version-indicator');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe(`v${__MANIFEST_VERSION__}`);
    expect(badge?.getAttribute('aria-label')).toBe(`Version ${__MANIFEST_VERSION__}`);
  });

  it('keeps the plain badge when already on the latest release', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    const { container } = render(() => <VersionIndicator />);
    await waitFor(() => expect(mockGetVersionInfo).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.version-indicator__update')).toBeNull();
    expect(container.querySelector('.version-indicator')?.textContent).toBe(
      `v${__MANIFEST_VERSION__}`,
    );
  });

  it('links to the changelog when a newer release exists', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    mockGetVersionInfo.mockResolvedValue(newer());
    const { container, findByText } = render(() => <VersionIndicator />);

    const changelog = (await findByText('v9.9.9 available')) as HTMLAnchorElement;
    expect(changelog.tagName).toBe('A');
    expect(changelog.href).toBe('https://manifest.build/changelog/#v9-9-9');
    expect(changelog.target).toBe('_blank');
    expect(changelog.rel).toContain('noopener');

    const badge = container.querySelector('.version-indicator');
    expect(badge?.classList.contains('version-indicator--update')).toBe(true);
    expect(badge?.getAttribute('aria-label')).toBe(
      `Version ${__MANIFEST_VERSION__}, update to 9.9.9 available`,
    );
  });

  it('shows neither an upgrade link nor a releases-behind count', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    mockGetVersionInfo.mockResolvedValue(newer());
    const { container, findByText } = render(() => <VersionIndicator />);

    await findByText('v9.9.9 available');
    expect(container.querySelector('.version-indicator__upgrade')).toBeNull();
    expect(container.textContent).not.toContain('behind');
    expect(container.textContent).not.toContain('How to upgrade');
  });

  it('hides the update notice when dismissed and remembers the dismissed version', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    mockGetVersionInfo.mockResolvedValue(newer());
    const { container, findByLabelText } = render(() => <VersionIndicator />);

    const close = await findByLabelText('Dismiss update notice');
    expect(close.tagName).toBe('BUTTON');
    fireEvent.click(close);

    expect(container.querySelector('.version-indicator__update')).toBeNull();
    expect(container.querySelector('.version-indicator')?.textContent).toBe(
      `v${__MANIFEST_VERSION__}`,
    );
    expect(container.querySelector('.version-indicator--update')).toBeNull();
    expect(localStorage.getItem(UPDATE_DISMISSED_STORAGE_KEY)).toBe('9.9.9');
  });

  it('stays dismissed on later loads while the latest version is unchanged', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, '9.9.9');
    mockGetVersionInfo.mockResolvedValue(newer());
    const { container } = render(() => <VersionIndicator />);

    await waitFor(() => expect(mockGetVersionInfo).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container.querySelector('.version-indicator__update')).toBeNull();
  });

  it('shows the notice again once an even newer version is released', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, '9.9.8');
    mockGetVersionInfo.mockResolvedValue(newer());
    const { findByText } = render(() => <VersionIndicator />);

    await expect(findByText('v9.9.9 available')).resolves.toBeTruthy();
  });

  it('still works when localStorage is unavailable', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mockGetVersionInfo.mockResolvedValue(newer());
    const { container, findByLabelText, findByText } = render(() => <VersionIndicator />);

    await findByText('v9.9.9 available');
    fireEvent.click(await findByLabelText('Dismiss update notice'));
    expect(container.querySelector('.version-indicator__update')).toBeNull();
  });

  it('keeps the plain badge when the version check fails', async () => {
    vi.stubEnv('VITE_MANIFEST_SELFHOSTED', 'true');
    mockGetVersionInfo.mockRejectedValue(new Error('network down'));
    const { container } = render(() => <VersionIndicator />);
    await waitFor(() => expect(mockGetVersionInfo).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container.querySelector('.version-indicator__update')).toBeNull();
    expect(container.querySelector('.version-indicator')?.textContent).toBe(
      `v${__MANIFEST_VERSION__}`,
    );
  });
});
