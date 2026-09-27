import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SHARED_PROVIDERS } from 'manifest-shared';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { result } from '../tool-result';

/** Model discovery and pricing readouts. */
export function registerModelTools(
  server: McpServer,
  deps: McpToolDeps,
  _operator: McpOperator,
): void {
  server.registerTool(
    'manifest_models_list',
    {
      title: 'List available models',
      description: 'List the models the harness can route to, per connected provider.',
      inputSchema: z.object({ agent: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName }) =>
      result(
        (async () => {
          const agent = await deps.resolveAgent.resolve(_operator.tenantId, agentName, {
            allowPlayground: true,
          });
          const models = await deps.modelDiscovery.getModelsForAgent(agent.tenant_id, agent.id);
          return {
            models: models.map((m) => ({
              id: m.id,
              provider: m.provider,
              display_name: m.displayName ?? null,
            })),
          };
        })(),
      ),
  );

  server.registerTool(
    'manifest_model_prices',
    {
      title: 'Model prices',
      description: 'Install-wide model pricing. No agent is required.',
      inputSchema: z.object({ provider: z.string().min(1).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ provider }) =>
      result(
        (async () => {
          const { models, lastSyncedAt } = deps.modelPrices.getAll();
          const lookup = provider?.trim().toLowerCase();
          // Pricing rows carry the provider's display label ("OpenAI"), while
          // callers pass the id ("openai"). Accept either, plus aliases.
          const entry = lookup
            ? SHARED_PROVIDERS.find(
                (p) =>
                  p.id.toLowerCase() === lookup ||
                  p.aliases.some((alias) => alias.toLowerCase() === lookup),
              )
            : undefined;
          const labels = new Set(
            [lookup, entry?.id.toLowerCase(), entry?.displayName.toLowerCase()].filter(
              (value): value is string => typeof value === 'string',
            ),
          );
          return {
            models: models.filter((row) => !lookup || labels.has(row.provider.toLowerCase())),
            lastSyncedAt,
          };
        })(),
      ),
  );
}
