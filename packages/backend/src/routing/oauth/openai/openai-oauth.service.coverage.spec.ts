import { ConfigService } from '@nestjs/config';
import { OpenaiOauthService } from './openai-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';

const originalFetch = global.fetch;

function mockResponse(status: number, body: unknown, text = ''): Response {
  const jsonBody = body;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => text || JSON.stringify(jsonBody),
  } as unknown as Response;
}

function createConfig(nodeEnv = 'production'): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'OPENAI_OAUTH_CLIENT_ID') return undefined;
      return undefined;
    },
  } as unknown as ConfigService;
}

function createProviderService() {
  const upsertProvider = jest.fn().mockResolvedValue({ provider: { id: 'p1' } });
  const recalculateTiers = jest.fn().mockResolvedValue(undefined);
  const recalculateTiersForUser = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue(undefined);
  const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
  return {
    svc: {
      upsertProvider,
      recalculateTiers,
      recalculateTiersForUser,
      nextOAuthLabel,
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock: mockSubscriptionCredentialLock({
        getFreshSubscriptionCredential,
        upsertProvider,
      }),
    } as unknown as ProviderService,
    upsertProvider,
    recalculateTiers,
    recalculateTiersForUser,
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

describe('OpenaiOauthService', () => {
  let fetchMock: jest.Mock;
  let providerService: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;
  let svc: OpenaiOauthService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    providerService = createProviderService();
    discovery = createDiscovery();
    svc = new OpenaiOauthService(providerService.svc, createConfig('production'), discovery.svc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('generateAuthorizationUrl', () => {
    it('builds an OAuth URL with PKCE S256 challenge and tracks pending state', async () => {
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1', 'http://localhost:3001');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://auth.openai.com/oauth/authorize');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
      expect(parsed.searchParams.get('scope')).toBe('openid profile email offline_access');
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(parsed.searchParams.get('state')?.length).toBeGreaterThan(0);
      expect(svc.getPendingCount()).toBe(1);
    });

    it('cleans up expired pending states on each call', async () => {
      await svc.generateAuthorizationUrl('a1', 'u1');
      expect(svc.getPendingCount()).toBe(1);
      // Advance past the 10-minute TTL.
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      await svc.generateAuthorizationUrl('a2', 'u2');
      // The old entry should have been cleaned up; only the new one remains.
      expect(svc.getPendingCount()).toBe(1);
    });

    it('uses a custom client id from ConfigService when provided', async () => {
      const config = {
        get: (key: string) => (key === 'OPENAI_OAUTH_CLIENT_ID' ? 'custom-client' : 'production'),
      } as unknown as ConfigService;
      const customSvc = new OpenaiOauthService(providerService.svc, config, discovery.svc);
      const url = await customSvc.generateAuthorizationUrl('a', 'u');
      expect(new URL(url).searchParams.get('client_id')).toBe('custom-client');
    });
  });

  describe('exchangeCode', () => {
    it('rejects unknown states', async () => {
      await expect(svc.exchangeCode('bogus-state', 'code')).rejects.toThrow(
        'Invalid or expired OAuth state',
      );
    });

    it('rejects (and purges) expired states', async () => {
      const url = await svc.generateAuthorizationUrl('a', 'u');
      const state = new URL(url).searchParams.get('state')!;
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      await expect(svc.exchangeCode(state, 'code')).rejects.toThrow('OAuth state expired');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('exchanges a valid code, stores the blob, and triggers model discovery', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
        }),
      );
      const url = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');
      const state = new URL(url).searchParams.get('state')!;

      await svc.exchangeCode(state, 'auth-code');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [tokenUrl, init] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('https://auth.openai.com/oauth/token');
      const body = new URLSearchParams(init.body.toString());
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('code_verifier')?.length).toBeGreaterThan(0);

      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'tenant-1',
        'openai',
        expect.stringContaining('"t":"access-1"'),
        'subscription',
        undefined,
        undefined,
        null,
      );
      expect(discovery.discoverModels).toHaveBeenCalled();
      expect(providerService.recalculateTiers).not.toHaveBeenCalled();
      expect(providerService.recalculateTiersForUser).not.toHaveBeenCalled();
      // State is one-time-use.
      expect(svc.getPendingCount()).toBe(0);
    });

    it('does not route agents after discovery when the provider row is new', async () => {
      providerService.upsertProvider.mockResolvedValueOnce({ provider: { id: 'p1' }, isNew: true });
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      );
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      await svc.exchangeCode(state, 'auth-code');

      expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
      expect(providerService.recalculateTiersForUser).not.toHaveBeenCalled();
      expect(providerService.recalculateTiers).not.toHaveBeenCalled();
    });

    it('throws when the token endpoint returns an error', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_grant'));
      const url = await svc.generateAuthorizationUrl('a', 'u');
      const state = new URL(url).searchParams.get('state')!;
      await expect(svc.exchangeCode(state, 'bad')).rejects.toThrow('Token exchange failed');
    });

    it('swallows discovery errors (OAuth success is not rolled back)', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
      );
      discovery.discoverModels.mockRejectedValue(new Error('boom'));
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;
      await expect(svc.exchangeCode(state, 'c')).resolves.toBeUndefined();
      expect(providerService.upsertProvider).toHaveBeenCalled();
    });
  });

  describe('callback handler', () => {
    it('shuts down the callback server after a callback exchange failure', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_grant'));
      const url = await svc.generateAuthorizationUrl('a', 'u', 'http://localhost:3001');
      const state = new URL(url).searchParams.get('state')!;
      const close = jest.fn();
      const serviceInternals = svc as unknown as {
        callbackServer: { close: () => void } | null;
        serverReady: Promise<void> | null;
      };
      serviceInternals.callbackServer = { close };
      serviceInternals.serverReady = Promise.resolve();
      const req = { url: `/auth/callback?state=${state}&code=bad` };
      let resolveResponse!: () => void;
      const responseDone = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const res = { writeHead: jest.fn(), end: jest.fn(resolveResponse) };

      (
        svc as unknown as {
          handleCallbackRequest: (request: typeof req, response: typeof res) => void;
        }
      ).handleCallbackRequest(req, res);
      await responseDone;

      expect(close).toHaveBeenCalled();
      expect(serviceInternals.callbackServer).toBeNull();
      expect(serviceInternals.serverReady).toBeNull();
      expect(svc.getPendingCount()).toBe(0);
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    it('returns a fresh blob with a new expiry', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'a2',
          refresh_token: 'r2',
          expires_in: 1800,
        }),
      );
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob.t).toBe('a2');
      expect(blob.r).toBe('r2');
      expect(blob.e).toBe(Date.now() + 1800 * 1000);
    });

    it('retains the old refresh token when the server omits a new one', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { access_token: 'a2', expires_in: 60 }));
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob.r).toBe('old-refresh');
    });

    it('throws when the refresh endpoint returns a non-2xx status', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}));
      await expect(svc.refreshAccessToken('r')).rejects.toThrow('Token refresh failed');
    });
  });

  describe('unwrapToken', () => {
    it('returns null for malformed blobs', async () => {
      expect(await svc.unwrapToken('not-json', 'a', 'u')).toBeNull();
      expect(await svc.unwrapToken(JSON.stringify({}), 'a', 'u')).toBeNull();
    });

    it('returns the cached access token when it is still valid', async () => {
      const blob = { t: 'access', r: 'refresh', e: Date.now() + 10 * 60 * 1000 };
      expect(await svc.unwrapToken(JSON.stringify(blob), 'a', 'u')).toBe('access');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes and persists a fresh blob when the token is near expiry', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 30_000 }; // within the 60s skew window
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expires_in: 3600 }),
      );
      const token = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1', 'Work');
      expect(token).toBe('new');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        null,
        'user-1',
        'openai',
        expect.stringContaining('"t":"new"'),
        'subscription',
        undefined,
        'Work',
      );
    });

    it('returns null when the refresh call fails', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 1000 };
      fetchMock.mockRejectedValue(new Error('network'));
      expect(await svc.unwrapToken(JSON.stringify(blob), 'a', 'u')).toBeNull();
    });

    // Regression: a still-valid access token must be returned even when the
    // OAuth response omitted a refresh token. The earlier check
    // `!blob.t || !blob.r || !blob.e` short-circuited usable tokens to null.
    it('returns the access token for a valid blob with no refresh token', async () => {
      const blob = { t: 'still-good', r: '', e: Date.now() + 10 * 60 * 1000 };
      expect(await svc.unwrapToken(JSON.stringify(blob), 'a', 'u')).toBe('still-good');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null for an expired blob with no refresh token (cannot refresh)', async () => {
      const blob = { t: 'old', r: '', e: Date.now() + 1000 };
      expect(await svc.unwrapToken(JSON.stringify(blob), 'a', 'u')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('revokeToken', () => {
    it('POSTs the token to the revoke endpoint', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, {}));
      await svc.revokeToken('tok');
      const [revokeUrl, init] = fetchMock.mock.calls[0];
      expect(revokeUrl).toBe('https://auth.openai.com/oauth/revoke');
      const body = new URLSearchParams(init.body.toString());
      expect(body.get('token')).toBe('tok');
    });

    it('silently logs when the revoke endpoint returns an error', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'bad_token'));
      await expect(svc.revokeToken('x')).resolves.toBeUndefined();
    });

    it('silently logs on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('network'));
      await expect(svc.revokeToken('x')).resolves.toBeUndefined();
    });
  });

  describe('clearPendingState', () => {
    it('removes a known pending state', async () => {
      const url = await svc.generateAuthorizationUrl('a', 'u');
      const state = new URL(url).searchParams.get('state')!;
      expect(svc.getPendingCount()).toBe(1);
      svc.clearPendingState(state);
      expect(svc.getPendingCount()).toBe(0);
    });
  });
});
