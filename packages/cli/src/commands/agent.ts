import { CliIo, clientFromFlags, printJson } from '../context';
import { CliError } from '../errors';
import { ParsedArgs, parseArgs, requirePositional, requireString, requireYes } from '../args';
import { keyPrefixOf, validateKeyFileDestination, writeKeyFile } from '../secrets';
import { agentKeyPath, deleteAgentKey, readAgentKey, saveAgentKey } from '../keystore';
import { slugifyAgentName } from '../slug';
import { CATEGORY_CATALOG, PLATFORM_CATALOG, SETUP_TEMPLATES } from '../provider-catalog.gen';

const URL_ONLY = { strings: ['url'] } as const;

/**
 * Platforms come from the generated catalog (manifest-shared is the source of
 * truth; `npm run gen` refreshes it at build, a drift spec pins it) — a new
 * platform in Manifest lands in the CLI on the next build, never by hand.
 */
export const CLI_AGENT_PLATFORMS: readonly string[] = PLATFORM_CATALOG.map((p) => p.id);

function requirePlatform(args: ParsedArgs): string {
  const list = CLI_AGENT_PLATFORMS.join(', ');
  const value = args.strings['platform'];
  if (!value) {
    throw new CliError(
      'missing_platform',
      `--platform is required (it determines the agent setup). Valid platforms: ${list}`,
      'Run mnfst agent platforms to list them',
    );
  }
  if (!(CLI_AGENT_PLATFORMS as readonly string[]).includes(value)) {
    throw new CliError(
      'invalid_platform',
      `Unknown platform: ${value}. Valid platforms: ${list}`,
      'Run mnfst agent platforms to list them',
    );
  }
  return value;
}

/**
 * Categories are validated client-side against the generated catalog (source
 * of truth: manifest-shared AGENT_CATEGORIES) so a typo fails before any
 * network call, with the valid values in the message.
 */
function validateCategory(args: ParsedArgs): string | undefined {
  const value = args.strings['category'];
  if (value === undefined) return undefined;
  if (!CATEGORY_CATALOG.includes(value)) {
    throw new CliError(
      'invalid_category',
      `Unknown category: ${value}. Valid categories: ${CATEGORY_CATALOG.join(', ')}`,
    );
  }
  return value;
}

/**
 * The masked stand-in for the agent key in setup text. Deliberately NOT a
 * shell command substitution: the snippets embed it in JSON and single-quoted
 * contexts where no shell would expand it, so a literal placeholder that names
 * the command to run is the honest rendering — a human or agent substitutes it.
 * The origin is pinned so the key command resolves THIS host, even when setup
 * was generated with `--url` against a non-active login.
 */
function maskedKeyRef(slug: string, origin: string): string {
  return `<MNFST_AGENT_KEY — run: mnfst agent key show ${slug} --raw --url ${origin}>`;
}

/**
 * Render the platform's setup instructions. Templates come from
 * manifest-shared (the dashboard shows the same content); platforms without
 * a first-class snippet get generic OpenAI-compatible wiring guidance.
 * The key is masked by default so setup text is safe to log; `keyRef` carries
 * the real key on --reveal.
 */
function renderSetup(platform: string | undefined, origin: string, keyRef: string): string {
  const template = platform ? SETUP_TEMPLATES[platform] : undefined;
  if (template) {
    return template.replaceAll('{{ORIGIN}}', origin).replaceAll('{{API_KEY}}', keyRef);
  }
  return [
    `Point your tool's OpenAI-compatible client at Manifest:`,
    `  base URL: ${origin}/v1`,
    `  API key:  ${keyRef}`,
    `Or wire it via env: mnfst agent env <name> --url ${origin} >> .env`,
  ].join('\n');
}

export async function agentSetup(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], booleans: ['reveal'], maxPositionals: 1 });
  const name = requirePositional(args, 0, '<agent-name>');
  const slug = slugifyAgentName(name);
  const { client, target } = clientFromFlags(io, args);
  const info = (await client.request('GET', `/agents/${encodeURIComponent(slug)}`)) as {
    agent: { agent_platform?: string | null } | null;
  };
  if (!info.agent) {
    throw new CliError('not_found', `Agent "${slug}" not found`, 'See mnfst agent list', 404);
  }
  const keyRef = args.booleans['reveal']
    ? (await resolveAgentKey(io, args, slug)).key
    : maskedKeyRef(slug, target.origin);
  printJson(io, {
    agent: slug,
    platform: info.agent.agent_platform ?? null,
    setup: renderSetup(info.agent.agent_platform ?? undefined, target.origin, keyRef),
    ...(args.booleans['reveal'] ? {} : { hint: 'Pass --reveal to embed the real key' }),
  });
}

export async function agentPlatforms(io: CliIo, argv: string[]): Promise<void> {
  parseArgs(argv, { maxPositionals: 0 });
  printJson(io, { platforms: [...CLI_AGENT_PLATFORMS] });
}

export async function agentList(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url'],
    booleans: ['include-playground'],
    maxPositionals: 0,
  });
  const { client } = clientFromFlags(io, args);
  const result = await client.request('GET', '/agents', {
    query: { includePlayground: args.booleans['include-playground'] ? 'true' : undefined },
  });
  printJson(io, stripSparklines(result));
}

/**
 * The agents endpoint bundles per-agent `sparkline` series for the
 * dashboard's mini-charts. Terminal and agent consumers have no use for
 * render-only data, so drop it rather than make every caller skip it.
 */
function stripSparklines(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record['agents'])) return result;
  return {
    ...record,
    agents: record['agents'].map((agent) => {
      if (typeof agent !== 'object' || agent === null) return agent;
      const rest = { ...(agent as Record<string, unknown>) };
      delete rest['sparkline'];
      return rest;
    }),
  };
}

export async function agentCreate(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'name', 'key-file', 'category', 'platform'],
    booleans: ['if-absent'],
    maxPositionals: 0,
  });
  const name = requireString(args, 'name');
  const platform = requirePlatform(args);
  const category = validateCategory(args);
  // --key-file is an explicit override; the default home is the managed
  // keystore, so nobody has to invent a path to avoid printing a secret.
  const keyFile = args.strings['key-file']
    ? validateKeyFileDestination(args.strings['key-file'])
    : null;
  const { client, target } = clientFromFlags(io, args);

  let result: { agent: unknown; apiKey: string };
  try {
    result = (await client.request('POST', '/agents', {
      body: {
        name,
        agent_platform: platform,
        ...(category ? { agent_category: category } : {}),
      },
    })) as { agent: unknown; apiKey: string };
  } catch (error) {
    // --if-absent makes create re-runnable: an existing agent is success,
    // resolved to the same output shape (key from keystore/server recovery).
    if (args.booleans['if-absent'] && error instanceof CliError && error.status === 409) {
      const slug = slugifyAgentName(name);
      const existing = (await client.request('GET', `/agents/${encodeURIComponent(slug)}`)) as {
        agent: { agent_platform?: string | null } | null;
      };
      const resolved = await resolveAgentKey(io, args, slug);
      if (keyFile) writeKeyFile(keyFile, resolved.key);
      printJson(io, {
        agent: existing.agent,
        existed: true,
        keyPrefix: keyPrefixOf(resolved.key),
        ...(keyFile ? { keyFile } : {}),
        keyPath: resolved.path,
        // Same wiring instructions the create path prints — an --if-absent
        // re-run is the idempotent setup path, so it must not be poorer.
        // The stored platform wins: it is what the agent actually is.
        setup: renderSetup(
          existing.agent?.agent_platform ?? platform,
          target.origin,
          maskedKeyRef(slug, target.origin),
        ),
      });
      return;
    }
    throw error;
  }

  // The keystore is the CLI's memory of the key — ALWAYS refresh it, or
  // run/key-show would keep serving a stale credential after this mutation.
  const keyPath = saveAgentKey(io.env, target.origin, slugifyAgentName(name), result.apiKey);
  if (keyFile) {
    writeKeyFile(keyFile, result.apiKey);
    printJson(io, { agent: result.agent, keyPrefix: keyPrefixOf(result.apiKey), keyFile, keyPath });
    return;
  }
  printJson(io, {
    agent: result.agent,
    keyPrefix: keyPrefixOf(result.apiKey),
    keyPath,
    setup: renderSetup(
      platform,
      target.origin,
      maskedKeyRef(slugifyAgentName(name), target.origin),
    ),
  });
}

export async function agentGet(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const { client } = clientFromFlags(io, args);
  const result = (await client.request('GET', `/agents/${encodeURIComponent(name)}`)) as {
    agent: unknown | null;
  };
  // The API returns 200 { agent: null } for a missing agent — normalize.
  if (!result.agent) {
    throw new CliError('not_found', `Agent "${name}" not found`, 'See mnfst agent list', 404);
  }
  printJson(io, result);
}

export async function agentUpdate(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'name', 'category', 'platform'],
    maxPositionals: 1,
  });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const category = validateCategory(args);
  const body: Record<string, string> = {};
  if (args.strings['name']) body['name'] = args.strings['name'];
  if (category) body['agent_category'] = category;
  if (args.strings['platform']) body['agent_platform'] = args.strings['platform'];
  if (Object.keys(body).length === 0) {
    throw new CliError(
      'missing_flag',
      'Nothing to update — pass --name, --category, or --platform',
    );
  }
  const { client, target } = clientFromFlags(io, args);
  const result = await client.request('PATCH', `/agents/${encodeURIComponent(name)}`, { body });
  // A rename must MOVE the cached key. Leaving it under the old name would let
  // a later agent that reuses that name inherit this agent's key from cache.
  if (body['name'] !== undefined) {
    const nextName = slugifyAgentName(body['name']);
    if (nextName !== name) {
      const cached = readAgentKey(io.env, target.origin, name);
      if (cached) saveAgentKey(io.env, target.origin, nextName, cached);
      deleteAgentKey(io.env, target.origin, name);
    }
  }
  printJson(io, result);
}

export async function agentDelete(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], booleans: ['yes'], maxPositionals: 1 });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  requireYes(args, `delete agent "${name}"`);
  const { client, target } = clientFromFlags(io, args);
  const result = await client.request('DELETE', `/agents/${encodeURIComponent(name)}`);
  // The key died with the agent — drop the local cache entry too.
  deleteAgentKey(io.env, target.origin, name);
  printJson(io, result);
}

export async function agentRotateKey(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, {
    strings: ['url', 'key-file'],
    booleans: ['yes'],
    maxPositionals: 1,
  });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  requireYes(args, `rotate the API key of "${name}" (the previous key stops working)`);
  const keyFile = args.strings['key-file']
    ? validateKeyFileDestination(args.strings['key-file'])
    : null;
  const { client, target } = clientFromFlags(io, args);
  const result = (await client.request(
    'POST',
    `/agents/${encodeURIComponent(name)}/rotate-key`,
  )) as { apiKey: string };
  const keyPath = saveAgentKey(io.env, target.origin, name, result.apiKey);
  if (keyFile) {
    writeKeyFile(keyFile, result.apiKey);
    printJson(io, { rotated: true, keyPrefix: keyPrefixOf(result.apiKey), keyFile, keyPath });
    return;
  }
  printJson(io, { rotated: true, keyPrefix: keyPrefixOf(result.apiKey), keyPath });
}

/**
 * Resolve an agent's key: keystore first, else recover the server's copy and
 * re-cache it. Returns the raw key and where it came from.
 */
export async function resolveAgentKey(
  io: CliIo,
  args: ParsedArgs,
  name: string,
): Promise<{ key: string; path: string; origin: string; source: 'keystore' | 'server' }> {
  const { client, target } = clientFromFlags(io, args);
  const cached = readAgentKey(io.env, target.origin, name);
  if (cached) {
    return {
      key: cached,
      path: agentKeyPath(io.env, target.origin, name),
      origin: target.origin,
      source: 'keystore',
    };
  }
  const result = (await client.request('GET', `/agents/${encodeURIComponent(name)}/key`)) as {
    keyPrefix: string;
    apiKey?: string;
  };
  if (!result.apiKey) {
    throw new CliError(
      'key_unrecoverable',
      `The server cannot recover the key for "${name}"`,
      `Run mnfst agent rotate-key ${name} --yes to mint a fresh one`,
    );
  }
  const path = saveAgentKey(io.env, target.origin, name, result.apiKey);
  return { key: result.apiKey, path, origin: target.origin, source: 'server' };
}

export async function agentKeyPathCmd(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { ...URL_ONLY, maxPositionals: 1 });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const resolved = await resolveAgentKey(io, args, name);
  printJson(io, { agent: name, path: resolved.path, source: resolved.source });
}

/**
 * Emit the agent's connection config as env lines — the mainstream wiring
 * path: `mnfst agent env my-bot >> .env`, or eval `--export` in a shell, or
 * pipe into a platform CLI (railway variables set, vercel env add, ...).
 * Deliberately prints the raw key, like `agent key show`.
 */
export async function agentEnv(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], booleans: ['export'], maxPositionals: 1 });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const resolved = await resolveAgentKey(io, args, name);
  const prefix = args.booleans['export'] ? 'export ' : '';
  io.stdout(`${prefix}MANIFEST_AGENT_KEY=${resolved.key}`);
  io.stdout(`${prefix}MANIFEST_AGENT_URL=${resolved.origin}/v1`);
}

/**
 * Prints the raw key — the one deliberate, greppable way to surface it.
 * `--raw` prints the bare key with no JSON envelope, so it can be piped or
 * substituted into a config file; the key still never rides in argv.
 */
export async function agentKeyShow(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], booleans: ['raw'], maxPositionals: 1 });
  const name = slugifyAgentName(requirePositional(args, 0, '<agent-name>'));
  const resolved = await resolveAgentKey(io, args, name);
  if (args.booleans['raw']) {
    io.stdout(resolved.key);
    return;
  }
  printJson(io, { agent: name, apiKey: resolved.key });
}
