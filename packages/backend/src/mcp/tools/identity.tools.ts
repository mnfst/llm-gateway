import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { authIssuer, authOrigin, mcpResource } from '../../auth/auth.instance';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { ok, result } from '../tool-result';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: Record<string, unknown>;
}

/**
 * Identity and diagnostics. `doctor` runs the same dependency-ordered sweep the
 * CLI does — config → credential → providers → agents — because a wrong host and
 * a wrong key produce identical errors from any single command.
 */
export function registerIdentityTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  server.registerTool(
    'manifest_whoami',
    {
      title: 'Who am I',
      description: 'Return the acting user, tenant, and granted MCP scopes.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({ userId: operator.userId, tenantId: operator.tenantId, scopes: [...operator.scopes] }),
  );

  server.registerTool(
    'manifest_doctor',
    {
      title: 'Diagnose the workspace',
      description:
        'Run config, credential, provider, and agent checks in dependency order and report one verdict.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      result(
        (async () => {
          const checks: Check[] = [];
          checks.push({
            name: 'config',
            status: 'ok',
            detail: { url: authOrigin, issuer: authIssuer, mcp_resource: mcpResource },
          });
          checks.push({
            name: 'credential',
            status: 'ok',
            detail: {
              userId: operator.userId,
              tenantId: operator.tenantId,
              scopes: [...operator.scopes],
            },
          });

          const connections = await deps.providers.getProviders(operator.tenantId);
          const hollow = connections
            .filter((c) => c.is_active && (c.cached_models?.length ?? 0) === 0)
            .map((c) => `${c.provider}/${c.auth_type}${c.label ? `/${c.label}` : ''}`);
          checks.push({
            name: 'providers',
            // No connections means nothing can route; a hollow connection (active
            // with zero cached models) is equally unusable. Both fail the verdict.
            status: connections.length === 0 || hollow.length > 0 ? 'fail' : 'ok',
            detail: {
              connections: connections.length,
              // An active connection with zero cached models is unusable by
              // routing — report it instead of letting it read as healthy.
              hollow_connections: hollow,
            },
          });

          const agents = await deps.timeseries.getAgentList(operator.tenantId);
          checks.push({
            name: 'agents',
            status: agents.length === 0 ? 'warn' : 'ok',
            detail: { agents: agents.length },
          });

          return { ok: checks.every((c) => c.status !== 'fail'), url: authOrigin, checks };
        })(),
      ),
  );
}
