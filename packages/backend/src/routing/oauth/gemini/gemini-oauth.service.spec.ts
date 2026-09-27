import { ConfigService } from '@nestjs/config';
import { GeminiOauthService } from './gemini-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { CodeAssistClientService } from './codeassist-client.service';

const originalFetch = global.fetch;

function mockResponse(status: number, body: unknown, text = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text || JSON.stringify(body),
  } as unknown as Response;
}

function createConfig(nodeEnv = 'production'): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'app.nodeEnv') return nodeEnv;
      if (key === 'GEMINI_OAUTH_CLIENT_ID') return undefined;
      if (key === 'GEMINI_OAUTH_CLIENT_SECRET') return undefined;
      return undefined;
    },
  } as unknown as ConfigService;
}

function createProviderService(): {
  svc: ProviderService;
  upsertProvider: jest.Mock;
  recalculateTiers: jest.Mock;
  nextOAuthLabel: jest.Mock;
  getFreshSubscriptionCredential: jest.Mock;
  withSubscriptionCredentialLock: jest.Mock;
} {
  const upsertProvider = jest.fn().mockResolvedValue({ provider: { id: 'p1' } });
  const recalculateTiers = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue(undefined);
  const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
  const withSubscriptionCredentialLock = mockSubscriptionCredentialLock({
    getFreshSubscriptionCredential,
    upsertProvider,
  });
  return {
    svc: {
      upsertProvider,
      recalculateTiers,
      nextOAuthLabel,
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock,
    } as unknown as ProviderService,
    upsertProvider,
    recalculateTiers,
    nextOAuthLabel,
    getFreshSubscriptionCredential,
    withSubscriptionCredentialLock,
  };
}

function createDiscovery(): { svc: ModelDiscoveryService; discoverModels: jest.Mock } {
  const discoverModels = jest.fn().mockResolvedValue(undefined);
  return { svc: { discoverModels } as unknown as ModelDiscoveryService, discoverModels };
}

function createCodeAssist(onboard?: jest.Mock): {
  svc: CodeAssistClientService;
  onboard: jest.Mock;
} {
  const onboardMock =
    onboard ?? jest.fn().mockResolvedValue({ projectId: 'proj-123', tierId: 'free-tier' });
  return {
    svc: { onboard: onboardMock } as unknown as CodeAssistClientService,
    onboard: onboardMock,
  };
}

describe('GeminiOauthService', () => {
  let fetchMock: jest.Mock;
  let providerService: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;
  let codeAssist: ReturnType<typeof createCodeAssist>;
  let svc: GeminiOauthService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    providerService = createProviderService();
    discovery = createDiscovery();
    codeAssist = createCodeAssist();
    svc = new GeminiOauthService(
      providerService.svc,
      createConfig('production'),
      discovery.svc,
      codeAssist.svc,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('generateAuthorizationUrl', () => {
    it('builds a Google OAuth URL with PKCE S256 challenge and tracks pending state', async () => {
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1', 'http://localhost:3001');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
      expect(parsed.searchParams.get('state')?.length).toBeGreaterThan(0);
      expect(svc.getPendingCount()).toBe(1);
    });

    it('includes access_type=offline and prompt=consent in the authorize URL', async () => {
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
    });

    it('includes the cloud-platform scope required for CodeAssist', async () => {
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const scope = new URL(url).searchParams.get('scope') ?? '';
      expect(scope).toContain('https://www.googleapis.com/auth/cloud-platform');
      expect(scope).toContain('https://www.googleapis.com/auth/userinfo.email');
      expect(scope).toContain('https://www.googleapis.com/auth/userinfo.profile');
    });

    it('uses port 1455 for the callback redirect URI', async () => {
      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1', 'http://localhost:3001');
      const redirectUri = new URL(url).searchParams.get('redirect_uri');
      expect(redirectUri).toBe('http://localhost:1455/auth/callback');
    });

    it('cleans up expired pending states on each call', async () => {
      await svc.generateAuthorizationUrl('a1', 'u1');
      expect(svc.getPendingCount()).toBe(1);
      jest.advanceTimersByTime(10 * 60 * 1000 + 1);
      await svc.generateAuthorizationUrl('a2', 'u2');
      expect(svc.getPendingCount()).toBe(1);
    });

    it('uses a custom client id from ConfigService when provided', async () => {
      const config = {
        get: (key: string) => {
          if (key === 'GEMINI_OAUTH_CLIENT_ID') return 'custom-gemini-client';
          return 'production';
        },
      } as unknown as ConfigService;
      const customSvc = new GeminiOauthService(
        providerService.svc,
        config,
        discovery.svc,
        codeAssist.svc,
      );
      const url = await customSvc.generateAuthorizationUrl('a', 'u');
      expect(new URL(url).searchParams.get('client_id')).toBe('custom-gemini-client');
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

    it('calls enrichBlob (onboard) after token exchange and stores the project id in blob.u', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
        }),
      );
      codeAssist.onboard.mockResolvedValue({ projectId: 'proj-456', tierId: 'free-tier' });

      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;
      await svc.exchangeCode(state, 'auth-code');

      expect(codeAssist.onboard).toHaveBeenCalledWith('access-1');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'user-1',
        'gemini',
        expect.stringContaining('"u":"proj-456"'),
        'subscription',
        undefined,
        undefined,
        null,
      );
      expect(providerService.nextOAuthLabel).toHaveBeenCalledWith('user-1', 'gemini');
    });

    it('stores providerId as gemini and authType as subscription', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
        }),
      );

      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;
      await svc.exchangeCode(state, 'auth-code');

      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'user-1',
        'gemini',
        expect.any(String),
        'subscription',
        undefined,
        undefined,
        null,
      );
    });

    it('aborts exchange when onboard throws, without calling upsertProvider', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
        }),
      );
      codeAssist.onboard.mockRejectedValue(new Error('CodeAssist returned no allowed tiers'));

      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;
      await expect(svc.exchangeCode(state, 'auth-code')).rejects.toThrow();
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });

    it('triggers model discovery after successful exchange', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      );

      const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;
      await svc.exchangeCode(state, 'auth-code');

      expect(discovery.discoverModels).toHaveBeenCalled();
      expect(providerService.recalculateTiers).not.toHaveBeenCalled();
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

    it('throws when the token endpoint returns an error', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_grant'));
      const url = await svc.generateAuthorizationUrl('a', 'u');
      const state = new URL(url).searchParams.get('state')!;
      await expect(svc.exchangeCode(state, 'bad')).rejects.toThrow('Token exchange failed');
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

    it('preserves the resourceField as blob.u when supplied', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a3', refresh_token: 'r3', expires_in: 3600 }),
      );
      const blob = await svc.refreshAccessToken('old-refresh', 'proj-999');
      expect(blob.u).toBe('proj-999');
    });

    it('does not set blob.u when resourceField is undefined', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a3', refresh_token: 'r3', expires_in: 3600 }),
      );
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob.u).toBeUndefined();
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

    it('passes blob.u to refreshAccessToken when refreshing so the project id is preserved', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 30_000, u: 'proj-abc' };
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expires_in: 3600 }),
      );
      const token = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1');
      expect(token).toBe('new');
      // The upserted blob must carry the project id so it survives the refresh.
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        null,
        'user-1',
        'gemini',
        expect.stringContaining('"u":"proj-abc"'),
        'subscription',
        undefined,
        undefined,
      );
    });

    it('refreshes and persists a fresh blob when the token is near expiry', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 30_000 };
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expires_in: 3600 }),
      );
      const token = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1', 'Work');
      expect(token).toBe('new');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        null,
        'user-1',
        'gemini',
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
  });

  describe('revokeToken', () => {
    it('POSTs the token to the Google revoke endpoint', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, {}));
      await svc.revokeToken('tok');
      const [revokeUrl, init] = fetchMock.mock.calls[0];
      expect(revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
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
