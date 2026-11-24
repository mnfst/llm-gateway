import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { readManifestVersion } from '../telemetry/telemetry.config';
import {
  buildVersionCheckConfig,
  changelogUrlFor,
  compareVersions,
  githubReleaseUrlFor,
  parseReleaseTag,
  summarizeReleases,
  UPGRADE_COMMAND,
  UPGRADE_DOCS_URL,
} from './version-check.config';

jest.mock('../common/utils/detect-self-hosted', () => ({
  isSelfHosted: jest.fn(),
}));
jest.mock('../telemetry/telemetry.config', () => ({
  readManifestVersion: jest.fn(),
  UNKNOWN_VERSION: 'unknown',
}));

const mockIsSelfHosted = isSelfHosted as jest.MockedFunction<typeof isSelfHosted>;
const mockReadVersion = readManifestVersion as jest.MockedFunction<typeof readManifestVersion>;

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('6.21.1', '6.21.1')).toBe(0);
  });

  it('returns a negative number when the first version is older', () => {
    expect(compareVersions('6.21.1', '6.22.0')).toBeLessThan(0);
    expect(compareVersions('6.21.1', '7.0.0')).toBeLessThan(0);
    expect(compareVersions('6.21.1', '6.21.2')).toBeLessThan(0);
  });

  it('returns a positive number when the first version is newer', () => {
    expect(compareVersions('6.22.0', '6.21.9')).toBeGreaterThan(0);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('6.9.0', '6.10.0')).toBeLessThan(0);
  });

  it('returns null when either side is not a strict X.Y.Z version', () => {
    expect(compareVersions('unknown', '6.22.0')).toBeNull();
    expect(compareVersions('6.22.0', '6.22')).toBeNull();
    expect(compareVersions('6.22.0-beta.1', '6.22.0')).toBeNull();
  });
});

describe('parseReleaseTag', () => {
  it('extracts the version from a manifest@X.Y.Z release tag', () => {
    expect(parseReleaseTag('manifest@6.22.0')).toBe('6.22.0');
  });

  it('returns null for tags that are not Manifest releases', () => {
    expect(parseReleaseTag('n8n-nodes-manifest-v0.2.1')).toBeNull();
    expect(parseReleaseTag('v5.0.5')).toBeNull();
    expect(parseReleaseTag('manifest@6.22')).toBeNull();
    expect(parseReleaseTag(undefined)).toBeNull();
  });
});

describe('summarizeReleases', () => {
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    ...extra,
  });

  it('returns the newest version and how many releases are newer than current', () => {
    const body = [
      release('manifest@6.21.1'),
      release('manifest@6.21.0'),
      release('manifest@6.20.0'),
      release('manifest@6.19.0'),
    ];
    expect(summarizeReleases(body, '6.19.0')).toEqual({ latest: '6.21.1', releasesBehind: 3 });
  });

  it('reports zero behind when current is the newest', () => {
    const body = [release('manifest@6.21.1'), release('manifest@6.21.0')];
    expect(summarizeReleases(body, '6.21.1')).toEqual({ latest: '6.21.1', releasesBehind: 0 });
  });

  it('ignores drafts, pre-releases, and non-Manifest tags', () => {
    const body = [
      release('manifest@7.0.0', { draft: true }),
      release('manifest@6.22.0', { prerelease: true }),
      release('n8n-nodes-manifest-v0.2.1'),
      release('manifest@6.21.1'),
    ];
    expect(summarizeReleases(body, '6.21.0')).toEqual({ latest: '6.21.1', releasesBehind: 1 });
  });

  it('does not rely on the API ordering to find the newest', () => {
    const body = [
      release('manifest@6.20.0'),
      release('manifest@6.21.1'),
      release('manifest@6.21.0'),
    ];
    expect(summarizeReleases(body, '6.20.0')).toEqual({ latest: '6.21.1', releasesBehind: 2 });
  });

  it('returns null when the body holds no usable release', () => {
    expect(summarizeReleases([release('v5.0.5')], '6.21.1')).toBeNull();
    expect(summarizeReleases([], '6.21.1')).toBeNull();
    expect(summarizeReleases({ message: 'rate limited' }, '6.21.1')).toBeNull();
    expect(summarizeReleases(['not-an-object', null], '6.21.1')).toBeNull();
  });

  it('reports an unknown distance when current cannot be parsed', () => {
    const body = [release('manifest@6.21.1'), release('manifest@6.21.0')];
    expect(summarizeReleases(body, 'unknown')).toEqual({ latest: '6.21.1', releasesBehind: null });
  });
});

describe('release URLs', () => {
  it('points changelogUrlFor at the website anchor for that version', () => {
    expect(changelogUrlFor('6.22.0')).toBe('https://manifest.build/changelog/#v6-22-0');
  });

  it('points githubReleaseUrlFor at the encoded GitHub release tag', () => {
    expect(githubReleaseUrlFor('6.22.0')).toBe(
      'https://github.com/mnfst/llm-gateway/releases/tag/manifest%406.22.0',
    );
  });

  it('exposes the documented upgrade instructions', () => {
    expect(UPGRADE_DOCS_URL).toBe('https://manifest.build/llm-gateway/docs/self-hosted/#upgrading');
    expect(UPGRADE_COMMAND).toBe('docker compose pull && docker compose up -d');
  });
});

describe('buildVersionCheckConfig', () => {
  beforeEach(() => {
    mockIsSelfHosted.mockReset();
    mockReadVersion.mockReset();
    mockReadVersion.mockReturnValue('6.21.1');
  });

  it('enables the check on self-hosted installs by default', () => {
    mockIsSelfHosted.mockReturnValue(true);
    expect(buildVersionCheckConfig({})).toEqual({ enabled: true, currentVersion: '6.21.1' });
  });

  it('never checks in cloud mode', () => {
    mockIsSelfHosted.mockReturnValue(false);
    expect(buildVersionCheckConfig({}).enabled).toBe(false);
  });

  it('honours MANIFEST_UPDATE_CHECK_DISABLED as 1 or true', () => {
    mockIsSelfHosted.mockReturnValue(true);
    expect(buildVersionCheckConfig({ MANIFEST_UPDATE_CHECK_DISABLED: '1' }).enabled).toBe(false);
    expect(buildVersionCheckConfig({ MANIFEST_UPDATE_CHECK_DISABLED: 'true' }).enabled).toBe(false);
  });

  it('treats an empty or 0 MANIFEST_UPDATE_CHECK_DISABLED as not disabled', () => {
    mockIsSelfHosted.mockReturnValue(true);
    expect(buildVersionCheckConfig({ MANIFEST_UPDATE_CHECK_DISABLED: '' }).enabled).toBe(true);
    expect(buildVersionCheckConfig({ MANIFEST_UPDATE_CHECK_DISABLED: '0' }).enabled).toBe(true);
  });

  it('reads process.env when no environment is passed', () => {
    mockIsSelfHosted.mockReturnValue(true);
    const previous = process.env['MANIFEST_UPDATE_CHECK_DISABLED'];
    process.env['MANIFEST_UPDATE_CHECK_DISABLED'] = '1';
    try {
      expect(buildVersionCheckConfig().enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_UPDATE_CHECK_DISABLED'];
      else process.env['MANIFEST_UPDATE_CHECK_DISABLED'] = previous;
    }
  });

  it('disables the check when the running version cannot be read', () => {
    mockIsSelfHosted.mockReturnValue(true);
    mockReadVersion.mockReturnValue('unknown');
    expect(buildVersionCheckConfig({})).toEqual({ enabled: false, currentVersion: 'unknown' });
  });
});
