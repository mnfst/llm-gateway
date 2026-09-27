import type { Repository } from 'typeorm';
import { ReasoningContentCacheEntry } from '../../../entities/reasoning-content-cache-entry.entity';
import { ReasoningContentCache, MAX_CACHE_ENTRIES } from '../reasoning-content-cache';

const makeRepo = () =>
  ({
    upsert: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
  }) as unknown as jest.Mocked<Repository<ReasoningContentCacheEntry>>;

describe('ReasoningContentCache', () => {
  let cache: ReasoningContentCache;

  beforeEach(() => {
    cache = new ReasoningContentCache();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores and retrieves reasoning_content', () => {
    cache.store('session-1', 'call_1', 'thinking');
    expect(cache.retrieve('session-1', 'call_1')).toBe('thinking');
  });

  it('returns null for a non-existent key', () => {
    expect(cache.retrieve('no-session', 'no-call')).toBeNull();
  });

  it('ignores empty reasoning_content', () => {
    cache.store('session-1', 'call_1', '');
    expect(cache.retrieve('session-1', 'call_1')).toBeNull();
  });

  it('returns null for an expired entry', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    cache.store('session-1', 'call_1', 'expired');

    Date.now = () => baseTime + 31 * 60 * 1000;
    expect(cache.retrieve('session-1', 'call_1')).toBeNull();

    Date.now = realNow;
  });

  it('returns content when it has not yet expired', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    cache.store('session-1', 'call_1', 'valid');

    Date.now = () => baseTime + 29 * 60 * 1000;
    expect(cache.retrieve('session-1', 'call_1')).toBe('valid');

    Date.now = realNow;
  });

  it('clearSession removes all entries for a given session', () => {
    cache.store('session-A', 'call_1', 'a');
    cache.store('session-A', 'call_2', 'b');
    cache.store('session-B', 'call_1', 'c');

    cache.clearSession('session-A');

    expect(cache.retrieve('session-A', 'call_1')).toBeNull();
    expect(cache.retrieve('session-A', 'call_2')).toBeNull();
    expect(cache.retrieve('session-B', 'call_1')).toBe('c');
  });

  it('stores entries for multiple sessions independently', () => {
    cache.store('s1', 'call_1', 'a');
    cache.store('s2', 'call_1', 'b');
    cache.store('s3', 'call_2', 'c');

    expect(cache.retrieve('s1', 'call_1')).toBe('a');
    expect(cache.retrieve('s2', 'call_1')).toBe('b');
    expect(cache.retrieve('s3', 'call_2')).toBe('c');
  });

  it('overwrites existing entry for the same session and tool call', () => {
    cache.store('session-1', 'call_1', 'old');
    cache.store('session-1', 'call_1', 'new');

    expect(cache.retrieve('session-1', 'call_1')).toBe('new');
  });

  it('persists stored reasoning_content to the shared repository when available', () => {
    const repo = makeRepo();
    const sharedCache = new ReasoningContentCache(repo);

    sharedCache.store('session-1', 'call_1', 'thinking');

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        session_key: 'session-1',
        first_tool_call_id: 'call_1',
        content: 'thinking',
      }),
      ['session_key', 'first_tool_call_id'],
    );
  });

  it('retrieves shared reasoning_content and warms the local cache', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      {
        session_key: 'session-1',
        first_tool_call_id: 'call_2',
        content: 'shared thinking',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const sharedCache = new ReasoningContentCache(repo);

    const result = await sharedCache.retrieveMany('session-1', ['call_2']);

    expect(result.get('call_2')).toBe('shared thinking');
    expect(sharedCache.retrieve('session-1', 'call_2')).toBe('shared thinking');
  });

  it('re-injects shared reasoning_content into compatible assistant tool-call messages', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      {
        session_key: 'session-1',
        first_tool_call_id: 'call_1',
        content: 'shared thinking',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const sharedCache = new ReasoningContentCache(repo);
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await sharedCache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-chat');

    const messages = result.messages as Array<Record<string, unknown>>;
    const originalMessages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('shared thinking');
    expect(originalMessages[0].reasoning_content).toBeUndefined();
  });

  it('does not re-inject reasoning_content into assistant messages without tool calls', async () => {
    const body = {
      messages: [{ role: 'assistant', content: 'The answer is 42.' }],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    expect(result).toBe(body);
    expect((body.messages[0] as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it('replays an empty reasoning_content key onto non-tool assistant turns in a tool conversation', async () => {
    const body = {
      messages: [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: 'on it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    // DeepSeek's thinking mode rejects the request when any assistant turn omits
    // the key once tools are in play, so the plain turn is replayed empty too.
    expect(messages[1].reasoning_content).toBe('');
    expect(messages[2].reasoning_content).toBe('');
    expect(messages[0].reasoning_content).toBeUndefined();
    expect(messages[3].reasoning_content).toBeUndefined();
  });

  it('leaves an existing non-tool reasoning_content untouched in a tool conversation', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: 'on it',
          reasoning_content: 'client thinking',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('client thinking');
  });

  it('leaves request bodies without messages unchanged', async () => {
    const body = { prompt: 'The answer is 42.' };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    expect(result).toBe(body);
  });

  it('synthesizes empty reasoning_content when the client dropped it and no cache exists', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('');
    expect(result).not.toBe(body);
  });

  it('keeps an existing empty fallback without copying the request', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    expect(result).toBe(body);
  });

  it('keeps exact client reasoning_content without copying the request', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'client thinking',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    expect(result).toBe(body);
  });

  it('replaces empty client reasoning_content with an exact cache hit', async () => {
    cache.store('session-1', 'call_1', 'cached thinking');
    const body = {
      messages: [
        {
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('cached thinking');
  });

  it('synthesizes empty reasoning_content when the first tool call has no cache key', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('');
  });

  it('uses empty reasoning_content when a tool call id is ambiguous in one request', async () => {
    cache.store('session-1', 'call_1', 'cached thinking');
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{}' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'deepseek', 'deepseek-v4-flash');

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('');
    expect(messages[2].reasoning_content).toBe('');
    expect(result).not.toBe(body);
  });

  it('does not re-inject reasoning_content into strict providers', async () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(body, 'session-1', 'mistral', 'mistral-large');

    expect(result).toBe(body);
    expect((body.messages[0] as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it('does not query shared cache for strict providers', async () => {
    const repo = makeRepo();
    const sharedCache = new ReasoningContentCache(repo);
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await sharedCache.prepareRequest(body, 'session-1', 'mistral', 'mistral-large');

    expect(result).toBe(body);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('evicts the oldest in-memory entries once MAX_CACHE_ENTRIES is exceeded', () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      cache.store('session', `call_${i}`, `content-${i}`);
    }

    // The five oldest entries are evicted FIFO; the cap holds and recent entries survive.
    expect(cache.retrieve('session', 'call_0')).toBeNull();
    expect(cache.retrieve('session', 'call_4')).toBeNull();
    expect(cache.retrieve('session', 'call_5')).not.toBeNull();
    expect(cache.retrieve('session', `call_${MAX_CACHE_ENTRIES + 4}`)).not.toBeNull();
  });

  it('evicts expired entries lazily when cleanup interval has elapsed', () => {
    const realNow = Date.now;
    const baseTime = 1000000000000;

    Date.now = () => baseTime;
    const localCache = new ReasoningContentCache();
    localCache.store('s1', 'call_1', 'first');

    Date.now = () => baseTime + 31 * 60 * 1000;
    localCache.store('s2', 'call_2', 'second');

    expect(localCache.retrieve('s1', 'call_1')).toBeNull();
    expect(localCache.retrieve('s2', 'call_2')).toBe('second');

    Date.now = realNow;
  });
});

describe('ReasoningContentCache catalog wiring', () => {
  const zenCatalog = {
    isReasoningModel: (_endpointKey: string, model: string) =>
      model.toLowerCase().endsWith('big-pickle') ? true : undefined,
  };

  it('prepares Zen codename tool turns the catalog marks as reasoning', async () => {
    const cache = new ReasoningContentCache(undefined, zenCatalog);
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(
      body,
      'session-1',
      'opencode-zen',
      'opencode-zen/big-pickle',
    );

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('');
  });

  it('leaves Zen slugs alone when the catalog does not know them', async () => {
    const cache = new ReasoningContentCache(undefined, zenCatalog);
    const body = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
        },
      ],
    };

    const result = await cache.prepareRequest(
      body,
      'session-1',
      'opencode-zen',
      'opencode-zen/mystery-slug',
    );

    expect(result).toBe(body);
  });
});
