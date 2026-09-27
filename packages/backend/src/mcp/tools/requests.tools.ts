import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MESSAGE_ORIGIN_FILTER_VALUES,
  MESSAGE_STATUS_FILTER_VALUES,
} from '../../analytics/dto/messages-query.dto';
import { RANGE_VALUES } from '../../common/utils/range.util';
import { McpOperator } from '../mcp-auth';
import { McpToolDeps } from '../tool-deps';
import { result } from '../tool-result';

/**
 * Request ledger readout. Mirrors the API's opaque-cursor pagination: one page
 * per call, `next_cursor` for the following page.
 */
export function registerRequestTools(
  server: McpServer,
  deps: McpToolDeps,
  operator: McpOperator,
): void {
  server.registerTool(
    'manifest_requests_get',
    {
      title: 'Get requests',
      description: 'List recent Manifest requests (provider attempts) with cursor pagination.',
      inputSchema: z.object({
        agent: z.string().min(1).max(100).optional(),
        range: z.enum(RANGE_VALUES).optional(),
        status: z.enum(MESSAGE_STATUS_FILTER_VALUES).optional(),
        provider: z.string().min(1).max(100).optional(),
        origin: z.enum(MESSAGE_ORIGIN_FILTER_VALUES).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ agent, range, status, provider, origin, limit, cursor }) =>
      result(
        (async () => {
          const page = (await deps.messages.getMessages({
            tenantId: operator.tenantId,
            agent_name: agent,
            range,
            status,
            provider,
            origin,
            limit: Math.min(limit ?? 50, 200),
            cursor,
            // The handler discards filter metadata; do not build it.
            include_filter_options: false,
          })) as {
            items?: unknown[];
            next_cursor?: string | null;
            total_count?: number;
          };
          return {
            items: page.items ?? [],
            next_cursor: page.next_cursor ?? null,
            total_count: page.total_count ?? 0,
          };
        })(),
      ),
  );
}
