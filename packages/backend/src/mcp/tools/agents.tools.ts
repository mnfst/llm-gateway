import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AGENT_CATEGORIES, AGENT_PLATFORMS } from 'manifest-shared';
import { PLAYGROUND_AGENT_SLUG } from '../../common/constants/playground.constants';
import { slugify } from '../../common/utils/slugify';
import { McpOperator, MCP_WRITE_SCOPE } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { ok, result } from '../tool-result';

/**
 * Agent lifecycle tools. The write path mirrors AgentsController exactly —
 * including the provider-enable compensation, because a brand-new agent that
 * cannot reach a provider is silently unroutable, and the cache invalidation
 * that keeps the harness list from serving a stale roster to the dashboard.
 */
export function registerAgentTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  const invalidate = async (tenantId: string | null): Promise<void> => {
    if (tenantId) await deps.agentListCache.invalidate(tenantId);
  };

  // The dashboard caches a workspace Autofix verdict under this key; a create or
  // update that flips Autofix must drop it or the sidebar keeps the old state.
  const invalidateAutofixStatus = async (tenantId: string | null): Promise<void> => {
    if (tenantId) await deps.cacheManager.del(`${tenantId}:/api/v1/autofix/status`);
  };

  server.registerTool(
    'manifest_agent_list',
    {
      title: 'List agents',
      description: 'List the workspace harnesses (agents) with usage rollups.',
      inputSchema: z.object({
        include_playground: z
          .boolean()
          .optional()
          .describe('Include the reserved Playground agent.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ include_playground }) =>
      result(
        (async () => {
          const agents = await deps.timeseries.getAgentList(
            operator.tenantId,
            include_playground === true,
          );
          // sparkline is a dashboard-only field — strip it so an agent's context
          // is not filled with 24 numbers it cannot use.
          return {
            agents: agents.map((agent) => {
              const rest: Record<string, unknown> = { ...agent };
              delete rest.sparkline;
              return rest;
            }),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_get',
    {
      title: 'Get an agent',
      description: 'Fetch one harness by name (slug).',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent }) =>
      result(
        (async () => ({ agent: await deps.lifecycle.findAgentInfo(operator.tenantId, agent) }))(),
      ),
  );

  server.registerTool(
    'manifest_agent_platforms',
    {
      title: 'List agent platforms',
      description: 'List valid agent platforms and categories for create/update.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        platforms: [...AGENT_PLATFORMS],
        categories: [...AGENT_CATEGORIES],
      }),
  );

  // Everything below mutates state or returns a live secret — a read-only token
  // must not even see these tools, so the client cannot offer them.
  if (!operator.scopes.has(MCP_WRITE_SCOPE)) return;

  server.registerTool(
    'manifest_agent_create',
    {
      title: 'Create an agent',
      description:
        'Create a harness (agent) and return its ingest key once. The key is a secret — store it immediately.',
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        agent_category: z.enum(AGENT_CATEGORIES).optional(),
        agent_platform: z.enum(AGENT_PLATFORMS).optional(),
        autofix_enabled: z.boolean().optional(),
        record_messages: z.boolean().optional(),
      }),
    },
    async ({ name, agent_category, agent_platform, autofix_enabled, record_messages }) =>
      result(
        (async () => {
          const slug = slugify(name);
          if (!slug) throw new Error('Agent name produces an empty slug');
          if (slug === PLAYGROUND_AGENT_SLUG) throw new Error('"Playground" is a reserved name');
          if (autofix_enabled === true) {
            await deps.autofixStats.recordAutofixConsent();
            await invalidateAutofixStatus(operator.tenantId);
          }
          const created = await deps.apiKeys.onboardAgent({
            tenantId: operator.tenantId,
            ownerUserId: operator.userId,
            agentName: slug,
            displayName: name.trim(),
            agentCategory: agent_category,
            agentPlatform: agent_platform,
            autofixEnabled: autofix_enabled,
            recordMessages: record_messages,
          });
          try {
            await deps.providers.enableAllProvidersForAgent(created.agentId, created.tenantId);
          } catch (error) {
            // A committed agent with zero enabled providers is unroutable — roll
            // back rather than leave a broken harness behind. If the rollback
            // itself fails the agent survives, so still drop the caches that may
            // have captured it before rethrowing the original error.
            try {
              await deps.lifecycle.deleteAgent(created.tenantId, slug);
            } catch {
              // Best effort: the caller sees the provider error either way.
            }
            await invalidate(created.tenantId);
            await invalidateAutofixStatus(created.tenantId);
            throw error;
          }
          await invalidate(created.tenantId);
          await invalidateAutofixStatus(created.tenantId);
          deps.eventBus.emit(created.tenantId, 'agent', operator.userId);
          return {
            agent: {
              id: created.agentId,
              name: slug,
              display_name: name.trim(),
              agent_category: agent_category ?? null,
              agent_platform: agent_platform ?? null,
            },
            apiKey: created.apiKey,
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_update',
    {
      title: 'Update an agent',
      description: 'Rename a harness or change its category/platform.',
      inputSchema: z.object({
        agent: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        agent_category: z.enum(AGENT_CATEGORIES).optional(),
        agent_platform: z.enum(AGENT_PLATFORMS).optional(),
      }),
    },
    async ({ agent, name, agent_category, agent_platform }) =>
      result(
        (async () => {
          if (name !== undefined) {
            const slug = slugify(name);
            if (!slug) throw new Error('Agent name produces an empty slug');
            if (slug === PLAYGROUND_AGENT_SLUG) {
              throw new Error('"Playground" is a reserved name');
            }
            await deps.lifecycle.renameAgent(operator.tenantId, agent, slug, name.trim());
            // The resolver caches by name; drop the old slug or it keeps serving
            // the renamed agent for the cache TTL.
            deps.resolveAgent.invalidate(operator.tenantId, agent);
            deps.resolveAgent.invalidate(operator.tenantId, slug);
          }
          if (agent_category !== undefined || agent_platform !== undefined) {
            await deps.lifecycle.updateAgentType(operator.tenantId, name ? slugify(name) : agent, {
              agent_category,
              agent_platform,
            });
          }
          await invalidate(operator.tenantId);
          deps.eventBus.emit(operator.tenantId, 'agent', operator.userId);
          return { updated: agent };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_delete',
    {
      title: 'Delete an agent',
      description: 'Soft-delete a harness and deactivate its key.',
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) =>
      result(
        (async () => {
          await deps.lifecycle.deleteAgent(operator.tenantId, agent);
          await invalidate(operator.tenantId);
          await invalidateAutofixStatus(operator.tenantId);
          deps.eventBus.emit(operator.tenantId, 'agent', operator.userId);
          return { deleted: true, agent };
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_rotate_key',
    {
      title: 'Rotate an agent key',
      description: 'Rotate the harness ingest key and return the new key once.',
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) =>
      result(
        (async () => {
          const info = await deps.lifecycle.findAgentInfo(operator.tenantId, agent);
          if (!info) throw new Error(`Agent "${agent}" not found`);
          return await deps.apiKeys.rotateKey(operator.tenantId, agent);
        })(),
      ),
  );

  server.registerTool(
    'manifest_agent_key_show',
    {
      title: 'Show an agent key',
      description:
        'Return the harness ingest key. Read-only access still exposes a live secret, so this requires the mcp:write scope.',
      inputSchema: z.object({ agent: z.string().min(1) }),
    },
    async ({ agent }) =>
      result(
        (async () => {
          const info = await deps.lifecycle.findAgentInfo(operator.tenantId, agent);
          if (!info) throw new Error(`Agent "${agent}" not found`);
          const key = await deps.apiKeys.getKeyForAgent(operator.tenantId, agent);
          return { keyPrefix: key.keyPrefix, ...(key.fullKey ? { apiKey: key.fullKey } : {}) };
        })(),
      ),
  );
}
