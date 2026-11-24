import { Logger } from '@nestjs/common';
import { VersionCheckService } from './version-check.service';
import { RELEASES_URL, UPGRADE_COMMAND, UPGRADE_DOCS_URL } from './version-check.config';

const fetchMock = jest.fn();
(global as unknown as Record<string, unknown>).fetch = fetchMock;

const HOUR_MS = 60 * 60 * 1000;
const realDateNow = Date.now;

/** A GitHub release-list body: newest first, like the real API. */
function releasesResponse(...tagNames: unknown[]) {
  const body = tagNames.map((tag_name) => ({ tag_name, draft: false, prerelease: false }));
  return { ok: true, status: 200, json: async () => body };
}

function make(enabled = true, currentVersion = '6.21.1') {
  return new VersionCheckService({ enabled, currentVersion });
}

describe('VersionCheckService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    Date.now = () => 1_800_000_000_000;
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Date.now = realDateNow;
    warnSpy.mockRestore();
  });

  it('makes no outbound call and reports check_enabled=false when disabled', async () => {
    const info = await make(false).getVersionInfo();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).toEqual({
      current: '6.21.1',
      latest: null,
      update_available: false,
      releases_behind: null,
      release_url: null,
      github_release_url: null,
      upgrade_docs_url: UPGRADE_DOCS_URL,
      upgrade_command: UPGRADE_COMMAND,
      check_enabled: false,
      checked_at: null,
    });
  });

  it('reports an available update with changelog and release links', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0', 'manifest@6.21.1'));

    const info = await make().getVersionInfo();

    expect(info).toEqual({
      current: '6.21.1',
      latest: '6.22.0',
      update_available: true,
      releases_behind: 1,
      release_url: 'https://manifest.build/changelog/#v6-22-0',
      github_release_url: 'https://github.com/mnfst/llm-gateway/releases/tag/manifest%406.22.0',
      upgrade_docs_url: UPGRADE_DOCS_URL,
      upgrade_command: UPGRADE_COMMAND,
      check_enabled: true,
      checked_at: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it('counts how many releases sit between current and latest', async () => {
    fetchMock.mockResolvedValue(
      releasesResponse(
        'manifest@6.22.0',
        'manifest@6.21.1',
        'manifest@6.21.0',
        'manifest@6.20.0',
        'manifest@6.19.0',
      ),
    );

    const info = await make(true, '6.19.0').getVersionInfo();

    expect(info.latest).toBe('6.22.0');
    expect(info.releases_behind).toBe(4);
  });

  it('calls the GitHub release-list API with a JSON accept header and a timeout', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0'));

    await make().getVersionInfo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports no update when already on the latest release', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.21.1', 'manifest@6.21.0'));

    const info = await make().getVersionInfo();

    expect(info.latest).toBe('6.21.1');
    expect(info.update_available).toBe(false);
    expect(info.releases_behind).toBe(0);
    expect(info.release_url).toBe('https://manifest.build/changelog/#v6-21-1');
  });

  it('reports no update when running a version newer than the latest release', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.21.0'));

    const info = await make().getVersionInfo();

    expect(info.update_available).toBe(false);
    expect(info.releases_behind).toBe(0);
  });

  it('coalesces concurrent callers into a single GitHub request', async () => {
    let resolveFetch: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const service = make();

    const first = service.getVersionInfo();
    const second = service.getVersionInfo();
    const third = service.getVersionInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(releasesResponse('manifest@6.22.0'));
    const results = await Promise.all([first, second, third]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const info of results) {
      expect(info.latest).toBe('6.22.0');
      expect(info.update_available).toBe(true);
    }
  });

  it('lets a caller after a coalesced failure see the failure, not hang', async () => {
    let rejectFetch: (reason: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((_, reject) => (rejectFetch = reject)));
    const service = make();

    const first = service.getVersionInfo();
    const second = service.getVersionInfo();
    rejectFetch(new Error('boom'));
    const [a, b] = await Promise.all([first, second]);

    expect(a.latest).toBeNull();
    expect(b.latest).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('serves the cached result for 24 hours, then refreshes', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0'));
    const service = make();

    await service.getVersionInfo();
    Date.now = () => 1_800_000_000_000 + 23 * HOUR_MS;
    await service.getVersionInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Date.now = () => 1_800_000_000_000 + 25 * HOUR_MS;
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.23.0'));
    const info = await service.getVersionInfo();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(info.latest).toBe('6.23.0');
  });

  it('degrades to "unknown latest" when the network call throws, and warns once', async () => {
    fetchMock.mockRejectedValue(new Error('ENETUNREACH'));

    const info = await make().getVersionInfo();

    expect(info.latest).toBeNull();
    expect(info.update_available).toBe(false);
    expect(info.releases_behind).toBeNull();
    expect(info.release_url).toBeNull();
    expect(info.github_release_url).toBeNull();
    expect(info.check_enabled).toBe(true);
    expect(info.checked_at).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ENETUNREACH');
  });

  it('logs a non-Error rejection without crashing', async () => {
    fetchMock.mockRejectedValue('socket hang up');

    const info = await make().getVersionInfo();

    expect(info.latest).toBeNull();
    expect(warnSpy.mock.calls[0][0]).toContain('socket hang up');
  });

  it('treats a non-OK response as a failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    const info = await make().getVersionInfo();

    expect(info.latest).toBeNull();
    expect(warnSpy.mock.calls[0][0]).toContain('403');
  });

  it('treats a body without any Manifest release as a failure', async () => {
    fetchMock.mockResolvedValue(releasesResponse('v5.0.5'));

    const info = await make().getVersionInfo();

    expect(info.latest).toBeNull();
    expect(warnSpy.mock.calls[0][0]).toContain('no Manifest release');
  });

  it('backs off for an hour after a failure instead of retrying every request', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const service = make();

    await service.getVersionInfo();
    Date.now = () => 1_800_000_000_000 + 30 * 60 * 1000;
    await service.getVersionInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Date.now = () => 1_800_000_000_000 + 61 * 60 * 1000;
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0'));
    const info = await service.getVersionInfo();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(info.latest).toBe('6.22.0');
  });

  it('keeps serving the last good result when a refresh fails', async () => {
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0'));
    const service = make();
    await service.getVersionInfo();

    Date.now = () => 1_800_000_000_000 + 25 * HOUR_MS;
    fetchMock.mockRejectedValue(new Error('boom'));
    const info = await service.getVersionInfo();

    expect(info.latest).toBe('6.22.0');
    expect(info.update_available).toBe(true);
    expect(info.releases_behind).toBe(1);
    expect(info.checked_at).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('only warns once per outage, not on every failed refresh', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const service = make();

    await service.getVersionInfo();
    Date.now = () => 1_800_000_000_000 + 2 * HOUR_MS;
    await service.getVersionInfo();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns again after a recovery when a new outage starts', async () => {
    const service = make();
    fetchMock.mockRejectedValue(new Error('first'));
    await service.getVersionInfo();

    Date.now = () => 1_800_000_000_000 + 2 * HOUR_MS;
    fetchMock.mockResolvedValue(releasesResponse('manifest@6.22.0'));
    await service.getVersionInfo();

    Date.now = () => 1_800_000_000_000 + 27 * HOUR_MS;
    fetchMock.mockRejectedValue(new Error('second'));
    await service.getVersionInfo();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1][0]).toContain('second');
  });
});
