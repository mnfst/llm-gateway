import { ConfigService } from '@nestjs/config';
import type { ServerResponse } from 'http';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { XaiOauthService } from './xai-oauth.service';

const mockHttpControl: {
  reqHandler?: (req: unknown, res: unknown) => void;
  errorHandler?: (err: NodeJS.ErrnoException) => void;
  listenCb?: () => void;
  server?: { on: jest.Mock; listen: jest.Mock; close: jest.Mock; unref: jest.Mock };
} = {};

jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: jest.fn((reqHandler: (req: unknown, res: unknown) => void) => {
      mockHttpControl.reqHandler = reqHandler;
      const server: { on: jest.Mock; listen: jest.Mock; close: jest.Mock; unref: jest.Mock } = {
        on: jest.fn((event: string, cb: (err: NodeJS.ErrnoException) => void) => {
          if (event === 'error') mockHttpControl.errorHandler = cb;
          return server;
        }),
        listen: jest.fn((_port: number, _host: string, cb: () => void) => {
          mockHttpControl.listenCb = cb;
          return server;
        }),
        close: jest.fn(),
        unref: jest.fn(),
      };
      mockHttpControl.server = server;
      return server;
    }),
  };
});

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
      if (key === 'XAI_OAUTH_CLIENT_ID') return undefined;
      return undefined;
    },
  } as unknown as ConfigService;
}

function createProviderService() {
  const upsertProvider = jest.fn().mockResolvedValue({ provider: { id: 'p1' } });
  const recalculateTiers = jest.fn().mockResolvedValue(undefined);
  const recalculateTiersForUser = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue('X Account');
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

describe('XaiOauthService', () => {
  let fetchMock: jest.Mock;
  let providerService: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;
  let svc: XaiOauthService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    providerService = createProviderService();
    discovery = createDiscovery();
    svc = new XaiOauthService(providerService.svc, createConfig('production'), discovery.svc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('builds an xAI OAuth URL with PKCE and the subscription scopes', async () => {
    const url = await svc.generateAuthorizationUrl('agent-1', 'user-1', 'http://localhost:3001');
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe('https://auth.x.ai/oauth2/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')?.length).toBeGreaterThan(0);
    expect(parsed.searchParams.get('scope')).toContain('grok-cli:access');
    expect(parsed.searchParams.get('scope')).toContain('api:access');
    expect(parsed.searchParams.has('plan')).toBe(false);
    expect(parsed.searchParams.has('referrer')).toBe(false);
    expect(parsed.searchParams.get('state')?.length).toBeGreaterThan(0);
    expect(svc.getPendingCount()).toBe(1);
  });

  it('uses a custom xAI client id from ConfigService when provided', async () => {
    const config = {
      get: (key: string) =>
        key === 'XAI_OAUTH_CLIENT_ID'
          ? 'custom-xai-client'
          : key === 'app.nodeEnv'
            ? 'production'
            : undefined,
    } as unknown as ConfigService;
    const customSvc = new XaiOauthService(providerService.svc, config, discovery.svc);
    const url = await customSvc.generateAuthorizationUrl('a', 'u');
    expect(new URL(url).searchParams.get('client_id')).toBe('custom-xai-client');
  });

  it('exchanges a valid code, stores the OAuth blob, and triggers model discovery', async () => {
    fetchMock.mockResolvedValue(
      mockResponse(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
    );
    const url = await svc.generateAuthorizationUrl('agent-1', 'tenant-1', undefined, 'user-1');
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state')!;

    await svc.exchangeCode(state, 'auth-code');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://auth.x.ai/oauth2/token');
    const body = new URLSearchParams(init.body.toString());
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback');
    expect(body.get('code_verifier')?.length).toBeGreaterThan(0);
    expect(body.has('code_challenge')).toBe(false);
    expect(body.has('code_challenge_method')).toBe(false);

    expect(providerService.nextOAuthLabel).toHaveBeenCalledWith('tenant-1', 'xai');
    expect(providerService.upsertProvider).toHaveBeenCalledWith(
      'agent-1',
      'tenant-1',
      'xai',
      expect.stringContaining('"t":"access-1"'),
      'subscription',
      undefined,
      'X Account',
      'user-1',
    );
    expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
    expect(providerService.recalculateTiers).not.toHaveBeenCalled();
    expect(providerService.recalculateTiersForUser).not.toHaveBeenCalled();
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

  it('rejects unknown and expired states', async () => {
    await expect(svc.exchangeCode('bogus-state', 'code')).rejects.toThrow(
      'Invalid or expired OAuth state',
    );

    const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
    const state = new URL(url).searchParams.get('state')!;
    jest.advanceTimersByTime(10 * 60 * 1000 + 1);

    await expect(svc.exchangeCode(state, 'code')).rejects.toThrow('OAuth state expired');
    expect(svc.getPendingCount()).toBe(0);
  });

  it('throws when the token endpoint returns an error', async () => {
    fetchMock.mockResolvedValue(mockResponse(400, {}, 'invalid_grant'));
    const url = await svc.generateAuthorizationUrl('agent-1', 'user-1');
    const state = new URL(url).searchParams.get('state')!;

    await expect(svc.exchangeCode(state, 'bad-code')).rejects.toThrow('Token exchange failed');
  });

  it('refreshes and persists a fresh access token when the stored token is near expiry', async () => {
    const blob = { t: 'old', r: 'refresh-old', e: Date.now() + 30_000 };
    fetchMock.mockResolvedValue(
      mockResponse(200, {
        access_token: 'new-access',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      }),
    );

    const token = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1', 'Work');

    expect(token).toBe('new-access');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.x.ai/oauth2/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(providerService.upsertProvider).toHaveBeenCalledWith(
      null,
      'user-1',
      'xai',
      expect.stringContaining('"t":"new-access"'),
      'subscription',
      undefined,
      'Work',
    );
  });

  it('returns cached token while still valid and null for malformed blobs', async () => {
    const blob = { t: 'access', r: 'refresh', e: Date.now() + 10 * 60 * 1000 };
    expect(await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1')).toBe('access');
    expect(await svc.unwrapToken('not-json', 'agent-1', 'user-1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs tokens to the xAI revoke endpoint', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, {}));

    await svc.revokeToken('tok');

    const [revokeUrl, init] = fetchMock.mock.calls[0];
    expect(revokeUrl).toBe('https://auth.x.ai/oauth2/revoke');
    const body = new URLSearchParams(init.body.toString());
    expect(body.get('token')).toBe('tok');
  });

  it('swallows model-discovery failures after a successful exchange', async () => {
    fetchMock.mockResolvedValue(
      mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    );
    discovery.discoverModels.mockRejectedValueOnce(new Error('discovery boom'));
    const url = await svc.generateAuthorizationUrl('agent-1', 'tenant-1');
    const state = new URL(url).searchParams.get('state')!;

    await expect(svc.exchangeCode(state, 'code')).resolves.toBeUndefined();
    expect(providerService.upsertProvider).toHaveBeenCalled();
    expect(svc.getPendingCount()).toBe(0);
  });

  it('throws when the refresh endpoint returns an error', async () => {
    fetchMock.mockResolvedValue(mockResponse(400, {}, 'bad_refresh'));
    await expect(svc.refreshAccessToken('refresh-x')).rejects.toThrow('Token refresh failed');
  });

  it('keeps the existing refresh token when the response omits a new one', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { access_token: 'na', expires_in: 3600 }));
    const blob = await svc.refreshAccessToken('keep-me');
    expect(blob.t).toBe('na');
    expect(blob.r).toBe('keep-me');
  });

  it('returns null and logs when a refresh during unwrap fails', async () => {
    const blob = { t: 'old', r: 'refresh-old', e: Date.now() + 30_000 };
    fetchMock.mockRejectedValue(new Error('network down'));
    const token = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'tenant-1', 'Work');
    expect(token).toBeNull();
  });

  it('logs a warning when revocation returns an error status', async () => {
    fetchMock.mockResolvedValue(mockResponse(400, {}, 'revoke_failed'));
    await expect(svc.revokeToken('tok')).resolves.toBeUndefined();
  });

  it('swallows revocation network errors', async () => {
    fetchMock.mockRejectedValue(new Error('revoke network'));
    await expect(svc.revokeToken('tok')).resolves.toBeUndefined();
  });

  it('ignores a malformed backend redirect URL', async () => {
    const url = await svc.generateAuthorizationUrl('a', 't', 'not a url');
    expect(new URL(url).searchParams.get('state')).toBeTruthy();
  });

  it('ignores a non-loopback backend redirect URL', async () => {
    const url = await svc.generateAuthorizationUrl('a', 't', 'http://evil.example.com');
    expect(new URL(url).searchParams.get('state')).toBeTruthy();
  });

  describe('dev-mode callback server', () => {
    let devSvc: XaiOauthService;
    const flush = () => new Promise((r) => setImmediate(r));
    const mockRes = () => ({ writeHead: jest.fn(), end: jest.fn() }) as unknown as ServerResponse;

    beforeEach(() => {
      jest.useRealTimers();
      mockHttpControl.reqHandler = undefined;
      mockHttpControl.errorHandler = undefined;
      mockHttpControl.listenCb = undefined;
      (jest.requireMock('http').createServer as jest.Mock).mockClear();
      devSvc = new XaiOauthService(providerService.svc, createConfig('development'), discovery.svc);
    });

    it('starts the callback server and resolves once it is listening', async () => {
      const p = devSvc.generateAuthorizationUrl('agent-1', 'tenant-1', 'http://localhost:3001');
      expect(mockHttpControl.listenCb).toBeDefined();
      mockHttpControl.listenCb!();
      const url = await p;
      expect(new URL(url).searchParams.get('state')).toBeTruthy();
      expect(mockHttpControl.server!.unref).toHaveBeenCalled();
    });

    it('reuses an in-flight server-ready promise across concurrent flows', async () => {
      const p1 = devSvc.generateAuthorizationUrl('a', 't');
      const p2 = devSvc.generateAuthorizationUrl('b', 't');
      mockHttpControl.listenCb!();
      await Promise.all([p1, p2]);
      expect(jest.requireMock('http').createServer).toHaveBeenCalledTimes(1);
    });

    it('reuses the running callback server on later flows', async () => {
      const p1 = devSvc.generateAuthorizationUrl('a', 't');
      mockHttpControl.listenCb!();
      await p1;
      await devSvc.generateAuthorizationUrl('b', 't');
      expect(jest.requireMock('http').createServer).toHaveBeenCalledTimes(1);
    });

    it('rejects when the callback port is already in use', async () => {
      const p = devSvc.generateAuthorizationUrl('a', 't');
      mockHttpControl.errorHandler!({ code: 'EADDRINUSE' } as NodeJS.ErrnoException);
      await expect(p).rejects.toThrow(/already in use/);
    });

    it('rejects on a generic callback server error', async () => {
      const p = devSvc.generateAuthorizationUrl('a', 't');
      mockHttpControl.errorHandler!({ message: 'boom' } as NodeJS.ErrnoException);
      await expect(p).rejects.toThrow('Callback server failed: boom');
    });

    it('returns 404 for non-callback request paths', async () => {
      const p = devSvc.generateAuthorizationUrl('a', 't');
      mockHttpControl.listenCb!();
      await p;
      const res = mockRes();
      mockHttpControl.reqHandler!({ url: '/nope' }, res);
      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('redirects to the app with ok=0 when the provider returns an error', async () => {
      const p = devSvc.generateAuthorizationUrl('a', 't', 'http://localhost:3001');
      mockHttpControl.listenCb!();
      const url = await p;
      const state = new URL(url).searchParams.get('state')!;
      const res = mockRes();
      mockHttpControl.reqHandler!(
        { url: `/callback?error=access_denied&error_description=nope&state=${state}` },
        res,
      );
      expect(res.writeHead).toHaveBeenCalledWith(
        302,
        expect.objectContaining({ Location: expect.stringContaining('done?ok=0') }),
      );
    });

    it('exchanges the code and serves the done HTML on a valid callback', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      );
      const p = devSvc.generateAuthorizationUrl('agent-1', 'tenant-1');
      mockHttpControl.listenCb!();
      const url = await p;
      const state = new URL(url).searchParams.get('state')!;
      const res = mockRes();
      mockHttpControl.reqHandler!({ url: `/callback?code=auth&state=${state}` }, res);
      await flush();
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalled();
      expect(mockHttpControl.server!.close).toHaveBeenCalled();
    });

    it('serves a failure response when the callback exchange rejects', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, {}, 'bad'));
      const p = devSvc.generateAuthorizationUrl('agent-1', 'tenant-1');
      mockHttpControl.listenCb!();
      const url = await p;
      const state = new URL(url).searchParams.get('state')!;
      const res = mockRes();
      mockHttpControl.reqHandler!({ url: `/callback?code=bad&state=${state}` }, res);
      await flush();
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    });
  });
});
