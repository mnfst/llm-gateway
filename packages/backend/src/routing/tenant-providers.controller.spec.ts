import { TenantProvidersController } from './tenant-providers.controller';
import { CredentialHealthService } from './routing-core/credential-health.service';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';
import type { TenantProvider } from '../entities/tenant-provider.entity';

describe('TenantProvidersController', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  const ctx: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'cloud';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  const makeProvider = (id: string, label: string): TenantProvider =>
    ({
      id,
      tenant_id: 'tenant-1',
      created_by_user_id: 'user-1',
      agent_id: null,
      provider: 'openai',
      auth_type: 'api_key',
      label,
      priority: 0,
      api_key_encrypted: 'encrypted-same-key',
      key_prefix: 'sk-test',
      region: null,
      is_active: true,
      connected_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      cached_models: [{ id: 'gpt-4o' }] as never,
      models_fetched_at: '2026-01-01T00:00:00.000Z',
    }) as TenantProvider;

  it('lists multiple provider rows without deleting them', async () => {
    const providerRepo = {
      find: jest
        .fn()
        .mockResolvedValue([
          makeProvider('provider-agent-a', 'Default'),
          makeProvider('provider-agent-b', 'Default [provider-agent-b]'),
        ]),
      delete: jest.fn(),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(providerRepo.find).toHaveBeenCalledWith({ where: { tenant_id: 'tenant-1' } });
    expect(providerRepo.delete).not.toHaveBeenCalled();
    expect(result.providers).toEqual([
      expect.objectContaining({
        provider: 'openai',
        auth_type: 'api_key',
        connection_count: 2,
        connections: [
          expect.objectContaining({ id: 'provider-agent-a', label: 'Default' }),
          expect.objectContaining({
            id: 'provider-agent-b',
            label: 'Default [provider-agent-b]',
          }),
        ],
      }),
    ]);
  });

  it('does not expose usage fields (split out to /providers/usage)', async () => {
    const providerRepo = {
      find: jest.fn().mockResolvedValue([makeProvider('p1', 'Default')]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    // The slim config endpoint must NOT carry any usage stats.
    expect(result.providers[0]).not.toHaveProperty('consumption_tokens');
    expect(result.providers[0]).not.toHaveProperty('consumption_messages');
    expect(result.providers[0]).not.toHaveProperty('consumption_cost');
    expect(result.providers[0]).not.toHaveProperty('last_used_at');
    expect(result.providers[0]).not.toHaveProperty('sparkline_7d');
  });

  it('surfaces a rejected subscription credential as requires_reauth', async () => {
    const providerRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ ...makeProvider('p1', 'Work'), auth_type: 'subscription' }]),
    };
    const health = new CredentialHealthService();
    health.markRejected('p1', 'encrypted-same-key', {
      statusCode: 401,
      reason: 'subscription_token_rejected',
      keyLabel: 'Work',
      provider: 'openai',
    });
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
      health,
    );

    const result = await controller.listProviders(ctx);
    const connection = result.providers[0].connections[0];

    expect(connection).toMatchObject({ id: 'p1', requires_reauth: true });
    expect(connection.last_auth_failure).toMatchObject({ statusCode: 401, keyLabel: 'Work' });
  });

  it('returns empty providers when tenant has none', async () => {
    const providerRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.providers).toEqual([]);
    expect(result.model_counts).toEqual({});
  });

  it('hides legacy built-in local rows in cloud but keeps tunneled custom providers', async () => {
    const providerRepo = {
      find: jest.fn().mockResolvedValue([
        { ...makeProvider('ollama-row', 'Default'), provider: 'ollama', auth_type: 'local' },
        {
          ...makeProvider('tunnel-row', 'Default'),
          provider: 'custom:runtime-id',
          auth_type: 'local',
        },
      ]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([{ id: 'runtime-id', name: 'LM Studio' }]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.providers.map((provider) => provider.provider)).toEqual(['custom:runtime-id']);
  });

  it('returns empty providers when ctx has no tenant (fresh account)', async () => {
    const providerRepo = { find: jest.fn() };
    const customProviderService = { list: jest.fn() };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      customProviderService as never,
    );

    const result = await controller.listProviders({ tenantId: null, userId: 'user-1' });

    expect(providerRepo.find).not.toHaveBeenCalled();
    expect(customProviderService.list).not.toHaveBeenCalled();
    expect(result.providers).toEqual([]);
    expect(result.model_counts).toEqual({});
  });

  it('groups providers by provider+auth_type key', async () => {
    const providerRepo = {
      find: jest.fn().mockResolvedValue([
        {
          ...makeProvider('p1', 'Key1'),
          provider: 'anthropic',
          auth_type: 'api_key',
          cached_models: [],
        },
        {
          ...makeProvider('p2', 'Key2'),
          provider: 'openai',
          auth_type: 'api_key',
          cached_models: [],
        },
        {
          ...makeProvider('p3', 'OpenAI Sub'),
          provider: 'openai',
          auth_type: 'subscription',
          cached_models: [],
        },
      ]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.providers).toHaveLength(3);
    expect(
      result.providers.map(
        (p: { provider: string; auth_type: string }) => `${p.provider}::${p.auth_type}`,
      ),
    ).toEqual(
      expect.arrayContaining(['anthropic::api_key', 'openai::api_key', 'openai::subscription']),
    );
  });

  it('reports total_models as the max cached_models length across keys in a group', async () => {
    const providerRepo = {
      find: jest.fn().mockResolvedValue([
        { ...makeProvider('p1', 'Default'), cached_models: [{ id: 'a' }] as never },
        {
          ...makeProvider('p2', 'Second'),
          cached_models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
        },
      ]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.providers[0].total_models).toBe(3);
    expect(result.providers[0].connection_count).toBe(2);
  });

  it('treats a non-array cached_models as zero models', async () => {
    const providerRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ ...makeProvider('p1', 'Default'), cached_models: null as never }]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.providers[0].total_models).toBe(0);
    expect(result.providers[0].connections[0].cached_model_count).toBe(0);
  });

  it('returns model_counts from pricing cache', async () => {
    const providerRepo = { find: jest.fn().mockResolvedValue([]) };
    const controller = new TenantProvidersController(
      providerRepo as never,
      {
        getAll: jest.fn().mockReturnValue([
          { provider: 'OpenAI', model_name: 'gpt-4o' },
          { provider: 'OpenAI', model_name: 'gpt-4o-mini' },
          { provider: 'Anthropic', model_name: 'claude-3-5-sonnet' },
          // Pricing rows with no provider are skipped.
          { provider: null, model_name: 'mystery' },
        ]),
      } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(result.model_counts).toEqual({ openai: 2, anthropic: 1 });
  });

  it('resolves display_name for custom provider groups', async () => {
    const providerRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ ...makeProvider('p1', 'Default'), provider: 'custom:u-9' }]),
    };
    const customProviderService = {
      list: jest.fn().mockResolvedValue([{ id: 'u-9', name: 'MyLLM' }]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      customProviderService as never,
    );

    const result = await controller.listProviders(ctx);

    expect(customProviderService.list).toHaveBeenCalledWith('tenant-1');
    expect(result.providers[0]).toMatchObject({
      provider: 'custom:u-9',
      display_name: 'MyLLM',
    });
  });

  it('returns null display_name for built-in groups and deleted custom providers', async () => {
    const providerRepo = {
      find: jest
        .fn()
        .mockResolvedValue([
          makeProvider('p1', 'Default'),
          { ...makeProvider('p2', 'Gone'), provider: 'custom:gone' },
        ]),
    };
    const controller = new TenantProvidersController(
      providerRepo as never,
      { getAll: jest.fn().mockReturnValue([]) } as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
    );

    const result = await controller.listProviders(ctx);

    expect(
      result.providers.find((p: { provider: string }) => p.provider === 'openai')!.display_name,
    ).toBeNull();
    expect(
      result.providers.find((p: { provider: string }) => p.provider === 'custom:gone')!
        .display_name,
    ).toBeNull();
  });
});
