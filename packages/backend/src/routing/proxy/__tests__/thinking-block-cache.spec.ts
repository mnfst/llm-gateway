import { ThinkingBlockCache, ThinkingBlock, MAX_CACHE_ENTRIES } from '../thinking-block-cache';

describe('ThinkingBlockCache', () => {
  let cache: ThinkingBlockCache;

  beforeEach(() => {
    cache = new ThinkingBlockCache();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores and retrieves a blocks array (same reference)', () => {
    const blocks: ThinkingBlock[] = [
      { type: 'thinking', thinking: 'reasoning...', signature: 'sig_1' },
    ];
    cache.store('session-1', 'toolu_1', blocks);

    const retrieved = cache.retrieve('session-1', 'toolu_1');
    expect(retrieved).toBe(blocks);
  });

  it('retrieves route-scoped blocks only for the same provider auth and model', () => {
    const blocks: ThinkingBlock[] = [
      { type: 'thinking', thinking: 'reasoning...', signature: 'sig_1' },
    ];
    const routeContext = {
      provider: 'anthropic',
      authType: 'subscription',
      model: 'claude-sonnet-4-5-20250929',
    };

    cache.store('session-1', 'toolu_1', blocks, routeContext);

    expect(cache.retrieve('session-1', 'toolu_1', routeContext)).toBe(blocks);
    expect(
      cache.retrieve('session-1', 'toolu_1', {
        provider: 'anthropic',
        authType: 'api_key',
        model: 'claude-sonnet-4-5-20250929',
      }),
    ).toBeNull();
    expect(
      cache.retrieve('session-1', 'toolu_1', {
        provider: 'minimax',
        authType: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      }),
    ).toBeNull();
    expect(
      cache.retrieve('session-1', 'toolu_1', {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-opus-4-1-20250805',
      }),
    ).toBeNull();

    // Incompatible attempts do not consume or mutate the cached blocks.
    expect(cache.retrieve('session-1', 'toolu_1', routeContext)).toBe(blocks);
  });

  it('normalizes route context case and defaults missing auth type to api_key', () => {
    const blocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 'ok', signature: 'sig' }];
    cache.store('session-1', 'toolu_1', blocks, {
      provider: 'Anthropic',
      model: 'Claude-Sonnet-4-5-20250929',
    });

    expect(
      cache.retrieve('session-1', 'toolu_1', {
        provider: 'anthropic',
        authType: 'api_key',
        model: 'claude-sonnet-4-5-20250929',
      }),
    ).toBe(blocks);
  });

  it('does not replay an unscoped entry into a scoped lookup', () => {
    const blocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 'legacy', signature: 'sig' }];
    cache.store('session-1', 'toolu_1', blocks);

    expect(
      cache.retrieve('session-1', 'toolu_1', {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      }),
    ).toBeNull();
    expect(cache.retrieve('session-1', 'toolu_1')).toBe(blocks);
  });

  it('returns null for a non-existent key', () => {
    expect(cache.retrieve('no-session', 'no-tool')).toBeNull();
  });

  it('returns null and deletes the entry when it has expired', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    cache.store('session-1', 'toolu_1', [{ type: 'thinking', thinking: 'x', signature: 's' }]);

    // Retrieve 31 minutes later (TTL is 30 minutes)
    Date.now = () => baseTime + 31 * 60 * 1000;
    expect(cache.retrieve('session-1', 'toolu_1')).toBeNull();

    // Advance time back and confirm entry was deleted (second retrieve still null)
    Date.now = () => baseTime + 31 * 60 * 1000 + 1;
    expect(cache.retrieve('session-1', 'toolu_1')).toBeNull();

    Date.now = realNow;
  });

  it('returns the blocks when they have not yet expired', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    const blocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 'ok', signature: 'sig' }];
    cache.store('session-1', 'toolu_1', blocks);

    // Retrieve 29 minutes later (still within 30 min TTL)
    Date.now = () => baseTime + 29 * 60 * 1000;
    expect(cache.retrieve('session-1', 'toolu_1')).toBe(blocks);

    Date.now = realNow;
  });

  it('store with empty blocks array is a no-op', () => {
    cache.store('session-1', 'toolu_1', []);
    expect(cache.retrieve('session-1', 'toolu_1')).toBeNull();
  });

  it('clearSession removes all entries for a given session', () => {
    cache.store('session-A', 'toolu_1', [{ type: 'thinking', thinking: 'a', signature: 's1' }]);
    cache.store('session-A', 'toolu_2', [{ type: 'thinking', thinking: 'b', signature: 's2' }]);
    cache.store('session-B', 'toolu_1', [{ type: 'thinking', thinking: 'c', signature: 's3' }]);

    cache.clearSession('session-A');

    expect(cache.retrieve('session-A', 'toolu_1')).toBeNull();
    expect(cache.retrieve('session-A', 'toolu_2')).toBeNull();
    expect(cache.retrieve('session-B', 'toolu_1')).not.toBeNull();
  });

  it('clearSession does not throw for a non-existent session', () => {
    expect(() => cache.clearSession('unknown')).not.toThrow();
  });

  it('stores entries for multiple sessions independently', () => {
    const b1: ThinkingBlock[] = [{ type: 'thinking', thinking: 'a', signature: 'x' }];
    const b2: ThinkingBlock[] = [{ type: 'thinking', thinking: 'b', signature: 'y' }];
    const b3: ThinkingBlock[] = [{ type: 'redacted_thinking', data: 'zzz' }];
    cache.store('s1', 'toolu_1', b1);
    cache.store('s2', 'toolu_1', b2);
    cache.store('s3', 'toolu_2', b3);

    expect(cache.retrieve('s1', 'toolu_1')).toBe(b1);
    expect(cache.retrieve('s2', 'toolu_1')).toBe(b2);
    expect(cache.retrieve('s3', 'toolu_2')).toBe(b3);
  });

  it('overwrites an existing entry for the same session and tool use id', () => {
    const oldBlocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 'old', signature: 's' }];
    const newBlocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 'new', signature: 's' }];
    cache.store('session-1', 'toolu_1', oldBlocks);
    cache.store('session-1', 'toolu_1', newBlocks);

    expect(cache.retrieve('session-1', 'toolu_1')).toBe(newBlocks);
  });

  it('evicts the oldest entries once MAX_CACHE_ENTRIES is exceeded', () => {
    const block: ThinkingBlock[] = [{ type: 'thinking', thinking: 't', signature: 's' }];
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      cache.store('session', `toolu_${i}`, block);
    }

    // The five oldest entries are evicted FIFO; the cap holds and recent entries survive.
    expect(cache.retrieve('session', 'toolu_0')).toBeNull();
    expect(cache.retrieve('session', 'toolu_4')).toBeNull();
    expect(cache.retrieve('session', 'toolu_5')).not.toBeNull();
    expect(cache.retrieve('session', `toolu_${MAX_CACHE_ENTRIES + 4}`)).not.toBeNull();
  });

  describe('maybeCleanup (lazy eviction)', () => {
    it('evicts expired entries when cleanup interval has elapsed', () => {
      const realNow = Date.now;
      const baseTime = 1000000000000;

      Date.now = () => baseTime;
      const localCache = new ThinkingBlockCache();

      // Store an entry at baseTime
      localCache.store('s1', 'toolu_1', [
        { type: 'thinking', thinking: 'first', signature: 'sig1' },
      ]);

      // Advance past TTL (30 min) AND cleanup interval (5 min)
      Date.now = () => baseTime + 31 * 60 * 1000;

      // Store a new entry — this triggers maybeCleanup because
      // now - lastCleanup > 5 min, and s1's entry is expired
      localCache.store('s2', 'toolu_2', [
        { type: 'thinking', thinking: 'second', signature: 'sig2' },
      ]);

      // The expired entry should have been cleaned up during the store call
      expect(localCache.retrieve('s1', 'toolu_1')).toBeNull();
      // The new entry is still valid
      expect(localCache.retrieve('s2', 'toolu_2')).not.toBeNull();

      Date.now = realNow;
    });

    it('does not evict entries when cleanup interval has not elapsed', () => {
      const realNow = Date.now;
      const baseTime = 1000000000000;

      Date.now = () => baseTime;
      const localCache = new ThinkingBlockCache();

      const blocks1: ThinkingBlock[] = [{ type: 'thinking', thinking: 'first', signature: 'sig1' }];
      localCache.store('s1', 'toolu_1', blocks1);

      // Advance only 2 minutes (less than 5 min cleanup interval)
      Date.now = () => baseTime + 2 * 60 * 1000;
      const blocks2: ThinkingBlock[] = [
        { type: 'thinking', thinking: 'second', signature: 'sig2' },
      ];
      localCache.store('s2', 'toolu_2', blocks2);

      // blocks1 has not expired (only 2 min passed, TTL is 30 min)
      expect(localCache.retrieve('s1', 'toolu_1')).toBe(blocks1);
      expect(localCache.retrieve('s2', 'toolu_2')).toBe(blocks2);

      Date.now = realNow;
    });
  });
});
