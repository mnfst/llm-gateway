import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  getManagedFreeProviderConfig,
  ManagedFreeProviderConfig,
} from '../../common/constants/managed-free-providers';
import { ManagedFreeProviderService } from './managed-free-provider.service';

describe('ManagedFreeProviderService', () => {
  const providerRepo = {
    find: jest.fn(),
  };
  const providerService = {
    upsertProvider: jest.fn(),
  };
  const discoveryService = {
    discoverModels: jest.fn().mockResolvedValue(undefined),
  };

  let service: ManagedFreeProviderService;
  const originalFetch = global.fetch;
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env };
    process.env['CREDITS_MASTER_KEY'] = 'sk-master';
    process.env['CREDITS_BASE_URL'] = 'https://credits.test';
    delete process.env['CREDITS_AUTO_PROVISION_ALLOWLIST'];
    service = new ManagedFreeProviderService(
      providerRepo as never,
      providerService as never,
      discoveryService as never,
    );
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = env;
  });

  it('returns an existing connection without minting', async () => {
    providerRepo.find.mockResolvedValue([{ id: 'conn-1', is_active: true }]);

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).resolves.toEqual({
      connected: true,
      connection_id: 'conn-1',
      source: 'existing',
      auto_available: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves an explicit disconnect without minting a replacement key', async () => {
    providerRepo.find.mockResolvedValue([{ id: 'conn-1', is_active: false }]);

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).resolves.toEqual({
      connected: false,
      connection_id: null,
      source: 'none',
      auto_available: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(providerService.upsertProvider).not.toHaveBeenCalled();
  });

  it('stores a pasted LiteLLM virtual key under Gemini Free', async () => {
    providerRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    providerService.upsertProvider.mockResolvedValue({
      provider: { id: 'conn-2' },
      isNew: true,
    });

    const result = await service.ensureConnection('gemini-free', {
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'a@x.com',
      apiKey: 'sk-virtual',
    });

    expect(result).toMatchObject({ connection_id: 'conn-2', source: 'manual' });
    expect(providerService.upsertProvider).toHaveBeenCalledWith(
      null,
      't1',
      'gemini-free',
      'sk-virtual',
      'api_key',
      undefined,
      undefined,
      'u1',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps a connection when immediate model discovery fails', async () => {
    providerRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    providerService.upsertProvider.mockResolvedValue({
      provider: { id: 'conn-2' },
      isNew: true,
    });
    discoveryService.discoverModels.mockRejectedValueOnce('catalog unavailable');

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
        apiKey: 'sk-virtual',
      }),
    ).resolves.toMatchObject({ connection_id: 'conn-2', source: 'manual' });
  });

  it('mints a virtual key scoped to Gemini models', async () => {
    providerRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ key: 'sk-minted' }),
    });
    providerService.upsertProvider.mockResolvedValue({
      provider: { id: 'conn-3' },
      isNew: true,
    });

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).resolves.toEqual({
      connected: true,
      connection_id: 'conn-3',
      source: 'auto',
      auto_available: true,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://credits.test/key/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-master' }),
        signal: expect.any(AbortSignal),
      }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      models: ['gemini/*'],
      max_budget: 10,
      key_alias: 'gemini-free:t1',
      metadata: {
        source: 'gemini-free',
        tenant_id: 't1',
        user_email: 'a@x.com',
      },
    });
  });

  it('returns none when automatic provisioning is unavailable', async () => {
    delete process.env['CREDITS_MASTER_KEY'];
    providerRepo.find.mockResolvedValue([]);

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).resolves.toEqual({
      connected: false,
      connection_id: null,
      source: 'none',
      auto_available: false,
    });
  });

  it('rejects direct key generation when the master key is missing', async () => {
    delete process.env['CREDITS_MASTER_KEY'];
    const privateService = service as unknown as {
      mintVirtualKey(
        config: ManagedFreeProviderConfig,
        tenantId: string,
        userEmail: string | null,
      ): Promise<string>;
    };

    await expect(
      privateService.mintVirtualKey(getManagedFreeProviderConfig('gemini-free')!, 't1', 'a@x.com'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a concurrent second connection', async () => {
    providerRepo.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'conn-existing', is_active: true }]);

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
        apiKey: 'sk-virtual',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(providerService.upsertProvider).not.toHaveBeenCalled();
  });

  it('rejects failed key generation', async () => {
    providerRepo.find.mockResolvedValue([]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a failed or timed-out key-generation request', async () => {
    providerRepo.find.mockResolvedValue([]);
    (global.fetch as jest.Mock).mockRejectedValue(new Error('request timed out'));

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a key-generation response without a virtual key', async () => {
    providerRepo.find.mockResolvedValue([]);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      service.ensureConnection('gemini-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects provider IDs that are not registered as managed free providers', async () => {
    await expect(
      service.ensureConnection('future-free', {
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'a@x.com',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(providerRepo.find).not.toHaveBeenCalled();
  });
});
