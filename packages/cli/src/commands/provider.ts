import { CliIo, clientFromFlags, printJson } from '../context';
import { CliError } from '../errors';
import { slugifyAgentName } from '../slug';
import { parseArgs, requirePositional, requireYes } from '../args';
import { readCredential } from '../secrets';
import { PROVIDER_CATALOG } from '../provider-catalog.gen';
import { subscriptionConnect, supportsSubscription } from './oauth-connect';

/**
 * Lists what the CLI can connect — no auth, no network. Aliases stay internal
 * (they feed resolveProviderId); the output is id + displayName + authTypes.
 * Subscription is only advertised when the CLI can actually drive that
 * provider's sign-in, so the catalog never promises a mode `connect` rejects.
 */
export async function providerCatalog(io: CliIo, argv: string[]): Promise<void> {
  parseArgs(argv, { maxPositionals: 0 });
  const providers = PROVIDER_CATALOG.map(({ id, displayName, authTypes }) => ({
    id,
    displayName,
    authTypes: authTypes.filter((t) => t !== 'subscription' || supportsSubscription(id)),
  })).filter((p) => p.authTypes.length > 0);
  printJson(io, { providers });
}

/**
 * Resolve a --provider value to its canonical id, accepting aliases
 * ("google" → gemini). Unknown values fail before any network call.
 */
export function resolveProviderId(input: string): string {
  const needle = input.trim().toLowerCase();
  const hit = PROVIDER_CATALOG.find((p) => p.id === needle || (p.aliases ?? []).includes(needle));
  if (!hit) {
    throw new CliError(
      'unknown_provider',
      `Unknown provider: ${input}`,
      'Run mnfst provider catalog to list connectable providers',
    );
  }
  return hit.id;
}

export async function providerList(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url', 'agent'], maxPositionals: 0 });
  const { client } = clientFromFlags(io, args);
  const result = await client.request('GET', '/providers');
  if (!args.strings['agent']) {
    printJson(io, stripProviderNoise(result));
    return;
  }

  // Per-agent view: join the tenant connections with the agent's enabled set
  // (presence in agent_provider_access = enabled for that agent).
  const agent = slugifyAgentName(args.strings['agent']);
  const agentRes = (await client.request('GET', `/agents/${encodeURIComponent(agent)}`)) as {
    agent: unknown | null;
  };
  if (!agentRes.agent) {
    throw new CliError('not_found', `Agent "${agent}" not found`, 'See mnfst agent list', 404);
  }
  const enabledRes = (await client.request(
    'GET',
    `/agents/${encodeURIComponent(agent)}/enabled-providers`,
  )) as { enabled: string[] };
  printJson(io, {
    agent,
    ...(stripProviderNoise(result, new Set(enabledRes.enabled)) as Record<string, unknown>),
  });
}

/**
 * The providers endpoint carries dashboard-only fields: `model_counts` is the
 * global catalog census (not your connections), `models_fetched_at` and
 * `priority` render freshness/ordering chrome, `key_prefix` decorates the key
 * card. Kept: `cached_model_count` (0 = discovery found nothing, routing will
 * fail on that connection), `is_active`, and `display_name` when set (custom
 * providers have no other human name).
 */
function stripProviderNoise(result: unknown, enabledSet?: Set<string>): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const record = { ...(result as Record<string, unknown>) };
  delete record['model_counts'];
  if (!Array.isArray(record['providers'])) return record;
  return {
    ...record,
    providers: record['providers'].map((provider) => {
      if (typeof provider !== 'object' || provider === null) return provider;
      const p = { ...(provider as Record<string, unknown>) };
      if (p['display_name'] === null) delete p['display_name'];
      // Redundant aggregate: it is the sum of the connections' cached_model_count.
      delete p['total_models'];
      if (Array.isArray(p['connections'])) {
        p['connections'] = p['connections'].map((conn) => {
          if (typeof conn !== 'object' || conn === null) return conn;
          const c = { ...(conn as Record<string, unknown>) };
          delete c['key_prefix'];
          delete c['priority'];
          delete c['models_fetched_at'];
          if (enabledSet && typeof c['id'] === 'string') {
            c['enabled'] = enabledSet.has(c['id']);
          }
          return c;
        });
      }
      return p;
    }),
  };
}

/**
 * Take the provider as a positional (`provider connect xai`), tolerating the
 * legacy --provider flag; giving both (or neither) is an error.
 */
function providerFromArgs(args: ReturnType<typeof parseArgs>): string {
  const positional = args.positionals[0];
  const flagged = args.strings['provider'];
  if (positional && flagged) {
    throw new CliError(
      'invalid_flag',
      'Pass the provider once — positional or --provider, not both',
    );
  }
  const input = positional ?? flagged;
  if (!input) {
    throw new CliError(
      'missing_positional',
      'Usage: mnfst provider connect <provider>',
      'Run mnfst provider catalog to list connectable providers',
    );
  }
  return resolveProviderId(input);
}

/**
 * Connecting a provider is tenant-wide (the backend enables it for every
 * agent), but the API path is agent-scoped for model discovery. Any agent
 * yields the same result, so when --agent is omitted the CLI picks one and
 * says which it used.
 */
export async function resolveDiscoveryAgent(
  io: CliIo,
  args: ReturnType<typeof parseArgs>,
): Promise<string> {
  const explicit = args.strings['agent'];
  if (explicit) return slugifyAgentName(explicit);
  const { client } = clientFromFlags(io, args);
  const result = (await client.request('GET', '/agents')) as {
    agents?: Array<{ agent_name?: string }>;
  };
  const first = result?.agents?.find((a) => typeof a.agent_name === 'string');
  if (!first?.agent_name) {
    throw new CliError(
      'no_agents',
      'No agent exists yet — connecting a provider needs one for model discovery',
      'Run mnfst agent create --name <name> --platform <p> first',
    );
  }
  return first.agent_name;
}

/**
 * Pick the auth type. Explicit --auth-type wins (validated against the
 * catalog). Without it: a credential source implies api_key (a pasted key
 * cannot be anything else), local-only providers imply local, single-choice
 * providers need no flag — and a genuine multi-way choice is an ERROR, not a
 * prompt: this CLI is deterministic and agent-first.
 */
function resolveAuthType(
  args: ReturnType<typeof parseArgs>,
  providerId: string,
): string | undefined {
  const entry = PROVIDER_CATALOG.find((p) => p.id === providerId);
  const supported = entry?.authTypes ?? ['api_key'];
  const flagged = args.strings['auth-type'];
  if (flagged) {
    if (!supported.includes(flagged)) {
      throw new CliError(
        'invalid_auth_type',
        `${providerId} supports: ${supported.join(', ')}`,
        'Run mnfst provider catalog to see auth types per provider',
      );
    }
    return flagged;
  }
  const hasCredentialSource =
    Boolean(args.booleans['credential-stdin']) || Boolean(args.strings['credential-env']);
  if (hasCredentialSource && supported.includes('api_key')) return 'api_key';
  if (supported.length === 1) {
    return supported[0] === 'api_key' ? undefined : supported[0];
  }
  throw new CliError(
    'missing_auth_type',
    `--auth-type is required for ${providerId}. Supported: ${supported.join(', ')}`,
    'Run mnfst provider catalog to see auth types per provider',
  );
}

interface ConnectionRow {
  id?: string;
  label?: string;
}

interface ProviderGroup {
  provider?: string;
  auth_type?: string;
  display_name?: string;
  connections?: ConnectionRow[];
}

/**
 * Resolve a provider reference + optional filters to ONE tenant connection id.
 * Accepts catalog ids/aliases, raw `custom:<id>` keys, and custom-provider
 * display names. Zero matches list what exists; several demand a filter.
 */
async function resolveConnection(
  io: CliIo,
  args: ReturnType<typeof parseArgs>,
  input: string,
): Promise<{ id: string; provider: string; label: string }> {
  let providerId: string | null = null;
  try {
    providerId = resolveProviderId(input);
  } catch {
    providerId = null; // maybe a custom provider — matched below
  }
  const { client } = clientFromFlags(io, args);
  const result = (await client.request('GET', '/providers')) as { providers?: unknown } | null;
  const groups = (Array.isArray(result?.providers) ? result.providers : []).filter(
    (g): g is ProviderGroup => typeof g === 'object' && g !== null,
  );
  const needle = input.trim().toLowerCase();
  const matchesGroup = (g: ProviderGroup) =>
    (providerId !== null && g.provider === providerId) ||
    g.provider === input ||
    (typeof g.display_name === 'string' && g.display_name.toLowerCase() === needle);

  const authType = args.strings['auth-type'];
  const label = args.strings['label'];
  const candidates = groups
    .filter(matchesGroup)
    .filter((g) => !authType || g.auth_type === authType)
    .flatMap((g) =>
      (g.connections ?? [])
        .filter((c): c is ConnectionRow => typeof c === 'object' && c !== null)
        .filter((c) => !label || (c.label ?? '').toLowerCase() === label.toLowerCase())
        .map((c) => ({
          id: c.id as string,
          provider: g.provider as string,
          label: c.label ?? '',
          auth_type: g.auth_type ?? '',
        })),
    )
    .filter((c) => typeof c.id === 'string');

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new CliError(
      'not_found',
      `No connection matches "${input}"${authType ? ` (auth-type ${authType})` : ''}${label ? ` (label ${label})` : ''}`,
      'See mnfst provider list',
      404,
    );
  }
  throw new CliError(
    'ambiguous',
    `"${input}" matches ${candidates.length} connections: ${candidates
      .map((c) => `${c.provider}/${c.auth_type}/${c.label}`)
      .join(', ')}`,
    'Disambiguate with --auth-type and/or --label',
  );
}

/**
 * Opt a connection in/out for one agent. Lives under `agent provider` —
 * connections are tenant resources, but enabling is a property OF an agent,
 * so the agent is the first positional, like every agent-scoped command.
 */
export async function agentProviderEnable(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'auth-type', 'label'],
    maxPositionals: 2,
  });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const input = requirePositional(args, 1, '<provider>');
  const conn = await resolveConnection(io, args, input);
  const { client } = clientFromFlags(io, args);
  await client.request(
    'PUT',
    `/agents/${encodeURIComponent(agent)}/enabled-providers/${encodeURIComponent(conn.id)}`,
  );
  printJson(io, { agent, enabled: true, provider: conn.provider, connection: conn.id });
}

export async function agentProviderDisable(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'auth-type', 'label'],
    booleans: ['yes'],
    maxPositionals: 2,
  });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const input = requirePositional(args, 1, '<provider>');
  requireYes(args, `disable "${input}" for agent "${agent}"`);
  const conn = await resolveConnection(io, args, input);
  const { client } = clientFromFlags(io, args);
  await client.request(
    'DELETE',
    `/agents/${encodeURIComponent(agent)}/enabled-providers/${encodeURIComponent(conn.id)}`,
  );
  printJson(io, { agent, enabled: false, provider: conn.provider, connection: conn.id });
}

export async function providerConnect(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'provider', 'agent', 'credential-env', 'label', 'region', 'auth-type'],
    booleans: ['credential-stdin'],
    maxPositionals: 1,
  });
  const provider = providerFromArgs(args);
  const agent = await resolveDiscoveryAgent(io, args);
  const authType = resolveAuthType(args, provider);

  if (authType === 'subscription') {
    const { client } = clientFromFlags(io, args);
    await subscriptionConnect(io, client, provider, agent, args.strings['region']);
    return;
  }

  // API-key providers need a credential; `local` (Ollama) does not.
  const credential =
    authType === 'local'
      ? undefined
      : await readCredential(
          io,
          Boolean(args.booleans['credential-stdin']),
          args.strings['credential-env'],
          'credential',
        );

  const { client } = clientFromFlags(io, args);
  const result = await client.request('POST', `/routing/${encodeURIComponent(agent)}/providers`, {
    body: {
      provider,
      ...(credential !== undefined ? { apiKey: credential } : {}),
      ...(authType ? { authType } : {}),
      ...(args.strings['label'] ? { label: args.strings['label'] } : {}),
      ...(args.strings['region'] ? { region: args.strings['region'] } : {}),
    },
  });
  printJson(
    io,
    typeof result === 'object' && result !== null
      ? { agent, ...(result as Record<string, unknown>) }
      : { agent, result },
  );
}

/** Per-connection model census — what `provider refresh` actually changed. */
function modelCounts(result: unknown): Array<Record<string, unknown>> {
  const raw = (result as { providers?: unknown } | null)?.providers;
  const groups = (Array.isArray(raw) ? raw : []).filter(
    (g): g is Record<string, unknown> => typeof g === 'object' && g !== null,
  );
  return groups.flatMap((g) =>
    (Array.isArray(g['connections']) ? (g['connections'] as unknown[]) : [])
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({
        provider: g['provider'],
        auth_type: g['auth_type'],
        ...(c['label'] ? { label: c['label'] } : {}),
        is_active: c['is_active'],
        cached_model_count: c['cached_model_count'],
      })),
  );
}

/**
 * Re-run model discovery. Connections cache their model list at connect time,
 * so a provider that shipped a new model — or a connection that was hollow
 * while its credential was broken — needs this before routing can name it.
 * Discovery is tenant-wide; the agent in the path only performs the call.
 */
export async function providerRefresh(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'agent', 'auth-type'],
    maxPositionals: 1,
  });
  const input = args.positionals[0];
  const provider = input !== undefined ? resolveProviderId(input) : null;
  const agent = await resolveDiscoveryAgent(io, args);
  const { client } = clientFromFlags(io, args);

  const refreshed = await (provider === null
    ? client.request('POST', `/routing/${encodeURIComponent(agent)}/refresh-models`)
    : client.request(
        'POST',
        `/routing/${encodeURIComponent(agent)}/providers/${encodeURIComponent(provider)}/refresh-models`,
        { query: { authType: args.strings['auth-type'] } },
      ));

  // Read back so the caller sees the outcome, not just an ack: a connection
  // still at 0 models after a refresh is a credential problem, not a stale one.
  const listed = await client.request('GET', '/providers');
  printJson(io, {
    agent,
    ...(provider !== null ? { provider } : {}),
    refresh: refreshed,
    connections: modelCounts(listed),
  });
}

export async function providerDisconnect(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'provider', 'agent', 'auth-type', 'label'],
    booleans: ['yes'],
    maxPositionals: 1,
  });
  const provider = providerFromArgs(args);
  const agent = await resolveDiscoveryAgent(io, args);
  requireYes(args, `disconnect provider "${provider}" (tenant-wide)`);
  const { client } = clientFromFlags(io, args);
  const result = await client.request(
    'DELETE',
    `/routing/${encodeURIComponent(agent)}/providers/${encodeURIComponent(provider)}`,
    {
      query: {
        authType: args.strings['auth-type'],
        label: args.strings['label'],
      },
    },
  );
  printJson(io, result);
}
