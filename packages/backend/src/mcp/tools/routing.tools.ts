import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PLATFORM_API_SURFACES, type JsonValue } from 'manifest-shared';
import { authOrigin } from '../../auth/auth.instance';
import { McpOperator, MCP_WRITE_SCOPE } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { result } from '../tool-result';
import {
  describeUnresolvedModel,
  matchesModelName,
  resolveModelRoute,
} from '../../routing/routing-core/resolve-model-route';

const AUTH_TYPES = ['api_key', 'subscription', 'local'] as const;
const ROUTE_TEST_TIMEOUT_MS = 120_000;

/** --models states the whole chain: extra entries set fallbacks, a lone entry clears them. */
async function setOrClear<T>(
  set: () => Promise<T>,
  clear: () => Promise<void>,
  fallbacks: string[],
): Promise<T | []> {
  if (fallbacks.length > 0) return set();
  await clear();
  return [];
}

interface SurfaceResult {
  reply: string;
  servedModel: string | null;
  tokens?: number;
}

function parseCompletionSurface(parsed: Record<string, unknown>): SurfaceResult {
  const choice = (parsed['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
  const message = choice?.['message'] as { content?: string } | undefined;
  const usage = parsed['usage'] as
    { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    reply: message?.content ?? '',
    servedModel: typeof parsed['model'] === 'string' ? parsed['model'] : null,
    ...(usage?.prompt_tokens !== undefined
      ? { tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) }
      : {}),
  };
}

function parseMessagesSurface(parsed: Record<string, unknown>): SurfaceResult {
  const blocks = parsed['content'] as Array<Record<string, unknown>> | undefined;
  const textBlock = blocks?.find((b) => b['type'] === 'text');
  const usage = parsed['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    reply: typeof textBlock?.['text'] === 'string' ? (textBlock['text'] as string) : '',
    servedModel: typeof parsed['model'] === 'string' ? parsed['model'] : null,
    ...(usage?.input_tokens !== undefined
      ? { tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
      : {}),
  };
}

function parseResponsesSurface(parsed: Record<string, unknown>): SurfaceResult {
  const output = parsed['output'] as Array<Record<string, unknown>> | undefined;
  let reply = '';
  for (const item of output ?? []) {
    if (item['type'] !== 'message') continue;
    const content = item['content'] as Array<Record<string, unknown>> | undefined;
    for (const part of content ?? []) {
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') reply += part['text'];
    }
  }
  const usage = parsed['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    reply,
    servedModel: typeof parsed['model'] === 'string' ? parsed['model'] : null,
    ...(usage?.input_tokens !== undefined
      ? { tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) }
      : {}),
  };
}

function hasSurfacePayload(surface: string, parsed: Record<string, unknown>): boolean {
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  if (surface === 'messages') return nonEmpty(parsed['content']);
  if (surface === 'responses') return nonEmpty(parsed['output']);
  return nonEmpty(parsed['choices']);
}

/**
 * Routing tools: readiness, default-tier fallbacks, per-agent Autofix/recording
 * switches, and the custom (header) tier lifecycle. "Custom tier" is the CLI's
 * name for a header tier — a rule that overrides the route when a request
 * carries a matching header.
 */
export function registerRoutingTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  const canWrite = operator.scopes.has(MCP_WRITE_SCOPE);
  server.registerTool(
    'manifest_routing_status',
    {
      title: 'Routing status',
      description: 'Report whether a harness can route yet, and why not.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          const providers = await deps.providers.getProviders(agent.tenant_id);
          if (providers.length === 0) return { enabled: false, reason: 'no_provider' };
          if (deps.pricingSync.getAll().size === 0)
            return { enabled: false, reason: 'pricing_cache_empty' };
          const routable = await deps.tiers.hasRoutableTier(agent.id);
          return { enabled: routable, reason: routable ? null : 'no_routable_models' };
        })(),
      ),
  );

  server.registerTool(
    'manifest_routing_fallbacks_get',
    {
      title: 'Get fallbacks',
      description: 'Read the fallback chain of a tier (default tier by default).',
      inputSchema: z.object({ agent: z.string().min(1), tier: z.string().min(1).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName, tier }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          return { fallbacks: await deps.tiers.getFallbacks(agent.id, tier ?? 'default') };
        })(),
      ),
  );

  if (canWrite)
    server.registerTool(
      'manifest_routing_fallbacks_set',
      {
        title: 'Set fallbacks',
        description: 'Replace the fallback chain of a tier. One entry clears the rest.',
        inputSchema: z.object({
          agent: z.string().min(1),
          models: z.array(z.string().min(1)).max(5),
          tier: z.string().min(1).optional(),
        }),
      },
      async ({ agent: agentName, models, tier }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            const fallbacks = await deps.tiers.setFallbacks(
              agent.id,
              agent.tenant_id,
              tier ?? 'default',
              models,
            );
            return { fallbacks };
          })(),
        ),
    );

  if (canWrite)
    server.registerTool(
      'manifest_routing_fallbacks_clear',
      {
        title: 'Clear fallbacks',
        description: 'Remove the fallback chain from a tier.',
        inputSchema: z.object({ agent: z.string().min(1), tier: z.string().min(1).optional() }),
      },
      async ({ agent: agentName, tier }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            await deps.tiers.clearFallbacks(agent.id, tier ?? 'default');
            return { ok: true };
          })(),
        ),
    );

  server.registerTool(
    'manifest_routing_params_get',
    {
      title: 'Get model params',
      description:
        'List the params a routed model accepts (type, allowed values, description) with their saved ' +
        'values, e.g. reasoning.effort or temperature. tier is "default" or a custom tier name; model ' +
        'defaults to the tier primary and may name one of its fallbacks. current: null means the ' +
        'provider default applies.',
      inputSchema: z.object({
        agent: z.string().min(1),
        tier: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName, tier, model }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          return deps.routeModelParams.get(agent.id, tier, model);
        })(),
      ),
  );

  if (canWrite)
    server.registerTool(
      'manifest_routing_params_set',
      {
        title: 'Set model params',
        description:
          'Set or unset params on a routed model. Saved params override the values the caller sends ' +
          'on routed requests (model "auto" or a matching custom-tier header); a request naming a ' +
          'concrete model skips them. ' +
          'set maps a param path to its value ({"reasoning.effort": "high"}); unset lists paths to ' +
          'remove. Other saved params are kept. Read manifest_routing_params_get first for valid paths.',
        inputSchema: z.object({
          agent: z.string().min(1),
          tier: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          set: z.record(z.string().min(1), z.unknown()).optional(),
          unset: z.array(z.string().min(1)).max(50).optional(),
        }),
      },
      async ({ agent: agentName, tier, model, set, unset }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            return deps.routeModelParams.update(agent.id, tier, model, {
              set: set as Record<string, JsonValue> | undefined,
              unset,
            });
          })(),
        ),
    );

  server.registerTool(
    'manifest_routing_autofix_get',
    {
      title: 'Get Autofix state',
      description: 'Report whether Autofix is effective for a harness.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          return { enabled: deps.autofix.resolveEnabled(agent.autofix_enabled) };
        })(),
      ),
  );

  if (canWrite)
    server.registerTool(
      'manifest_routing_autofix_set',
      {
        title: 'Set Autofix state',
        description: 'Enable or disable Autofix for a harness.',
        inputSchema: z.object({ agent: z.string().min(1), enabled: z.boolean() }),
      },
      async ({ agent: agentName, enabled }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            if (enabled) await deps.autofixStats.recordAutofixConsent();
            await deps.agentRepo.update(agent.id, { autofix_enabled: enabled });
            deps.resolveAgent.invalidate(agent.tenant_id, agentName);
            await deps.cacheManager.del(`${agent.tenant_id}:/api/v1/autofix/status`);
            return { enabled: deps.autofix.resolveEnabled(enabled) };
          })(),
        ),
    );

  server.registerTool(
    'manifest_routing_recording_get',
    {
      title: 'Get recording state',
      description: 'Report whether request recording is on for a harness.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          return { enabled: await deps.recording.isRecording(agent.id) };
        })(),
      ),
  );

  if (canWrite)
    server.registerTool(
      'manifest_routing_recording_set',
      {
        title: 'Set recording state',
        description: 'Turn request recording on or off for a harness.',
        inputSchema: z.object({ agent: z.string().min(1), enabled: z.boolean() }),
      },
      async ({ agent: agentName, enabled }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            await deps.agentRepo.update(agent.id, { record_messages: enabled });
            deps.resolveAgent.invalidate(agent.tenant_id, agentName);
            return { enabled };
          })(),
        ),
    );

  server.registerTool(
    'manifest_routing_custom_list',
    {
      title: 'List custom tiers',
      description: 'List a harness’s header-triggered custom tiers.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
          return { custom_tiers: await deps.headerTiers.list(agent.id) };
        })(),
      ),
  );

  if (canWrite)
    server.registerTool(
      'manifest_routing_test',
      {
        title: 'Test a route end-to-end',
        description:
          'Send one real request through the harness route and the platform surface it uses. Spends provider tokens.',
        inputSchema: z.object({
          agent: z.string().min(1),
          prompt: z.string().min(1).optional(),
          tier: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          as: z.string().min(1).optional().describe('Force a platform surface (e.g. claude-code).'),
        }),
      },
      async ({ agent: agentName, prompt, tier, model, as: platformOverride }) =>
        result(
          (async () => {
            const info = await deps.lifecycle.findAgentInfo(operator.tenantId, agentName);
            if (!info) throw new Error(`Agent "${agentName}" not found`);
            if (
              platformOverride !== undefined &&
              !Object.prototype.hasOwnProperty.call(PLATFORM_API_SURFACES, platformOverride)
            ) {
              throw new Error(`Unknown platform: ${platformOverride}`);
            }
            const platform = platformOverride ?? info.agent_platform ?? undefined;
            const surface =
              (platform
                ? (PLATFORM_API_SURFACES as Record<string, string>)[platform]
                : undefined) ?? 'chat_completions';
            const key = await deps.apiKeys.getKeyForAgent(operator.tenantId, info.agent_name);
            if (!key.fullKey) throw new Error('No active key for this agent');

            const endpoint =
              surface === 'messages'
                ? `${authOrigin}/v1/messages`
                : surface === 'responses'
                  ? `${authOrigin}/v1/responses`
                  : `${authOrigin}/v1/chat/completions`;
            const text = prompt ?? 'Reply with exactly: OK';
            const requestedModel = model ?? 'auto';
            const body =
              surface === 'messages'
                ? {
                    model: requestedModel,
                    max_tokens: 64,
                    messages: [{ role: 'user', content: text }],
                  }
                : surface === 'responses'
                  ? { model: requestedModel, input: text }
                  : { model: requestedModel, messages: [{ role: 'user', content: text }] };

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ROUTE_TEST_TIMEOUT_MS);
            const started = Date.now();
            let response: Response;
            let raw: string;
            try {
              response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${key.fullKey}`,
                  'Content-Type': 'application/json',
                  ...(surface === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
                  ...(tier ? { 'x-manifest-tier': tier } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
              });
              raw = await response.text();
            } finally {
              clearTimeout(timer);
            }
            const durationMs = Date.now() - started;

            let parsed: Record<string, unknown> = {};
            let parsedOk = false;
            try {
              const value: unknown = JSON.parse(raw);
              if (typeof value === 'object' && value !== null) {
                parsed = value as Record<string, unknown>;
                parsedOk = true;
              }
            } catch {
              /* non-JSON body → handled below */
            }
            if (!response.ok) {
              const message = (parsed['error'] as { message?: string } | undefined)?.message;
              throw new Error(message ?? `Route test failed with HTTP ${response.status}`);
            }
            if (!parsedOk || !hasSurfacePayload(surface, parsed)) {
              throw new Error(`Route test got HTTP ${response.status} but no ${surface} payload`);
            }
            const surfaceResult =
              surface === 'messages'
                ? parseMessagesSurface(parsed)
                : surface === 'responses'
                  ? parseResponsesSurface(parsed)
                  : parseCompletionSurface(parsed);
            if (/^\[🦚 Manifest M\d+\]/.test(surfaceResult.reply)) {
              throw new Error(surfaceResult.reply);
            }
            return {
              agent: info.agent_name,
              ok: true,
              surface,
              ...(platform ? { platform } : {}),
              requested_model: requestedModel,
              ...(tier ? { tier } : {}),
              served_model: surfaceResult.servedModel,
              duration_ms: durationMs,
              ...(surfaceResult.tokens !== undefined ? { tokens: surfaceResult.tokens } : {}),
              reply: surfaceResult.reply,
            };
          })(),
        ),
    );

  if (canWrite)
    server.registerTool(
      'manifest_agent_configure',
      {
        title: 'Configure an agent',
        description:
          'Set the default route and fallback chain (or a custom header tier), and/or toggle Autofix and recording. `models` is the full chain: first is the route, the rest are fallbacks.',
        inputSchema: z.object({
          agent: z.string().min(1),
          models: z.array(z.string().min(1)).min(1).max(6).optional(),
          provider: z.string().min(1).optional(),
          auth_type: z.enum(AUTH_TYPES).optional(),
          key_label: z.string().min(1).max(50).optional(),
          tier: z
            .string()
            .min(1)
            .optional()
            .describe('Upsert this custom header tier instead of the default route.'),
          autofix: z.boolean().optional(),
          recording: z.boolean().optional(),
          force: z.boolean().optional().describe('Skip the discovered-model check.'),
        }),
      },
      async ({
        agent: agentName,
        models,
        provider,
        auth_type,
        key_label,
        tier,
        autofix,
        recording,
        force,
      }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            const output: Record<string, unknown> = { agent: agentName };
            const wantsRoute =
              models !== undefined ||
              provider !== undefined ||
              auth_type !== undefined ||
              key_label !== undefined;
            if (!wantsRoute && autofix === undefined && recording === undefined) {
              throw new Error(
                'Nothing to configure — pass models + provider, autofix, and/or recording',
              );
            }
            if (tier !== undefined && !wantsRoute)
              throw new Error('tier needs models and provider');

            if (wantsRoute) {
              if (!models || models.length === 0 || !provider) {
                throw new Error('models and provider are required together');
              }
              const primary = models[0];
              const fallbacks = models.slice(1);
              const available = await deps.modelDiscovery.getModelsForAgent(
                agent.tenant_id,
                agent.id,
              );
              // Resolve the route the way it will be stored: scoped to its
              // provider, and to its auth type when one was given.
              const primaryRoute = resolveModelRoute(primary, available, {
                provider,
                authType: auth_type,
              });
              if (!force) {
                if (!primaryRoute.ok) {
                  throw new Error(
                    `${describeUnresolvedModel(primary, primaryRoute.reason, available, {
                      provider,
                      authType: auth_type,
                    })} Refresh models or pass force:true.`,
                  );
                }
                const missing = fallbacks.filter(
                  (name) => !available.some((m) => matchesModelName(m, name)),
                );
                if (missing.length > 0) {
                  throw new Error(
                    `Not in the models discovered for "${agentName}": ${missing.join(', ')}. ` +
                      'Refresh models or pass force:true.',
                  );
                }
              }
              // An omitted auth_type follows discovery, so a subscription model
              // is never stored as a metered api_key route.
              const authType =
                auth_type ?? (primaryRoute.ok ? primaryRoute.route.authType : 'api_key');
              if (tier) {
                const list = await deps.headerTiers.list(agent.id);
                const hit = list.find((t) => t.name.toLowerCase() === tier.toLowerCase());
                const target =
                  hit ??
                  (await deps.headerTiers.create(agent.id, agent.tenant_id, {
                    name: tier,
                    header_key: 'x-manifest-tier',
                    header_value: tier,
                    badge_color: 'indigo' as never,
                  }));
                output['tier'] = { id: target.id, name: target.name, created: !hit };
                try {
                  output['route'] = await deps.headerTiers.setOverride(
                    agent.id,
                    agent.tenant_id,
                    target.id,
                    primary,
                    provider,
                    authType,
                    key_label ?? null,
                  );
                  output['fallbacks'] = await setOrClear(
                    () =>
                      deps.headerTiers.setFallbacks(
                        agent.id,
                        agent.tenant_id,
                        target.id,
                        fallbacks,
                      ),
                    () => deps.headerTiers.clearFallbacks(agent.id, target.id),
                    fallbacks,
                  );
                } catch (error) {
                  // The tier was created by this call; drop it so a failed
                  // route/fallback write does not leave an enabled empty tier.
                  if (!hit)
                    await deps.headerTiers.delete(agent.id, target.id).catch(() => undefined);
                  throw error;
                }
              } else {
                output['route'] = await deps.tiers.setOverride(
                  agent.id,
                  agent.tenant_id,
                  'default',
                  primary,
                  provider,
                  authType,
                  key_label,
                );
                output['fallbacks'] = await setOrClear(
                  () => deps.tiers.setFallbacks(agent.id, agent.tenant_id, 'default', fallbacks),
                  () => deps.tiers.clearFallbacks(agent.id, 'default'),
                  fallbacks,
                );
              }
            }
            if (autofix !== undefined) {
              if (autofix) await deps.autofixStats.recordAutofixConsent();
              await deps.agentRepo.update(agent.id, { autofix_enabled: autofix });
              deps.resolveAgent.invalidate(agent.tenant_id, agentName);
              await deps.cacheManager.del(`${agent.tenant_id}:/api/v1/autofix/status`);
              output['autofix'] = { enabled: deps.autofix.resolveEnabled(autofix) };
            }
            if (recording !== undefined) {
              await deps.agentRepo.update(agent.id, { record_messages: recording });
              deps.resolveAgent.invalidate(agent.tenant_id, agentName);
              output['recording'] = { enabled: recording };
            }
            return output;
          })(),
        ),
    );

  if (canWrite)
    server.registerTool(
      'manifest_routing_custom_create',
      {
        title: 'Create a custom tier',
        description:
          'Create a header-triggered custom tier, optionally with a route override and fallbacks.',
        inputSchema: z.object({
          agent: z.string().min(1),
          name: z.string().min(1),
          header_key: z.string().min(1),
          header_value: z.string().min(1),
          badge_color: z.string().min(1),
          model: z.string().min(1).optional(),
          provider: z.string().min(1).optional(),
          auth_type: z.enum(AUTH_TYPES).optional(),
          fallbacks: z.array(z.string().min(1)).max(5).optional(),
        }),
      },
      async ({
        agent: agentName,
        name,
        header_key,
        header_value,
        badge_color,
        model,
        provider,
        auth_type,
        fallbacks,
      }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            if (fallbacks && fallbacks.length > 0 && !model) {
              // Fallbacks without a primary route leave matching requests
              // unroutable, so reject instead of persisting a broken tier.
              throw new Error('fallbacks require a model (the primary route)');
            }
            const tier = await deps.headerTiers.create(agent.id, agent.tenant_id, {
              name,
              header_key,
              header_value,
              badge_color: badge_color as never,
            });
            // The tier create, its override, and its fallbacks are separate
            // writes. If a later step fails, delete the tier so a rejected
            // custom tier is not left behind.
            try {
              if (model) {
                await deps.headerTiers.setOverride(
                  agent.id,
                  agent.tenant_id,
                  tier.id,
                  model,
                  provider,
                  auth_type,
                );
              }
              if (fallbacks && fallbacks.length > 0) {
                await deps.headerTiers.setFallbacks(agent.id, agent.tenant_id, tier.id, fallbacks);
              }
            } catch (error) {
              await deps.headerTiers.delete(agent.id, tier.id).catch(() => undefined);
              throw error;
            }
            return {
              tier: await deps.headerTiers
                .list(agent.id)
                .then((t) => t.find((x) => x.id === tier.id)),
            };
          })(),
        ),
    );

  if (canWrite)
    server.registerTool(
      'manifest_routing_custom_delete',
      {
        title: 'Delete a custom tier',
        description: 'Delete a header-triggered custom tier by id.',
        inputSchema: z.object({ agent: z.string().min(1), id: z.string().min(1) }),
      },
      async ({ agent: agentName, id }) =>
        result(
          (async () => {
            const agent = await deps.resolveAgent.resolve(operator.tenantId, agentName);
            await deps.headerTiers.delete(agent.id, id);
            return { ok: true };
          })(),
        ),
    );
}
