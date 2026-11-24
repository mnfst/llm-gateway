import { McpServer } from '@modelcontextprotocol/server';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { registerAgentTools } from './agents.tools';
import { registerEnvironmentTools, registerGuideTool } from './environment.tools';
import { registerIdentityTools } from './identity.tools';
import { registerModelTools } from './models.tools';
import { registerProviderTools } from './providers.tools';
import { registerRequestTools } from './requests.tools';
import { registerRoutingTools } from './routing.tools';

// The tool files read the server origin from the auth instance, which is
// ESM-only and cannot be required by Jest on Node 22. The origin is all they use.
jest.mock('../../auth/auth.instance', () => ({ authOrigin: 'http://localhost:3001' }));

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;

function capture(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const TENANT = 'tenant-1';
const AGENT = { id: 'agent-1', tenant_id: TENANT, name: 'demo', autofix_enabled: null };
const CONNECTION = {
  id: 'conn-1',
  provider: 'openai',
  auth_type: 'api_key',
  label: 'default',
  priority: 0,
  region: null,
  is_active: true,
  key_prefix: 'sk-',
  cached_models: [{ id: 'gpt-4o' }],
  models_fetched_at: '2026-01-01',
  connected_at: '2026-01-01',
  tenant_id: TENANT,
};

function makeDeps(): McpToolDeps {
  const chainable = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  return {
    dataSource: {} as never,
    tenantCache: {} as never,
    cacheManager: { del: jest.fn().mockResolvedValue(undefined) } as never,
    agentListCache: { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    eventBus: { emit: jest.fn() } as never,
    recording: { isRecording: jest.fn().mockResolvedValue(true) } as never,
    timeseries: {
      getAgentList: jest.fn().mockResolvedValue([{ agent_name: 'demo', sparkline: [1, 2] }]),
    } as never,
    lifecycle: {
      findAgentInfo: jest.fn().mockResolvedValue({
        agent_name: 'demo',
        display_name: 'Demo',
        agent_category: 'coding',
        agent_platform: 'codex',
      }),
      renameAgent: jest.fn().mockResolvedValue(undefined),
      updateAgentType: jest.fn().mockResolvedValue(undefined),
      deleteAgent: jest.fn().mockResolvedValue(undefined),
    } as never,
    apiKeys: {
      onboardAgent: jest
        .fn()
        .mockResolvedValue({ tenantId: TENANT, agentId: 'agent-1', apiKey: 'k' }),
      getKeyForAgent: jest.fn().mockResolvedValue({ keyPrefix: 'p', fullKey: 'full' }),
      rotateKey: jest.fn().mockResolvedValue({ apiKey: 'r' }),
    } as never,
    autofixStats: { recordAutofixConsent: jest.fn().mockResolvedValue(undefined) } as never,
    messages: {
      getMessages: jest
        .fn()
        .mockResolvedValue({ items: [{ id: 'm' }], next_cursor: 'c', total_count: 1 }),
    } as never,
    providers: {
      getProviders: jest.fn().mockResolvedValue([CONNECTION]),
      enableAllProvidersForAgent: jest.fn().mockResolvedValue(undefined),
      upsertProvider: jest.fn().mockResolvedValue({ provider: CONNECTION, isNew: true }),
      removeProvider: jest.fn().mockResolvedValue({ notifications: ['n'] }),
      recalculateTiers: jest.fn().mockResolvedValue(undefined),
    } as never,
    tiers: {
      getTiers: jest.fn().mockResolvedValue([
        {
          tier: 'default',
          override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
          fallback_routes: [],
        },
      ]),
      hasRoutableTier: jest.fn().mockResolvedValue(true),
      getFallbacks: jest.fn().mockResolvedValue([]),
      setFallbacks: jest.fn().mockResolvedValue([]),
      clearFallbacks: jest.fn().mockResolvedValue(undefined),
      setOverride: jest.fn().mockResolvedValue({}),
    } as never,
    specificity: { getAssignments: jest.fn().mockResolvedValue([]) } as never,
    resolveAgent: {
      resolve: jest.fn().mockResolvedValue(AGENT),
      invalidate: jest.fn(),
    } as never,
    headerTiers: {
      list: jest.fn().mockResolvedValue([{ id: 'h1', name: 'tier' }]),
      create: jest.fn().mockResolvedValue({ id: 'h1', name: 'tier' }),
      setOverride: jest.fn().mockResolvedValue({}),
      setFallbacks: jest.fn().mockResolvedValue([]),
      clearFallbacks: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as never,
    customProviders: {
      list: jest
        .fn()
        .mockResolvedValue([{ id: 'c1', name: 'cp', alias: 'cp', base_url: 'http://x' }]),
      create: jest.fn().mockResolvedValue({ id: 'c1', name: 'cp', alias: 'cp' }),
      remove: jest.fn().mockResolvedValue(undefined),
      probeModels: jest.fn().mockResolvedValue([{ model_name: 'm' }]),
    } as never,
    autofix: { resolveEnabled: jest.fn().mockReturnValue(true) } as never,
    routeModelParams: {
      get: jest.fn().mockResolvedValue({ tier: 'default', params: [] }),
      update: jest.fn().mockResolvedValue({ tier: 'default', params: [] }),
    } as never,
    modelDiscovery: {
      getModelsForAgent: jest
        .fn()
        .mockResolvedValue([
          { id: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', authType: 'api_key' },
        ]),
      discoverModels: jest.fn().mockResolvedValue(undefined),
      refreshProvider: jest.fn().mockResolvedValue({ ok: true, model_count: 1 }),
      discoverAllForAgent: jest.fn().mockResolvedValue(undefined),
    } as never,
    pricingSync: {
      getAll: jest.fn().mockReturnValue(new Map([['gpt-4o', { input: 1, output: 2 }]])),
    } as never,
    modelPrices: {
      getAll: jest.fn().mockReturnValue({
        models: [
          {
            model_name: 'gpt-4o',
            provider: 'OpenAI',
            input_price_per_million: 1,
            output_price_per_million: 2,
            display_name: 'GPT-4o',
            validated: true,
          },
        ],
        lastSyncedAt: null,
      }),
    } as never,
    tenantProviderRepo: {} as never,
    agentEnabledProviderRepo: {
      createQueryBuilder: jest.fn().mockReturnValue(chainable),
      delete: jest.fn().mockResolvedValue(undefined),
    } as never,
    agentRepo: { update: jest.fn().mockResolvedValue(undefined) } as never,
  };
}

const OPERATOR: McpOperator = {
  userId: 'user-1',
  tenantId: TENANT,
  scopes: new Set(['mcp:read', 'mcp:write']),
};

function parse(res: unknown): { data?: unknown; error?: boolean; text: string } {
  const r = res as { content?: { text: string }[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { data, error: r.isError === true, text };
}

function registerAll(deps: McpToolDeps, operator = OPERATOR) {
  const { server, tools } = capture();
  registerIdentityTools(server, deps, operator);
  registerAgentTools(server, deps, operator);
  registerEnvironmentTools(server, deps, operator);
  registerProviderTools(server, deps, operator);
  registerRoutingTools(server, deps, operator);
  registerModelTools(server, deps, operator);
  registerRequestTools(server, deps, operator);
  registerGuideTool(server);
  return tools;
}

async function call(tools: Map<string, Handler>, name: string, args: Record<string, unknown> = {}) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`no tool ${name}`);
  return parse(await handler(args));
}

describe('MCP tools', () => {
  describe('agent tools', () => {
    it('lists agents and strips the sparkline', async () => {
      const tools = registerAll(makeDeps());
      const { data } = await call(tools, 'manifest_agent_list', { include_playground: true });
      expect((data as { agents: Record<string, unknown>[] }).agents[0]).not.toHaveProperty(
        'sparkline',
      );
    });

    it('gets one agent', async () => {
      const { data } = await call(registerAll(makeDeps()), 'manifest_agent_get', { agent: 'demo' });
      expect(data).toMatchObject({ agent: { agent_name: 'demo' } });
    });

    it('lists platforms', async () => {
      const { data } = await call(registerAll(makeDeps()), 'manifest_agent_platforms');
      expect((data as { platforms: string[] }).platforms.length).toBeGreaterThan(0);
    });

    it('creates an agent and returns the key', async () => {
      const { data } = await call(registerAll(makeDeps()), 'manifest_agent_create', {
        name: 'My Agent',
        agent_platform: 'codex',
        agent_category: 'automation',
        autofix_enabled: true,
      });
      expect(data).toMatchObject({ agent: { name: 'my-agent' }, apiKey: 'k' });
    });

    it('rejects a reserved name and an empty slug', async () => {
      const tools = registerAll(makeDeps());
      expect((await call(tools, 'manifest_agent_create', { name: 'Playground' })).error).toBe(true);
      expect((await call(tools, 'manifest_agent_create', { name: '!!!' })).error).toBe(true);
    });

    it('rolls back the agent when provider enablement fails, and survives a failed rollback', async () => {
      const deps = makeDeps();
      (deps.providers.enableAllProvidersForAgent as jest.Mock).mockRejectedValueOnce(
        new Error('boom'),
      );
      const first = await call(registerAll(deps), 'manifest_agent_create', { name: 'A' });
      expect(first.error).toBe(true);

      const deps2 = makeDeps();
      (deps2.providers.enableAllProvidersForAgent as jest.Mock).mockRejectedValueOnce(
        new Error('boom'),
      );
      (deps2.lifecycle.deleteAgent as jest.Mock).mockRejectedValueOnce(new Error('cleanup'));
      expect((await call(registerAll(deps2), 'manifest_agent_create', { name: 'B' })).error).toBe(
        true,
      );
    });

    it('renames / retypes and rejects the reserved slug', async () => {
      const tools = registerAll(makeDeps());
      const ok = await call(tools, 'manifest_agent_update', {
        agent: 'demo',
        name: 'Renamed',
        agent_category: 'coding',
        agent_platform: 'openai-sdk',
      });
      expect(ok.error).toBeFalsy();
      expect(
        (await call(tools, 'manifest_agent_update', { agent: 'demo', name: 'Playground' })).error,
      ).toBe(true);
    });

    it('deletes, rotates, and shows a key', async () => {
      const deps = makeDeps();
      const tools = registerAll(deps);
      expect((await call(tools, 'manifest_agent_delete', { agent: 'demo' })).error).toBeFalsy();
      expect((await call(tools, 'manifest_agent_rotate_key', { agent: 'demo' })).error).toBeFalsy();
      const show = await call(tools, 'manifest_agent_key_show', { agent: 'demo' });
      expect(show.data).toMatchObject({ apiKey: 'full' });
      (deps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValueOnce(null);
      expect((await call(tools, 'manifest_agent_key_show', { agent: 'x' })).error).toBe(true);
      (deps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValueOnce(null);
      expect((await call(tools, 'manifest_agent_rotate_key', { agent: 'x' })).error).toBe(true);
    });

    it('hides write tools from a read-only token', () => {
      const tools = registerAll(makeDeps(), { ...OPERATOR, scopes: new Set(['mcp:read']) });
      expect(tools.has('manifest_agent_list')).toBe(true);
      expect(tools.has('manifest_agent_create')).toBe(false);
    });
  });

  describe('provider tools', () => {
    it('lists connections and custom providers', async () => {
      const { data } = await call(registerAll(makeDeps()), 'manifest_provider_list');
      expect(data).toMatchObject({ connections: [{ cached_model_count: 1 }] });
    });

    it('counts a custom connection by the models entered on its custom provider', async () => {
      const deps = makeDeps();
      (deps.providers.getProviders as jest.Mock).mockResolvedValue([
        CONNECTION,
        { ...CONNECTION, id: 'conn-2', provider: 'custom:c1', cached_models: null },
      ]);
      (deps.customProviders.list as jest.Mock).mockResolvedValue([
        {
          id: 'c1',
          name: 'cp',
          alias: 'cp',
          base_url: 'http://x',
          models: [{ model_name: 'a' }, { model_name: 'b' }],
        },
        { id: 'c2', name: 'empty', alias: 'empty', base_url: 'http://y', models: null },
      ]);
      const tools = registerAll(deps);

      const { data } = await call(tools, 'manifest_provider_list');
      expect(data).toMatchObject({
        connections: [{ cached_model_count: 1 }, { cached_model_count: 2 }],
        custom_providers: [{ model_count: 2 }, { model_count: 0 }],
      });

      const refreshed = await call(tools, 'manifest_provider_refresh', { agent: 'demo' });
      expect(refreshed.data).toMatchObject({
        connections: [{ cached_model_count: 1 }, { cached_model_count: 2 }],
      });
    });

    it('counts a connection with no discovery cache as empty', async () => {
      const deps = makeDeps();
      (deps.providers.getProviders as jest.Mock).mockResolvedValue([
        { ...CONNECTION, cached_models: null },
      ]);
      const { data } = await call(registerAll(deps), 'manifest_provider_list');
      expect(data).toMatchObject({ connections: [{ cached_model_count: 0 }] });
    });

    it('returns the catalog', async () => {
      const { data } = await call(registerAll(makeDeps()), 'manifest_provider_catalog');
      expect((data as { providers: unknown[] }).providers.length).toBeGreaterThan(0);
    });

    it('connects a known provider and rejects an unknown one', async () => {
      const tools = registerAll(makeDeps());
      expect(
        (await call(tools, 'manifest_provider_connect', { provider: 'openai', agent: 'demo' }))
          .error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_provider_connect', { provider: 'nope', agent: 'demo' })).error,
      ).toBe(true);
      // Local-only providers are rejected outside self-hosted installs. Pin the
      // deployment mode so a container marker cannot flip isSelfHosted().
      const previousMode = process.env['MANIFEST_MODE'];
      process.env['MANIFEST_MODE'] = 'cloud';
      try {
        expect(
          (await call(tools, 'manifest_provider_connect', { provider: 'ollama', agent: 'demo' }))
            .error,
        ).toBe(true);
      } finally {
        if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
        else process.env['MANIFEST_MODE'] = previousMode;
      }

      // Discovery failing after the connection is saved still succeeds.
      const discoveryFails = makeDeps();
      (discoveryFails.modelDiscovery.discoverModels as jest.Mock).mockRejectedValueOnce(
        new Error('upstream down'),
      );
      const res = await call(registerAll(discoveryFails), 'manifest_provider_connect', {
        provider: 'openai',
        agent: 'demo',
      });
      expect(res.error).toBeFalsy();
      expect(res.data).toMatchObject({
        models_discovered: false,
        discovery_error: 'upstream down',
      });
    });

    it('disconnects and refreshes', async () => {
      const tools = registerAll(makeDeps());
      expect(
        (await call(tools, 'manifest_provider_disconnect', { provider: 'openai', agent: 'demo' }))
          .error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_provider_refresh', { agent: 'demo', provider: 'openai' }))
          .error,
      ).toBeFalsy();
      expect((await call(tools, 'manifest_provider_refresh', { agent: 'demo' })).error).toBeFalsy();
    });

    it('adds and removes a custom provider', async () => {
      const tools = registerAll(makeDeps());
      const add = await call(tools, 'manifest_provider_custom_add', {
        name: 'cp',
        base_url: 'http://127.0.0.1:1/v1',
        alias: 'cp',
      });
      expect(add.error).toBeFalsy();
      expect((await call(tools, 'manifest_provider_custom_list')).error).toBeFalsy();
      expect(
        (await call(tools, 'manifest_provider_custom_remove', { name: 'cp' })).error,
      ).toBeFalsy();

      // An endpoint with no models and no explicit list is an error.
      const deps = makeDeps();
      (deps.customProviders.probeModels as jest.Mock).mockResolvedValueOnce([]);
      expect(
        (
          await call(registerAll(deps), 'manifest_provider_custom_add', {
            name: 'empty',
            base_url: 'http://127.0.0.1:1/v1',
          })
        ).error,
      ).toBe(true);
    });

    it('enables and disables a provider for an agent (route impact blocks disable)', async () => {
      const deps = makeDeps();
      const tools = registerAll(deps);
      expect(
        (await call(tools, 'manifest_agent_provider_enable', { agent: 'demo', provider: 'openai' }))
          .error,
      ).toBeFalsy();
      // The default tier points at openai, so disable must be rejected.
      const blocked = await call(tools, 'manifest_agent_provider_disable', {
        agent: 'demo',
        provider: 'openai',
      });
      expect(blocked.error).toBe(true);

      (deps.tiers.getTiers as jest.Mock).mockResolvedValueOnce([
        { tier: 'default', override_route: null, fallback_routes: [] },
      ]);
      expect(
        (
          await call(tools, 'manifest_agent_provider_disable', {
            agent: 'demo',
            provider: 'openai',
          })
        ).error,
      ).toBeFalsy();

      // No matching connection.
      expect(
        (
          await call(tools, 'manifest_agent_provider_enable', {
            agent: 'demo',
            provider: 'anthropic',
          })
        ).error,
      ).toBe(true);
    });

    it('covers the specificity branch of the route-impact scan', async () => {
      const deps = makeDeps();
      (deps.tiers.getTiers as jest.Mock).mockResolvedValue([
        { tier: 'default', override_route: null, fallback_routes: [] },
      ]);
      (deps.specificity.getAssignments as jest.Mock).mockResolvedValue([
        {
          category: 'coding',
          override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
          fallback_routes: [],
        },
      ]);
      const blocked = await call(registerAll(deps), 'manifest_agent_provider_disable', {
        agent: 'demo',
        provider: 'openai',
      });
      expect(blocked.error).toBe(true);
    });

    it('scans tier, header-tier, and specificity fallbacks for the disabled provider', async () => {
      const deps = makeDeps();
      (deps.providers.getProviders as jest.Mock).mockResolvedValue([
        { ...CONNECTION, priority: 1, label: 'work' },
      ]);
      const matching = {
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-4o',
        keyLabel: 'work',
      };
      (deps.tiers.getTiers as jest.Mock).mockResolvedValue([
        // No keyLabel, priority!=0, label!='default' → not affected.
        {
          tier: 'default',
          override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
          fallback_routes: [],
        },
        { tier: 'team', override_route: null, fallback_routes: [matching] },
      ]);
      (deps.headerTiers.list as jest.Mock).mockResolvedValue([
        { id: 'h1', name: 'hdr', override_route: null, fallback_routes: [matching] },
      ]);
      (deps.specificity.getAssignments as jest.Mock).mockResolvedValue([
        // No provider field → matched by model id.
        { category: 'coding', override_route: null, fallback_routes: [{ model: 'gpt-4o' }] },
      ]);
      const blocked = await call(registerAll(deps), 'manifest_agent_provider_disable', {
        agent: 'demo',
        provider: 'openai',
      });
      expect(blocked.error).toBe(true);
    });
  });

  describe('routing tools', () => {
    it('reports status in each branch', async () => {
      const deps = makeDeps();
      expect(
        (await call(registerAll(deps), 'manifest_routing_status', { agent: 'demo' })).data,
      ).toMatchObject({ enabled: true });

      const noProviders = makeDeps();
      (noProviders.providers.getProviders as jest.Mock).mockResolvedValue([]);
      expect(
        (await call(registerAll(noProviders), 'manifest_routing_status', { agent: 'demo' })).data,
      ).toMatchObject({ reason: 'no_provider' });

      const noPricing = makeDeps();
      (noPricing.pricingSync.getAll as jest.Mock).mockReturnValue(new Map());
      expect(
        (await call(registerAll(noPricing), 'manifest_routing_status', { agent: 'demo' })).data,
      ).toMatchObject({ reason: 'pricing_cache_empty' });

      const notRoutable = makeDeps();
      (notRoutable.tiers.hasRoutableTier as jest.Mock).mockResolvedValue(false);
      expect(
        (await call(registerAll(notRoutable), 'manifest_routing_status', { agent: 'demo' })).data,
      ).toMatchObject({ reason: 'no_routable_models' });
    });

    it('reads and writes fallbacks', async () => {
      const tools = registerAll(makeDeps());
      expect(
        (await call(tools, 'manifest_routing_fallbacks_get', { agent: 'demo' })).error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_fallbacks_set', { agent: 'demo', models: ['a', 'b'] }))
          .error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_fallbacks_clear', { agent: 'demo' })).error,
      ).toBeFalsy();
    });

    it('reads and writes model params by tier and model', async () => {
      const deps = makeDeps();
      const tools = registerAll(deps);
      const got = await call(tools, 'manifest_routing_params_get', {
        agent: 'demo',
        tier: 'deep',
        model: 'gpt-5',
      });
      expect(got.data).toEqual({ tier: 'default', params: [] });
      expect(deps.routeModelParams.get).toHaveBeenCalledWith('agent-1', 'deep', 'gpt-5');

      const set = await call(tools, 'manifest_routing_params_set', {
        agent: 'demo',
        tier: 'deep',
        model: 'gpt-5',
        set: { 'reasoning.effort': 'high' },
        unset: ['temperature'],
      });
      expect(set.error).toBe(false);
      expect(deps.routeModelParams.update).toHaveBeenCalledWith('agent-1', 'deep', 'gpt-5', {
        set: { 'reasoning.effort': 'high' },
        unset: ['temperature'],
      });
    });

    it('hides the params write tool from a read-only token', () => {
      const tools = registerAll(makeDeps(), { ...OPERATOR, scopes: new Set(['mcp:read']) });
      expect(tools.has('manifest_routing_params_get')).toBe(true);
      expect(tools.has('manifest_routing_params_set')).toBe(false);
    });

    it('reads and writes Autofix and recording', async () => {
      const tools = registerAll(makeDeps());
      expect(
        (await call(tools, 'manifest_routing_autofix_get', { agent: 'demo' })).error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_autofix_set', { agent: 'demo', enabled: false }))
          .error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_recording_get', { agent: 'demo' })).error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_recording_set', { agent: 'demo', enabled: true }))
          .error,
      ).toBeFalsy();
    });

    it('manages custom tiers, including rollback', async () => {
      const deps = makeDeps();
      const tools = registerAll(deps);
      expect(
        (await call(tools, 'manifest_routing_custom_list', { agent: 'demo' })).error,
      ).toBeFalsy();
      expect(
        (
          await call(tools, 'manifest_routing_custom_create', {
            agent: 'demo',
            name: 'tier',
            header_key: 'x',
            header_value: 'y',
            badge_color: 'indigo',
            model: 'gpt-4o',
            provider: 'openai',
            fallbacks: ['gpt-4o'],
          })
        ).error,
      ).toBeFalsy();
      expect(
        (await call(tools, 'manifest_routing_custom_delete', { agent: 'demo', id: 'h1' })).error,
      ).toBeFalsy();

      (deps.headerTiers.setOverride as jest.Mock).mockRejectedValueOnce(new Error('nope'));
      expect(
        (
          await call(tools, 'manifest_routing_custom_create', {
            agent: 'demo',
            name: 'tier2',
            header_key: 'x',
            header_value: 'y',
            badge_color: 'indigo',
            model: 'gpt-4o',
            provider: 'openai',
          })
        ).error,
      ).toBe(true);

      // Fallbacks without a primary route are rejected.
      expect(
        (
          await call(tools, 'manifest_routing_custom_create', {
            agent: 'demo',
            name: 'tier3',
            header_key: 'x',
            header_value: 'y',
            badge_color: 'indigo',
            fallbacks: ['gpt-4o'],
          })
        ).error,
      ).toBe(true);
    });

    it('configures the default route, a custom tier, and toggles', async () => {
      const deps = makeDeps();
      const tools = registerAll(deps);
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['gpt-4o'],
            provider: 'openai',
          })
        ).error,
      ).toBeFalsy();
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['gpt-4o', 'gpt-4o'],
            provider: 'openai',
            tier: 'test',
            auth_type: 'api_key',
            key_label: 'default',
          })
        ).error,
      ).toBeFalsy();
      // Default tier with a fallback (set branch) and a custom tier with none.
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['gpt-4o', 'gpt-4o'],
            provider: 'openai',
          })
        ).error,
      ).toBeFalsy();
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['gpt-4o'],
            provider: 'openai',
            tier: 'test',
          })
        ).error,
      ).toBeFalsy();
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            autofix: false,
            recording: true,
          })
        ).error,
      ).toBeFalsy();

      // Nothing to configure.
      expect((await call(tools, 'manifest_agent_configure', { agent: 'demo' })).error).toBe(true);
      // tier without a route.
      expect(
        (await call(tools, 'manifest_agent_configure', { agent: 'demo', tier: 'x' })).error,
      ).toBe(true);
      // Unknown model without force.
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['nope'],
            provider: 'openai',
          })
        ).error,
      ).toBe(true);
      // force skips the check.
      expect(
        (
          await call(tools, 'manifest_agent_configure', {
            agent: 'demo',
            models: ['nope'],
            provider: 'openai',
            force: true,
          })
        ).error,
      ).toBeFalsy();
      // Missing provider.
      expect(
        (await call(tools, 'manifest_agent_configure', { agent: 'demo', models: ['gpt-4o'] }))
          .error,
      ).toBe(true);
    });

    it('checks the primary against its provider and takes its auth type from discovery', async () => {
      const deps = makeDeps();
      (deps.modelDiscovery.getModelsForAgent as jest.Mock).mockResolvedValue([
        { id: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', authType: 'api_key' },
        { id: 'gpt-5.4', provider: 'openai', displayName: 'GPT-5.4', authType: 'subscription' },
      ]);
      const tools = registerAll(deps);

      // A model another provider offers no longer passes the guard.
      const wrong = await call(tools, 'manifest_agent_configure', {
        agent: 'demo',
        models: ['gpt-4o'],
        provider: 'anthropic',
      });
      expect(wrong.error).toBe(true);
      expect(wrong.text).toContain('not offered by provider "anthropic"');

      // An unknown fallback is still named.
      const fallback = await call(tools, 'manifest_agent_configure', {
        agent: 'demo',
        models: ['gpt-4o', 'nope'],
        provider: 'openai',
      });
      expect(fallback.error).toBe(true);
      expect(fallback.text).toContain('Not in the models discovered for "demo": nope');

      // No auth_type: a subscription model stays a subscription route.
      await call(tools, 'manifest_agent_configure', {
        agent: 'demo',
        models: ['openai/gpt-5.4-subscription'],
        provider: 'openai',
      });
      expect(deps.tiers.setOverride).toHaveBeenLastCalledWith(
        'agent-1',
        expect.anything(),
        'default',
        'openai/gpt-5.4-subscription',
        'openai',
        'subscription',
        undefined,
      );
    });

    it('rejects tier-only config and rolls back a failed new custom tier', async () => {
      const tools = registerAll(makeDeps());
      // tier with another toggle set reaches the "tier needs models" guard.
      expect(
        (await call(tools, 'manifest_agent_configure', { agent: 'demo', tier: 'x', autofix: true }))
          .error,
      ).toBe(true);

      const deps = makeDeps();
      (deps.headerTiers.list as jest.Mock).mockResolvedValueOnce([]);
      (deps.headerTiers.setOverride as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const res = await call(registerAll(deps), 'manifest_agent_configure', {
        agent: 'demo',
        models: ['gpt-4o'],
        provider: 'openai',
        tier: 'new',
      });
      expect(res.error).toBe(true);
      expect(deps.headerTiers.delete).toHaveBeenCalledWith('agent-1', 'h1');
    });

    it('runs an end-to-end route test across surfaces', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'gpt-4o',
            choices: [{ message: { content: 'OK' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      try {
        const tools = registerAll(makeDeps());
        const res = await call(tools, 'manifest_routing_test', {
          agent: 'demo',
          prompt: 'hi',
          as: 'openclaw',
        });
        expect(res.data).toMatchObject({ ok: true, reply: 'OK', surface: 'chat_completions' });

        // messages surface
        global.fetch = jest.fn().mockResolvedValue(
          new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'HI' }] }), {
            status: 200,
          }),
        );
        expect(
          (await call(tools, 'manifest_routing_test', { agent: 'demo', as: 'claude-code' })).data,
        ).toMatchObject({ surface: 'messages', reply: 'HI' });

        // unknown platform
        expect(
          (await call(tools, 'manifest_routing_test', { agent: 'demo', as: 'constructor' })).error,
        ).toBe(true);

        // upstream failure
        global.fetch = jest
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 }),
          );
        expect(
          (await call(tools, 'manifest_routing_test', { agent: 'demo', as: 'openclaw' })).error,
        ).toBe(true);

        // 2xx with no payload
        global.fetch = jest
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
        expect(
          (await call(tools, 'manifest_routing_test', { agent: 'demo', as: 'openclaw' })).error,
        ).toBe(true);

        // Manifest error reply
        global.fetch = jest.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '[🦚 Manifest M100] no provider' } }],
            }),
            { status: 200 },
          ),
        );
        expect(
          (await call(tools, 'manifest_routing_test', { agent: 'demo', as: 'openclaw' })).error,
        ).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('parses the responses surface', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'm',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'RESP' }] }],
          }),
          { status: 200 },
        ),
      );
      try {
        const res = await call(registerAll(makeDeps()), 'manifest_routing_test', {
          agent: 'demo',
          as: 'codex',
        });
        expect(res.data).toMatchObject({ surface: 'responses', reply: 'RESP' });
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('model tools', () => {
    it('lists models and prices (provider id or display name)', async () => {
      const tools = registerAll(makeDeps());
      expect((await call(tools, 'manifest_models_list', { agent: 'demo' })).error).toBeFalsy();
      expect(
        (await call(tools, 'manifest_model_prices', { provider: 'openai' })).data,
      ).toMatchObject({
        models: [{ model_name: 'gpt-4o' }],
      });
      expect((await call(tools, 'manifest_model_prices', {})).error).toBeFalsy();
      // A provider alias resolves to the provider entry in the label lookup.
      const aliasDeps = makeDeps();
      (aliasDeps.modelPrices.getAll as jest.Mock).mockReturnValue({
        models: [
          {
            model_name: 'bedrock-model',
            provider: 'bedrock',
            input_price_per_million: 1,
            output_price_per_million: 2,
            display_name: 'BM',
            validated: true,
          },
        ],
        lastSyncedAt: null,
      });
      expect(
        (await call(registerAll(aliasDeps), 'manifest_model_prices', { provider: 'aws-bedrock' }))
          .data,
      ).toMatchObject({ models: [{ provider: 'bedrock' }] });
    });
  });

  describe('request tools', () => {
    it('returns a page', async () => {
      const res = await call(registerAll(makeDeps()), 'manifest_requests_get', {
        agent: 'demo',
        status: 'success',
        origin: 'provider',
        limit: 10,
      });
      expect(res.data).toMatchObject({ next_cursor: 'c' });
    });
  });

  describe('identity tools', () => {
    it('reports whoami and a doctor verdict', async () => {
      const tools = registerAll(makeDeps());
      expect((await call(tools, 'manifest_whoami')).data).toMatchObject({ tenantId: TENANT });
      expect((await call(tools, 'manifest_doctor')).data).toMatchObject({ ok: true });

      const empty = makeDeps();
      (empty.providers.getProviders as jest.Mock).mockResolvedValue([]);
      (empty.timeseries.getAgentList as jest.Mock).mockResolvedValue([]);
      expect((await call(registerAll(empty), 'manifest_doctor')).data).toMatchObject({ ok: false });

      const hollow = makeDeps();
      (hollow.providers.getProviders as jest.Mock).mockResolvedValue([
        { ...CONNECTION, cached_models: [] },
      ]);
      expect((await call(registerAll(hollow), 'manifest_doctor')).data).toMatchObject({
        ok: false,
      });

      // Hollow connection with no label exercises the label-less branch.
      const hollowNoLabel = makeDeps();
      (hollowNoLabel.providers.getProviders as jest.Mock).mockResolvedValue([
        { ...CONNECTION, label: '', cached_models: [] },
      ]);
      expect((await call(registerAll(hollowNoLabel), 'manifest_doctor')).data).toMatchObject({
        ok: false,
      });
    });
  });

  describe('environment tools', () => {
    it('renders setup masked, revealed, and generic', async () => {
      const tools = registerAll(makeDeps());
      const masked = await call(tools, 'manifest_agent_setup', { agent: 'demo' });
      expect((masked.data as { setup: string }).setup).toContain('MNFST_AGENT_KEY');

      const revealed = await call(tools, 'manifest_agent_setup', { agent: 'demo', reveal: true });
      expect((revealed.data as { setup: string }).setup).not.toContain('MNFST_AGENT_KEY');

      const deps = makeDeps();
      (deps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValue({
        agent_name: 'demo',
        display_name: 'Demo',
        agent_category: 'coding',
        agent_platform: 'unknown-platform',
      });
      const generic = await call(registerAll(deps), 'manifest_agent_setup', { agent: 'demo' });
      expect((generic.data as { setup: string }).setup).toContain('base URL');
    });

    it('rejects reveal without write scope and missing agents', async () => {
      const deps = makeDeps();
      (deps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValueOnce(null);
      expect((await call(registerAll(deps), 'manifest_agent_setup', { agent: 'x' })).error).toBe(
        true,
      );

      const ro = registerAll(makeDeps(), { ...OPERATOR, scopes: new Set(['mcp:read']) });
      expect((await call(ro, 'manifest_agent_setup', { agent: 'demo', reveal: true })).error).toBe(
        true,
      );
      expect(ro.has('manifest_agent_env')).toBe(false);
      // Read-only generic setup omits the write-only env guidance.
      const roDeps = makeDeps();
      (roDeps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValue({
        agent_name: 'demo',
        display_name: 'Demo',
        agent_category: 'coding',
        agent_platform: 'unknown-platform',
      });
      const roSetup = await call(
        registerAll(roDeps, { ...OPERATOR, scopes: new Set(['mcp:read']) }),
        'manifest_agent_setup',
        { agent: 'demo' },
      );
      expect((roSetup.data as { setup: string }).setup).not.toContain('manifest_agent_env');
    });

    it('returns env lines and the guide', async () => {
      const tools = registerAll(makeDeps());
      const env = await call(tools, 'manifest_agent_env', { agent: 'demo', export: true });
      expect((env.data as { lines: string[] }).lines[0]).toContain('export MANIFEST_AGENT_KEY=');
      expect((await call(tools, 'manifest_guide')).data).toHaveProperty('workflow');

      const deps = makeDeps();
      (deps.lifecycle.findAgentInfo as jest.Mock).mockResolvedValueOnce(null);
      expect((await call(registerAll(deps), 'manifest_agent_env', { agent: 'x' })).error).toBe(
        true,
      );
      const deps2 = makeDeps();
      (deps2.apiKeys.getKeyForAgent as jest.Mock).mockResolvedValueOnce({ keyPrefix: 'p' });
      expect((await call(registerAll(deps2), 'manifest_agent_env', { agent: 'demo' })).error).toBe(
        true,
      );
    });
  });
});
