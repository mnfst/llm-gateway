import { CliIo, clientFromFlags, printJson } from '../context';
import { parseArgs, requirePositional } from '../args';
import { slugifyAgentName } from '../slug';
import { resolveProviderId } from './provider';

interface ModelRow {
  model_name?: string;
  provider?: string;
  auth_type?: string;
  context_window?: unknown;
  input_price_per_token?: unknown;
  output_price_per_token?: unknown;
  cost_per_request?: unknown;
  capability_reasoning?: unknown;
  capability_code?: unknown;
  capabilities?: unknown;
  input_modalities?: unknown;
}

/**
 * Models routable for an agent (union of its ENABLED provider connections).
 * Mirrors the /v1/models proxy contract: bare identity by default, --cost and
 * --capabilities opt into the heavier metadata. The agent is a required
 * positional — the answer genuinely depends on which agent you ask about.
 * --provider filters (aliases accepted).
 */
export async function modelsList(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'provider'],
    booleans: ['cost', 'capabilities'],
    maxPositionals: 1,
  });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  // Custom providers are addressed by their raw `custom:<id>` key, which the
  // catalog does not contain — accept it before the catalog lookup.
  const providerInput = args.strings['provider'];
  const providerFilter = providerInput
    ? /^custom:/i.test(providerInput.trim())
      ? `custom:${providerInput.trim().slice('custom:'.length)}`
      : resolveProviderId(providerInput)
    : null;
  const includeCost = Boolean(args.booleans['cost']);
  const includeCapabilities = Boolean(args.booleans['capabilities']);
  const { client } = clientFromFlags(io, args);
  const rows = (await client.request(
    'GET',
    `/routing/${encodeURIComponent(agent)}/available-models`,
  )) as unknown;

  const models = (Array.isArray(rows) ? rows : [])
    .filter((m): m is ModelRow => typeof m === 'object' && m !== null)
    .filter((m) => !providerFilter || m.provider === providerFilter)
    .map((m) => ({
      model: m.model_name,
      provider: m.provider,
      auth_type: m.auth_type,
      ...(includeCost
        ? {
            input_price_per_token: m.input_price_per_token,
            output_price_per_token: m.output_price_per_token,
            ...(m.cost_per_request != null ? { cost_per_request: m.cost_per_request } : {}),
          }
        : {}),
      ...(includeCapabilities
        ? {
            context_window: m.context_window,
            capability_reasoning: m.capability_reasoning,
            capability_code: m.capability_code,
            ...(m.capabilities != null ? { capabilities: m.capabilities } : {}),
            ...(m.input_modalities != null ? { input_modalities: m.input_modalities } : {}),
          }
        : {}),
    }));

  printJson(io, {
    agent,
    count: models.length,
    // A connection only contributes models when it is active AND discovery
    // cached its list — an empty result usually means one of those is off.
    ...(models.length === 0
      ? {
          hint: `No routable models${providerFilter ? ` for ${providerFilter}` : ''} — check connections are active and models were fetched: mnfst provider list --agent ${agent}`,
        }
      : {}),
    models,
  });
}
