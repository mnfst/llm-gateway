import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as routing from '../../../src/services/api/routing';

vi.mock('../../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function setupFetch(response: unknown = {}, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('routing API client (additional coverage)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/' } });
    routing.invalidateCustomProvidersCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    routing.invalidateCustomProvidersCache();
  });

  it('getRoutingStatus GETs the status endpoint', async () => {
    const fetchMock = setupFetch({ enabled: true, reason: null });
    const out = await routing.getRoutingStatus('demo');
    expect(out).toEqual({ enabled: true, reason: null });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/status');
  });

  it('getProviders GETs the providers list', async () => {
    const fetchMock = setupFetch([{ id: 'p1' }]);
    await routing.getProviders('demo');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/providers');
  });

  it('connectProvider POSTs the new provider record', async () => {
    const fetchMock = setupFetch({
      id: 'p1',
      provider: 'openai',
      auth_type: 'api_key',
      is_active: true,
    });
    const out = await routing.connectProvider('demo', {
      provider: 'openai',
      apiKey: 'sk-1',
      authType: 'api_key',
    });
    expect(out.id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/providers');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: 'openai',
      apiKey: 'sk-1',
      authType: 'api_key',
    });
  });

  it('disconnectProvider DELETEs the provider with no authType', async () => {
    const fetchMock = setupFetch({ ok: true, notifications: [] });
    await routing.disconnectProvider('demo', 'openai');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/providers/openai');
    expect(url).not.toContain('authType=');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('disconnectProvider appends authType when provided', async () => {
    const fetchMock = setupFetch({ ok: true, notifications: [] });
    await routing.disconnectProvider('demo', 'openai', 'subscription');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('authType=subscription');
  });

  it('copilotDeviceCode POSTs to the device-code endpoint', async () => {
    const fetchMock = setupFetch({
      device_code: 'd1',
      user_code: 'CODE',
      verification_uri: 'https://verify',
      expires_in: 900,
      interval: 5,
    });
    await routing.copilotDeviceCode('demo');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/copilot/device-code');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('copilotPollToken POSTs the device code as JSON', async () => {
    const fetchMock = setupFetch({ status: 'pending' });
    const out = await routing.copilotPollToken('demo', 'dc-1');
    expect(out).toEqual({ status: 'pending' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/routing/demo/copilot/poll-token');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ deviceCode: 'dc-1' });
  });

  it('copilotPollToken throws on non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(routing.copilotPollToken('demo', 'dc-1')).rejects.toThrow(/Poll failed/);
  });

  describe('autofix config', () => {
    it('getAutofix GETs the autofix endpoint', async () => {
      const fetchMock = setupFetch({ enabled: true });
      const out = await routing.getAutofix('demo');
      expect(out).toEqual({ enabled: true });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/routing/demo/autofix');
    });

    it('updateAutofix PATCHes the autofix endpoint with a JSON body', async () => {
      const fetchMock = setupFetch({ enabled: true });
      const out = await routing.updateAutofix('demo', { enabled: true });
      expect(out).toEqual({ enabled: true });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/v1/routing/demo/autofix');
      expect((init as RequestInit).method).toBe('PATCH');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        enabled: true,
      });
    });
  });

  describe('message recording config', () => {
    it('GETs and PATCHes the per-agent recording flag', async () => {
      const fetchMock = setupFetch({ enabled: false });
      await expect(routing.getRecording('demo')).resolves.toEqual({ enabled: false });
      expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/routing/demo/recording');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ enabled: true }),
        text: async () => '{"enabled":true}',
      });
      await expect(routing.updateRecording('demo', { enabled: true })).resolves.toEqual({
        enabled: true,
      });
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toContain('/api/v1/routing/demo/recording');
      expect((init as RequestInit).method).toBe('PATCH');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ enabled: true });
    });
  });

  it('getTierAssignments GETs the tiers list', async () => {
    const fetchMock = setupFetch([]);
    await routing.getTierAssignments('demo');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/tiers');
  });

  it('resetTier DELETEs the tier override', async () => {
    const fetchMock = setupFetch({});
    await routing.resetTier('demo', 'simple');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/tiers/simple');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('overrideTier includes providerKeyLabel in both legacy and structured payloads', async () => {
    const fetchMock = setupFetch({ tier: 'simple' });
    await routing.overrideTier('demo', 'simple', 'gpt-4o', 'openai', 'api_key', 'primary');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
      authType: 'api_key',
      providerKeyLabel: 'primary',
      route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o', keyLabel: 'primary' },
    });
  });

  it('setTierResponseMode PATCHes the response-mode endpoint', async () => {
    const fetchMock = setupFetch({ tier: 'simple', response_mode: 'stream' });
    const out = await routing.setTierResponseMode('demo', 'simple', 'stream');
    expect(out).toEqual({ tier: 'simple', response_mode: 'stream' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/tiers/simple/response-mode');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      response_mode: 'stream',
    });
  });

  it('resetAllTiers POSTs to /reset-all', async () => {
    const fetchMock = setupFetch({});
    await routing.resetAllTiers('demo');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/tiers/reset-all');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('getFallbacks GETs the fallbacks endpoint', async () => {
    const fetchMock = setupFetch([]);
    await routing.getFallbacks('demo', 'simple');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/tiers/simple/fallbacks');
  });

  it('clearFallbacks DELETEs the fallbacks endpoint', async () => {
    const fetchMock = setupFetch({});
    await routing.clearFallbacks('demo', 'simple');
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('getAvailableModels GETs the available-models endpoint', async () => {
    const fetchMock = setupFetch([]);
    await routing.getAvailableModels('demo');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/available-models');
  });

  it('refreshModels POSTs to the refresh-models endpoint', async () => {
    const fetchMock = setupFetch({ ok: true });
    await routing.refreshModels('demo');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/refresh-models');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('refreshProviderModels POSTs without authType by default', async () => {
    const fetchMock = setupFetch({ ok: true, model_count: 12, last_fetched_at: null, error: null });
    await routing.refreshProviderModels('demo', 'openai');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/demo/providers/openai/refresh-models');
    expect(url).not.toContain('authType=');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('refreshProviderModels appends authType when provided', async () => {
    const fetchMock = setupFetch({ ok: true, model_count: 12, last_fetched_at: null, error: null });
    await routing.refreshProviderModels('demo', 'openai', 'api_key');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/demo/providers/openai/refresh-models?authType=api_key');
  });

  it('getEnabledProviders GETs enabled user provider ids', async () => {
    const fetchMock = setupFetch({ enabled: ['up-1'] });
    const out = await routing.getEnabledProviders('demo agent');
    expect(out).toEqual({ enabled: ['up-1'] });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/agents/demo%20agent/enabled-providers');
  });

  it('getAgentProviderDisableImpact GETs the disable impact endpoint', async () => {
    const fetchMock = setupFetch({ affected_tiers: [] });
    await routing.getAgentProviderDisableImpact('demo', 'up/1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/agents/demo/enabled-providers/up%2F1/impact');
  });

  it('enableProviderForAgent PUTs to the enabled-providers endpoint', async () => {
    const fetchMock = setupFetch({ ok: true });
    await routing.enableProviderForAgent('demo', 'up-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/agents/demo/enabled-providers/up-1');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('disableProviderForAgent DELETEs the enabled-providers endpoint', async () => {
    const fetchMock = setupFetch({ ok: true });
    await routing.disableProviderForAgent('demo', 'up-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/agents/demo/enabled-providers/up-1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('getPricingHealth GETs the pricing-health endpoint', async () => {
    const fetchMock = setupFetch({ model_count: 100, last_fetched_at: '2025-01-01' });
    await routing.getPricingHealth();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/routing/pricing-health');
  });

  it('refreshPricing POSTs to the refresh endpoint', async () => {
    const fetchMock = setupFetch({ ok: true, model_count: 50, last_fetched_at: '2025-01-01' });
    await routing.refreshPricing();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/routing/pricing/refresh');
    expect((init as RequestInit).method).toBe('POST');
  });

  describe('custom providers cache', () => {
    it('caches the result and returns the same promise on subsequent calls', async () => {
      const fetchMock = setupFetch([{ id: 'cp-1' }]);
      const p1 = routing.getCustomProviders('demo');
      const p2 = routing.getCustomProviders('demo');
      expect(p1).toBe(p2);
      await p1;
      // Only one network call
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('invalidateCustomProvidersCache(name) drops the cached entry for that agent', async () => {
      const fetchMock = setupFetch([]);
      await routing.getCustomProviders('demo');
      routing.invalidateCustomProvidersCache('demo');
      await routing.getCustomProviders('demo');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('invalidateCustomProvidersCache() with no arg clears the entire cache', async () => {
      const fetchMock = setupFetch([]);
      await routing.getCustomProviders('a');
      await routing.getCustomProviders('b');
      routing.invalidateCustomProvidersCache();
      await routing.getCustomProviders('a');
      // initial 2 + 1 after invalidation
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('drops the cache entry on fetch failure so the next call retries', async () => {
      // First call fails
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => 'boom',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ id: 'cp-1' }],
          text: async () => '[]',
        });
      vi.stubGlobal('fetch', fetchMock);

      await expect(routing.getCustomProviders('demo')).rejects.toThrow();
      // Next call should re-fetch
      await routing.getCustomProviders('demo');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('deleteCustomProvider DELETEs the custom provider and invalidates its cache', async () => {
      const fetchMock = setupFetch([]);
      await routing.getCustomProviders('demo');
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      });
      await routing.deleteCustomProvider('demo', 'cp/1');
      await routing.getCustomProviders('demo');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toContain('/api/v1/routing/demo/custom-providers/cp%2F1');
      expect((init as RequestInit).method).toBe('DELETE');
    });
  });

  it('createCustomProvider invalidates the cache and POSTs', async () => {
    const fetchMock = setupFetch({
      id: 'cp-new',
      name: 'New',
      base_url: 'http://x',
      has_api_key: false,
      models: [],
      created_at: '2025-01-01',
    });
    await routing.createCustomProvider('demo', {
      name: 'New',
      base_url: 'http://x',
      models: [],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/routing/demo/custom-providers');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('updateCustomProvider invalidates the cache and PUTs to the id-scoped endpoint', async () => {
    const fetchMock = setupFetch({
      id: 'cp-1',
      name: 'Updated',
      base_url: 'http://y',
      has_api_key: true,
      models: [],
      created_at: '2025-01-01',
    });
    await routing.updateCustomProvider('demo', 'cp-1', { name: 'Updated' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/routing/demo/custom-providers/cp-1');
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('probeCustomProvider returns { models: [] } when response body is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await routing.probeCustomProvider('demo', 'http://x');
    expect(out).toEqual({ models: [] });
  });

  it('probeCustomProvider includes api_kind when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
      text: async () => JSON.stringify({ models: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await routing.probeCustomProvider('demo', 'http://x', undefined, 'anthropic');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.api_kind).toBe('anthropic');
  });

  it('probeCustomProvider includes provider_name when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
      text: async () => JSON.stringify({ models: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await routing.probeCustomProvider('demo', 'http://x', undefined, 'openai', 'Kilo Gateway');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.provider_name).toBe('Kilo Gateway');
  });

  it('probeCustomProvider throws using parseErrorMessage on non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'bad URL' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(routing.probeCustomProvider('demo', 'http://x')).rejects.toThrow('bad URL');
  });

  it('disconnectConnection DELETEs the tenant-level provider with auth type and label', async () => {
    const fetchMock = setupFetch({ ok: true, notifications: [] });
    await routing.disconnectConnection('custom:a b', 'api_key', 'Work key');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/providers/custom%3Aa%20b?authType=api_key&label=Work+key');
    expect(url).not.toContain('/routing/');
    expect(init.method).toBe('DELETE');
  });

  it('disconnectConnection omits the query string when no filters are given', async () => {
    const fetchMock = setupFetch({ ok: true, notifications: [] });
    await routing.disconnectConnection('openai');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/providers\/openai$/);
  });

  it('renameConnection PATCHes the tenant-level key label', async () => {
    const fetchMock = setupFetch({ id: 'p1', label: 'New', priority: 0 });
    await routing.renameConnection('openai', 'Old key', 'New', 'subscription');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/providers/openai/keys/Old%20key');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ newLabel: 'New', authType: 'subscription' });
  });

  it('renameConnection leaves authType out of the body when not given', async () => {
    const fetchMock = setupFetch({ id: 'p1', label: 'New', priority: 0 });
    await routing.renameConnection('openai', 'Old', 'New');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ newLabel: 'New' });
  });

  it('refreshConnectionModels POSTs the tenant-level refresh', async () => {
    const fetchMock = setupFetch({ ok: true });
    await routing.refreshConnectionModels();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/providers/refresh-models');
    expect(init.method).toBe('POST');
  });
});
