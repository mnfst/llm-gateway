import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PLATFORM_SETUP_SNIPPETS } from 'manifest-shared';
import { authOrigin } from '../../auth/auth.instance';
import { McpOperator, MCP_WRITE_SCOPE } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { ok, result } from '../tool-result';

/** The masked stand-in for an agent key in setup text — never a shell substitution. */
function maskedKeyRef(slug: string): string {
  // Pin the origin so the command targets the server that produced the setup,
  // not whatever host the CLI is configured for.
  return `<MNFST_AGENT_KEY — run: mnfst agent key show ${slug} --raw --url ${authOrigin}>`;
}

/**
 * Render a platform's setup instructions. Templates come from manifest-shared —
 * the same source the dashboard and CLI render — so the wiring guidance cannot
 * drift between surfaces. Platforms with no first-class snippet get generic
 * OpenAI-compatible guidance.
 */
function renderSetup(platform: string | null, keyRef: string, canWrite: boolean): string {
  const template = platform ? PLATFORM_SETUP_SNIPPETS[platform] : undefined;
  if (template) {
    return template(`${authOrigin}/v1`, keyRef);
  }
  const lines = [
    "Point your tool's OpenAI-compatible client at Manifest:",
    `  base URL: ${authOrigin}/v1`,
    `  API key:  ${keyRef}`,
  ];
  // `manifest_agent_env` is a write tool, so only name it when it is available.
  if (canWrite) lines.push('Or wire it via env: use manifest_agent_env to get the export lines.');
  return lines.join('\n');
}

/**
 * Setup and environment tools, plus the operating guide. These mirror the CLI's
 * `agent setup`, `agent env`, and `skill show`. Both key-bearing tools require
 * mcp:write: even the CLI treats a key read as a privileged operation.
 */
export function registerEnvironmentTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  const canWrite = operator.scopes.has(MCP_WRITE_SCOPE);

  server.registerTool(
    'manifest_agent_setup',
    {
      title: 'Agent setup instructions',
      description:
        'Return platform setup instructions for a harness. The key is masked unless reveal is true (requires mcp:write).',
      inputSchema: z.object({ agent: z.string().min(1), reveal: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent: agentName, reveal }) =>
      result(
        (async () => {
          const info = await deps.lifecycle.findAgentInfo(operator.tenantId, agentName);
          if (!info) throw new Error(`Agent "${agentName}" not found`);
          let keyRef = maskedKeyRef(info.agent_name);
          if (reveal) {
            if (!canWrite) throw new Error('mcp:write scope is required to reveal the key');
            const key = await deps.apiKeys.getKeyForAgent(operator.tenantId, info.agent_name);
            if (!key.fullKey) throw new Error('No active key for this agent');
            keyRef = key.fullKey;
          }
          return {
            agent: info.agent_name,
            platform: info.agent_platform ?? null,
            setup: renderSetup(info.agent_platform ?? null, keyRef, canWrite),
            ...(!reveal && canWrite ? { hint: 'Pass reveal:true to embed the real key' } : {}),
          };
        })(),
      ),
  );

  if (!canWrite) return;

  server.registerTool(
    'manifest_agent_env',
    {
      title: 'Agent environment variables',
      description:
        'Return the dotenv/shell lines that point a harness at Manifest (MANIFEST_AGENT_KEY + MANIFEST_AGENT_URL).',
      inputSchema: z.object({ agent: z.string().min(1), export: z.boolean().optional() }),
    },
    async ({ agent: agentName, export: useExport }) =>
      result(
        (async () => {
          const info = await deps.lifecycle.findAgentInfo(operator.tenantId, agentName);
          if (!info) throw new Error(`Agent "${agentName}" not found`);
          const key = await deps.apiKeys.getKeyForAgent(operator.tenantId, info.agent_name);
          if (!key.fullKey) throw new Error('No active key for this agent');
          const prefix = useExport ? 'export ' : '';
          return {
            agent: info.agent_name,
            MANIFEST_AGENT_KEY: key.fullKey,
            MANIFEST_AGENT_URL: `${authOrigin}/v1`,
            lines: [
              `${prefix}MANIFEST_AGENT_KEY=${key.fullKey}`,
              `${prefix}MANIFEST_AGENT_URL=${authOrigin}/v1`,
            ],
          };
        })(),
      ),
  );
}

/**
 * The operating guide. An MCP client already sees the tool list; this returns
 * the higher-level workflow the CLI ships as its agent skill.
 */
export function registerGuideTool(server: McpServer): void {
  server.registerTool(
    'manifest_guide',
    {
      title: 'Manifest operating guide',
      description: 'Return the recommended workflow for managing a Manifest workspace.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      ok({
        workflow: [
          'Call manifest_doctor first when anything looks wrong — it separates a bad URL from a bad credential.',
          'Harnesses: manifest_agent_list, then manifest_agent_get. Create with manifest_agent_create; the returned key is shown once.',
          'Providers: manifest_provider_catalog lists what is connectable; manifest_provider_connect stores a tenant-wide connection and discovers its models.',
          'Routing: manifest_routing_status tells you whether a harness can route. Configure the default chain with the newer agent configure surface, or per-agent fallbacks with manifest_routing_fallbacks_set.',
          'Model params (reasoning effort, temperature, …): manifest_routing_params_get lists what a tier route accepts and what is saved; manifest_routing_params_set saves values that override what the harness sends on routed requests (model "auto" or a matching custom-tier header). Address the route by tier ("default" or a custom tier name) and model.',
          'Verify end-to-end with manifest_routing_test — it sends one real request through the selected platform surface.',
          'A connection that is active with zero cached models is unusable; run manifest_provider_refresh.',
        ],
      }),
  );
}
