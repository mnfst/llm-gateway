import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getVersionInfo, type VersionInfo } from '../../src/services/api/version.js';
import * as api from '../../src/services/api.js';

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('location', { origin: 'http://localhost:3000' });
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getVersionInfo', () => {
  it('fetches GET /api/v1/version and returns the payload', async () => {
    const payload: VersionInfo = {
      current: '6.21.1',
      latest: '6.22.0',
      update_available: true,
      releases_behind: 1,
      release_url: 'https://manifest.build/changelog/#v6-22-0',
      github_release_url: 'https://github.com/mnfst/llm-gateway/releases/tag/manifest%406.22.0',
      upgrade_docs_url: 'https://manifest.build/llm-gateway/docs/self-hosted/#upgrading',
      upgrade_command: 'docker compose pull && docker compose up -d',
      check_enabled: true,
      checked_at: '2026-09-04T09:00:00.000Z',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    });

    const result = await getVersionInfo();

    expect(result).toEqual(payload);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe('http://localhost:3000/api/v1/version');
  });

  it('is re-exported from the api barrel', () => {
    expect(api.getVersionInfo).toBe(getVersionInfo);
  });
});
