import { ConfigService } from '@nestjs/config';
import { KiroOauthService } from './kiro-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';
import { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import {
  KiroAuthorizationOptionsError,
  parseKiroOAuthTokenBlob,
  serializeKiroOAuthTokenBlob,
} from './kiro-oidc';

const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function rawResponse(status: number, rawText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => rawText,
    json: async () => (rawText ? JSON.parse(rawText) : null),
  } as unknown as Response;
}

function createConfig(overrides: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

function createProviderService() {
  const upsertProvider = jest.fn().mockResolvedValue({ provider: { id: 'p1' } });
  const recalculateTiers = jest.fn().mockResolvedValue(undefined);
  const recalculateTiersForUser = jest.fn().mockResolvedValue(undefined);
  const nextOAuthLabel = jest.fn().mockResolvedValue('Kiro 1');
  const getFreshSubscriptionCredential = jest.fn().mockResolvedValue(null);
  const withSubscriptionCredentialLock = mockSubscriptionCredentialLock({
    getFreshSubscriptionCredential,
    upsertProvider,
  });
  return {
    svc: {
      upsertProvider,
      recalculateTiers,
      recalculateTiersForUser,
      nextOAuthLabel,
      getFreshSubscriptionCredential,
      withSubscriptionCredentialLock,
    } as unknown as ProviderService,
    upsertProvider,
    recalculateTiers,
    recalculateTiersForUser,
    nextOAuthLabel,
    getFreshSubscriptionCredential,
    withSubscriptionCredentialLock,
  };
}

function createDiscovery() {
  const discoverModels = jest.fn().mockResolvedValue(undefined);
  return { svc: { discoverModels } as unknown as ModelDiscoveryService, discoverModels };
}

const REGISTER_OK = jsonResponse(200, { clientId: 'cid', clientSecret: 'csecret' });
const DEVICE_OK = jsonResponse(200, {
  deviceCode: 'device-code',
  userCode: 'AAAA-BBBB',
  verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
  verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=AAAA-BBBB',
  expiresIn: 600,
  interval: 5,
});

describe('KiroOauthService', () => {
  let fetchMock: jest.Mock;
  let provider: ReturnType<typeof createProviderService>;
  let discovery: ReturnType<typeof createDiscovery>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-26T00:00:00Z'));
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    provider = createProviderService();
    discovery = createDiscovery();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function makeService(config: ConfigService = createConfig()): KiroOauthService {
    return new KiroOauthService(provider.svc, config, discovery.svc);
  }

  async function startFlow(service: KiroOauthService) {
    fetchMock.mockResolvedValueOnce(REGISTER_OK).mockResolvedValueOnce(DEVICE_OK);
    return service.startAuthorization('agent-1', 'user-1');
  }

  describe('configuration', () => {
    it('honors region/startUrl/scopes overrides from config', async () => {
      const service = makeService(
        createConfig({
          KIRO_OIDC_REGION: 'eu-west-1',
          KIRO_START_URL: 'https://example.awsapps.com/start',
          KIRO_OAUTH_SCOPES: 'scope:a, scope:b , ,scope:c',
        }),
      );
      await startFlow(service);

      const [registerUrl, registerInit] = fetchMock.mock.calls[0];
      expect(registerUrl).toBe('https://oidc.eu-west-1.amazonaws.com/client/register');
      expect(JSON.parse((registerInit as RequestInit).body as string).scopes).toEqual([
        'scope:a',
        'scope:b',
        'scope:c',
      ]);
      const [, deviceInit] = fetchMock.mock.calls[1];
      expect(JSON.parse((deviceInit as RequestInit).body as string).startUrl).toBe(
        'https://example.awsapps.com/start',
      );
    });

    it('falls back to default scopes when no override is set', async () => {
      const service = makeService();
      await startFlow(service);
      const registerBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(registerBody.scopes).toContain('codewhisperer:completions');
      expect(registerBody.clientType).toBe('public');
    });
  });

  describe('startAuthorization', () => {
    it('registers a client, starts device auth, and stores a pending flow', async () => {
      const service = makeService();
      const result = await startFlow(service);

      expect(result.userCode).toBe('AAAA-BBBB');
      expect(result.verificationUri).toContain('?user_code=AAAA-BBBB');
      expect(result.expiresAt).toBe(Date.now() + 600 * 1000);
      expect(result.pollIntervalMs).toBe(5000);
      expect(service.getPendingCount()).toBe(1);
    });

    it('uses per-flow IAM Identity Center start URL and region options', async () => {
      const service = makeService();
      fetchMock
        .mockResolvedValueOnce(REGISTER_OK)
        .mockResolvedValueOnce(DEVICE_OK)
        .mockResolvedValueOnce(
          jsonResponse(200, {
            accessToken: 'aoa-token',
            refreshToken: 'aor-token',
            expiresIn: 3600,
          }),
        );

      const { flowId } = await service.startAuthorization('agent-1', 'user-1', null, {
        startUrl: ' https://org.awsapps.com/start ',
        region: 'EU-WEST-1',
      });
      await service.pollAuthorization(flowId, 'user-1');

      const [registerUrl] = fetchMock.mock.calls[0];
      expect(registerUrl).toBe('https://oidc.eu-west-1.amazonaws.com/client/register');
      const [, deviceInit] = fetchMock.mock.calls[1];
      expect(JSON.parse((deviceInit as RequestInit).body as string).startUrl).toBe(
        'https://org.awsapps.com/start',
      );
      const [tokenUrl] = fetchMock.mock.calls[2];
      expect(tokenUrl).toBe('https://oidc.eu-west-1.amazonaws.com/token');
      const saved = parseKiroOAuthTokenBlob(provider.upsertProvider.mock.calls[0][3] as string);
      expect(saved?.region).toBe('eu-west-1');
    });

    it('rejects invalid IAM Identity Center options before registering a client', async () => {
      const service = makeService();

      await expect(
        service.startAuthorization('agent-1', 'user-1', null, {
          startUrl: 'http://org.awsapps.com/start',
          region: 'eu-west-1',
        }),
      ).rejects.toThrow('must use HTTPS');
      await expect(
        service.startAuthorization('agent-1', 'user-1', null, {
          startUrl: 'https://org.awsapps.com/start',
          region: 'eu-west-1.example',
        }),
      ).rejects.toThrow('region is invalid');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names IAM Identity Center option errors for diagnostics', () => {
      const error = new KiroAuthorizationOptionsError('bad option');

      expect(error.name).toBe('KiroAuthorizationOptionsError');
      expect(error.message).toBe('bad option');
    });

    it('sweeps expired pending flows when a new flow starts', async () => {
      const service = makeService();
      await startFlow(service);
      expect(service.getPendingCount()).toBe(1);
      jest.setSystemTime(new Date('2026-05-26T01:00:00Z'));
      await startFlow(service);
      // The stale flow was purged; only the freshly started one remains.
      expect(service.getPendingCount()).toBe(1);
    });

    it('falls back to verificationUri when the complete URI is absent', async () => {
      const service = makeService();
      fetchMock.mockResolvedValueOnce(REGISTER_OK).mockResolvedValueOnce(
        jsonResponse(200, {
          deviceCode: 'device-code',
          userCode: 'CCCC-DDDD',
          verificationUri: 'https://verify.example/',
          expiresIn: 600,
        }),
      );
      const result = await service.startAuthorization('agent-1', 'user-1');
      expect(result.verificationUri).toBe('https://verify.example/');
      expect(result.pollIntervalMs).toBe(5000);
    });

    it('throws when client registration fails', async () => {
      const service = makeService();
      fetchMock.mockResolvedValueOnce(rawResponse(403, 'forbidden'));
      await expect(service.startAuthorization('a', 'u')).rejects.toThrow(
        'Failed to start Kiro login',
      );
    });

    it('throws when client registration payload is incomplete', async () => {
      const service = makeService();
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { clientId: 'cid' }));
      await expect(service.startAuthorization('a', 'u')).rejects.toThrow('incomplete payload');
    });

    it('throws when device authorization fails', async () => {
      const service = makeService();
      fetchMock.mockResolvedValueOnce(REGISTER_OK).mockResolvedValueOnce(rawResponse(400, 'bad'));
      await expect(service.startAuthorization('a', 'u')).rejects.toThrow(
        'Failed to start Kiro login',
      );
    });

    it('throws when device authorization payload is incomplete', async () => {
      const service = makeService();
      fetchMock
        .mockResolvedValueOnce(REGISTER_OK)
        .mockResolvedValueOnce(jsonResponse(200, { userCode: 'X', expiresIn: 600 }));
      await expect(service.startAuthorization('a', 'u')).rejects.toThrow('incomplete payload');
    });
  });

  describe('pollAuthorization', () => {
    async function startAndGetFlowId(service: KiroOauthService): Promise<string> {
      const { flowId } = await startFlow(service);
      return flowId;
    }

    it('returns error for an unknown flow', async () => {
      const service = makeService();
      const result = await service.pollAuthorization('nope', 'user-1');
      expect(result).toEqual({ status: 'error', message: 'Kiro login expired. Start again.' });
    });

    it('returns error when the user does not match', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      const result = await service.pollAuthorization(flowId, 'someone-else');
      expect(result.status).toBe('error');
      expect(result.message).toContain('does not match');
    });

    it('expires a pending flow whose deadline passed', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      jest.setSystemTime(new Date('2026-05-26T01:00:00Z'));
      const result = await service.pollAuthorization(flowId, 'user-1');
      expect(result.message).toBe('Kiro login expired. Start again.');
      expect(service.getPendingCount()).toBe(0);
    });

    it('keeps polling at the same interval on authorization_pending', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }));
      const result = await service.pollAuthorization(flowId, 'user-1');
      expect(result.status).toBe('pending');
      expect(result.pollIntervalMs).toBe(5000);
      expect(service.getPendingCount()).toBe(1);
    });

    it('backs off the interval by 5s on each slow_down (RFC 8628 §3.5)', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);

      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }));
      let result = await service.pollAuthorization(flowId, 'user-1');
      expect(result.status).toBe('pending');
      expect(result.pollIntervalMs).toBe(10000);

      // A second slow_down compounds the backoff on the persisted interval.
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }));
      result = await service.pollAuthorization(flowId, 'user-1');
      expect(result.pollIntervalMs).toBe(15000);
      expect(service.getPendingCount()).toBe(1);
    });

    it('surfaces error_description on a hard token error', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { error: 'access_denied', error_description: 'User said no' }),
      );
      const result = await service.pollAuthorization(flowId, 'user-1');
      expect(result).toEqual({ status: 'error', message: 'User said no' });
      expect(service.getPendingCount()).toBe(0);
    });

    it('falls back to message, then a default, on a hard token error', async () => {
      const service = makeService();
      let flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { error: 'expired_token', message: 'gone' }),
      );
      expect((await service.pollAuthorization(flowId, 'user-1')).message).toBe('gone');

      flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(rawResponse(400, ''));
      expect((await service.pollAuthorization(flowId, 'user-1')).message).toBe(
        'Kiro login failed.',
      );

      flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(rawResponse(400, 'not-json'));
      expect((await service.pollAuthorization(flowId, 'user-1')).message).toBe(
        'Kiro login failed.',
      );
    });

    it('errors when the token response is missing fields', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a' }));
      const result = await service.pollAuthorization(flowId, 'user-1');
      expect(result.message).toContain('incomplete token payload');
      expect(service.getPendingCount()).toBe(0);
    });

    it('stores the token blob and runs discovery on success', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'aoa-token', refreshToken: 'aor-token', expiresIn: 3600 }),
      );
      const result = await service.pollAuthorization(flowId, 'user-1');

      expect(result).toEqual({ status: 'success' });
      expect(provider.nextOAuthLabel).toHaveBeenCalledWith('user-1', 'kiro');
      const [, , prov, serialized, authType, , label] = provider.upsertProvider.mock.calls[0];
      expect(prov).toBe('kiro');
      expect(authType).toBe('subscription');
      expect(label).toBe('Kiro 1');
      const blob = parseKiroOAuthTokenBlob(serialized as string);
      expect(blob).toMatchObject({
        source: 'kiro-oidc',
        t: 'aoa-token',
        r: 'aor-token',
        cid: 'cid',
        cs: 'csecret',
        region: 'us-east-1',
      });
      expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
      expect(provider.recalculateTiers).not.toHaveBeenCalled();
      expect(provider.recalculateTiersForUser).not.toHaveBeenCalled();
    });

    it('does not route agents after discovery when the provider row is new', async () => {
      provider.upsertProvider.mockResolvedValueOnce({ provider: { id: 'p1' }, isNew: true });
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
      );

      await service.pollAuthorization(flowId, 'user-1');

      expect(discovery.discoverModels).toHaveBeenCalledWith({ id: 'p1' });
      expect(provider.recalculateTiersForUser).not.toHaveBeenCalled();
      expect(provider.recalculateTiers).not.toHaveBeenCalled();
    });

    it('still succeeds when post-connect discovery throws', async () => {
      const service = makeService();
      const flowId = await startAndGetFlowId(service);
      discovery.discoverModels.mockRejectedValueOnce(new Error('discovery down'));
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
      );
      expect((await service.pollAuthorization(flowId, 'user-1')).status).toBe('success');
    });
  });

  describe('unwrapToken', () => {
    function blobString(overrides: Partial<Record<string, unknown>> = {}): string {
      return serializeKiroOAuthTokenBlob({
        source: 'kiro-oidc',
        t: 'stored-access',
        r: 'stored-refresh',
        e: Date.now() + 3600 * 1000,
        cid: 'cid',
        cs: 'cs',
        region: 'us-east-1',
        ...(overrides as object),
      });
    }

    it('returns null for an unparseable blob', async () => {
      const service = makeService();
      expect(await service.unwrapToken('garbage', 'a', 'u')).toBeNull();
    });

    it('returns the stored token when it is still fresh', async () => {
      const service = makeService();
      expect(await service.unwrapToken(blobString(), 'a', 'u')).toBe('stored-access');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes an expired token, persists it, and returns the new one', async () => {
      const service = makeService();
      const raw = blobString({ e: Date.now() + 1000 });
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          expiresIn: 3600,
        }),
      );
      expect(await service.unwrapToken(raw, 'agent-1', 'user-1', 'Work')).toBe('fresh-access');
      const saved = parseKiroOAuthTokenBlob(provider.upsertProvider.mock.calls[0][3] as string);
      expect(saved).toMatchObject({ t: 'fresh-access', r: 'fresh-refresh' });
      expect(provider.upsertProvider.mock.calls[0][6]).toBe('Work');
    });

    it('keeps the old refresh token when the refresh response omits one', async () => {
      const service = makeService();
      const raw = blobString({ e: Date.now() + 1000 });
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh', expiresIn: 3600 }));
      await service.unwrapToken(raw, 'agent-1', 'user-1');
      const saved = parseKiroOAuthTokenBlob(provider.upsertProvider.mock.calls[0][3] as string);
      expect(saved?.r).toBe('stored-refresh');
    });

    it('returns the still-valid stored token if refresh fails', async () => {
      const service = makeService();
      const raw = blobString({ e: Date.now() + 30_000 });
      fetchMock.mockResolvedValueOnce(rawResponse(401, 'unauthorized'));
      expect(await service.unwrapToken(raw, 'a', 'u')).toBe('stored-access');
    });

    it('returns null if refresh fails and the stored token is already expired', async () => {
      const service = makeService();
      const raw = blobString({ e: Date.now() - 1000 });
      fetchMock.mockResolvedValueOnce(rawResponse(401, 'unauthorized'));
      expect(await service.unwrapToken(raw, 'a', 'u')).toBeNull();
    });

    it('recovers when the refresh payload is incomplete', async () => {
      const service = makeService();
      const raw = blobString({ e: Date.now() + 30_000 });
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { expiresIn: 3600 }));
      expect(await service.unwrapToken(raw, 'a', 'u')).toBe('stored-access');
    });

    it('refreshes against the blob region', async () => {
      const service = makeService(createConfig({ KIRO_OIDC_REGION: 'us-west-2' }));
      const raw = blobString({ e: Date.now() + 1000, region: 'eu-central-1' });
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'x', refreshToken: 'y', expiresIn: 3600 }),
      );
      await service.unwrapToken(raw, 'a', 'u');
      expect(fetchMock.mock.calls[0][0]).toBe('https://oidc.eu-central-1.amazonaws.com/token');
    });

    it('falls back to the configured region when the blob omits one', async () => {
      const service = makeService(createConfig({ KIRO_OIDC_REGION: 'us-west-2' }));
      const raw = blobString({ e: Date.now() + 1000, region: undefined });
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'x', refreshToken: 'y', expiresIn: 3600 }),
      );
      await service.unwrapToken(raw, 'a', 'u');
      expect(fetchMock.mock.calls[0][0]).toBe('https://oidc.us-west-2.amazonaws.com/token');
    });
  });
});
