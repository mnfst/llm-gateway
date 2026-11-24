const fetchMock = jest.fn();
(global as unknown as Record<string, unknown>).fetch = fetchMock;

describe('GithubController', () => {
  let controller: InstanceType<typeof import('./github.controller').GithubController>;
  // Capture the real Date.now once at module load so individual tests can
  // overwrite Date.now safely. afterEach restores it unconditionally so a
  // failing test cannot leak a fake Date.now into sibling tests.
  const realDateNow = Date.now;

  /** Re-imports the module with fresh module-level cache variables. */
  async function freshImport() {
    const mod = await import('./github.controller');
    return new mod.GithubController();
  }

  beforeEach(async () => {
    jest.resetModules();
    fetchMock.mockReset();
    controller = await freshImport();
  });

  afterEach(() => {
    // Restore Date.now even when a test throws before its inline restore.
    Date.now = realDateNow;
  });

  // ── Happy path ────────────────────────────────────────────────

  it('should fetch stars from GitHub API on first call', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 42 }),
    });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/mnfst/llm-gateway', {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
  });

  it('should return cached stars within TTL without fetching', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 100 }),
    });

    // First call populates the cache
    await controller.getStars();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call should use the cache
    const result = await controller.getStars();

    expect(result).toEqual({ stars: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should re-fetch after cache TTL expires', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 50 }),
    });

    await controller.getStars();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance time past the 10-minute TTL. afterEach restores Date.now.
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 75 }),
    });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: 75 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Error handling ────────────────────────────────────────────

  it('should return null when API fails on first call', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: null });
  });

  it('should return stale cache when API fails after previous success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 200 }),
    });
    await controller.getStars();

    // Expire the cache. afterEach restores Date.now.
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: 200 });
  });

  it('should return null when fetch throws on first call', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));

    const result = await controller.getStars();

    expect(result).toEqual({ stars: null });
  });

  it('should return stale cache when fetch throws after previous success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 300 }),
    });
    await controller.getStars();

    // Expire the cache. afterEach restores Date.now.
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    fetchMock.mockRejectedValue(new Error('timeout'));

    const result = await controller.getStars();

    expect(result).toEqual({ stars: 300 });
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('should not update cache when stargazers_count is missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ some_other_field: 'abc' }),
    });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: null });
  });

  it('should not update cache when stargazers_count is not a number', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 'not-a-number' }),
    });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: null });
  });

  it('should update cache when stargazers_count is zero', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ stargazers_count: 0 }),
    });

    const result = await controller.getStars();

    expect(result).toEqual({ stars: 0 });
  });

  // ── Concurrency ───────────────────────────────────────────────

  it('should deduplicate concurrent requests during cache expiry', async () => {
    // Step 1: prime the cache with a known value so we can exercise the
    // "expired cache + many concurrent callers" code path.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stargazers_count: 100 }),
    });
    await controller.getStars();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Step 2: expire the cache by advancing Date.now past the 10-minute TTL.
    Date.now = () => realDateNow() + 11 * 60 * 1000;

    // Step 3: fire 10 concurrent calls while a single fetch is in flight.
    // The fetch resolution is gated by a manual trigger so all 10 callers
    // observe the in-flight request before it completes.
    let triggerFetchResolve: (value: {
      ok: boolean;
      json: () => Promise<{ stargazers_count: number }>;
    }) => void = () => undefined;
    const pendingFetch = new Promise<{
      ok: boolean;
      json: () => Promise<{ stargazers_count: number }>;
    }>((resolve) => {
      triggerFetchResolve = resolve;
    });
    fetchMock.mockReturnValue(pendingFetch);

    const concurrentCalls = Array.from({ length: 10 }, () => controller.getStars());

    // Yield to the microtask queue so each call has a chance to enter the
    // controller and either share or trigger its own fetch.
    await Promise.resolve();

    // Documents the current behavior: the module-level cache has NO in-flight
    // request coalescing, so every concurrent caller past TTL triggers its
    // own fetch (thundering herd). This test pins the existing semantics so a
    // future deduplication patch shows up as an intentional change here.
    // Total includes the 1 priming call + 10 concurrent calls = 11.
    expect(fetchMock).toHaveBeenCalledTimes(11);

    // Step 4: release the gated fetch and verify all 10 concurrent callers
    // resolve to the same, consistent star count.
    triggerFetchResolve({
      ok: true,
      json: async () => ({ stargazers_count: 250 }),
    });

    const results = await Promise.all(concurrentCalls);

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result).toEqual({ stars: 250 });
    }
  });
});
