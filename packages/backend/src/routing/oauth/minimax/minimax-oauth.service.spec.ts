import { ConfigService } from '@nestjs/config';
import { MinimaxOauthService } from './minimax-oauth.service';
import { ProviderService } from '../../routing-core/provider.service';
import { mockSubscriptionCredentialLock } from '../__tests__/mock-subscription-lock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchMock = jest.fn() as jest.Mock<Promise<any>>;
global.fetch = fetchMock;

describe('MinimaxOauthService', () => {
  let service: MinimaxOauthService;
  let providerService: jest.Mocked<ProviderService>;
  let configService: jest.Mocked<ConfigService>;
  let discoveryService: { discoverModels: jest.Mock };
  let dateNowSpy: jest.SpyInstance<number, []>;
  const now = 1_760_000_000_000;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
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

    service = new MinimaxOauthService(providerService, configService, discoveryService as never);
    fetchMock.mockReset();
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe('startAuthorization', () => {
    it('returns device-code payload, normalizes timing fields, and stores a pending flow', async () => {
      fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
        const params = new URLSearchParams(init?.body as string);
        expect(url).toBe('https://api.minimax.io/oauth/code');
        return {
          ok: true,
          json: async () => ({
            user_code: 'ABCD-1234',
            verification_uri: 'https://www.minimax.io/verify',
            expired_in: 60,
            interval: 2,
            state: params.get('state'),
          }),
        };
      });

      const result = await service.startAuthorization('agent-1', 'user-1');

      expect(result.userCode).toBe('ABCD-1234');
      expect(result.verificationUri).toBe('https://www.minimax.io/verify');
      expect(result.expiresAt).toBe(now + 60_000);
      expect(result.pollIntervalMs).toBe(2000);
      expect(service.getPendingCount()).toBe(1);
    });

    it('uses the CN OAuth host when the region is cn', async () => {
      fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
        const params = new URLSearchParams(init?.body as string);
        expect(url).toBe('https://api.minimaxi.com/oauth/code');
        return {
          ok: true,
          json: async () => ({
            user_code: 'ABCD-1234',
            verification_uri: 'https://www.minimax.io/verify',
            expired_in: 60,
            interval: 2,
            state: params.get('state'),
          }),
        };
      });

      await service.startAuthorization('agent-1', 'user-1', 'cn');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('pollAuthorization', () => {
    it('stores MiniMax tokens after approval', async () => {
      fetchMock
        .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
          const params = new URLSearchParams(init?.body as string);
          return {
            ok: true,
            json: async () => ({
              user_code: 'ABCD-1234',
              verification_uri: 'https://www.minimax.io/verify',
              expired_in: 60,
              interval: 2,
              state: params.get('state'),
            }),
          };
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            JSON.stringify({
              status: 'success',
              access_token: 'access-123',
              refresh_token: 'refresh-456',
              expired_in: 3600,
              resource_url: 'https://api.minimax.io/anthropic/v1',
            }),
        });

      const start = await service.startAuthorization('agent-1', 'user-1');
      const result = await service.pollAuthorization(start.flowId, 'user-1');

      expect(result).toEqual({ status: 'success' });
      expect(providerService.upsertProvider).toHaveBeenCalledWith(
        'agent-1',
        'user-1',
        'minimax',
        expect.any(String),
        'subscription',
        undefined,
        undefined,
        null,
      );
      expect(discoveryService.discoverModels).toHaveBeenCalled();
    });

    it('returns pending while approval has not completed', async () => {
      fetchMock
        .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
          const params = new URLSearchParams(init?.body as string);
          return {
            ok: true,
            json: async () => ({
              user_code: 'ABCD-1234',
              verification_uri: 'https://www.minimax.io/verify',
              expired_in: 60,
              interval: 2,
              state: params.get('state'),
            }),
          };
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ status: 'pending' }),
        });

      const start = await service.startAuthorization('agent-1', 'user-1');
      const result = await service.pollAuthorization(start.flowId, 'user-1');

      expect(result.status).toBe('pending');
      expect(providerService.upsertProvider).not.toHaveBeenCalled();
    });
  });

  describe('unwrapToken', () => {
    it('returns null when the stored OAuth blob has invalid field types', async () => {
      const result = await service.unwrapToken(
        JSON.stringify({
          t: 'old-access',
          r: 'old-refresh',
          e: now + 7200,
          u: { host: 'https://api.minimax.io/anthropic/v1' },
        }),
        'agent-1',
        'user-1',
      );

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes expired tokens and preserves resource URL', async () => {
      fetchMock.mockImplementationOnce(async (url: string) => {
        expect(url).toBe('https://api.minimax.io/oauth/token');
        return {
          ok: true,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expired_in: 7200,
          }),
        };
      });

      const result = await service.unwrapToken(
        JSON.stringify({
          t: 'old-access',
          r: 'old-refresh',
          e: Date.now() - 1000,
          u: 'https://api.minimax.io/anthropic/v1',
        }),
        'agent-1',
        'user-1',
      );

      expect(result).toEqual(
        expect.objectContaining({
          t: 'new-access',
          r: 'new-refresh',
          u: 'https://api.minimax.io/anthropic/v1',
        }),
      );
      expect(providerService.upsertProvider).toHaveBeenCalled();
    });

    it('refreshes against the CN OAuth host when the stored resource URL is regional', async () => {
      fetchMock.mockImplementationOnce(async (url: string) => {
        expect(url).toBe('https://api.minimaxi.com/oauth/token');
        return {
          ok: true,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expired_in: 7200,
          }),
        };
      });

      await service.unwrapToken(
        JSON.stringify({
          t: 'old-access',
          r: 'old-refresh',
          e: now - 1000,
          u: 'https://api.minimaxi.com/anthropic',
        }),
        'agent-1',
        'user-1',
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('preserves absolute MiniMax refresh expiry timestamps', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expired_in: now + 7200,
        }),
      });

      const result = await service.refreshAccessToken(
        'refresh-token',
        'https://api.minimax.io/anthropic/v1',
      );

      expect(result.e).toBe(now + 7200);
    });

    it('falls back to the default MiniMax OAuth host when the stored resource URL is invalid', async () => {
      fetchMock.mockImplementationOnce(async (url: string) => {
        expect(url).toBe('https://api.minimax.io/oauth/token');
        return {
          ok: true,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expired_in: 7200,
          }),
        };
      });

      const result = await service.refreshAccessToken(
        'refresh-token',
        'https://evil.example/anthropic',
      );

      expect(result.u).toBe('https://api.minimax.io/anthropic/v1');
    });
  });
});
