/**
 * Callback-handler tests for RedirectPkceOauthBaseService — specifically the
 * sendDoneResponse logic that decides between a 302 redirect to the SPA
 * (only when the stored backendUrl is loopback) and the inline HTML page.
 *
 * These tests do NOT spin up a real HTTP server; they invoke the private
 * handleCallbackRequest directly with stub req/res objects so the assertions
 * are deterministic.
 */
import { ConfigService } from '@nestjs/config';
import { ProviderService } from '../../routing-core/provider.service';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import {
  RedirectPkceOauthBaseService,
  type RedirectPkceOauthConfig,
} from './redirect-pkce-oauth.base';

class TestPkceOauthService extends RedirectPkceOauthBaseService {
  constructor(
    providerService: ProviderService,
    configService: ConfigService,
    discoveryService: ModelDiscoveryService,
    config?: Partial<RedirectPkceOauthConfig>,
  ) {
    super(providerService, configService, discoveryService, {
      providerId: 'test-provider',
      serviceName: 'TestPkceOauthService',
      defaultClientId: 'test-client-id',
      clientIdEnvVar: 'TEST_OAUTH_CLIENT_ID',
      authorizeUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      revokeUrl: 'https://auth.example.com/oauth/revoke',
      scope: 'openid profile email',
      callbackPort: 1455,
      ...config,
    });
  }
}

function createConfig(): ConfigService {
  return {
    get: (key: string) => (key === 'app.nodeEnv' ? 'production' : undefined),
  } as unknown as ConfigService;
}

function createProviderService(): ProviderService {
  return {
    upsertProvider: jest.fn().mockResolvedValue({ provider: { id: 'p1' } }),
    recalculateTiers: jest.fn().mockResolvedValue(undefined),
    nextOAuthLabel: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProviderService;
}

function createDiscovery(): ModelDiscoveryService {
  return {
    discoverModels: jest.fn().mockResolvedValue(undefined),
  } as unknown as ModelDiscoveryService;
}

function buildSvc(): TestPkceOauthService {
  return new TestPkceOauthService(createProviderService(), createConfig(), createDiscovery());
}

interface CallbackPair {
  req: { url: string };
  res: { writeHead: jest.Mock; end: jest.Mock };
  done: Promise<void>;
  writeHead: jest.Mock;
  end: jest.Mock;
}

function buildCallbackPair(callbackUrl: string): CallbackPair {
  const req = { url: callbackUrl };
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const writeHead = jest.fn();
  const end = jest.fn(resolveDone);
  const res = { writeHead, end };
  return { req, res, done, writeHead, end };
}

function invokeHandler(svc: TestPkceOauthService, req: unknown, res: unknown): void {
  (
    svc as unknown as {
      handleCallbackRequest: (request: unknown, response: unknown) => void;
    }
  ).handleCallbackRequest(req, res);
}

describe('RedirectPkceOauthBaseService — sendDoneResponse', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('falls back to the inline HTML page when no backendUrl was stored', async () => {
    const svc = buildSvc();
    const url = await svc.generateAuthorizationUrl('a', 'u');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead, end } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    const html = end.mock.calls[0][0] as string;
    expect(html).toContain('Login failed');
    // No 302 redirect was issued.
    expect(writeHead).not.toHaveBeenCalledWith(302, expect.anything());
  });

  it('falls back to inline HTML when the stored backendUrl was sanitised away (attacker.com)', async () => {
    const svc = buildSvc();
    // attacker.com URL is rejected at storage, so backendUrl=''. The callback
    // handler must NOT redirect to attacker.com.
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://attacker.com');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    expect(writeHead).not.toHaveBeenCalledWith(302, expect.anything());
  });

  it('redirects to the stored localhost backendUrl on error', async () => {
    const svc = buildSvc();
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://localhost:3001');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: 'http://localhost:3001/api/v1/oauth/test-provider/done?ok=0',
    });
  });

  it('redirects to the stored [::1] IPv6 loopback backendUrl on error', async () => {
    const svc = buildSvc();
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://[::1]:3001');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: 'http://[::1]:3001/api/v1/oauth/test-provider/done?ok=0',
    });
  });

  it('redirects to localhost backendUrl with ok=0 when exchange fails', async () => {
    const svc = buildSvc();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad',
    } as unknown as Response) as unknown as typeof fetch;

    try {
      const url = await svc.generateAuthorizationUrl('a', 'u', 'http://127.0.0.1:3001');
      const state = new URL(url).searchParams.get('state')!;

      const { req, res, done, writeHead } = buildCallbackPair(
        `/auth/callback?state=${state}&code=bad-code`,
      );
      invokeHandler(svc, req, res);
      await done;

      expect(writeHead).toHaveBeenCalledWith(302, {
        Location: 'http://127.0.0.1:3001/api/v1/oauth/test-provider/done?ok=0',
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns 404 for paths other than /auth/callback', () => {
    const svc = buildSvc();
    const { req, res } = buildCallbackPair('/other-path');
    invokeHandler(svc, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith('Not found');
  });

  it('treats a request with no URL as the root path and returns 404', () => {
    const svc = buildSvc();
    const { res } = buildCallbackPair('');
    // Pass through req with no .url property to exercise the `req.url ?? '/'`
    // fallback in handleCallbackRequest.
    invokeHandler(svc, {}, res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith('Not found');
  });

  it('uses the provider id from config in the redirect Location', async () => {
    const svc = new TestPkceOauthService(
      createProviderService(),
      createConfig(),
      createDiscovery(),
      { providerId: 'custom-provider' },
    );
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://localhost:3001');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: 'http://localhost:3001/api/v1/oauth/custom-provider/done?ok=0',
    });
  });

  it('redirects with ok=0 (not ok=1) on provider-side error', async () => {
    const svc = buildSvc();
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://localhost:3001');
    const state = new URL(url).searchParams.get('state')!;

    const { req, res, done, writeHead } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied&error_description=user%20refused`,
    );
    invokeHandler(svc, req, res);
    await done;

    const [, headers] = writeHead.mock.calls[0];
    expect(headers.Location).toContain('ok=0');
    expect(headers.Location).not.toContain('ok=1');
  });

  it('clears the pending state when the provider returns an error', async () => {
    const svc = buildSvc();
    const url = await svc.generateAuthorizationUrl('a', 'u', 'http://localhost:3001');
    const state = new URL(url).searchParams.get('state')!;
    expect(svc.getPendingCount()).toBe(1);

    const { req, res, done } = buildCallbackPair(
      `/auth/callback?state=${state}&error=access_denied`,
    );
    invokeHandler(svc, req, res);
    await done;

    expect(svc.getPendingCount()).toBe(0);
  });
});
