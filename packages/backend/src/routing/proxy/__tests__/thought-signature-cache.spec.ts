import { ThoughtSignatureCache, MAX_CACHE_ENTRIES } from '../thought-signature-cache';

describe('ThoughtSignatureCache', () => {
  let cache: ThoughtSignatureCache;

  beforeEach(() => {
    cache = new ThoughtSignatureCache();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores and retrieves a signature', () => {
    cache.store('session-1', 'tc-1', 'sig-abc');
    expect(cache.retrieve('session-1', 'tc-1')).toBe('sig-abc');
  });

  it('returns null for a non-existent key', () => {
    expect(cache.retrieve('no-session', 'no-tool')).toBeNull();
  });

  it('returns null for an expired entry', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    // Store at baseTime
    Date.now = () => baseTime;
    cache.store('session-1', 'tc-1', 'sig-expired');

    // Retrieve 31 minutes later (TTL is 30 minutes)
    Date.now = () => baseTime + 31 * 60 * 1000;
    expect(cache.retrieve('session-1', 'tc-1')).toBeNull();

    Date.now = realNow;
  });

  it('returns the signature when it has not yet expired', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    cache.store('session-1', 'tc-1', 'sig-valid');

    // Retrieve 29 minutes later (still within 30 min TTL)
    Date.now = () => baseTime + 29 * 60 * 1000;
    expect(cache.retrieve('session-1', 'tc-1')).toBe('sig-valid');

    Date.now = realNow;
  });

  it('clearSession removes all entries for a given session', () => {
    cache.store('session-A', 'tc-1', 'sig-1');
    cache.store('session-A', 'tc-2', 'sig-2');
    cache.store('session-B', 'tc-1', 'sig-3');

    cache.clearSession('session-A');

    expect(cache.retrieve('session-A', 'tc-1')).toBeNull();
    expect(cache.retrieve('session-A', 'tc-2')).toBeNull();
    expect(cache.retrieve('session-B', 'tc-1')).toBe('sig-3');
  });

  it('clearSession does not throw for a non-existent session', () => {
    expect(() => cache.clearSession('unknown')).not.toThrow();
  });

  it('stores entries for multiple sessions independently', () => {
    cache.store('s1', 'tc-1', 'a');
    cache.store('s2', 'tc-1', 'b');
    cache.store('s3', 'tc-2', 'c');

    expect(cache.retrieve('s1', 'tc-1')).toBe('a');
    expect(cache.retrieve('s2', 'tc-1')).toBe('b');
    expect(cache.retrieve('s3', 'tc-2')).toBe('c');
  });

  it('overwrites existing entry for the same session and tool call', () => {
    cache.store('session-1', 'tc-1', 'old-sig');
    cache.store('session-1', 'tc-1', 'new-sig');

    expect(cache.retrieve('session-1', 'tc-1')).toBe('new-sig');
  });

  it('evicts the oldest entries once MAX_CACHE_ENTRIES is exceeded', () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      cache.store('session', `tc-${i}`, `sig-${i}`);
    }

    // The five oldest entries are evicted FIFO; the cap holds and recent entries survive.
    expect(cache.retrieve('session', 'tc-0')).toBeNull();
    expect(cache.retrieve('session', 'tc-4')).toBeNull();
    expect(cache.retrieve('session', 'tc-5')).not.toBeNull();
    expect(cache.retrieve('session', `tc-${MAX_CACHE_ENTRIES + 4}`)).not.toBeNull();
  });

  describe('maybeCleanup (lazy eviction)', () => {
    it('evicts expired entries when cleanup interval has elapsed', () => {
      const realNow = Date.now;
      const baseTime = 1000000000000;

      // Create a fresh cache with mocked Date.now so lastCleanup is baseTime
      Date.now = () => baseTime;
      const localCache = new ThoughtSignatureCache();

      // Store an entry at baseTime
      localCache.store('s1', 'tc-1', 'sig-1');

      // Advance past TTL (30 min) AND cleanup interval (5 min)
      Date.now = () => baseTime + 31 * 60 * 1000;

      // Store a new entry - this triggers maybeCleanup because
      // now - lastCleanup > 5 min, and sig-1 is expired
      localCache.store('s2', 'tc-2', 'sig-2');

      // The expired entry should have been cleaned up during the store call
      expect(localCache.retrieve('s1', 'tc-1')).toBeNull();
      // The new entry is still valid
      expect(localCache.retrieve('s2', 'tc-2')).toBe('sig-2');

      Date.now = realNow;
    });

    it('does not evict entries when cleanup interval has not elapsed', () => {
      const realNow = Date.now;
      const baseTime = 1000000000000;

      Date.now = () => baseTime;
      const localCache = new ThoughtSignatureCache();

      localCache.store('s1', 'tc-1', 'sig-1');

      // Advance only 2 minutes (less than 5 min cleanup interval)
      Date.now = () => baseTime + 2 * 60 * 1000;
      localCache.store('s2', 'tc-2', 'sig-2');

      // sig-1 has not expired (only 2 min passed, TTL is 30 min)
      expect(localCache.retrieve('s1', 'tc-1')).toBe('sig-1');
      expect(localCache.retrieve('s2', 'tc-2')).toBe('sig-2');

      Date.now = realNow;
    });
  });
});
