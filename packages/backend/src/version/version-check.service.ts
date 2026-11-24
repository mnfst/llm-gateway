import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  changelogUrlFor,
  compareVersions,
  githubReleaseUrlFor,
  RELEASES_URL,
  summarizeReleases,
  UPGRADE_COMMAND,
  UPGRADE_DOCS_URL,
  type ReleaseSummary,
  type VersionCheckConfig,
} from './version-check.config';

export const VERSION_CHECK_CONFIG = Symbol('VERSION_CHECK_CONFIG');

/** Successful checks are reused for a day; failures back off for an hour. */
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  /**
   * Releases published after `current`, capped at the 100 the check fetches.
   * Null until the first successful check or when `current` is unreadable.
   */
  releases_behind: number | null;
  /** Website changelog anchored at `latest`. */
  release_url: string | null;
  github_release_url: string | null;
  upgrade_docs_url: string;
  upgrade_command: string;
  /** False in cloud mode or when `MANIFEST_UPDATE_CHECK_DISABLED` is set. */
  check_enabled: boolean;
  /** When `latest` was last confirmed; null until the first successful check. */
  checked_at: string | null;
}

interface CachedCheck extends ReleaseSummary {
  checkedAt: number;
}

/**
 * Answers "is there a newer Manifest, and how far behind am I?" for
 * self-hosted dashboards.
 *
 * One outbound call to GitHub per day per process, never on cloud, never when
 * opted out, and never more than once an hour while GitHub is unreachable —
 * the dashboard may poll this on every page load, and the unauthenticated
 * GitHub API allows 60 requests an hour.
 */
@Injectable()
export class VersionCheckService {
  private readonly logger = new Logger(VersionCheckService.name);
  private cached: CachedCheck | null = null;
  private lastFailureAt: number | null = null;
  /** The refresh in progress, so concurrent callers share one GitHub request. */
  private inflight: Promise<void> | null = null;

  constructor(@Inject(VERSION_CHECK_CONFIG) private readonly config: VersionCheckConfig) {}

  async getVersionInfo(): Promise<VersionInfo> {
    if (this.config.enabled) {
      await this.refreshIfDue();
    }
    return this.buildInfo();
  }

  private refreshIfDue(): Promise<void> {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < SUCCESS_TTL_MS) return Promise.resolve();
    if (this.lastFailureAt !== null && now - this.lastFailureAt < FAILURE_BACKOFF_MS) {
      return Promise.resolve();
    }
    if (!this.inflight) {
      this.inflight = this.refresh(now).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Never rejects: a failure is recorded for backoff and the caller gets stale/null data. */
  private async refresh(now: number): Promise<void> {
    try {
      const summary = await this.fetchReleases();
      this.cached = { ...summary, checkedAt: now };
      this.lastFailureAt = null;
    } catch (err) {
      // Warn once per outage: the first failure after a success (or at boot)
      // is worth a log line; repeating it every hour is noise.
      if (this.lastFailureAt === null) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Update check failed (${message}); will retry in an hour`);
      }
      this.lastFailureAt = now;
    }
  }

  private async fetchReleases(): Promise<ReleaseSummary> {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub responded ${res.status}`);
    }
    const summary = summarizeReleases(await res.json(), this.config.currentVersion);
    if (!summary) {
      throw new Error('no Manifest release in the GitHub response');
    }
    return summary;
  }

  private buildInfo(): VersionInfo {
    const current = this.config.currentVersion;
    const cached = this.config.enabled ? this.cached : null;
    const latest = cached?.latest ?? null;
    const cmp = latest ? compareVersions(current, latest) : null;
    return {
      current,
      latest,
      update_available: cmp !== null && cmp < 0,
      releases_behind: cached?.releasesBehind ?? null,
      release_url: latest ? changelogUrlFor(latest) : null,
      github_release_url: latest ? githubReleaseUrlFor(latest) : null,
      upgrade_docs_url: UPGRADE_DOCS_URL,
      upgrade_command: UPGRADE_COMMAND,
      check_enabled: this.config.enabled,
      checked_at: cached ? new Date(cached.checkedAt).toISOString() : null,
    };
  }
}
