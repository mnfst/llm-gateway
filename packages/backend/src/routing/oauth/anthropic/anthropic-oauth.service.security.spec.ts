import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { AnthropicOauthService } from './anthropic-oauth.service';
import {
  OAuthPendingFlowStore,
  type OAuthPendingFlowInput,
  type OAuthPendingFlowRecord,
} from '../core';

const originalFetch = global.fetch;

function mockResponse(status: number, body: unknown, text = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text || JSON.stringify(body),
  } as unknown as Response;
}

function createProviderService() {
  const upsertProvider = jest.fn().mockResolvedValue({ provider: { id: 'p1' } });
  const recalculateTiers = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue(undefined);
  const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
  return {
    svc: {
      upsertProvider,
      recalculateTiers,
      nextOAuthLabel,
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock: mockSubscriptionCredentialLock({
        getFreshSubscriptionCredential,
        upsertProvider,
      }),
    } as unknown as ProviderService,
    upsertProvider,
    recalculateTiers,
    nextOAuthLabel,
    getFreshSubscriptionCredential,
    withSubscriptionCredentialLock: mockSubscriptionCredentialLock({
      getFreshSubscriptionCredential,
      upsertProvider,
    }),
  };
}

function createDiscovery(): { svc: ModelDiscoveryService; discoverModels: jest.Mock } {
  const discoverModels = jest.fn().mockResolvedValue(undefined);
  return { svc: { discoverModels } as unknown as ModelDiscoveryService, discoverModels };
}

function createPendingStore() {
  const flows = new Map<string, OAuthPendingFlowRecord>();
  const key = (p: string, s: string) => `${p}:${s}`;
  const cleanup = () => {
    for (const [k, f] of flows) if (f.expiresAt < Date.now()) flows.delete(k);
  };
  const svc = {
    create: jest.fn(async (provider: string, input: OAuthPendingFlowInput, ttlMs: number) => {
      cleanup();
      for (const [k, f] of flows) {
        if (
          f.provider === provider &&
          f.agentId === input.agentId &&
          f.tenantId === input.tenantId
        ) {
          flows.delete(k);
        }
      }
      const record = { provider, ...input, expiresAt: Date.now() + ttlMs };
      flows.set(key(provider, input.state), record);
      return record;
    }),
    consume: jest.fn(async (provider: string, state: string, agentId: string, tenantId: string) => {
      const flow = flows.get(key(provider, state));
      if (!flow || flow.agentId !== agentId || flow.tenantId !== tenantId) return null;
      flows.delete(key(provider, state));
      return flow;
    }),
    findLatestForAgent: jest.fn(async (provider: string, agentId: string, tenantId: string) => {
      cleanup();
      for (const f of flows.values()) {
        if (f.provider === provider && f.agentId === agentId && f.tenantId === tenantId) return f;
      }
      return null;
    }),
    clear: jest.fn(async (provider: string, state: string) => {
      flows.delete(key(provider, state));
    }),
    count: jest.fn(async (provider: string) => {
      cleanup();
      let t = 0;
      for (const f of flows.values()) if (f.provider === provider) t += 1;
      return t;
    }),
  } as unknown as OAuthPendingFlowStore;
  return { svc, flows };
}

describe('AnthropicOauthService - security & edge cases', () => {
  let fetchMock: jest.Mock;
  let providerService: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;
  let pendingStore: ReturnType<typeof createPendingStore>;
  let svc: AnthropicOauthService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-01T12:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    providerService = createProviderService();
    discovery = createDiscovery();
    pendingStore = createPendingStore();
    svc = new AnthropicOauthService(providerService.svc, discovery.svc, pendingStore.svc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('exchangeCode tenant boundaries', () => {
    it('rejects exchange when state belongs to a different tenant', async () => {
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await expect(
        svc.exchangeCode(`code#${state}`, undefined, 'agent-1', 'tenant-2'),
      ).rejects.toThrow('Invalid or expired OAuth state');

      // Boundary check is enforced by the store, not the service.
      expect(pendingStore.svc.consume).toHaveBeenCalledWith(
        'anthropic',
        state,
        'agent-1',
        'tenant-2',
      );
      // Original owner's pending flow stays intact so user-1 can still finish.
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toEqual({ state });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('rejects exchange when state belongs to a different agent', async () => {
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await expect(
        svc.exchangeCode(`code#${state}`, undefined, 'agent-2', 'tenant-1'),
      ).rejects.toThrow('Invalid or expired OAuth state');

      expect(pendingStore.svc.consume).toHaveBeenCalledWith(
        'anthropic',
        state,
        'agent-2',
        'tenant-1',
      );
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toEqual({ state });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('rejects state reuse after first successful exchange', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      );
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await svc.exchangeCode(`first-code#${state}`, undefined, 'agent-1', 'tenant-1');
      expect(providerService.upsertProvider).toHaveBeenCalledTimes(1);
      await expect(svc.getPendingCount()).resolves.toBe(0);

      // Replaying the same state with a different code must fail — one-time token.
      await expect(
        svc.exchangeCode(`replayed-code#${state}`, undefined, 'agent-1', 'tenant-1'),
      ).rejects.toThrow('Invalid or expired OAuth state');
      expect(providerService.upsertProvider).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('token endpoint error handling', () => {
    it('throws when the token endpoint returns malformed JSON', async () => {
      const badResponse = {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
        text: async () => '<html>oops</html>',
      } as unknown as Response;
      fetchMock.mockResolvedValue(badResponse);
      const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
      (svc as unknown as { logger: typeof logger }).logger = logger;
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await expect(
        svc.exchangeCode(`c#${state}`, undefined, 'agent-1', 'tenant-1'),
      ).rejects.toBeInstanceOf(SyntaxError);

      // State is consumed before JSON parsing — no rollback path today.
      await expect(svc.getPendingCount()).resolves.toBe(0);
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('throws and logs when the token endpoint returns 503 Service Unavailable', async () => {
      fetchMock.mockResolvedValue(mockResponse(503, {}, 'Service Unavailable'));
      const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
      (svc as unknown as { logger: typeof logger }).logger = logger;
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      const err = await svc
        .exchangeCode(`bad#${state}`, undefined, 'agent-1', 'tenant-1')
        .catch((e: Error) => e);
      // Generic Token exchange failed — no internal status text leakage.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Token exchange failed');
      expect((err as Error).message).not.toContain('Service Unavailable');
      expect((err as Error).message).not.toContain('503');
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('propagates the network error when fetch() itself throws', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await expect(
        svc.exchangeCode(`c#${state}`, undefined, 'agent-1', 'tenant-1'),
      ).rejects.toThrow('Network error');
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });
  });

  describe('unwrapToken expiry boundaries', () => {
    it('returns the cached access token at exactly 61s before expiry', async () => {
      // 61_000 > 60_000 → Date.now() < blob.e - 60_000 holds → return blob.t.
      const blob = JSON.stringify({ t: 'cached', r: 'rf', e: Date.now() + 61_000 });
      expect(await svc.unwrapToken(blob, 'agent-1', 'tenant-1')).toBe('cached');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes at exactly 59s before expiry', async () => {
      // 59_000 < 60_000 → Date.now() < blob.e - 60_000 is FALSE → refresh path.
      const blob = JSON.stringify({ t: 'old', r: 'rf', e: Date.now() + 59_000 });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expires_in: 3600 }),
      );
      expect(await svc.unwrapToken(blob, 'agent-1', 'tenant-1')).toBe('new');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes when the token expires exactly now', async () => {
      const blob = JSON.stringify({ t: 'old', r: 'rf', e: Date.now() });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'refreshed', refresh_token: 'rf2', expires_in: 3600 }),
      );
      expect(await svc.unwrapToken(blob, 'agent-1', 'tenant-1')).toBe('refreshed');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // New expiry is computed from Date.now() at the time of the refresh
      // response, not carried from the stale blob.
      const stored = providerService.upsertProvider.mock.calls[0][3] as string;
      expect(JSON.parse(stored).e).toBe(Date.now() + 3600 * 1000);
    });

    it('refresh updates the expiry from Date.now() rather than carrying the old e', async () => {
      // Pin a stale expiry 100s in the past so the refresh path runs.
      const staleExpiry = Date.now() - 100_000;
      const blob = JSON.stringify({ t: 'old', r: 'rf', e: staleExpiry });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'fresh', refresh_token: 'rf2', expires_in: 1800 }),
      );
      await svc.unwrapToken(blob, 'agent-1', 'tenant-1');
      const stored = providerService.upsertProvider.mock.calls[0][3] as string;
      const parsed = JSON.parse(stored) as { t: string; r: string; e: number };
      expect(parsed.e).toBe(Date.now() + 1800 * 1000);
      expect(parsed.e).not.toBe(staleExpiry);
    });
  });

  describe('unwrapToken refresh-token fallbacks', () => {
    it('returns access_token when blob has empty refresh and is past the refresh threshold', async () => {
      // e = Date.now() + 30s puts us inside the 60s refresh window. With r='',
      // the service must short-circuit and return blob.t — no fetch attempt.
      const blob = JSON.stringify({ t: 'access', r: '', e: Date.now() + 30_000 });
      expect(await svc.unwrapToken(blob, 'agent-1', 'tenant-1')).toBe('access');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('rejects a JSON blob whose r field is null (type system enforces string)', async () => {
      // parseOAuthTokenBlob requires r: string, so r: null fails isOAuthTokenBlob
      // and the value is treated as a legacy paste token (returned as-is).
      const raw = JSON.stringify({ t: 'access', r: null, e: Date.now() + 30_000 });
      expect(await svc.unwrapToken(raw, 'agent-1', 'tenant-1')).toBe(raw);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a JSON blob whose r field is missing entirely', async () => {
      // Missing r → not an OAuth blob → legacy paste fallback.
      const raw = JSON.stringify({ t: 'access', e: Date.now() + 30_000 });
      expect(await svc.unwrapToken(raw, 'agent-1', 'tenant-1')).toBe(raw);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken expiry computation', () => {
    it('computes the new expiry from the refresh-response time, not the prior token', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 1800 }),
      );
      const before = Date.now();
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob.e).toBe(before + 1800 * 1000);
    });
  });
});
