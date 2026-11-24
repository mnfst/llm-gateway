import { CliIo, clientFromFlags, printJson } from '../context';
import { resolveAgentKey } from './agent';
import { PLATFORM_CATALOG } from '../provider-catalog.gen';
import { slugifyAgentName } from '../slug';
import { CliError } from '../errors';
import { parseArgs, parseBooleanFlag, requirePositional, requireString, requireYes } from '../args';
import { ApiClient } from '../client';
import { assertModelsDiscovered } from './model-check';
import { CLI_USER_AGENT } from '../version';

const URL_ONLY = { strings: ['url'] } as const;

/**
 * The CLI exposes only the routing surfaces Manifest keeps long-term:
 * the DEFAULT route (one model + fallbacks) and CUSTOM header-triggered
 * tiers. The deprecated complexity tiers (simple/standard/complex/reasoning)
 * are deliberately absent.
 */

function agentPath(agent: string, suffix: string): string {
  return `/routing/${encodeURIComponent(agent)}${suffix}`;
}

function parseModelsList(raw: string): string[] {
  const models = raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new CliError('missing_flag', '--fallbacks must be a comma-separated list of model ids');
  }
  return models;
}

interface TierAssignmentRow {
  tier?: string;
  override_route?: unknown;
  fallback_routes?: unknown;
}

interface HeaderTierListRow {
  name?: string;
  header_key?: string;
  header_value?: string;
  enabled?: boolean;
  override_route?: unknown;
  fallback_routes?: unknown;
}

/**
 * The composite readback for everything `agent configure` writes: default
 * route + fallbacks, custom tiers with their triggers and routes, and the
 * autofix/recording toggles. (The backend's /status endpoint only reports the
 * deprecated complexity-routing flag, so this composes the real config.)
 */
export async function routingStatus(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const { client } = clientFromFlags(io, args);

  const [tiers, customTiers, autofix, recording] = await Promise.all([
    client.request('GET', agentPath(agent, '/tiers')),
    client.request('GET', agentPath(agent, '/header-tiers')),
    client.request('GET', agentPath(agent, '/autofix')),
    client.request('GET', agentPath(agent, '/recording')),
  ]);

  const defaultTier = (Array.isArray(tiers) ? tiers : [])
    .filter((t): t is TierAssignmentRow => typeof t === 'object' && t !== null)
    .find((t) => t.tier === 'default');

  const custom = (Array.isArray(customTiers) ? customTiers : [])
    .filter((t): t is HeaderTierListRow => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: t.name,
      trigger: `${t.header_key}: ${t.header_value}`,
      enabled: t.enabled,
      route: t.override_route ?? null,
      fallbacks: t.fallback_routes ?? [],
    }));

  printJson(io, {
    agent,
    default: {
      route: defaultTier?.override_route ?? null,
      fallbacks: defaultTier?.fallback_routes ?? [],
    },
    custom_tiers: custom,
    autofix: (autofix as { enabled?: boolean } | null)?.enabled ?? null,
    recording: (recording as { enabled?: boolean } | null)?.enabled ?? null,
  });
}

export async function routingFallbacksGet(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const { client } = clientFromFlags(io, args);
  printJson(io, await client.request('GET', agentPath(agent, '/tiers/default/fallbacks')));
}

export async function routingFallbacksClear(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], booleans: ['yes'], maxPositionals: 1 });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  requireYes(args, `clear the default-route fallbacks of "${agent}"`);
  const { client } = clientFromFlags(io, args);
  printJson(io, await client.request('DELETE', agentPath(agent, '/tiers/default/fallbacks')));
}

interface HeaderTierRow {
  id?: string;
  name?: string;
}

async function findCustomTier(
  client: ApiClient,
  agent: string,
  nameOrId: string,
): Promise<{ id: string; name: string }> {
  const rows = (await client.request('GET', agentPath(agent, '/header-tiers'))) as unknown;
  const list = (Array.isArray(rows) ? rows : []).filter(
    (t): t is HeaderTierRow => typeof t === 'object' && t !== null,
  );
  const needle = nameOrId.toLowerCase();
  const hit = list.find(
    (t) => t.id === nameOrId || (typeof t.name === 'string' && t.name.toLowerCase() === needle),
  );
  if (!hit?.id) {
    throw new CliError(
      'not_found',
      `No custom tier "${nameOrId}" on agent "${agent}"`,
      'See mnfst routing custom list',
      404,
    );
  }
  return { id: hit.id, name: typeof hit.name === 'string' ? hit.name : hit.id };
}

export const routingCustom = {
  list: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
    const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
    const { client } = clientFromFlags(io, args);
    printJson(io, await client.request('GET', agentPath(agent, '/header-tiers')));
  },

  /**
   * Create a custom tier and route it in one command. The tier triggers on
   * `<header-key>: <header-value>` (defaults: x-manifest-tier: <name>), so a
   * caller opts in per request with a single header.
   *
   * Models are validated against the agent's discovered set — the same gate
   * `agent configure` applies, so the two ways of writing a route cannot
   * disagree — and the check runs BEFORE the tier is created so a typo does
   * not leave an unrouted tier behind. --force skips it.
   */
  create: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, {
      strings: [
        'url',
        'name',
        'model',
        'provider',
        'auth-type',
        'fallbacks',
        'header-key',
        'header-value',
      ],
      booleans: ['force'],
      maxPositionals: 1,
    });
    const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
    const name = requireString(args, 'name');
    const model = requireString(args, 'model');
    const provider = requireString(args, 'provider');
    const fallbackModels = args.strings['fallbacks']
      ? parseModelsList(args.strings['fallbacks'])
      : [];
    const { client } = clientFromFlags(io, args);
    const normalized = await assertModelsDiscovered(
      client,
      agent,
      [model, ...fallbackModels],
      Boolean(args.booleans['force']),
      provider,
      args.strings['auth-type'] ?? 'api_key',
    );
    const routeModel = normalized[0];
    const normalizedFallbacks = normalized.slice(1);

    const tier = (await client.request('POST', agentPath(agent, '/header-tiers'), {
      body: {
        name,
        header_key: args.strings['header-key'] ?? 'x-manifest-tier',
        header_value: args.strings['header-value'] ?? name,
        badge_color: 'indigo',
      },
    })) as { id: string };

    const route = { model: routeModel, provider, authType: args.strings['auth-type'] ?? 'api_key' };
    let routeResult: unknown;
    let fallbacks: unknown;
    try {
      routeResult = await client.request(
        'PUT',
        agentPath(agent, `/header-tiers/${encodeURIComponent(tier.id)}/override`),
        { body: route },
      );
      if (normalizedFallbacks.length > 0) {
        fallbacks = await client.request(
          'PUT',
          agentPath(agent, `/header-tiers/${encodeURIComponent(tier.id)}/fallbacks`),
          { body: { models: normalizedFallbacks } },
        );
      }
    } catch (error) {
      // Roll back the tier so a failed route-write does not leave an enabled,
      // unrouted tier behind. Best-effort: surface the original error.
      await client
        .request('DELETE', agentPath(agent, `/header-tiers/${encodeURIComponent(tier.id)}`))
        .catch(() => undefined);
      throw error;
    }
    printJson(io, {
      agent,
      tier,
      route: routeResult,
      ...(fallbacks !== undefined ? { fallbacks } : {}),
    });
  },

  delete: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, { strings: ['url'], booleans: ['yes'], maxPositionals: 2 });
    const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
    const nameOrId = requirePositional(args, 1, '<tier-name-or-id>');
    const { client } = clientFromFlags(io, args);
    const tier = await findCustomTier(client, agent, nameOrId);
    requireYes(args, `delete custom tier "${tier.name}" of "${agent}"`);
    printJson(
      io,
      await client.request(
        'DELETE',
        agentPath(agent, `/header-tiers/${encodeURIComponent(tier.id)}`),
      ),
    );
  },
};

const TEST_TIMEOUT_MS = 120_000;

/**
 * Which proxy surface a platform's real traffic uses — read from the
 * generated catalog (source of truth: manifest-shared PLATFORM_API_SURFACES),
 * so a platform added in Manifest gets the right test surface automatically.
 */
const SURFACE_BY_PLATFORM = new Map(PLATFORM_CATALOG.map((p) => [p.id, p.surface]));

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

/** OpenAI Responses API: reply lives in `output[].content[].output_text`. */
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

/**
 * Whether the parsed body carries the fields the selected surface must return.
 * A 2xx with `{}` or `[]` must not read as a verified route.
 */
function hasSurfacePayload(surface: string, parsed: Record<string, unknown>): boolean {
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  if (surface === 'messages') return nonEmpty(parsed['content']);
  if (surface === 'responses') return nonEmpty(parsed['output']);
  return nonEmpty(parsed['choices']);
}

/**
 * Send ONE real request through the agent's route to prove the config works
 * end-to-end — the closing move after `agent configure`. Not an inference
 * client: fixed shape, canned default prompt, facts-first output. Manifest
 * errors that the proxy wraps as HTTP-200 assistant text are unmasked into
 * real failures so a broken route can never look like an answer.
 */
export async function routingTest(io: CliIo, argv: string[]): Promise<number | void> {
  const args = parseArgs(argv, { strings: ['url', 'tier', 'model', 'as'] });
  const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const prompt = args.positionals.slice(1).join(' ').trim() || 'Reply with exactly: OK';

  // Surface selection: --as override, else the agent's own stored platform.
  // An unknown --as would silently fall back to chat_completions and test the
  // wrong surface, so it fails loudly — before any network call, like agent
  // create's --platform.
  let platform: string | undefined = args.strings['as'];
  if (platform !== undefined && !SURFACE_BY_PLATFORM.has(platform)) {
    throw new CliError(
      'invalid_platform',
      `Unknown platform: ${platform}. Valid platforms: ${[...SURFACE_BY_PLATFORM.keys()].join(', ')}`,
      'Run mnfst agent platforms to list them',
    );
  }

  const resolved = await resolveAgentKey(io, args, agent);
  if (!platform) {
    const { client } = clientFromFlags(io, args);
    const info = (await client.request('GET', `/agents/${encodeURIComponent(agent)}`)) as {
      agent: { agent_platform?: string | null } | null;
    };
    platform = info.agent?.agent_platform ?? undefined;
  }
  const surface = SURFACE_BY_PLATFORM.get(platform ?? '') ?? 'chat_completions';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const started = Date.now();
  const endpoint =
    surface === 'messages'
      ? `${resolved.origin}/v1/messages`
      : surface === 'responses'
        ? `${resolved.origin}/v1/responses`
        : `${resolved.origin}/v1/chat/completions`;
  const requestBody =
    surface === 'messages'
      ? {
          // "auto" means "route me" on every public surface, /v1/messages
          // included — a concrete model is what the proxy reads as an explicit
          // route override. --model is that override when the caller wants it.
          model: args.strings['model'] ?? 'auto',
          max_tokens: 64,
          messages: [{ role: 'user', content: prompt }],
        }
      : surface === 'responses'
        ? {
            model: args.strings['model'] ?? 'auto',
            input: prompt,
          }
        : {
            model: args.strings['model'] ?? 'auto',
            messages: [{ role: 'user', content: prompt }],
          };
  let response: Response;
  let text: string;
  try {
    response = await io.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.key}`,
        'Content-Type': 'application/json',
        // Node's fetch sends `User-Agent: node` by default, which makes a CLI
        // test request indistinguishable from any other Node caller in the
        // gateway's caller_attribution. Same value ApiClient sends.
        'User-Agent': CLI_USER_AGENT,
        ...(surface === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...(args.strings['tier'] ? { 'x-manifest-tier': args.strings['tier'] } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    // Consume the body inside the abort scope so a stalled response cannot
    // hang the verifier after the timer was cleared.
    text = await response.text();
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${resolved.origin}: ${error instanceof Error ? error.message : String(error)}`,
      'Check the URL and that the Manifest server is running',
    );
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - started;

  let parsed: Record<string, unknown> = {};
  let parsedOk = false;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw === 'object' && raw !== null) {
      parsed = raw as Record<string, unknown>;
      parsedOk = true;
    }
  } catch {
    /* non-JSON body → handled below */
  }
  if (!response.ok) {
    const err = (parsed['error'] as { message?: string } | undefined)?.message;
    throw new CliError(
      'route_test_failed',
      err ?? `Route test failed with HTTP ${response.status}`,
      'See mnfst routing status ' + agent,
      response.status,
    );
  }
  // A 2xx without the surface's payload is not a verified route; without this
  // the surface parser returns an empty reply and the test falsely passes.
  if (!parsedOk || !hasSurfacePayload(surface, parsed)) {
    throw new CliError(
      'route_test_failed',
      `Route test got HTTP ${response.status} but no ${surface} payload`,
      'See mnfst routing status ' + agent,
      response.status,
    );
  }

  const result =
    surface === 'messages'
      ? parseMessagesSurface(parsed)
      : surface === 'responses'
        ? parseResponsesSurface(parsed)
        : parseCompletionSurface(parsed);
  if (/^\[🦚 Manifest M\d+\]/.test(result.reply)) {
    throw new CliError('route_test_failed', result.reply, 'See mnfst routing status ' + agent);
  }

  printJson(io, {
    agent,
    ok: true,
    surface,
    ...(platform ? { platform } : {}),
    requested_model: (requestBody as { model: string }).model,
    ...(args.strings['tier'] ? { tier: args.strings['tier'] } : {}),
    served_model: result.servedModel,
    duration_ms: durationMs,
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    reply: result.reply,
  });
}

function toggleCommand(feature: 'autofix' | 'recording') {
  return {
    get: async (io: CliIo, argv: string[]): Promise<void> => {
      const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
      const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
      const { client } = clientFromFlags(io, args);
      printJson(io, await client.request('GET', agentPath(agent, `/${feature}`)));
    },
    set: async (io: CliIo, argv: string[]): Promise<void> => {
      const args = parseArgs(argv, { strings: ['url', 'enabled'], maxPositionals: 1 });
      const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
      const enabled = parseBooleanFlag(requireString(args, 'enabled'), 'enabled');
      const { client } = clientFromFlags(io, args);
      printJson(
        io,
        await client.request('PATCH', agentPath(agent, `/${feature}`), { body: { enabled } }),
      );
    },
  };
}

export const routingAutofix = toggleCommand('autofix');
export const routingRecording = toggleCommand('recording');

function tierParamsPath(agent: string, tier: string | undefined): string {
  return agentPath(agent, `/tiers/${encodeURIComponent(tier ?? 'default')}/model-params`);
}

/** `path=value`: the value is JSON when it parses (numbers, booleans, objects), else a string. */
function parseParamAssignment(raw: string): [string, unknown] {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    throw new CliError(
      'invalid_flag',
      `--set expects <path>=<value>, got "${raw}"`,
      'Example: --set reasoning.effort=high',
    );
  }
  const text = raw.slice(eq + 1);
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: keep the literal string (e.g. `high`).
  }
  return [raw.slice(0, eq), value];
}

/**
 * Model params of one routed model, addressed as tier + model: `--tier` is
 * `default` (the default) or a custom tier's name, `--model` defaults to the
 * tier's primary and may name one of its fallbacks. Saved params override the
 * values the calling app sends, on requests Manifest routes (`model: "auto"`
 * or a matching custom-tier header); a request naming a model skips them.
 */
export const routingParams = {
  get: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, { strings: ['url', 'tier', 'model'], maxPositionals: 1 });
    const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
    const { client } = clientFromFlags(io, args);
    printJson(
      io,
      await client.request('GET', tierParamsPath(agent, args.strings['tier']), {
        query: { model: args.strings['model'] },
      }),
    );
  },
  set: async (io: CliIo, argv: string[]): Promise<void> => {
    const args = parseArgs(argv, {
      strings: ['url', 'tier', 'model'],
      repeatables: ['set', 'unset'],
      maxPositionals: 1,
    });
    const agent = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
    const assignments = (args.lists['set'] ?? []).map(parseParamAssignment);
    const unset = args.lists['unset'] ?? [];
    if (assignments.length === 0 && unset.length === 0) {
      throw new CliError(
        'missing_flag',
        'Pass at least one --set <path>=<value> or --unset <path>',
        `Run mnfst routing params get ${agent} to list the available params`,
      );
    }
    const { client } = clientFromFlags(io, args);
    printJson(
      io,
      await client.request('PATCH', tierParamsPath(agent, args.strings['tier']), {
        query: { model: args.strings['model'] },
        body: {
          ...(assignments.length > 0 ? { set: Object.fromEntries(assignments) } : {}),
          ...(unset.length > 0 ? { unset } : {}),
        },
      }),
    );
  },
};
