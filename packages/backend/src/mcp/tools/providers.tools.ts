import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CUSTOM_PROVIDER_ALIAS_MAX_LENGTH,
  CUSTOM_PROVIDER_ALIAS_PATTERN,
  SHARED_PROVIDER_BY_ID_OR_ALIAS,
  SHARED_PROVIDERS,
  SUPPORTED_SUBSCRIPTION_PROVIDER_IDS,
  normalizeProviderName,
  type ModelRoute,
} from 'manifest-shared';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import {
  CLOUD_LOCAL_PROVIDER_MESSAGE,
  isProviderAvailableForDeployment,
} from '../../common/utils/provider-availability';
import { McpOperator, MCP_WRITE_SCOPE } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { ok, result } from '../tool-result';

const AUTH_TYPES = ['api_key', 'subscription', 'local'] as const;

/**
 * Provider connection tools. Providers are tenant-global; an agent only decides
 * which connection performs a discovery call. The catalog comes from
 * manifest-shared — the same registry the CLI and dashboard use — so "what can
 * I connect?" cannot drift between surfaces.
 */
/**
 * Model count per connection. A custom provider keeps its models on its own
 * row (entered by hand) and never fills the connection's discovery cache, so
 * its count comes from there instead of reading as an empty catalog.
 */
async function modelCounter(
  deps: McpToolDeps,
  tenantId: string,
): Promise<(p: { provider: string; cached_models?: unknown[] | null }) => number> {
  const custom = new Map(
    (await deps.customProviders.list(tenantId)).map((c) => [
      `custom:${c.id}`,
      Array.isArray(c.models) ? c.models.length : 0,
    ]),
  );
  return (p) => custom.get(p.provider) ?? p.cached_models?.length ?? 0;
}

export function registerProviderTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  server.registerTool(
    'manifest_provider_list',
    {
      title: 'List provider connections',
      description: 'List the workspace provider connections and their cached model counts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        (async () => {
          const modelCount = await modelCounter(deps, operator.tenantId);
          return {
            connections: (await deps.providers.getProviders(operator.tenantId)).map((p) => ({
              id: p.id,
              provider: p.provider,
              auth_type: p.auth_type,
              label: p.label,
              region: p.region,
              is_active: p.is_active,
              key_prefix: p.key_prefix,
              cached_model_count: modelCount(p),
              models_fetched_at: p.models_fetched_at,
              connected_at: p.connected_at,
            })),
            custom_providers: (await deps.customProviders.list(operator.tenantId)).map((c) => ({
              id: c.id,
              name: c.name,
              alias: c.alias,
              base_url: c.base_url,
              model_count: Array.isArray(c.models) ? c.models.length : 0,
            })),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_catalog',
    {
      title: 'Provider catalog',
      description: 'List every connectable provider with its supported auth types.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        providers: SHARED_PROVIDERS.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          ...(p.aliases.length ? { aliases: [...p.aliases] } : {}),
          authTypes: [
            ...(p.localOnly ? ['local'] : []),
            ...(p.requiresApiKey ? ['api_key'] : []),
            ...(SUPPORTED_SUBSCRIPTION_PROVIDER_IDS.includes(p.id) ? ['subscription'] : []),
          ],
        })),
      }),
  );

  server.registerTool(
    'manifest_provider_custom_list',
    {
      title: 'List custom providers',
      description:
        'List the workspace custom providers (OpenAI- or Anthropic-compatible endpoints).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        (async () => ({
          custom_providers: (await deps.customProviders.list(operator.tenantId)).map((c) => ({
            id: c.id,
            name: c.name,
            alias: c.alias,
            base_url: c.base_url,
          })),
        }))(),
      ),
  );

  // Everything below connects, disconnects, or mutates provider access — a
  // read-only token must not see these tools.
  if (!operator.scopes.has(MCP_WRITE_SCOPE)) return;

  server.registerTool(
    'manifest_provider_connect',
    {
      title: 'Connect a provider',
      description:
        'Connect a provider for the workspace (tenant-wide) and discover its models. Supply the credential via api_key.',
      inputSchema: z.object({
        provider: z.string().min(1),
        api_key: z.string().min(1).optional(),
        auth_type: z.enum(AUTH_TYPES).optional(),
        region: z.string().min(1).optional(),
        label: z.string().max(50).optional(),
        agent: z.string().min(1).describe('Agent that performs discovery.'),
      }),
    },
    async ({ provider, api_key, auth_type, region, label, agent }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {
            allowPlayground: true,
          });
          const normalized = provider.trim().toLowerCase();
          const known =
            SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
            SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName(normalized));
          if (!known) throw new Error(`Unknown provider: ${provider}`);
          if (!isProviderAvailableForDeployment(provider)) {
            throw new Error(CLOUD_LOCAL_PROVIDER_MESSAGE);
          }
          const upserted = await deps.providers.upsertProvider(
            resolved.id,
            resolved.tenant_id,
            // Persist the canonical id, not the alias the caller typed, or every
            // later lookup (refresh/disable) fails to find the connection.
            known.id,
            api_key,
            auth_type,
            region,
            label,
            operator.userId,
          );
          let modelsDiscovered = true;
          let discoveryError: string | undefined;
          try {
            await deps.modelDiscovery.discoverModels(upserted.provider);
          } catch (error) {
            // The connection is already saved; discovery is retryable via refresh.
            modelsDiscovered = false;
            discoveryError = error instanceof Error ? error.message : String(error);
          }
          return {
            id: upserted.provider.id,
            provider: upserted.provider.provider,
            auth_type: upserted.provider.auth_type,
            is_new: upserted.isNew,
            label: upserted.provider.label,
            models_discovered: modelsDiscovered,
            ...(discoveryError ? { discovery_error: discoveryError } : {}),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_disconnect',
    {
      title: 'Disconnect a provider',
      description: 'Remove a provider connection from the workspace.',
      inputSchema: z.object({
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
        agent: z.string().min(1),
      }),
    },
    async ({ provider, auth_type, label, agent }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {});
          const { notifications } = await deps.providers.removeProvider(
            resolved.id,
            resolved.tenant_id,
            provider,
            auth_type,
            label,
          );
          return { ok: true, notifications };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_refresh',
    {
      title: 'Refresh provider models',
      description:
        'Re-run model discovery. With a provider, refresh that connection; otherwise refresh every connection for the agent.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1).optional(),
        auth_type: z.enum(AUTH_TYPES).optional(),
      }),
    },
    async ({ agent, provider, auth_type }) =>
      result(
        (async () => {
          const resolved = await deps.resolveAgent.resolve(operator.tenantId, agent, {
            allowPlayground: true,
          });
          if (provider) {
            const refreshed = await deps.modelDiscovery.refreshProvider(
              resolved.tenant_id,
              provider,
              auth_type,
            );
            return { provider, ...refreshed };
          }
          await deps.modelDiscovery.discoverAllForAgent(resolved.tenant_id, { forceRefresh: true });
          const connections = await deps.providers.getProviders(resolved.tenant_id);
          const modelCount = await modelCounter(deps, resolved.tenant_id);
          return {
            connections: connections.map((p) => ({
              provider: p.provider,
              auth_type: p.auth_type,
              label: p.label,
              cached_model_count: modelCount(p),
            })),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_custom_add',
    {
      title: 'Register a custom provider',
      description:
        'Register a custom OpenAI- or Anthropic-compatible provider. Models are discovered from the endpoint when not supplied.',
      inputSchema: z.object({
        name: z.string().min(1).max(50),
        base_url: z.string().url(),
        alias: z
          .string()
          .trim()
          .toLowerCase()
          .max(CUSTOM_PROVIDER_ALIAS_MAX_LENGTH)
          .regex(CUSTOM_PROVIDER_ALIAS_PATTERN)
          .nullable()
          .optional(),
        api_kind: z.enum(['openai', 'anthropic']).optional(),
        api_key: z.string().min(1).optional(),
        models: z.array(z.string().min(1).max(100)).max(500).optional(),
      }),
    },
    async ({ name, base_url, alias, api_kind, api_key, models }) =>
      result(
        (async () => {
          const modelDtos =
            models && models.length > 0
              ? models.map((model_name) => ({ model_name }))
              : await deps.customProviders
                  .probeModels(base_url, api_key, api_kind ?? 'openai', name)
                  .then((probed) => probed.map((m) => ({ model_name: m.model_name })));
          if (modelDtos.length === 0) {
            throw new Error('No models found at the endpoint; pass models explicitly');
          }
          const created = await deps.customProviders.create(
            operator.tenantId,
            { name, alias, base_url, api_kind, apiKey: api_key, models: modelDtos },
            operator.userId,
          );
          return { id: created.id, name: created.name, alias: created.alias };
        })(),
      ),
  );

  server.registerTool(
    'manifest_provider_custom_remove',
    {
      title: 'Remove a custom provider',
      description: 'Delete a custom provider registration by name.',
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) =>
      result(
        (async () => {
          const match = (await deps.customProviders.list(operator.tenantId)).find(
            (c) => c.name === name || c.alias === name,
          );
          if (!match) throw new Error(`Custom provider "${name}" not found`);
          await deps.customProviders.remove(operator.tenantId, match.id, operator.userId);
          return { removed: true, name };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_provider_enable',
    {
      title: 'Enable a provider for an agent',
      description: 'Grant one provider connection to a harness.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
      }),
    },
    async ({ agent, provider, auth_type, label }) =>
      result(setAgentProviderEnabled(deps, operator, agent, provider, auth_type, label, true)),
  );

  server.registerTool(
    'manifest_agent_provider_disable',
    {
      title: 'Disable a provider for an agent',
      description: 'Revoke one provider connection from a harness.',
      inputSchema: z.object({
        agent: z.string().min(1),
        provider: z.string().min(1),
        auth_type: z.enum(AUTH_TYPES).optional(),
        label: z.string().min(1).optional(),
      }),
    },
    async ({ agent, provider, auth_type, label }) =>
      result(setAgentProviderEnabled(deps, operator, agent, provider, auth_type, label, false)),
  );
}

async function setAgentProviderEnabled(
  deps: McpToolDeps,
  operator: McpOperator,
  agentName: string,
  provider: string,
  authType: ('api_key' | 'subscription' | 'local') | undefined,
  label: string | undefined,
  enabled: boolean,
): Promise<unknown> {
  const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
  const connections = await deps.providers.getProviders(agent.tenant_id);
  const connection = connections.find(
    (p) =>
      p.provider === provider &&
      (authType === undefined || p.auth_type === authType) &&
      (label === undefined || p.label === label),
  );
  if (!connection) {
    throw new Error(`No ${provider} connection matches the given auth type/label`);
  }
  if (enabled) {
    await deps.agentEnabledProviderRepo
      .createQueryBuilder()
      .insert()
      .into(AgentEnabledProvider)
      .values({ agent_id: agent.id, tenant_provider_id: connection.id })
      .orIgnore()
      .execute();
  } else {
    // Disabling a connection that a route still points at would leave that
    // route unusable, so reject it exactly as the REST controller does.
    const affected = await findAffectedRoutes(deps, agent.id, connection);
    if (affected.length > 0) {
      throw new Error(
        "Can't disable provider while its models are assigned to this harness's routing. Update routing first.",
      );
    }
    await deps.agentEnabledProviderRepo.delete({
      agent_id: agent.id,
      tenant_provider_id: connection.id,
    });
  }
  await deps.providers.recalculateTiers(agent.id, agent.tenant_id);
  return { ok: true, agent: agent.name, provider, enabled };
}

/**
 * Routes that would break if this connection were disabled: a tier or
 * specificity assignment whose primary route or fallback resolves to the
 * connection. Mirrors AgentEnabledProvidersController.findAffectedRoutes.
 */
async function findAffectedRoutes(
  deps: McpToolDeps,
  agentId: string,
  provider: TenantProvider,
): Promise<string[]> {
  const providerModels = new Set(
    (Array.isArray(provider.cached_models) ? provider.cached_models : []).map((m) => m.id),
  );
  const providerName = provider.provider.toLowerCase();
  const providerAuthType = provider.auth_type;
  const providerLabel = provider.label?.toLowerCase();
  const belongs = (route: ModelRoute | null): boolean => {
    if (!route) return false;
    if (route.provider) {
      if (route.provider.toLowerCase() !== providerName) return false;
      if (route.authType && route.authType !== providerAuthType) return false;
      if (route.keyLabel && providerLabel && route.keyLabel.toLowerCase() !== providerLabel) {
        return false;
      }
      if (!route.keyLabel && provider.priority !== 0 && providerLabel !== 'default') return false;
      return true;
    }
    return providerModels.has(route.model);
  };

  const affected: string[] = [];
  const tiers = await deps.tiers.getTiers(agentId, provider.tenant_id);
  for (const tier of tiers) {
    if (belongs(tier.override_route)) affected.push(`${tier.tier}: primary`);
    for (const [i, fallback] of (tier.fallback_routes ?? []).entries()) {
      if (belongs(fallback)) affected.push(`${tier.tier}: fallback ${i + 1}`);
    }
  }
  const headerTiers = await deps.headerTiers.list(agentId);
  for (const tier of headerTiers) {
    if (belongs(tier.override_route)) affected.push(`${tier.name}: primary`);
    for (const [i, fallback] of (tier.fallback_routes ?? []).entries()) {
      if (belongs(fallback)) affected.push(`${tier.name}: fallback ${i + 1}`);
    }
  }
  const assignments = await deps.specificity.getAssignments(agentId);
  for (const assignment of assignments) {
    if (belongs(assignment.override_route)) affected.push(`${assignment.category}: primary`);
    for (const [i, fallback] of (assignment.fallback_routes ?? []).entries()) {
      if (belongs(fallback)) affected.push(`${assignment.category}: fallback ${i + 1}`);
    }
  }
  return affected;
}
