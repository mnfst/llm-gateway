import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import {
  AnthropicOauthExchangeError,
  AnthropicOauthService,
  splitAnthropicAuthPayload,
} from './anthropic-oauth.service';
import { ANTHROPIC_OAUTH } from './anthropic-oauth.config';
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
  const recalculateTiersForTenant = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue(undefined);
  const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
  return {
    svc: {
      upsertProvider,
      recalculateTiers,
      recalculateTiersForTenant,
      nextOAuthLabel,
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock: mockSubscriptionCredentialLock({
        getFreshSubscriptionCredential,
        upsertProvider,
      }),
    } as unknown as ProviderService,
    upsertProvider,
    recalculateTiers,
    recalculateTiersForTenant,
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
  const key = (provider: string, state: string) => `${provider}:${state}`;
  const cleanup = () => {
    for (const [flowKey, flow] of flows) {
      if (flow.expiresAt < Date.now()) flows.delete(flowKey);
    }
  };
  const svc = {
    create: jest.fn(async (provider: string, input: OAuthPendingFlowInput, ttlMs: number) => {
      cleanup();
      for (const [flowKey, flow] of flows) {
        if (
          flow.provider === provider &&
          flow.agentId === input.agentId &&
          flow.tenantId === input.tenantId
        ) {
          flows.delete(flowKey);
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
      for (const flow of flows.values()) {
        if (flow.provider === provider && flow.agentId === agentId && flow.tenantId === tenantId) {
          return flow;
        }
      }
      return null;
    }),
    clear: jest.fn(async (provider: string, state: string) => {
      flows.delete(key(provider, state));
    }),
    count: jest.fn(async (provider: string) => {
      cleanup();
      let total = 0;
      for (const flow of flows.values()) {
        if (flow.provider === provider) total += 1;
      }
      return total;
    }),
  } as unknown as OAuthPendingFlowStore;
  return { svc, flows };
}

describe('splitAnthropicAuthPayload', () => {
  it('returns the bare code when no state suffix is present', () => {
    expect(splitAnthropicAuthPayload('abc123')).toEqual({ code: 'abc123' });
  });

  it('splits `<code>#<state>` into separate parts', () => {
    expect(splitAnthropicAuthPayload('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('treats a trailing # as no state', () => {
    expect(splitAnthropicAuthPayload('abc#')).toEqual({ code: 'abc', state: undefined });
  });

  it('trims surrounding whitespace from pasted input', () => {
    expect(splitAnthropicAuthPayload('  abc#xyz  ')).toEqual({ code: 'abc', state: 'xyz' });
  });
});

describe('AnthropicOauthService', () => {
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

  describe('generateAuthorizationUrl', () => {
    it('builds a Claude.ai authorize URL with PKCE S256 challenge and tracks pending state', async () => {
      const { url, state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(ANTHROPIC_OAUTH.AUTHORIZE_URL);
      expect(parsed.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH.CLIENT_ID);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('redirect_uri')).toBe(ANTHROPIC_OAUTH.REDIRECT_URI);
      expect(parsed.searchParams.get('scope')).toBe(ANTHROPIC_OAUTH.SCOPE);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(pendingStore.svc.create).toHaveBeenCalledWith(
        'anthropic',
        expect.objectContaining({ state, verifier: state }),
        ANTHROPIC_OAUTH.STATE_TTL_MS,
      );
      await expect(svc.getPendingCount()).resolves.toBe(1);
    });
  });

  describe('exchangeCode', () => {
    it('rejects when no code is supplied', async () => {
      await expect(svc.exchangeCode('', 'state', 'agent-1', 'tenant-1')).rejects.toThrow(
        'Missing authorization code',
      );
    });

    it('rejects when no state is supplied', async () => {
      await expect(svc.exchangeCode('code', undefined, 'agent-1', 'tenant-1')).rejects.toThrow(
        'Missing OAuth state',
      );
    });

    it('rejects unknown states', async () => {
      await expect(
        svc.exchangeCode('code#bogus', undefined, 'agent-1', 'tenant-1'),
      ).rejects.toThrow('Invalid or expired OAuth state');
    });

    it('rejects (and purges) expired states', async () => {
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      jest.advanceTimersByTime(ANTHROPIC_OAUTH.STATE_TTL_MS + 1);
      await expect(svc.exchangeCode(`code#${state}`, undefined, 'a', 't')).rejects.toThrow(
        'OAuth state expired',
      );
      await expect(svc.getPendingCount()).resolves.toBe(0);
    });

    it('exchanges a valid code, stores the blob, and triggers model discovery', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
        }),
      );
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await svc.exchangeCode(`auth-code#${state}`, undefined, 'agent-1', 'tenant-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [tokenUrl, init] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(ANTHROPIC_OAUTH.TOKEN_URL);
      expect(new URL(tokenUrl).origin).toBe('https://api.anthropic.com');
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'anthropic',
      });
      const body = JSON.parse(init.body);
      expect(body.grant_type).toBe('authorization_code');
      expect(body.code).toBe('auth-code');
      expect(body.state).toBe(state);
      expect(body.code_verifier).toBe(state);

      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'tenant-1',
        'anthropic',
        expect.stringContaining('"t":"access-1"'),
        'subscription',
        undefined,
        undefined,
        undefined,
      );
      expect(discovery.discoverModels).toHaveBeenCalled();
      expect(providerService.recalculateTiers).not.toHaveBeenCalled();
      expect(providerService.recalculateTiersForTenant).not.toHaveBeenCalled();
      await expect(svc.getPendingCount()).resolves.toBe(0);
    });

    it('does not route agents after discovery when the provider row is new', async () => {
      providerService.upsertProvider.mockResolvedValueOnce({ provider: { id: 'p1' }, isNew: true });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      );
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await svc.exchangeCode(`auth-code#${state}`, undefined, 'agent-1', 'tenant-1');

      expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
      expect(providerService.recalculateTiersForTenant).not.toHaveBeenCalled();
      expect(providerService.recalculateTiers).not.toHaveBeenCalled();
    });

    it('accepts the code and state passed separately', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
      );
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      await svc.exchangeCode('plain-code', state, 'a', 't');
      expect(providerService.upsertProvider).toHaveBeenCalled();
    });

    it('uses the next OAuth label when adding another Anthropic account', async () => {
      providerService.nextOAuthLabel.mockResolvedValue('Key 2');
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 }),
      );
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');

      await svc.exchangeCode(`second-code#${state}`, undefined, 'agent-1', 'tenant-1');

      expect(providerService.nextOAuthLabel).toHaveBeenCalledWith('tenant-1', 'anthropic');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'tenant-1',
        'anthropic',
        expect.stringContaining('"t":"a2"'),
        'subscription',
        undefined,
        'Key 2',
        undefined,
      );
    });

    it('falls back to the latest pending state when the client posts a bare code', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
      );
      const { state } = await svc.generateAuthorizationUrl('a', 't');

      await svc.exchangeCode('plain-code', undefined, 'a', 't');

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).state).toBe(state);
      expect(providerService.upsertProvider).toHaveBeenCalled();
    });

    it('throws when the token endpoint returns an error', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_grant'));
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
      (svc as unknown as { logger: typeof logger }).logger = logger;

      await expect(svc.exchangeCode(`bad#${state}`, undefined, 'a', 't')).rejects.toThrow(
        'Token exchange failed',
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('"stateMatchesCodeVerifier":true'),
      );
    });

    it('preserves Anthropic token endpoint rate limits as rate-limit errors', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(400, {
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.',
          },
        }),
      );
      const { state } = await svc.generateAuthorizationUrl('a', 't');

      await expect(svc.exchangeCode(`bad#${state}`, undefined, 'a', 't')).rejects.toMatchObject({
        message:
          'Anthropic rate-limited the OAuth token exchange. Please wait a minute, then sign in again.',
        status: 429,
      } satisfies Partial<AnthropicOauthExchangeError>);
    });

    it('falls back to state when the pending verifier is missing', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_request'));
      const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
      (svc as unknown as { logger: typeof logger }).logger = logger;
      jest.spyOn(pendingStore.svc, 'consume').mockResolvedValue({
        provider: 'anthropic',
        state: 'state-1',
        verifier: undefined as unknown as string,
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        expiresAt: Date.now() + 60_000,
      });

      await expect(
        svc.exchangeCode('bad#state-1', undefined, 'agent-1', 'tenant-1'),
      ).rejects.toThrow('Token exchange failed');

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body).code_verifier).toBe('state-1');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('"stateMatchesCodeVerifier":true'),
      );
    });

    it('stores an empty refresh token when Anthropic omits one in the response', async () => {
      // No refresh_token field — defensive fallback exercises the `?? ''`.
      fetchMock.mockResolvedValue(mockResponse(200, { access_token: 'a', expires_in: 60 }));
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      await svc.exchangeCode(`c#${state}`, undefined, 'a', 't');
      const stored = providerService.upsertProvider.mock.calls[0][3] as string;
      expect(JSON.parse(stored).r).toBe('');
    });

    it('swallows discovery errors so the OAuth save is not rolled back', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
      );
      discovery.discoverModels.mockRejectedValue(new Error('boom'));
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      await expect(svc.exchangeCode(`c#${state}`, undefined, 'a', 't')).resolves.toBeUndefined();
      expect(providerService.upsertProvider).toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    it('returns a fresh blob with a new expiry', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 1800 }),
      );
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob).toEqual({ t: 'a2', r: 'r2', e: Date.now() + 1800 * 1000 });
      expect(fetchMock.mock.calls[0][1].headers).toEqual({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'anthropic',
      });
    });

    it('retains the old refresh token when the server omits a new one', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { access_token: 'a2', expires_in: 60 }));
      const blob = await svc.refreshAccessToken('old');
      expect(blob.r).toBe('old');
    });

    it('throws when the refresh endpoint returns a non-2xx status', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}));
      await expect(svc.refreshAccessToken('r')).rejects.toThrow('Token refresh failed');
    });
  });

  describe('unwrapToken', () => {
    it('returns the raw value when it is not an OAuth blob (legacy setup-token)', async () => {
      expect(await svc.unwrapToken('sk-ant-oat01-legacy', 'a', 't')).toBe('sk-ant-oat01-legacy');
    });

    it('returns null when given an empty string', async () => {
      expect(await svc.unwrapToken('', 'a', 't')).toBeNull();
    });

    it('returns the cached access token when it is still valid', async () => {
      const blob = JSON.stringify({ t: 'access', r: 'refresh', e: Date.now() + 10 * 60_000 });
      expect(await svc.unwrapToken(blob, 'a', 't')).toBe('access');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes and persists a fresh blob when the token is near expiry', async () => {
      const blob = JSON.stringify({ t: 'old', r: 'rf', e: Date.now() + 30_000 });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expires_in: 3600 }),
      );
      const token = await svc.unwrapToken(blob, 'agent-1', 'tenant-1', 'Work');
      expect(token).toBe('new');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        'anthropic',
        expect.stringContaining('"t":"new"'),
        'subscription',
        undefined,
        'Work',
      );
    });

    it('returns the access token unchanged when the blob has no refresh token', async () => {
      const blob = JSON.stringify({ t: 'access', r: '', e: Date.now() + 30_000 });
      expect(await svc.unwrapToken(blob, 'a', 't')).toBe('access');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when the refresh call fails', async () => {
      const blob = JSON.stringify({ t: 'old', r: 'rf', e: Date.now() + 1_000 });
      fetchMock.mockRejectedValue(new Error('network'));
      expect(await svc.unwrapToken(blob, 'a', 't')).toBeNull();
    });
  });

  describe('clearPendingState', () => {
    it('removes a known pending state', async () => {
      const { state } = await svc.generateAuthorizationUrl('a', 't');
      await expect(svc.getPendingCount()).resolves.toBe(1);
      await svc.clearPendingState(state);
      await expect(svc.getPendingCount()).resolves.toBe(0);
    });
  });

  describe('findPendingForAgent', () => {
    it('returns the active state when one exists for the agent and user', async () => {
      const { state } = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toEqual({ state });
    });

    it('returns null when no flow is pending for the agent', async () => {
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toBeNull();
    });

    it('skips entries belonging to other agents', async () => {
      await svc.generateAuthorizationUrl('other-agent', 'tenant-1');
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toBeNull();
    });

    it('skips entries belonging to other users', async () => {
      await svc.generateAuthorizationUrl('agent-1', 'other-tenant');
      await expect(svc.findPendingForAgent('agent-1', 'tenant-1')).resolves.toBeNull();
    });
  });
});
