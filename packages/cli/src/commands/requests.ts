import { CliIo, clientFromFlags, printJson } from '../context';
import { CliError } from '../errors';
import { parseArgs } from '../args';
import { slugifyAgentName } from '../slug';

/**
 * Paginated read of the Requests log, mirroring the real API contract
 * (GET /api/v1/messages): opaque `cursor` + `next_cursor`, server-capped
 * `limit`. One page per invocation — callers (and agents) page explicitly:
 *
 *   mnfst requests get --agent john --limit 50
 *   mnfst requests get --agent john --cursor <next_cursor from last page>
 */
/** Always present on a trimmed row. */
const CORE_FIELDS = [
  'id',
  'agent_name',
  'timestamp',
  'status',
  'model',
  'provider',
  'auth_type',
  'cost',
  'input_tokens',
  'output_tokens',
  'duration_ms',
  'attempt_count',
] as const;

/** Included only when they carry a value — noise-free happy path. */
const WHEN_SET_FIELDS = [
  'error_code',
  'error_message',
  'error_origin',
  'fallback_from_model',
  'header_tier_name',
  'custom_provider_name',
] as const;

function trimRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of CORE_FIELDS) if (f in r) out[f] = r[f];
  for (const f of WHEN_SET_FIELDS) if (r[f] !== null && r[f] !== undefined) out[f] = r[f];
  if (r['autofix_applied'] === true) out['autofix_applied'] = true;
  return out;
}

const VALID_RANGES = ['1h', '6h', '24h', '7d', '30d', '90d', '365d'] as const;

export async function requestsGet(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'agent', 'range', 'status', 'provider', 'limit', 'cursor', 'origin'],
    booleans: ['full'],
    maxPositionals: 0,
  });
  let limit: number | undefined;
  if (args.strings['limit'] !== undefined) {
    // Digits only: parseInt would silently truncate "2.5" or accept "2abc".
    if (!/^\d+$/.test(args.strings['limit'])) {
      throw new CliError('invalid_flag', '--limit must be an integer between 1 and 200');
    }
    limit = Number(args.strings['limit']);
    if (limit < 1 || limit > 200) {
      throw new CliError('invalid_flag', '--limit must be an integer between 1 and 200');
    }
  }
  if (
    args.strings['range'] !== undefined &&
    !(VALID_RANGES as readonly string[]).includes(args.strings['range'])
  ) {
    throw new CliError('invalid_flag', `--range must be one of: ${VALID_RANGES.join(', ')}`);
  }
  const agent = args.strings['agent'] ? slugifyAgentName(args.strings['agent']) : undefined;
  const { client } = clientFromFlags(io, args);
  const result = (await client.request('GET', '/messages', {
    query: {
      agent_name: agent,
      range: args.strings['range'],
      status: args.strings['status'],
      provider: args.strings['provider'],
      origin: args.strings['origin'],
      limit: limit !== undefined ? String(limit) : undefined,
      cursor: args.strings['cursor'],
    },
  })) as {
    items?: unknown[];
    next_cursor?: string | null;
    total_count?: number;
    total_count_exact?: boolean;
  } | null;

  const items = Array.isArray(result?.items) ? result.items : [];
  printJson(io, {
    ...(agent ? { agent } : {}),
    count: items.length,
    // Faithful pagination: hand back the API's cursor; null means last page.
    next_cursor: result?.next_cursor ?? null,
    total_count: result?.total_count,
    total_count_exact: result?.total_count_exact,
    // Trimmed to decision-relevant fields; --full passes API rows untouched.
    requests: args.booleans['full'] ? items : items.map(trimRow),
  });
}
