import { fetchJson } from './core.js';

/** Mirrors `VersionInfo` in `packages/backend/src/version/version-check.service.ts`. */
export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  /** Releases published after `current` (capped at 100); null when unknown. */
  releases_behind: number | null;
  /** Website changelog anchored at `latest`. */
  release_url: string | null;
  github_release_url: string | null;
  upgrade_docs_url: string;
  upgrade_command: string;
  /** False on cloud or when the install opted out of update checks. */
  check_enabled: boolean;
  checked_at: string | null;
}

export function getVersionInfo(): Promise<VersionInfo> {
  return fetchJson<VersionInfo>('/version');
}
