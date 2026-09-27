import { createHash, randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

const SESSION_TTL_MS = 5 * 60 * 1000; // matches the OpenAI prompt-cache idle window
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_ENTRIES = 10_000;
// Legitimate prompt_cache_key values are short identifiers; an over-long one is
// treated as absent so a caller can't amplify memory by storing huge unique
// keys (MAX_ENTRIES bounds the count, this bounds each key's size).
const MAX_CACHE_KEY_LEN = 512;

/**
 * Deterministic v4-shaped UUID for a caller cache key. The version and
 * variant bits are set so the value passes UUID validation on the backend,
 * and the namespace keeps session-id and thread-id distinct for one key.
 */
function derivedUuid(namespace: 'session-id' | 'thread-id', cacheKey: string): string {
  const digest = createHash('sha256').update(`${namespace}\u0000${cacheKey}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface CodexSession {
  sessionId: string;
  threadId: string;
  promptCacheKey: string;
  turnState?: string;
  expiresAt: number;
  /** Bumped on every replacement so a capture from a request that outlived its entry is ignored. */
  incarnation: number;
}

export interface CodexAffinityRequest {
  /** Headers to merge into the upstream request. */
  headers: Record<string, string>;
  /** Key under which `capture()` stores the response's turn-state token. */
  storeKey?: string;
  /** Incarnation of the entry `prepare()` resolved; `capture()` ignores a stale one. */
  incarnation?: number;
}

/**
 * Prompt-cache affinity for the ChatGPT subscription backend
 * (`chatgpt.com/backend-api/codex/responses`).
 *
 * The Codex backend only serves prompt-cache hits when consecutive requests
 * land on the same shard. The real Codex CLI achieves that by (1) sending
 * stable `session-id` / `thread-id` headers, (2) defaulting the body's
 * `prompt_cache_key` to its thread id, and (3) replaying the
 * `x-codex-turn-state` sticky-routing token returned by each response on the
 * next request. Manifest sent none of these, so every request landed on an
 * arbitrary shard and `cached_tokens` was always 0 — agentic tool loops
 * re-paid their full prompt prefix on every step (mnfst/llm-gateway#2217).
 *
 * This service closes that gap:
 * - `prepare()` resolves a session for the subscription token + the caller's
 *   `prompt_cache_key` and attaches its ids plus the last seen turn-state
 *   token. Requests without a caller cache key receive request-local affinity
 *   because the subscription token is a credential, not a conversation scope.
 * - `capture()` stores the response's turn-state token for the next request,
 *   and drops it on upstream errors so a poisoned token can't wedge a session.
 *
 * Session and thread ids are a pure function of the caller's
 * `prompt_cache_key` (a v4-shaped UUID derived from its SHA-256), so every
 * replica and every process restart sends the same ids for the same
 * conversation without any shared state. The Codex backend routes on those
 * ids: measured directly against the backend, stable ids alone serve cache
 * hits from the second request on, while ids that change between requests
 * never hit even when `prompt_cache_key` and the turn-state token are
 * replayed. Random per-process ids therefore cost one cold request per
 * replica per conversation, and the sticky token captured on one replica
 * was useless on the others. The credential is never hashed — it is only
 * used as an in-memory map key for the turn-state token. Requests without a
 * caller cache key keep random request-local ids.
 *
 * The turn-state token still lives in-memory with a sliding TTL: the CLI
 * scopes it to a single turn, but a proxy cannot see turn boundaries, so the
 * TTL bounds how far a token can outlive its turn to the window where the
 * cache it routes to is still warm. The token is a best-effort, per-instance
 * optimisation on top of the deterministic ids, not the routing primitive.
 */
@Injectable()
export class CodexSessionAffinity {
  private readonly sessions = new Map<string, CodexSession>();
  /** Monotonic so a replacement never reuses the incarnation of a swept or evicted entry. */
  private nextIncarnation = 1;
  private lastCleanup = Date.now();

  /**
   * Resolve affinity headers for an outgoing Codex-backend request and inject
   * a request-local `prompt_cache_key` into `requestBody` when the caller sent none.
   */
  prepare(apiKey: string, requestBody: Record<string, unknown>): CodexAffinityRequest {
    const callerKey = requestBody.prompt_cache_key;
    const cacheKey =
      typeof callerKey === 'string' && callerKey && callerKey.length <= MAX_CACHE_KEY_LEN
        ? callerKey
        : null;
    const storeKey = cacheKey ? `${apiKey}\u0000${cacheKey}` : undefined;
    const session = storeKey
      ? this.getOrCreateSession(storeKey, cacheKey)
      : this.createSession(null);
    requestBody.prompt_cache_key = session.promptCacheKey;

    const headers: Record<string, string> = {
      'session-id': session.sessionId,
      'thread-id': session.threadId,
    };
    if (session.turnState) headers['x-codex-turn-state'] = session.turnState;

    return storeKey ? { headers, storeKey, incarnation: session.incarnation } : { headers };
  }

  /**
   * Store the response's sticky-routing token for the next request in this
   * session, or evict the stale one when the upstream rejected the request.
   */
  capture(storeKey: string | undefined, response: Response, incarnation?: number): void {
    if (!storeKey) return;
    const session = this.sessions.get(storeKey);
    // The session can be gone when a request outlives the TTL; the next
    // prepare() starts a fresh one, so there is nothing to record here.
    if (!session) return;
    // A request that outlived its entry (expired or evicted, then replaced
    // under the same key) must not hand its token to the replacement: the
    // ids match, but the token belongs to a turn the new entry never saw.
    if (incarnation !== undefined && incarnation !== session.incarnation) return;
    if (!response.ok) {
      delete session.turnState;
      return;
    }
    const token = response.headers.get('x-codex-turn-state');
    if (!token) return;
    session.turnState = token;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  private getOrCreateSession(storeKey: string, callerCacheKey: string | null): CodexSession {
    this.maybeCleanup();
    const existing = this.sessions.get(storeKey);
    if (existing && Date.now() <= existing.expiresAt) {
      // Sliding expiry: an active tool loop keeps its affinity alive.
      existing.expiresAt = Date.now() + SESSION_TTL_MS;
      // Delete-then-set keeps Map insertion order ≈ recency for the eviction below.
      this.sessions.delete(storeKey);
      this.sessions.set(storeKey, existing);
      return existing;
    }
    if (existing) this.sessions.delete(storeKey);
    if (this.sessions.size >= MAX_ENTRIES) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
    const session = this.createSession(callerCacheKey);
    session.incarnation = this.nextIncarnation++;
    this.sessions.set(storeKey, session);
    return session;
  }

  private createSession(callerCacheKey: string | null): CodexSession {
    if (callerCacheKey === null) {
      return {
        sessionId: randomUUID(),
        threadId: randomUUID(),
        promptCacheKey: randomUUID(),
        expiresAt: Date.now() + SESSION_TTL_MS,
        incarnation: 0,
      };
    }
    return {
      sessionId: derivedUuid('session-id', callerCacheKey),
      threadId: derivedUuid('thread-id', callerCacheKey),
      promptCacheKey: callerCacheKey,
      expiresAt: Date.now() + SESSION_TTL_MS,
      incarnation: 0,
    };
  }

  /** Lazily evict expired entries to avoid unbounded growth. */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    for (const [key, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(key);
    }
  }
}
