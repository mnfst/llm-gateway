import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ReasoningContentCacheEntry } from '../../entities/reasoning-content-cache-entry.entity';
import { supportsReasoningContent, type ReasoningModelCatalog } from './reasoning-format';
import { ModelsDevReasoningCatalog } from './reasoning-model-catalog';

interface CachedReasoningContent {
  content: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Hard ceiling on turns held in the in-memory layer. The key embeds an
 * upstream-generated tool call id, so the in-memory keyspace is unbounded and
 * the lazy TTL sweep — which only runs on writes — cannot cap a burst. Oldest
 * entries are evicted FIFO; the shared DB layer is pruned separately by
 * `expires_at`.
 */
export const MAX_CACHE_ENTRIES = 10_000;

/**
 * In-memory cache for OpenAI-compatible `reasoning_content` strings.
 *
 * DeepSeek-compatible reasoning providers require assistant tool-call turns to
 * be replayed with the same `reasoning_content` they returned. Generic
 * OpenAI-compatible SDKs often drop that provider-specific field when they
 * rebuild conversation history, so Manifest caches tool turns by the first tool
 * call id.
 *
 * Turns with no tool call are never cached (content-based matching can attach
 * reasoning to the wrong visible turn) but are still replayed, using the
 * empty-string fallback, once the conversation contains a tool call: DeepSeek
 * rejects the request when any assistant turn omits the key.
 */
@Injectable()
export class ReasoningContentCache {
  private readonly logger = new Logger(ReasoningContentCache.name);
  private cache = new Map<string, CachedReasoningContent>();
  private lastCleanup = Date.now();

  constructor(
    @Optional()
    @InjectRepository(ReasoningContentCacheEntry)
    private readonly repo?: Repository<ReasoningContentCacheEntry>,
    /**
     * Read by the response handler too, which needs it for the stream-format
     * question `supportsReasoningContent` alone can't answer.
     */
    @Optional()
    @Inject(ModelsDevReasoningCatalog)
    readonly modelCatalog?: ReasoningModelCatalog,
  ) {}

  /** Store the reasoning_content string for an assistant tool-call turn. */
  store(sessionKey: string, firstToolCallId: string, content: string): void {
    this.storeByCacheKey(sessionKey, firstToolCallId, content);
  }

  private storeByCacheKey(sessionKey: string, cacheKey: string, content: string): void {
    if (!content) return;
    this.maybeCleanup();
    const expiresAt = Date.now() + TTL_MS;
    this.cache.set(`${sessionKey}:${cacheKey}`, { content, expiresAt });
    this.evictOverflow();
    void this.persist(sessionKey, cacheKey, content, expiresAt);
  }

  /** Retrieve cached reasoning_content, or null if not found/expired. */
  retrieve(sessionKey: string, firstToolCallId: string): string | null {
    const entry = this.cache.get(`${sessionKey}:${firstToolCallId}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(`${sessionKey}:${firstToolCallId}`);
      return null;
    }
    return entry.content;
  }

  async retrieveMany(sessionKey: string, cacheKeys: string[]): Promise<Map<string, string>> {
    this.maybeCleanup();
    const result = new Map<string, string>();
    const missing: string[] = [];

    for (const id of [...new Set(cacheKeys)]) {
      const local = this.retrieve(sessionKey, id);
      if (local) {
        result.set(id, local);
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0 || !this.repo) return result;

    try {
      const rows = await this.repo.find({
        where: {
          session_key: sessionKey,
          first_tool_call_id: In(missing),
        },
      });
      const now = Date.now();
      const expired: string[] = [];
      for (const row of rows) {
        if (new Date(row.expires_at).getTime() <= now) {
          expired.push(row.first_tool_call_id);
          continue;
        }
        result.set(row.first_tool_call_id, row.content);
        this.cache.set(`${sessionKey}:${row.first_tool_call_id}`, {
          content: row.content,
          expiresAt: new Date(row.expires_at).getTime(),
        });
      }
      this.evictOverflow();
      if (expired.length > 0) void this.deleteExpired(sessionKey, expired);
    } catch (err) {
      this.logger.warn(`Failed to read shared reasoning_content cache: ${String(err)}`);
    }

    return result;
  }

  async prepareRequest(
    body: Record<string, unknown>,
    sessionKey: string,
    endpointKey: string | null,
    model: string,
  ): Promise<Record<string, unknown>> {
    if (!endpointKey || !supportsReasoningContent(endpointKey, model, this.modelCatalog)) {
      return body;
    }
    const messages = body.messages;
    if (!Array.isArray(messages)) return body;

    // Only tool conversations enforce the echo; a plain chat thread keeps its
    // exact turn shape.
    const includeNonToolTurns = messages.some(
      (message) =>
        !!message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        Array.isArray((message as Record<string, unknown>).tool_calls) &&
        ((message as Record<string, unknown>).tool_calls as unknown[]).length > 0,
    );

    const candidates = messages.map((message) =>
      reasoningReplayCandidate(message, includeNonToolTurns),
    );
    if (!candidates.some(Boolean)) return body;

    const keys = candidates.flatMap((candidate) =>
      candidate?.cacheKey ? [candidate.cacheKey] : [],
    );
    const repeatedKeys = repeatedReplayKeys(keys);
    const cached = keys.length > 0 ? await this.retrieveMany(sessionKey, keys) : new Map();

    let changed = false;
    const nextMessages = messages.map((message, index) => {
      const candidate = candidates[index];
      if (!candidate) return message;
      const content =
        candidate.cacheKey && !repeatedKeys.has(candidate.cacheKey)
          ? (cached.get(candidate.cacheKey) ?? '')
          : '';
      if ((message as Record<string, unknown>).reasoning_content === content) return message;
      changed = true;
      return { ...(message as Record<string, unknown>), reasoning_content: content };
    });

    return changed ? { ...body, messages: nextMessages } : body;
  }

  /** Clear all cached reasoning_content for a session. */
  clearSession(sessionKey: string): void {
    const prefix = `${sessionKey}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    if (this.repo) {
      void this.repo.delete({ session_key: sessionKey }).catch((err) => {
        this.logger.warn(`Failed to clear shared reasoning_content cache: ${String(err)}`);
      });
    }
  }

  /** Bound the in-memory cache to MAX_CACHE_ENTRIES, evicting oldest (FIFO) first. */
  private evictOverflow(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      // size > cap (> 0) guarantees a first key exists.
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  /** Lazily evict expired entries to avoid unbounded growth. */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
    if (this.repo) void this.cleanupSharedExpired(now);
  }

  private async persist(
    sessionKey: string,
    firstToolCallId: string,
    content: string,
    expiresAt: number,
  ): Promise<void> {
    if (!this.repo) return;
    const now = new Date().toISOString();
    try {
      await this.repo.upsert(
        {
          session_key: sessionKey,
          first_tool_call_id: firstToolCallId,
          content,
          expires_at: new Date(expiresAt).toISOString(),
          created_at: now,
          updated_at: now,
        },
        ['session_key', 'first_tool_call_id'],
      );
    } catch (err) {
      this.logger.warn(`Failed to persist reasoning_content cache: ${String(err)}`);
    }
  }

  private async deleteExpired(sessionKey: string, firstToolCallIds: string[]): Promise<void> {
    if (!this.repo || firstToolCallIds.length === 0) return;
    try {
      await this.repo.delete({
        session_key: sessionKey,
        first_tool_call_id: In(firstToolCallIds),
      });
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async cleanupSharedExpired(now: number): Promise<void> {
    if (!this.repo) return;
    try {
      await this.repo
        .createQueryBuilder()
        .delete()
        .where('expires_at < :now', { now: new Date(now).toISOString() })
        .execute();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

interface ReasoningReplayCandidate {
  cacheKey: string | null;
}

function reasoningReplayCandidate(
  message: unknown,
  includeNonToolTurns: boolean,
): ReasoningReplayCandidate | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== 'assistant') return null;
  if (typeof record.reasoning_content === 'string' && record.reasoning_content) return null;

  if (!Array.isArray(record.tool_calls) || record.tool_calls.length === 0) {
    // Once tools are in play DeepSeek wants the key on every assistant turn.
    return includeNonToolTurns ? { cacheKey: null } : null;
  }

  const firstToolCall = record.tool_calls[0];
  if (!firstToolCall || typeof firstToolCall !== 'object' || Array.isArray(firstToolCall)) {
    return { cacheKey: null };
  }
  const id = (firstToolCall as Record<string, unknown>).id;
  return { cacheKey: typeof id === 'string' && id ? id : null };
}

function repeatedReplayKeys(keys: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}
