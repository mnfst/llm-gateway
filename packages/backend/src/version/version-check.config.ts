import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { readManifestVersion, UNKNOWN_VERSION } from '../telemetry/telemetry.config';

/**
 * The GitHub releases the Docker publish job creates for every version. They
 * are the source of truth for "what is the latest Manifest?" — the website
 * changelog is generated from them. One page of 100 is enough to both find
 * the newest and count how far behind an install is (capped at 100).
 */
export const RELEASES_PAGE_SIZE = 100;
export const RELEASES_URL = `https://api.github.com/repos/mnfst/llm-gateway/releases?per_page=${RELEASES_PAGE_SIZE}`;
export const UPGRADE_DOCS_URL = 'https://manifest.build/llm-gateway/docs/self-hosted/#upgrading';
export const UPGRADE_COMMAND = 'docker compose pull && docker compose up -d';

export interface VersionCheckConfig {
  /** False in cloud mode, when opted out, or when the running version is unreadable. */
  enabled: boolean;
  currentVersion: string;
}

/**
 * Opt-out with `MANIFEST_UPDATE_CHECK_DISABLED=1`. Deliberately separate from
 * the telemetry opt-out: one is "don't send data about me", the other is
 * "don't make outbound calls at all" (air-gapped installs). Cloud never
 * checks — cloud users are always on the latest deploy.
 */
export function buildVersionCheckConfig(env: NodeJS.ProcessEnv = process.env): VersionCheckConfig {
  const disabled = env['MANIFEST_UPDATE_CHECK_DISABLED'];
  const isDisabled = disabled === '1' || disabled === 'true';
  const currentVersion = readManifestVersion();
  return {
    enabled: isSelfHosted() && !isDisabled && currentVersion !== UNKNOWN_VERSION,
    currentVersion,
  };
}

const STRICT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG = /^manifest@(\d+\.\d+\.\d+)$/;

/**
 * Numeric three-part compare. Changesets only ever emits strict `X.Y.Z`, so
 * anything else (pre-releases, `unknown`) returns null rather than guessing.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = STRICT_SEMVER.exec(a);
  const pb = STRICT_SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `manifest@6.22.0` → `6.22.0`; anything else → null. */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const match = RELEASE_TAG.exec(tag);
  return match ? match[1] : null;
}

export interface ReleaseSummary {
  latest: string;
  /** Releases newer than `current`; null when `current` is not a strict X.Y.Z. */
  releasesBehind: number | null;
}

/**
 * Reduces a GitHub release-list body to the newest published Manifest
 * version and the number of releases newer than `current`. Drafts,
 * pre-releases, and other tags in the repo (the n8n node) are ignored, and
 * the API ordering is not trusted. Null when nothing usable is in the body.
 */
export function summarizeReleases(body: unknown, current: string): ReleaseSummary | null {
  if (!Array.isArray(body)) return null;
  const versions: string[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    const release = entry as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (release.draft === true || release.prerelease === true) continue;
    const version = parseReleaseTag(release.tag_name);
    if (version) versions.push(version);
  }
  if (versions.length === 0) return null;

  let latest = versions[0];
  let releasesBehind: number | null = STRICT_SEMVER.test(current) ? 0 : null;
  for (const version of versions) {
    if ((compareVersions(version, latest) ?? 0) > 0) latest = version;
    if (releasesBehind !== null && (compareVersions(version, current) ?? 0) > 0) releasesBehind++;
  }
  return { latest, releasesBehind };
}

/** Website changelog, scrolled to that version's entry. */
export function changelogUrlFor(version: string): string {
  return `https://manifest.build/changelog/#v${version.replace(/\./g, '-')}`;
}

export function githubReleaseUrlFor(version: string): string {
  return `https://github.com/mnfst/llm-gateway/releases/tag/${encodeURIComponent(`manifest@${version}`)}`;
}
