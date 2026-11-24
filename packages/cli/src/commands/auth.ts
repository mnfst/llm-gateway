import { ApiClient } from '../client';
import { loadConfig, normalizeOrigin, saveConfig, DEFAULT_URL } from '../config';
import { CliIo, clientFromFlags, getConfigPath, printJson, resolveFromFlags } from '../context';
import { parseArgs } from '../args';
import { readCredential } from '../secrets';
import { browserLogin } from '../oauth-login';
import { CliError } from '../errors';
import { SKILL_NUDGE } from './skill';

interface MeResponse {
  tenantId: string | null;
  userId: string | null;
  authMethod: string | null;
  expiresAt: string | null;
}

const LOGIN_FLAGS = { strings: ['token-env', 'url'], booleans: ['token-stdin'] } as const;

export async function login(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { ...LOGIN_FLAGS, maxPositionals: 0 });
  const origin = normalizeOrigin(args.strings['url'] ?? io.env['MANIFEST_URL'] ?? DEFAULT_URL);
  const useStdin = Boolean(args.booleans['token-stdin']);
  const tokenEnv = args.strings['token-env'];
  if (tokenEnv === '') {
    throw new CliError(
      'missing_value',
      '--token-env requires an environment variable name',
      'Pass a name, e.g. --token-env MANIFEST_TOKEN',
    );
  }

  const viaBrowser = !useStdin && tokenEnv === undefined;

  let token: string;
  let expiresAt: string | null = null;
  if (viaBrowser) {
    if (!io.isTTY) {
      throw new CliError(
        'no_tty',
        'Browser login needs an interactive terminal',
        'Use mnfst login --token-stdin or --token-env <name> in scripts',
      );
    }
    const result = await browserLogin(io, origin);
    token = result.token;
    expiresAt = result.expiresAt;
  } else {
    token = await readCredential(io, useStdin, tokenEnv, 'token');
  }

  const configPath = getConfigPath(io);
  const store = (): void => {
    const config = loadConfig(configPath);
    config.hosts = { ...config.hosts, [origin]: { apiKey: token } };
    config.activeHost = origin;
    saveConfig(configPath, config);
  };

  // Ordering differs by source, deliberately. A browser token was just minted
  // by this server, so it is valid by construction — store it BEFORE /me, or a
  // failing validation call strands a live 30-day PAT that the user can no
  // longer revoke with `mnfst logout`. A user-supplied token may be garbage, so
  // that path keeps validate-then-store and writes nothing on failure.
  if (viaBrowser) store();

  const client = new ApiClient({ origin, apiKey: token, fetchImpl: io.fetchImpl });
  let me: MeResponse;
  try {
    me = (await client.request('GET', '/me')) as MeResponse;
  } catch (error) {
    if (!viaBrowser) throw error;
    throw new CliError(
      'login_validation_failed',
      error instanceof Error ? error.message : String(error),
      `Credential stored for ${origin} — run mnfst auth status to retry, or mnfst logout to revoke`,
    );
  }
  if (!viaBrowser) store();

  printJson(io, {
    authenticated: true,
    url: origin,
    tenantId: me.tenantId,
    userId: me.userId,
    authMethod: me.authMethod,
    expiresAt: me.expiresAt ?? expiresAt,
    source: 'config',
  });
  // Stderr only: stdout is the JSON contract, and a fresh login is the one
  // moment an agent is certain to be reading this CLI's output.
  io.stderr(SKILL_NUDGE);
}

export async function logout(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], maxPositionals: 0 });
  const configPath = getConfigPath(io);
  const config = loadConfig(configPath);
  const origin = normalizeOrigin(
    args.strings['url'] ?? io.env['MANIFEST_URL'] ?? config.activeHost ?? DEFAULT_URL,
  );

  const stored = config.hosts?.[origin]?.apiKey;
  let revoked = false;
  if (stored) {
    try {
      const result = (await new ApiClient({
        origin,
        apiKey: stored,
        fetchImpl: io.fetchImpl,
      }).request('DELETE', '/cli/token')) as { revoked?: boolean } | null;
      revoked = Boolean(result?.revoked);
    } catch {
      // Best-effort: local logout must succeed even when the server is gone.
    }
  }

  const existed = Boolean(config.hosts?.[origin]);
  if (config.hosts) delete config.hosts[origin];
  if (config.activeHost === origin) delete config.activeHost;
  saveConfig(configPath, config);

  printJson(io, { loggedOut: existed, revoked, url: origin });
}

export async function authStatus(io: CliIo, argv: string[]): Promise<number | void> {
  const args = parseArgs(argv, { strings: ['url'], maxPositionals: 0 });
  const target = resolveFromFlags(io, args);
  if (!target.apiKey) {
    printJson(io, {
      authenticated: false,
      url: target.origin,
      hint: 'Run mnfst login, or set MANIFEST_API_KEY',
    });
    return 1;
  }
  const client = new ApiClient({
    origin: target.origin,
    apiKey: target.apiKey,
    fetchImpl: io.fetchImpl,
  });
  const me = (await client.request('GET', '/me')) as MeResponse;
  printJson(io, {
    authenticated: true,
    url: target.origin,
    source: target.source,
    tenantId: me.tenantId,
    userId: me.userId,
    authMethod: me.authMethod,
    expiresAt: me.expiresAt,
  });
}

export async function whoami(io: CliIo, argv: string[]): Promise<void> {
  const args = parseArgs(argv, { strings: ['url'], maxPositionals: 0 });
  const { client, target } = clientFromFlags(io, args);
  const me = (await client.request('GET', '/me')) as MeResponse;
  printJson(io, { url: target.origin, ...me });
}

export async function configPath(io: CliIo, argv: string[]): Promise<void> {
  parseArgs(argv, { maxPositionals: 0 });
  printJson(io, { path: getConfigPath(io) });
}
