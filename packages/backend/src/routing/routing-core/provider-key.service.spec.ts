import { ProviderKeyService, SYNTHETIC_OLLAMA_PROVIDER_ID } from './provider-key.service';
import { CredentialHealthService } from './credential-health.service';
import type { CachedProviderKey } from './routing-cache.service';
import type { Repository } from 'typeorm';
import { encrypt } from '../../common/utils/crypto.util';
import type { TenantProvider } from '../../entities/tenant-provider.entity';
import type { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';

// getEncryptionSecret() falls back to BETTER_AUTH_SECRET; set it so the
// per-agent filter tests can produce real ciphertext that decryptOne resolves.
process.env['BETTER_AUTH_SECRET'] = 'a'.repeat(64);

/**
 * Focused unit coverage for the key-selection projections. The proxy specs
 * mock ProviderKeyService wholesale, so these are the only place the real
 * selectProviderKey / getProviderKeyId / wrapper bodies run. getProviderKeys is
 * spied so the selection logic is exercised without the DB/decryption path.
 */
describe('ProviderKeyService — selection projections', () => {
  let svc: ProviderKeyService;

  beforeEach(() => {
    svc = new ProviderKeyService(
      {} as never, // providerRepo
      {} as never, // pricingCache
      {} as never, // discoveryService
      {} as never, // routingCache
      {} as never, // providerService
      null, // accessRepo (optional)
    );
  });

  const key = (over: Partial<CachedProviderKey>): CachedProviderKey => ({
    id: 'up-1',
    label: 'Default',
    priority: 0,
    apiKey: 'sk',
    region: null,
    ...over,
  });

  describe('selectProviderKey', () => {
    it('returns null when no keys resolve', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([]);
      expect(await svc.selectProviderKey('u', 'openai', 'api_key')).toBeNull();
    });

    it('matches the requested label case-insensitively', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([
          key({ id: 'up-default', label: 'Default' }),
          key({ id: 'up-work', label: 'Work' }),
        ]);
      const sel = await svc.selectProviderKey('u', 'openai', 'api_key', 'work');
      expect(sel?.id).toBe('up-work');
    });

    it('falls back to the first key when the label does not match', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([key({ id: 'up-default', label: 'Default' })]);
      const sel = await svc.selectProviderKey('u', 'openai', 'api_key', 'nonexistent');
      expect(sel?.id).toBe('up-default');
    });

    // Serving the default key silently bills a connection the operator never
    // chose. The fallback stays (traffic keeps flowing) but it must be visible.
    it('warns when a supplied label matches no connection', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([key({ id: 'up-default', label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      await svc.selectProviderKey('u', 'openai', 'api_key', 'Retired');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Retired"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Default"'));
    });

    it('throttles repeated warnings for the same stale pin', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      await svc.selectProviderKey('u', 'openai', 'api_key', 'Retired', 'agent-1');
      await svc.selectProviderKey('u', 'openai', 'api_key', 'Retired', 'agent-1');

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns again after the stale-pin throttle window', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValueOnce(1_000).mockReturnValueOnce(61_000);

      await svc.selectProviderKey('u', 'openai', 'api_key', 'Retired', 'agent-1');
      await svc.selectProviderKey('u', 'openai', 'api_key', 'Retired', 'agent-1');

      expect(warn).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });

    it('bounds stale-pin warning keys', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined as unknown as void);

      for (let i = 0; i < 257; i++) {
        await svc.selectProviderKey('u', 'openai', 'api_key', `Retired-${i}`, 'agent-1');
      }

      expect(svc['stalePinWarnings'].size).toBe(256);
      expect(svc['stalePinWarnings'].has('u\0agent-1\0openai\0api_key\0retired-0')).toBe(false);
    });

    it('names the auth type as "any" in the warning when none was requested', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      await svc.selectProviderKey('u', 'openai', undefined, 'Retired');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('authType=any'));
    });

    it('sanitizes a label that carries control characters into the log line', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      // A newline in a user-authored label would otherwise forge a log line.
      await svc.selectProviderKey('u', 'openai', 'api_key', 'Work\nWARN fake entry');

      const line = warn.mock.calls[0][0] as string;
      expect(line).not.toContain('\n');
      expect(line).toContain('Work WARN fake entry');
    });

    it('truncates an over-long label in the log line', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ label: 'Default' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      await svc.selectProviderKey('u', 'openai', 'api_key', 'L'.repeat(200));

      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain(`${'L'.repeat(64)}…`);
      expect(line).not.toContain('L'.repeat(65));
    });

    it('does not warn when the label matches', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([key({ id: 'up-default' }), key({ id: 'up-work', label: 'Work' })]);
      const warn = jest
        .spyOn(svc['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      await svc.selectProviderKey('u', 'openai', 'api_key', 'Work');

      expect(warn).not.toHaveBeenCalled();
    });

    it('returns the first key when no label is given', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([key({ id: 'up-default' }), key({ id: 'up-2', label: 'Two' })]);
      const sel = await svc.selectProviderKey('u', 'openai', 'api_key');
      expect(sel?.id).toBe('up-default');
    });

    // A credential an upstream rejected must be skipped so the next request does
    // not keep hammering the dead connection before falling back (issue #2883).
    describe('rejected-credential skipping', () => {
      const withHealth = () => {
        const health = new CredentialHealthService();
        svc = new ProviderKeyService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          null,
          health,
        );
        return health;
      };

      it('prefers a healthy sibling over a rejected default key', async () => {
        const health = withHealth();
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([
            key({ id: 'up-dead', label: 'Dead', apiKey: 'sk-dead' }),
            key({ id: 'up-live', label: 'Live', apiKey: 'sk-live' }),
          ]);
        health.markRejected('up-dead', 'sk-dead', {
          statusCode: 401,
          reason: 'api_key_rejected',
        });

        expect((await svc.selectProviderKey('u', 'openai', 'api_key'))?.id).toBe('up-live');
      });

      it('substitutes a healthy key when the pinned key is rejected', async () => {
        const health = withHealth();
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([
            key({ id: 'up-dead', label: 'Work', apiKey: 'sk-dead' }),
            key({ id: 'up-live', label: 'Personal', apiKey: 'sk-live' }),
          ]);
        health.markRejected('up-dead', 'sk-dead', {
          statusCode: 401,
          reason: 'subscription_token_rejected',
        });
        const warn = jest
          .spyOn(svc['logger'], 'warn')
          .mockImplementation(() => undefined as unknown as void);

        expect((await svc.selectProviderKey('u', 'openai', 'subscription', 'Work'))?.id).toBe(
          'up-live',
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-authenticated'));
      });

      it('warns with "any" auth type when the request omits it', async () => {
        const health = withHealth();
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([
            key({ id: 'up-dead', label: 'Work', apiKey: 'sk-dead' }),
            key({ id: 'up-live', label: 'Personal', apiKey: 'sk-live' }),
          ]);
        health.markRejected('up-dead', 'sk-dead', { statusCode: 401, reason: 'api_key_rejected' });
        const warn = jest
          .spyOn(svc['logger'], 'warn')
          .mockImplementation(() => undefined as unknown as void);

        expect((await svc.selectProviderKey('u', 'openai', undefined, 'Work'))?.id).toBe('up-live');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('authType=any'));
      });

      it('throttles the skipped warning within the window and warns again after it', async () => {
        const health = withHealth();
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([
            key({ id: 'up-dead', label: 'Work', apiKey: 'sk-dead' }),
            key({ id: 'up-live', label: 'Personal', apiKey: 'sk-live' }),
          ]);
        health.markRejected('up-dead', 'sk-dead', {
          statusCode: 401,
          reason: 'api_key_rejected',
          at: 1,
        });
        const warn = jest
          .spyOn(svc['logger'], 'warn')
          .mockImplementation(() => undefined as unknown as void);
        const now = jest
          .spyOn(Date, 'now')
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(2_000)
          .mockReturnValueOnce(90_000);

        await svc.selectProviderKey('u', 'openai', 'api_key', 'Work');
        await svc.selectProviderKey('u', 'openai', 'api_key', 'Work');
        await svc.selectProviderKey('u', 'openai', 'api_key', 'Work');

        // Warned on the first and third call; the middle call is throttled.
        expect(warn).toHaveBeenCalledTimes(2);
        now.mockRestore();
      });

      it('still returns the rejected key when every key is rejected', async () => {
        const health = withHealth();
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([key({ id: 'up-dead', label: 'Dead', apiKey: 'sk-dead' })]);
        health.markRejected('up-dead', 'sk-dead', {
          statusCode: 401,
          reason: 'subscription_token_rejected',
        });

        // The proxy short-circuits this with a reauth error; reporting
        // "no provider key" here would hide that a connection exists.
        expect((await svc.selectProviderKey('u', 'openai', 'subscription'))?.id).toBe('up-dead');
      });

      it('resumes using a connection once its credential is rotated (re-auth)', async () => {
        const health = withHealth();
        const oldBlob = JSON.stringify({ t: 'a', r: 'refresh-old', e: 1 });
        const newBlob = JSON.stringify({ t: 'a2', r: 'refresh-new', e: 1 });
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([key({ id: 'up-work', label: 'Work', apiKey: oldBlob })]);
        health.markRejected('up-work', oldBlob, {
          statusCode: 401,
          reason: 'subscription_token_rejected',
        });

        // Re-auth rewrote up-work's stored credential.
        jest
          .spyOn(svc, 'getProviderKeys')
          .mockResolvedValue([key({ id: 'up-work', label: 'Work', apiKey: newBlob })]);

        expect((await svc.selectProviderKey('u', 'openai', 'subscription'))?.id).toBe('up-work');
      });

      it('bounds the skipped-unhealthy warning keys', async () => {
        const health = withHealth();
        jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined as unknown as void);

        for (let i = 0; i < 257; i++) {
          jest
            .spyOn(svc, 'getProviderKeys')
            .mockResolvedValue([
              key({ id: `up-${i}`, label: `Dead-${i}`, apiKey: `sk-${i}` }),
              key({ id: 'up-live', label: 'Live', apiKey: 'sk-live' }),
            ]);
          health.markRejected(`up-${i}`, `sk-${i}`, {
            statusCode: 401,
            reason: 'api_key_rejected',
          });
          await svc.selectProviderKey('u', 'openai', 'api_key', `Dead-${i}`, 'agent-1');
        }

        expect(svc['stalePinWarnings'].size).toBe(256);
      });
    });
  });

  describe('getProviderKeyId', () => {
    it('returns the selected key id', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ id: 'up-7' })]);
      expect(await svc.getProviderKeyId('u', 'openai', 'api_key')).toBe('up-7');
    });

    it('returns null for the synthetic Ollama key (no persisted row → would break the FK)', async () => {
      jest
        .spyOn(svc, 'getProviderKeys')
        .mockResolvedValue([key({ id: SYNTHETIC_OLLAMA_PROVIDER_ID, apiKey: '' })]);
      expect(await svc.getProviderKeyId('u', 'ollama', 'local')).toBeNull();
    });

    it('returns null when no key resolves', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([]);
      expect(await svc.getProviderKeyId('u', 'openai', 'api_key')).toBeNull();
    });
  });

  describe('getProviderApiKey / getProviderRegion projections', () => {
    it('getProviderApiKey returns the selected key apiKey', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ apiKey: 'sk-x' })]);
      expect(await svc.getProviderApiKey('u', 'openai', 'api_key')).toBe('sk-x');
    });

    it('getProviderApiKey returns null when no key resolves', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([]);
      expect(await svc.getProviderApiKey('u', 'openai', 'api_key')).toBeNull();
    });

    it('getProviderRegion returns the selected key region', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([key({ region: 'eu-west' })]);
      expect(await svc.getProviderRegion('u', 'openai', 'api_key')).toBe('eu-west');
    });

    it('getProviderRegion returns null when no key resolves', async () => {
      jest.spyOn(svc, 'getProviderKeys').mockResolvedValue([]);
      expect(await svc.getProviderRegion('u', 'openai', 'api_key')).toBeNull();
    });
  });
});

/**
 * Per-agent provider-visibility gate on the proxy hot path. The existing specs
 * above construct ProviderKeyService WITHOUT an enabledProviderRepo, so every
 * call hits the `enabledProviderRepo == null` short-circuit in
 * filterProvidersForAgent and the real per-agent filter never runs. These tests
 * build the service WITH a mocked enabledProviderRepo and drive the real filter
 * through getProviderKeys → resolveProviderKeys → filterProvidersForAgent so a
 * dropped `enabledIds.has(p.id)` check fails loudly.
 */
describe('ProviderKeyService — filterProvidersForAgent (per-agent visibility)', () => {
  const SECRET = process.env['BETTER_AUTH_SECRET'] as string;

  const tenantProvider = (over: Partial<TenantProvider>): TenantProvider =>
    ({
      id: 'tp-1',
      tenant_id: 'tenant-1',
      created_by_user_id: null,
      agent_id: null,
      provider: 'openai',
      // Real ciphertext so the private decryptOne path resolves to a key without
      // mocking crypto — exercises the full resolve→decrypt→filter chain.
      api_key_encrypted: encrypt('sk-real', SECRET),
      key_prefix: null,
      auth_type: 'api_key',
      label: 'Default',
      priority: 0,
      region: null,
      is_active: true,
      connected_at: '',
      updated_at: '',
      cached_models: null,
      models_fetched_at: null,
      ...over,
    }) as TenantProvider;

  const enabledRow = (tenantProviderId: string): AgentEnabledProvider =>
    ({ agent_id: 'agent-1', tenant_provider_id: tenantProviderId }) as AgentEnabledProvider;

  // providerRepo.find returns the tenant-global rows; routingCache always misses
  // so resolveProviderKeys runs; enabledProviderRepo.find returns the agent's
  // enabled junction rows.
  const buildService = (opts: {
    tenantProviders: TenantProvider[];
    enabledRows: AgentEnabledProvider[];
    enabledRepo?: Pick<Repository<AgentEnabledProvider>, 'find'> | null;
  }): {
    svc: ProviderKeyService;
    enabledFind: jest.Mock;
    setProviderKeys: jest.Mock;
  } => {
    const providerRepo = { find: jest.fn().mockResolvedValue(opts.tenantProviders) };
    const setProviderKeys = jest.fn();
    const routingCache = {
      getProviderKeys: jest.fn().mockReturnValue(undefined),
      setProviderKeys,
    };
    const enabledFind = jest.fn().mockResolvedValue(opts.enabledRows);
    const enabledRepo = opts.enabledRepo === undefined ? { find: enabledFind } : opts.enabledRepo;

    const svc = new ProviderKeyService(
      providerRepo as never, // providerRepo
      {} as never, // pricingCache
      {} as never, // discoveryService
      routingCache as never, // routingCache
      {} as never, // providerService
      enabledRepo as never, // enabledProviderRepo
    );
    return { svc, enabledFind, setProviderKeys };
  };

  it('returns [] when the agent has no enabled-provider rows (empty gate)', async () => {
    const { svc, enabledFind } = buildService({
      tenantProviders: [tenantProvider({ id: 'tp-openai', provider: 'openai' })],
      enabledRows: [], // agent has enabled nothing → see nothing
    });

    const keys = await svc.getProviderKeys('tenant-1', 'openai', undefined, 'agent-1');

    expect(keys).toEqual([]);
    expect(enabledFind).toHaveBeenCalledWith({ where: { agent_id: 'agent-1' } });
  });

  it('returns only the provider the agent has enabled when 1 of 2 tenant providers is allowed', async () => {
    // Two tenant-global openai keys; the agent's junction enables only tp-b.
    const { svc } = buildService({
      tenantProviders: [
        tenantProvider({
          id: 'tp-a',
          label: 'Personal',
          api_key_encrypted: encrypt('sk-a', SECRET),
        }),
        tenantProvider({ id: 'tp-b', label: 'Work', api_key_encrypted: encrypt('sk-b', SECRET) }),
      ],
      enabledRows: [enabledRow('tp-b')],
    });

    const keys = await svc.getProviderKeys('tenant-1', 'openai', undefined, 'agent-1');

    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe('tp-b');
    expect(keys[0].label).toBe('Work');
    expect(keys[0].apiKey).toBe('sk-b');
  });

  it('keeps multiple providers when several are enabled for the agent', async () => {
    const { svc } = buildService({
      tenantProviders: [
        tenantProvider({
          id: 'tp-a',
          label: 'Personal',
          api_key_encrypted: encrypt('sk-a', SECRET),
        }),
        tenantProvider({ id: 'tp-b', label: 'Work', api_key_encrypted: encrypt('sk-b', SECRET) }),
      ],
      enabledRows: [enabledRow('tp-a'), enabledRow('tp-b')],
    });

    const keys = await svc.getProviderKeys('tenant-1', 'openai', undefined, 'agent-1');

    expect(keys.map((k) => k.id).sort()).toEqual(['tp-a', 'tp-b']);
  });

  it('falls back to all providers (no per-agent filter) when no agentId is passed', async () => {
    // agentId undefined → filterProvidersForAgent short-circuits BEFORE touching
    // the repo, so even with an enabledProviderRepo present every key is returned.
    const { svc, enabledFind } = buildService({
      tenantProviders: [
        tenantProvider({
          id: 'tp-a',
          label: 'Personal',
          api_key_encrypted: encrypt('sk-a', SECRET),
        }),
        tenantProvider({ id: 'tp-b', label: 'Work', api_key_encrypted: encrypt('sk-b', SECRET) }),
      ],
      enabledRows: [],
    });

    const keys = await svc.getProviderKeys('tenant-1', 'openai'); // no agentId

    expect(keys.map((k) => k.id).sort()).toEqual(['tp-a', 'tp-b']);
    expect(enabledFind).not.toHaveBeenCalled();
  });

  it('null-repo short-circuit still returns all tenant providers even with an agentId', async () => {
    // The legacy/self-hosted path: enabledProviderRepo is null, so the agent
    // scope is a no-op and every provider stays visible.
    const { svc } = buildService({
      tenantProviders: [
        tenantProvider({
          id: 'tp-a',
          label: 'Personal',
          api_key_encrypted: encrypt('sk-a', SECRET),
        }),
        tenantProvider({ id: 'tp-b', label: 'Work', api_key_encrypted: encrypt('sk-b', SECRET) }),
      ],
      enabledRows: [],
      enabledRepo: null,
    });

    const keys = await svc.getProviderKeys('tenant-1', 'openai', undefined, 'agent-1');

    expect(keys.map((k) => k.id).sort()).toEqual(['tp-a', 'tp-b']);
  });
});
