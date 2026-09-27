import { ManagedFreeProviderController } from './managed-free-provider.controller';

describe('ManagedFreeProviderController', () => {
  const managedFreeProvider = {
    ensureConnection: jest.fn(),
  };
  const tenantCache = {
    ensureForUser: jest.fn(),
  };
  let controller: ManagedFreeProviderController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new ManagedFreeProviderController(
      managedFreeProvider as never,
      tenantCache as never,
    );
  });

  it('uses the authenticated tenant context', async () => {
    const expected = {
      connected: true,
      connection_id: 'conn-1',
      source: 'existing',
      auto_available: true,
    };
    managedFreeProvider.ensureConnection.mockResolvedValue(expected);

    await expect(
      controller.ensure(
        'gemini-free',
        { tenantId: 'tenant-1', userId: 'user-1' },
        { id: 'user-1', email: 'user@example.com' },
        { apiKey: 'sk-virtual' },
      ),
    ).resolves.toBe(expected);
    expect(tenantCache.ensureForUser).not.toHaveBeenCalled();
    expect(managedFreeProvider.ensureConnection).toHaveBeenCalledWith('gemini-free', {
      tenantId: 'tenant-1',
      userId: 'user-1',
      userEmail: 'user@example.com',
      apiKey: 'sk-virtual',
    });
  });

  it('creates a tenant lazily for an authenticated user', async () => {
    tenantCache.ensureForUser.mockResolvedValue('tenant-created');
    managedFreeProvider.ensureConnection.mockResolvedValue({ connected: false });

    await controller.ensure(
      'gemini-free',
      { tenantId: null, userId: null },
      { id: 'user-1', email: 'user@example.com' },
      {},
    );

    expect(tenantCache.ensureForUser).toHaveBeenCalledWith('user-1');
    expect(managedFreeProvider.ensureConnection).toHaveBeenCalledWith('gemini-free', {
      tenantId: 'tenant-created',
      userId: 'user-1',
      userEmail: 'user@example.com',
      apiKey: undefined,
    });
  });

  it('returns unavailable when no tenant can be resolved', async () => {
    await expect(
      controller.ensure('gemini-free', { tenantId: null, userId: null }, {}, undefined as never),
    ).resolves.toEqual({
      connected: false,
      connection_id: null,
      source: 'none',
      auto_available: false,
    });
    expect(managedFreeProvider.ensureConnection).not.toHaveBeenCalled();
  });
});
