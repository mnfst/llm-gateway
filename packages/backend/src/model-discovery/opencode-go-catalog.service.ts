import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface OpencodeGoCatalogEntry {
  /** Bare model ID as listed in the docs (e.g. "glm-5.1"). */
  id: string;
  /** Human-readable display name from the docs (e.g. "GLM-5.1"). */
  displayName: string;
  /** Which upstream API format the model expects. */
  format: 'openai' | 'anthropic' | 'responses';
  /**
   * Cost in USD attributed to one request, derived from the docs Usage Limits
   * table: `OPENCODE_GO_BUDGET_5H_USD / requestsPer5h`. `null` when the docs
   * table did not include a row for this model.
   */
  costPerRequestUsd: number | null;
}

const CATALOG_URL =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx';
const CACHE_TTL_MS = 60 * 60 * 1000;
// After a fetch failure we reuse the last-known-good list for a shorter window
// so a sustained outage does not turn into a per-call retry storm.
const ERROR_BACKOFF_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Published 5-hour quota in USD for an OpenCode Go subscription. The docs
 * express per-model usage as "requests per 5 hour", so dividing that dollar
 * value by the request count gives the dollar cost the docs attribute to a
 * single request.
 *
 * Source: https://opencode.ai/docs/go/#usage-limits
 */
export const OPENCODE_GO_BUDGET_5H_USD = 12;

/**
 * Fetches the OpenCode Go model list from the public docs source.
 * OpenCode Go has no /v1/models endpoint, so the canonical list lives
 * in the markdown docs file the website renders from. We parse the
 * Endpoints table (for model IDs + API format) and the Usage Limits
 * table (for per-request cost) and cache the merged result in memory.
 */
@Injectable()
export class OpencodeGoCatalogService implements OnModuleInit {
  private readonly logger = new Logger(OpencodeGoCatalogService.name);
  private cache: { entries: OpencodeGoCatalogEntry[]; expiresAt: number } | null = null;
  private lastGood: OpencodeGoCatalogEntry[] | null = null;
  private costByModelId = new Map<string, number>();
  private formatByModelId = new Map<string, OpencodeGoCatalogEntry['format']>();
  /**
   * In-flight fetch promise — concurrent callers (e.g. the onModuleInit
   * warmup plus the first proxy request) share the same fetch instead of
   * each issuing their own. Cleared once the fetch settles so the next call
   * after cache expiry re-fetches normally.
   */
  private inflight: Promise<OpencodeGoCatalogEntry[]> | null = null;

  /**
   * Warm the catalog in the background at boot so the per-request cost index
   * is populated before the proxy hot path runs. Discovery typically warms it
   * on its own, but a cold process restart can record OpenCode Go calls
   * against an empty index — the recorder treats a missing entry as $0,
   * which is the original bug. Fire-and-forget; failures fall through to the
   * existing fetch-on-demand path in `list()`.
   */
  onModuleInit(): void {
    void this.list().catch(() => {
      // `list()` already logs failures and arms the error-backoff window.
    });
  }

  async list(): Promise<OpencodeGoCatalogEntry[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.entries;
    }
    if (this.inflight) {
      // A concurrent caller (typically the onModuleInit warmup) is already
      // fetching. Share its result so we don't issue a duplicate request.
      return this.inflight;
    }
    return this.startFetch(now);
  }

  /**
   * Force a live catalog fetch even when the one-hour cache is warm. Manual
   * model refreshes use this so users can pick up newly published OpenCode Go
   * models without restarting the backend.
   */
  async refresh(): Promise<OpencodeGoCatalogEntry[]> {
    return this.startFetch(Date.now());
  }

  private startFetch(now: number): Promise<OpencodeGoCatalogEntry[]> {
    const request = this.fetchAndCache(now);
    const tracked = request.finally(() => {
      if (this.inflight === tracked) {
        this.inflight = null;
      }
    });
    this.inflight = tracked;
    return tracked;
  }

  private async fetchAndCache(now: number): Promise<OpencodeGoCatalogEntry[]> {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`OpenCode Go catalog fetch returned ${response.status}`);
        return this.cacheFallback(now);
      }
      const mdx = await response.text();
      const entries = this.parse(mdx);
      if (entries.length === 0) {
        this.logger.warn('OpenCode Go catalog parsed zero entries — docs format may have changed');
        return this.cacheFallback(now);
      }
      this.cache = { entries, expiresAt: now + CACHE_TTL_MS };
      this.lastGood = entries;
      this.rebuildIndexes(entries);
      this.logger.log(`OpenCode Go catalog loaded: ${entries.length} models`);
      return entries;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenCode Go catalog fetch failed: ${message}`);
      return this.cacheFallback(now);
    }
  }

  /**
   * Sync lookup for the per-request cost of an OpenCode Go model. Returns
   * `null` when the catalog has not been loaded yet, when the docs did not
   * publish a limit for the model, or when the model is unknown. Accepts
   * either a bare model ID (`glm-5.1`) or the prefixed form
   * (`opencode-go/glm-5.1`) — callers don't need to strip the prefix.
   */
  getCostPerRequest(modelId: string | null | undefined): number | null {
    const bare = bareOpencodeGoModelId(modelId);
    if (!bare) return null;
    return this.costByModelId.get(bare) ?? null;
  }

  /**
   * Sync lookup for the API format an OpenCode Go model expects. Returns
   * `null` before the docs catalog has loaded or when the model is unknown.
   */
  getFormat(modelId: string | null | undefined): OpencodeGoCatalogEntry['format'] | null {
    const bare = bareOpencodeGoModelId(modelId);
    if (!bare) return null;
    return this.formatByModelId.get(bare) ?? null;
  }

  /**
   * Same as `getCostPerRequest`, but if the in-memory index is empty (cold
   * process — `onModuleInit` warmup hasn't resolved yet) waits on the
   * already-running `list()` call before reading. `list()` caches on both
   * success and failure, so this is "fetch at most once per cache window",
   * not per call. Returns `null` if the docs still don't publish a limit
   * for the model after warming.
   */
  async resolveCostPerRequest(modelId: string | null | undefined): Promise<number | null> {
    if (!modelId) return null;
    if (this.costByModelId.size === 0) {
      await this.list();
    }
    return this.getCostPerRequest(modelId);
  }

  /**
   * Async format lookup for cold processes. Shares the same cached docs fetch
   * as list()/resolveCostPerRequest(), so concurrent first calls coalesce.
   */
  async resolveFormat(
    modelId: string | null | undefined,
  ): Promise<OpencodeGoCatalogEntry['format'] | null> {
    if (!modelId) return null;
    if (this.formatByModelId.size === 0) {
      await this.list();
    }
    return this.getFormat(modelId);
  }

  /**
   * Set a short error-backoff cache so repeated calls during an outage do not
   * hammer the network, then return the last-known-good list (or []).
   */
  private cacheFallback(now: number): OpencodeGoCatalogEntry[] {
    const entries = this.lastGood ?? [];
    this.cache = { entries, expiresAt: now + ERROR_BACKOFF_MS };
    return entries;
  }

  /** Parse the Endpoints and Usage Limits tables out of the go.mdx source. */
  parse(mdx: string): OpencodeGoCatalogEntry[] {
    const costByName = this.parseLimits(mdx);
    const rowRe =
      /\|\s*([A-Za-z][^|]*?)\s*\|\s*([a-z][a-z0-9.-]*)\s*\|\s*`?https:\/\/opencode\.ai\/zen\/go\/v1\/(chat\/completions|messages|responses)`?\s*\|/g;
    const entries: OpencodeGoCatalogEntry[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = rowRe.exec(mdx)) !== null) {
      const [, rawName, modelId, endpointSuffix] = match;
      const displayName = rawName.trim();
      // The header row never matches: "Model ID" starts uppercase, failing the
      // lowercase-anchored modelId group. Dash separator rows likewise start
      // with '-', not [A-Za-z]. So any row reaching this point is a data row.
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      entries.push({
        id: modelId,
        displayName,
        format:
          endpointSuffix === 'messages'
            ? 'anthropic'
            : endpointSuffix === 'responses'
              ? 'responses'
              : 'openai',
        costPerRequestUsd: costByName.get(normalizeDisplayName(displayName)) ?? null,
      });
    }
    return entries;
  }

  /**
   * Parse the Usage Limits table. Maps normalized display name → USD per
   * request, derived from the published 5-hour request count. The Endpoints
   * table and the token-price table are excluded because their first column
   * after the name is a model id or a dollar amount, not a bare count, and a
   * cost is only ever read back for a name the Endpoints table also lists.
   *
   * Parsed row by row rather than with one table-wide regex because the docs
   * dress these cells up: a promotional row strikes the superseded count
   * through and bolds the new one (`~~6,500~~<br />**26,000**`) and hangs a
   * `<small>` note off the model name. A regex anchored on a bare number
   * silently skipped those rows, so the model showed as quota-less.
   */
  private parseLimits(mdx: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of mdx.split('\n')) {
      const cells = splitTableRow(line);
      if (cells === null || cells.length < 4) continue;
      const [rawName, ...rest] = cells;
      if (!/^[A-Za-z]/.test(rawName)) continue;
      // Only the per-5-hour count is consumed. Gating on the per-week and
      // per-month columns too would drop the whole row the day the docs dress
      // one of them up, which is the failure this parser exists to prevent.
      const requestsPer5h = parseRequestCount(rest[0]);
      if (requestsPer5h === null) continue;
      const key = normalizeDisplayName(rawName);
      // First occurrence wins, mirroring the Endpoints table's dedup behaviour.
      if (out.has(key)) continue;
      out.set(key, OPENCODE_GO_BUDGET_5H_USD / requestsPer5h);
    }
    return out;
  }

  private rebuildIndexes(entries: OpencodeGoCatalogEntry[]): void {
    const nextCosts = new Map<string, number>();
    const nextFormats = new Map<string, OpencodeGoCatalogEntry['format']>();
    for (const entry of entries) {
      nextFormats.set(entry.id, entry.format);
      if (entry.costPerRequestUsd != null) {
        nextCosts.set(entry.id, entry.costPerRequestUsd);
      }
    }
    this.costByModelId = nextCosts;
    this.formatByModelId = nextFormats;
  }

  /** Test hook: clear in-memory state. */
  resetCache(): void {
    this.cache = null;
    this.lastGood = null;
    this.costByModelId = new Map();
    this.formatByModelId = new Map();
    this.inflight = null;
  }
}

function bareOpencodeGoModelId(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  return modelId.startsWith('opencode-go/') ? modelId.slice('opencode-go/'.length) : modelId;
}

/**
 * Normalize a docs display name for cross-table matching. The Endpoints
 * table lists "MiMo-V2.5" while the Usage Limits table lists
 * "MiMo-V2.5 (≤ 256K)". Lowercase, strip any parenthesized suffix, and
 * collapse whitespace so the two forms collide on the same key.
 */
function normalizeDisplayName(name: string): string {
  return (
    name
      // A name cell can carry an inline note ("DeepSeek V4.1 Flash<br
      // /><small>4x · Ends Sep 20</small>"). Names never contain '<', so cutting
      // there leaves the name the Endpoints table publishes.
      .split('<')[0]
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  );
}

/**
 * Split one markdown table line into trimmed cells, or null when the line is
 * not a table row.
 */
function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const body = trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split('|').map((cell) => cell.trim());
}

/**
 * Read a request count out of one cell, or null when the cell holds anything
 * else ("Unlimited", a dollar amount, a model id). Struck-through values are
 * superseded by the promoted one next to them, so they are dropped before the
 * number is read; the surviving markup (`<br />`, `**`) is stripped.
 */
function parseRequestCount(cell: string): number | null {
  const effective = cell
    .replace(/~~[^~]*~~/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\*/g, '')
    .trim();
  if (!/^[0-9][0-9,]*$/.test(effective)) return null;
  const value = Number(effective.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}
