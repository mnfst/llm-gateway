interface CachedSignature {
  signature: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Hard ceiling on cached signatures. The key embeds an upstream-generated tool
 * call id (unique per turn), so the keyspace is unbounded and the lazy TTL sweep
 * — which only runs on `store()` — cannot cap a burst. Oldest entries are
 * evicted FIFO.
 */
export const MAX_CACHE_ENTRIES = 10_000;

/**
 * In-memory cache for Google Gemini thought_signature values.
 *
 * Newer Gemini thinking models include a `thought_signature` on functionCall
 * parts. Google requires this signature to round-trip: when the client sends
 * the next request including the assistant's tool calls, the signature must
 * be present. However, many clients strip unknown fields from the OpenAI
 * format. This cache stores signatures from Gemini responses so they can be
 * re-injected when missing from subsequent requests.
 *
 * Keyed by `${sessionKey}:${toolCallId}`.
 */
export class ThoughtSignatureCache {
  private cache = new Map<string, CachedSignature>();
  private lastCleanup = Date.now();

  /** Store a thought_signature for a tool call in a session. */
  store(sessionKey: string, toolCallId: string, signature: string): void {
    this.maybeCleanup();
    this.cache.set(`${sessionKey}:${toolCallId}`, {
      signature,
      expiresAt: Date.now() + TTL_MS,
    });
    this.evictOverflow();
  }

  /** Bound the cache to MAX_CACHE_ENTRIES, evicting oldest (FIFO) entries first. */
  private evictOverflow(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      // size > cap (> 0) guarantees a first key exists.
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  /** Retrieve a cached thought_signature, or null if not found/expired. */
  retrieve(sessionKey: string, toolCallId: string): string | null {
    const entry = this.cache.get(`${sessionKey}:${toolCallId}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(`${sessionKey}:${toolCallId}`);
      return null;
    }
    return entry.signature;
  }

  /** Clear all cached signatures for a session. */
  clearSession(sessionKey: string): void {
    const prefix = `${sessionKey}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
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
  }
}
