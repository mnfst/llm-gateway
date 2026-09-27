import { ConfigService } from '@nestjs/config';
import { MinimaxOauthService } from './minimax-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';

const originalFetch = global.fetch;

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function mockRawResponse(status: number, rawText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => rawText,
    json: async () => JSON.parse(rawText),
  } as unknown as Response;
}

function createConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
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

describe('MinimaxOauthService', () => {
  let fetchMock: jest.Mock;
  let provider: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;
  let svc: MinimaxOauthService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-20T12:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    provider = createProviderService();
    discovery = createDiscovery();
    svc = new MinimaxOauthService(provider.svc, createConfig(), discovery.svc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // --- startAuthorization ---

  async function startFlow(region: 'global' | 'cn' = 'global') {
    // The code endpoint echoes back a user_code + state. The service generates
    // the state itself, so we need to capture it from the request and echo it.
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      return mockResponse(200, {
        user_code: 'USER-CODE',
        verification_uri: 'https://minimax.example/verify',
        expired_in: 600,
        interval: 2,
        state: body.get('state'),
      });
    });
    return svc.startAuthorization('agent-1', 'user-1', region);
  }

  describe('startAuthorization', () => {
    it('POSTs a PKCE-challenge to the region-specific code endpoint and records the pending flow', async () => {
      const out = await startFlow('global');
      expect(out.userCode).toBe('USER-CODE');
      expect(out.verificationUri).toBe('https://minimax.example/verify');
      expect(out.pollIntervalMs).toBe(2000);
      expect(out.expiresAt).toBe(Date.now() + 600_000);
      expect(svc.getPendingCount()).toBe(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.minimax.io/oauth/code');
      const body = new URLSearchParams((init as RequestInit).body as string);
      expect(body.get('response_type')).toBe('code');
      expect(body.get('code_challenge_method')).toBe('S256');
      expect(body.get('code_challenge')?.length).toBeGreaterThan(0);
    });

    it('hits the CN endpoint when region="cn"', async () => {
      await startFlow('cn');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.minimaxi.com/oauth/code');
    });

    it('throws when the code endpoint returns an error', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(500, { error: 'oops' }));
      await expect(svc.startAuthorization('a', 'u')).rejects.toThrow(
        'Failed to start MiniMax OAuth',
      );
    });

    it('throws when the payload is incomplete', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { state: 'x' }));
      await expect(svc.startAuthorization('a', 'u')).rejects.toThrow();
    });

    it('rewrites the broken upstream verification_uri host to platform.minimax.io', async () => {
      // Reproduces issue #1796: the MiniMax /oauth/code endpoint returns a
      // verification_uri pointing at www.minimax.io/oauth-authorize, which
      // 307-redirects to the homepage. The real authorize page lives on
      // platform.minimax.io.
      fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = new URLSearchParams(String(init.body));
        return mockResponse(200, {
          user_code: 'Y3CN-NY48',
          verification_uri:
            'https://www.minimax.io/oauth-authorize?user_code=Y3CN-NY48&client=OpenClaw',
          expired_in: 600,
          interval: 2,
          state: body.get('state'),
        });
      });
      const out = await svc.startAuthorization('agent-1', 'user-1', 'global');
      expect(out.verificationUri).toBe(
        'https://platform.minimax.io/oauth-authorize?user_code=Y3CN-NY48&client=OpenClaw',
      );
    });

    it('throws when the echoed state does not match the generated flow id', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          user_code: 'U',
          verification_uri: 'https://v',
          expired_in: 60,
          state: 'different',
        }),
      );
      await expect(svc.startAuthorization('a', 'u')).rejects.toThrow(
        'MiniMax OAuth state mismatch',
      );
    });
  });

  // --- pollAuthorization ---

  describe('pollAuthorization', () => {
    it('reports error for unknown or expired flow ids', async () => {
      const out = await svc.pollAuthorization('unknown', 'user-1');
      expect(out.status).toBe('error');
    });

    it('reports error when the user does not match the flow owner', async () => {
      const start = await startFlow();
      const out = await svc.pollAuthorization(start.flowId, 'someone-else');
      expect(out.status).toBe('error');
      expect(out.message).toContain('does not match');
    });

    it('reports error and purges the flow when the pending entry has expired', async () => {
      const start = await startFlow();
      jest.advanceTimersByTime(601_000);
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('error');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('purges and reports error when the flow expires between cleanup and the expiry check', async () => {
      const start = await startFlow();
      // cleanupExpired() and the explicit expiry check share Date.now(); only a
      // clock that advances between the two reads reaches the expiry branch.
      const nowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(start.expiresAt - 1)
        .mockReturnValueOnce(start.expiresAt + 1);
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      nowSpy.mockRestore();
      expect(out.status).toBe('error');
      expect(out.message).toContain('expired');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('returns "pending" when the token endpoint reports a pending approval', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(mockResponse(200, { status: 'pending' }));
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('pending');
      expect(out.pollIntervalMs).toBe(start.pollIntervalMs);
      // Flow is retained for another poll.
      expect(svc.getPendingCount()).toBe(1);
    });

    it('returns error and purges when the token endpoint explicitly reports status=error', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(mockResponse(200, { status: 'error' }));
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('error');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('returns error and purges when the token endpoint returns a non-2xx status', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(
        mockResponse(500, { base_resp: { status_msg: 'backend down' } }),
      );
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('error');
      expect(out.message).toBe('backend down');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('returns error when the body is non-JSON', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(mockRawResponse(200, 'not-json'));
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('error');
      expect(svc.getPendingCount()).toBe(0);
    });

    it('returns error when success payload is missing access/refresh/expiry', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(mockResponse(200, { status: 'success' }));
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('error');
    });

    it('persists the blob and triggers model discovery on success', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          status: 'success',
          access_token: 'at',
          refresh_token: 'rt',
          expired_in: 3600,
          resource_url: 'https://api.minimax.io/anthropic/v1',
        }),
      );
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('success');
      expect(provider.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'user-1',
        'minimax',
        expect.stringContaining('"t":"at"'),
        'subscription',
        undefined,
        undefined,
        null,
      );
      expect(discovery.discoverModels).toHaveBeenCalled();
      expect(provider.recalculateTiers).not.toHaveBeenCalled();
      expect(provider.recalculateTiersForUser).not.toHaveBeenCalled();
      expect(svc.getPendingCount()).toBe(0);
    });

    it('does not route agents after discovery when the provider row is new', async () => {
      provider.upsertProvider.mockResolvedValueOnce({ provider: { id: 'p1' }, isNew: true });
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          status: 'success',
          access_token: 'at',
          refresh_token: 'rt',
          expired_in: 3600,
        }),
      );

      await svc.pollAuthorization(start.flowId, 'user-1');

      expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
      expect(provider.recalculateTiersForUser).not.toHaveBeenCalled();
      expect(provider.recalculateTiers).not.toHaveBeenCalled();
    });

    it('swallows discovery errors after a successful token exchange', async () => {
      const start = await startFlow();
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, {
          status: 'success',
          access_token: 'at',
          refresh_token: 'rt',
          expired_in: 3600,
        }),
      );
      discovery.discoverModels.mockRejectedValue(new Error('boom'));
      const out = await svc.pollAuthorization(start.flowId, 'user-1');
      expect(out.status).toBe('success');
    });
  });

  // --- refreshAccessToken ---

  describe('refreshAccessToken', () => {
    it('returns a fresh blob preserving the refresh token when none is returned', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { access_token: 'a2', expired_in: 1800 }));
      const blob = await svc.refreshAccessToken('old-refresh');
      expect(blob.t).toBe('a2');
      expect(blob.r).toBe('old-refresh');
      expect(blob.e).toBe(Date.now() + 1800_000);
    });

    it('throws when the endpoint returns a non-2xx status', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(400, {}));
      await expect(svc.refreshAccessToken('r')).rejects.toThrow('Token refresh failed');
    });

    it('throws when the refresh payload is incomplete', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(200, { access_token: 'a2' }));
      await expect(svc.refreshAccessToken('r')).rejects.toThrow(
        'MiniMax token refresh returned an incomplete payload',
      );
    });
  });

  // --- unwrapToken ---

  describe('unwrapToken', () => {
    it('returns null for malformed JSON or non-blob shapes', async () => {
      expect(await svc.unwrapToken('not-json', 'a', 'u')).toBeNull();
      expect(await svc.unwrapToken(JSON.stringify({}), 'a', 'u')).toBeNull();
    });

    it('returns the blob unchanged when it is still valid', async () => {
      const blob = { t: 'a', r: 'r', e: Date.now() + 10 * 60 * 1000 };
      expect(await svc.unwrapToken(JSON.stringify(blob), 'a', 'u')).toEqual(blob);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes the blob when near expiry and persists the new one', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 30_000 };
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expired_in: 3600 }),
      );
      const out = await svc.unwrapToken(JSON.stringify(blob), 'agent-1', 'user-1', 'Work');
      expect(out?.t).toBe('new');
      expect(provider.upsertProvider).toHaveBeenCalled();
      expect(provider.upsertProvider.mock.calls[0][6]).toBe('Work');
    });

    it('returns the original blob (not null) when refresh fails', async () => {
      const blob = { t: 'old', r: 'rf', e: Date.now() + 30_000 };
      fetchMock.mockRejectedValueOnce(new Error('network'));
      const out = await svc.unwrapToken(JSON.stringify(blob), 'a', 'u');
      expect(out).toEqual(blob);
    });

    it('returns the fresher persisted blob without refreshing when one already exists', async () => {
      const stale = { t: 'old', r: 'rf', e: Date.now() - 1_000 };
      const fresh = { t: 'fresh', r: 'rf2', e: Date.now() + 10 * 60 * 1000 };
      provider.getFreshSubscriptionCredential.mockResolvedValueOnce(JSON.stringify(fresh));
      const out = await svc.unwrapToken(JSON.stringify(stale), 'agent-1', 'user-1', 'Work');
      expect(out).toEqual(fresh);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores an unparseable persisted credential and refreshes from the caller blob', async () => {
      const stale = { t: 'old', r: 'rf', e: Date.now() - 1_000 };
      provider.getFreshSubscriptionCredential.mockResolvedValueOnce('not-json{');
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expired_in: 3600 }),
      );
      const out = await svc.unwrapToken(JSON.stringify(stale), 'agent-1', 'user-1');
      expect(out?.t).toBe('new');
    });

    it('ignores a persisted value that is valid JSON but not a token blob', async () => {
      const stale = { t: 'old', r: 'rf', e: Date.now() - 1_000 };
      provider.getFreshSubscriptionCredential.mockResolvedValueOnce(JSON.stringify({ nope: true }));
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { access_token: 'new', refresh_token: 'rf2', expired_in: 3600 }),
      );
      const out = await svc.unwrapToken(JSON.stringify(stale), 'agent-1', 'user-1');
      expect(out?.t).toBe('new');
    });
  });
});
