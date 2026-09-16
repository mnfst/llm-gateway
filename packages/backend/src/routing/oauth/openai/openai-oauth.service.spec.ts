import { createServer } from 'http';
import { ConfigService } from '@nestjs/config';
import { OpenaiOauthService, OAuthTokenBlob } from './openai-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchMock = jest.fn() as jest.Mock<Promise<any>>;
global.fetch = fetchMock;

// Stub createServerMock so the callback server never actually binds a port
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: jest.fn(() => ({
      listen: jest.fn((_port: number, _host: string, cb?: () => void) => cb?.()),
      close: jest.fn(),
      on: jest.fn(),
      unref: jest.fn(),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createServerMock = createServer as unknown as jest.Mock<any>;

describe('OpenaiOauthService', () => {
  let service: OpenaiOauthService;
  let providerService: jest.Mocked<ProviderService>;
  let configService: jest.Mocked<ConfigService>;
  let discoveryService: { discoverModels: jest.Mock };

  beforeEach(() => {
    const upsertProvider = jest.fn().mockResolvedValue({ provider: {}, isNew: true });
    const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
    providerService = {
      upsertProvider,
      recalculateTiers: jest.fn().mockResolvedValue(undefined),
      nextOAuthLabel: jest.fn().mockResolvedValue(undefined),
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock: mockSubscriptionCredentialLock({
        getFreshSubscriptionCredential,
        upsertProvider,
      }),
    } as unknown as jest.Mocked<ProviderService>;

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    discoveryService = {
      discoverModels: jest.fn().mockResolvedValue([]),
    };

    service = new OpenaiOauthService(providerService, configService, discoveryService as never);
    fetchMock.mockReset();
  });

  afterEach(() => {
    // Force-clear internal refs to avoid cross-test leaks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).callbackServer = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).serverReady = null;
  });

  describe('generateAuthorizationUrl', () => {
    it('returns a valid OpenAI authorize URL with PKCE params', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');

      expect(url).toContain('https://auth.openai.com/oauth/authorize');
      expect(url).toMatch(/client_id=/);
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('state=');
      expect(url).toContain(
        `redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`,
      );
      expect(url).toContain('scope=openid+profile+email+offline_access');
    });

    it('stores pending state for later exchange', async () => {
      await service.generateAuthorizationUrl('agent-1', 'user-1');
      expect(service.getPendingCount()).toBe(1);
    });

    it('cleans up expired states on new URL generation', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const stateParam = new URL(url).searchParams.get('state')!;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = (service as any).pending as { peek(k: string): { expiresAt: number } };
      pending.peek(stateParam)!.expiresAt = Date.now() - 1000;

      await service.generateAuthorizationUrl('agent-2', 'user-2');
      expect(service.getPendingCount()).toBe(1);
    });
  });

  describe('exchangeCode', () => {
    it('exchanges code for tokens and stores them', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'tenant-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-123',
          refresh_token: 'refresh-456',
          expires_in: 3600,
        }),
      });

      await service.exchangeCode(state, 'auth-code-xyz');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({ method: 'POST' }),
      );

      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'tenant-1',
        'openai',
        expect.any(String),
        'subscription',
        undefined,
        undefined,
        null,
      );

      const storedBlob: OAuthTokenBlob = JSON.parse(
        providerService.upsertProvider.mock.calls[0][3] as string,
      );
      expect(storedBlob.t).toBe('access-123');
      expect(storedBlob.r).toBe('refresh-456');
      expect(storedBlob.e).toBeGreaterThan(Date.now());
    });

    it('throws for invalid state', async () => {
      await expect(service.exchangeCode('bad-state', 'code')).rejects.toThrow(
        'Invalid or expired OAuth state',
      );
    });

    it('throws for expired state', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = (service as any).pending as { peek(k: string): { expiresAt: number } };
      pending.peek(state)!.expiresAt = Date.now() - 1;

      await expect(service.exchangeCode(state, 'code')).rejects.toThrow('OAuth state expired');
      expect(service.getPendingCount()).toBe(0);
    });

    it('throws when token exchange fails', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        text: async () => 'bad request',
      });

      await expect(service.exchangeCode(state, 'code')).rejects.toThrow('Token exchange failed');
    });

    it('logs warning but does not throw when model discovery fails', async () => {
      discoveryService.discoverModels.mockRejectedValueOnce(new Error('discovery boom'));

      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      // Should not throw despite discovery failure
      await service.exchangeCode(state, 'code');

      expect(providerService.upsertProvider).toHaveBeenCalled();
      expect(discoveryService.discoverModels).toHaveBeenCalled();
    });

    it('removes state after successful exchange', async () => {
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      await service.exchangeCode(state, 'code');
      expect(service.getPendingCount()).toBe(0);
    });
  });

  describe('refreshAccessToken', () => {
    it('refreshes and returns new token blob', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 7200,
        }),
      });

      const result = await service.refreshAccessToken('old-refresh');

      expect(result.t).toBe('new-access');
      expect(result.r).toBe('new-refresh');
      expect(result.e).toBeGreaterThan(Date.now());
    });

    it('keeps original refresh token if none returned', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          expires_in: 3600,
        }),
      });

      const result = await service.refreshAccessToken('original-refresh');
      expect(result.r).toBe('original-refresh');
    });

    it('throws when refresh fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        text: async () => 'unauthorized',
      });

      await expect(service.refreshAccessToken('bad-token')).rejects.toThrow('Token refresh failed');
    });
  });

  describe('unwrapToken', () => {
    it('returns access token from valid, non-expired blob', async () => {
      const blob: OAuthTokenBlob = {
        t: 'access-tok',
        r: 'refresh-tok',
        e: Date.now() + 120_000,
      };

      const result = await service.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1');
      expect(result).toBe('access-tok');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null for non-JSON values', async () => {
      const result = await service.unwrapToken('sk-plain-api-key', 'agent-1', 'user-1');
      expect(result).toBeNull();
    });

    it('returns null for JSON without required fields', async () => {
      const result = await service.unwrapToken('{"foo":"bar"}', 'agent-1', 'user-1');
      expect(result).toBeNull();
    });

    it('refreshes expired token and stores new blob', async () => {
      const blob: OAuthTokenBlob = {
        t: 'old-access',
        r: 'refresh-tok',
        e: Date.now() - 1000,
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      });

      const result = await service.unwrapToken(JSON.stringify(blob), 'agent-1', 'tenant-1', 'Work');

      expect(result).toBe('new-access');
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        'openai',
        expect.any(String),
        'subscription',
        undefined,
        'Work',
      );
    });

    it('refreshes token within 60s buffer', async () => {
      const blob: OAuthTokenBlob = {
        t: 'expiring-soon',
        r: 'refresh-tok',
        e: Date.now() + 30_000,
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
      });

      const result = await service.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1');
      expect(result).toBe('fresh-access');
    });

    it('returns null when refresh fails', async () => {
      const blob: OAuthTokenBlob = {
        t: 'stale-access',
        r: 'bad-refresh',
        e: Date.now() - 1000,
      };

      fetchMock.mockResolvedValueOnce({
        ok: false,
        text: async () => 'token expired',
      });

      const result = await service.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('revokeToken', () => {
    it('calls OpenAI revoke endpoint with the token', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });

      await service.revokeToken('access-token-123');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/revoke',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
      expect(body.get('token')).toBe('access-token-123');
      expect(body.get('client_id')).toBeTruthy();
    });

    it('logs warning when revocation response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'invalid_token' });
      // Should not throw
      await service.revokeToken('bad-token');
    });

    it('logs warning when fetch throws a network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));
      // Should not throw
      await service.revokeToken('any-token');
    });
  });

  describe('callback server', () => {
    it('starts callback server on first URL generation', async () => {
      await service.generateAuthorizationUrl('agent-1', 'user-1');
      expect(createServerMock).toHaveBeenCalled();
    });

    it('skips callback server in production mode', async () => {
      const prodConfig = {
        get: jest.fn((key: string) => (key === 'app.nodeEnv' ? 'production' : undefined)),
      } as unknown as jest.Mocked<ConfigService>;
      const prodService = new OpenaiOauthService(
        providerService,
        prodConfig,
        discoveryService as never,
      );

      createServerMock.mockClear();
      await prodService.generateAuthorizationUrl('agent-1', 'user-1');
      expect(createServerMock).not.toHaveBeenCalled();
    });

    it('does not start a second server when one is already running', async () => {
      await service.generateAuthorizationUrl('agent-1', 'user-1');
      const callCount = createServerMock.mock.calls.length;
      await service.generateAuthorizationUrl('agent-2', 'user-2');
      expect(createServerMock.mock.calls.length).toBe(callCount);
    });

    it('shuts down callback server after last exchange completes', async () => {
      const firstUrl = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const firstState = new URL(firstUrl).searchParams.get('state')!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = (service as any).callbackServer;

      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      // Remove the unrelated pending entry so only one remains.
      service.clearPendingState(firstState);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      await service.exchangeCode(state, 'code');
      expect(server.close).toHaveBeenCalled();
    });

    it('rejects with error when EADDRINUSE', async () => {
      let errorHandler: (err: NodeJS.ErrnoException) => void;
      createServerMock.mockReturnValueOnce({
        listen: jest.fn(),
        close: jest.fn(),
        on: jest.fn((_event: string, handler: (err: NodeJS.ErrnoException) => void) => {
          errorHandler = handler;
        }),
        unref: jest.fn(),
      });

      // Reset internal refs so a fresh server is created
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;

      const promise = service.generateAuthorizationUrl('agent-1', 'user-1');

      // Simulate EADDRINUSE
      const err = new Error('Port in use') as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      errorHandler!(err);

      await expect(promise).rejects.toThrow(
        "Port 1455 is already in use. Run 'lsof -i :1455' to find the process.",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).callbackServer).toBeNull();
    });

    it('rejects with error on non-EADDRINUSE server errors', async () => {
      let errorHandler: (err: NodeJS.ErrnoException) => void;
      createServerMock.mockReturnValueOnce({
        listen: jest.fn(),
        close: jest.fn(),
        on: jest.fn((_event: string, handler: (err: NodeJS.ErrnoException) => void) => {
          errorHandler = handler;
        }),
        unref: jest.fn(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;

      const promise = service.generateAuthorizationUrl('agent-1', 'user-1');

      const err = new Error('Random error') as NodeJS.ErrnoException;
      err.code = 'ECONNREFUSED';
      errorHandler!(err);

      await expect(promise).rejects.toThrow('Callback server failed: Random error');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).callbackServer).toBeNull();
    });

    it('callback server handles requests on /auth/callback', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: `/auth/callback?code=the-code&state=${state}` }, res);

      // Wait for async exchange
      await new Promise((r) => setTimeout(r, 50));
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-success'));
    });

    it('callback server returns 404 for non-callback paths', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      await service.generateAuthorizationUrl('agent-1', 'user-1');

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: '/some/other/path' }, res);

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('callback server returns error HTML when provider sends error param', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!(
        {
          url: `/auth/callback?error=access_denied&error_description=User+denied&state=${state}`,
        },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-error'));
      expect(service.getPendingCount()).toBe(0);
    });

    it('callback server returns error HTML on exchange failure', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      await service.generateAuthorizationUrl('agent-1', 'user-1');

      const res = { writeHead: jest.fn(), end: jest.fn() };
      // Use an invalid state to trigger an error
      requestHandler!({ url: '/auth/callback?code=code&state=invalid-state' }, res);

      await new Promise((r) => setTimeout(r, 50));
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-error'));
    });

    it('always uses localhost:1455 as redirect_uri (Codex CLI OAuth app constraint)', async () => {
      // Even with backendUrl, redirect_uri must be localhost:1455
      // because the Codex CLI OAuth app only allows that redirect URI
      const url = await service.generateAuthorizationUrl(
        'agent-1',
        'user-1',
        'https://app.manifest.build',
      );

      expect(url).toContain(
        `redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`,
      );
    });

    it('callback server redirects to backendUrl on failure when set (local mode)', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      // No backendUrl → local mode → ephemeral server started
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        text: async () => 'bad request',
      });

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: `/auth/callback?code=code&state=${state}` }, res);

      await new Promise((r) => setTimeout(r, 50));
      // No backendUrl → inline error HTML, not a redirect
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-error'));
    });

    it('redirects to localhost backendUrl on success', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      const url = await service.generateAuthorizationUrl(
        'agent-1',
        'user-1',
        'http://localhost:3001',
      );
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: `/auth/callback?code=the-code&state=${state}` }, res);

      await new Promise((r) => setTimeout(r, 50));
      expect(res.writeHead).toHaveBeenCalledWith(302, {
        Location: 'http://localhost:3001/api/v1/oauth/openai/done?ok=1',
      });
    });

    it('falls back to HTML when backendUrl is an external origin', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      const url = await service.generateAuthorizationUrl(
        'agent-1',
        'user-1',
        'https://evil.example.com',
      );
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: `/auth/callback?code=the-code&state=${state}` }, res);

      await new Promise((r) => setTimeout(r, 50));
      // Should NOT redirect to external URL — falls back to HTML
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-success'));
    });

    it('falls back to HTML when backendUrl is an invalid URL', async () => {
      let requestHandler: (req: unknown, res: unknown) => void;
      createServerMock.mockImplementationOnce((handler: (req: unknown, res: unknown) => void) => {
        requestHandler = handler;
        return {
          listen: jest.fn((_p: number, _h: string, cb?: () => void) => cb?.()),
          close: jest.fn(),
          on: jest.fn(),
          unref: jest.fn(),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).callbackServer = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).serverReady = null;
      const url = await service.generateAuthorizationUrl('agent-1', 'user-1', 'not-a-valid-url');
      const state = new URL(url).searchParams.get('state')!;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
        }),
      });

      const res = { writeHead: jest.fn(), end: jest.fn() };
      requestHandler!({ url: `/auth/callback?code=the-code&state=${state}` }, res);

      await new Promise((r) => setTimeout(r, 50));
      // Invalid URL → falls back to HTML
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('manifest-oauth-success'));
    });
  });
});
