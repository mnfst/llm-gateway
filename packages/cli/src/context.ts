import { ApiClient } from './client';
import {
  CliConfig,
  Env,
  configFilePath,
  loadConfig,
  resolveTarget,
  ResolvedTarget,
} from './config';
import { CliError } from './errors';
import { ParsedArgs } from './args';

/**
 * Everything a command touches from the outside world, injected so tests can
 * run commands hermetically.
 */
export interface CliIo {
  env: Env;
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin: () => Promise<string>;
  /**
   * True when attached to an interactive terminal — gates browser login.
   * Wired from stderr, not stdout: stdout is JSON-only and is routinely piped
   * (`mnfst login | jq`), which must not disable browser login.
   */
  isTTY: boolean;
  /** Injected browser opener; falls back to defaultOpenBrowser. Returns false when opening failed. */
  openBrowser?: (url: string) => boolean;
  /** Injected child-process runner for `mnfst run`; defaults to stdio-inherit spawn. */
  spawnImpl?: (
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => Promise<number>;
  /**
   * Hidden-input prompt (echo off, prompt on stderr) for interactive secret
   * entry. Only wired when the process has a TTY; absent in scripts/agents,
   * which must use the explicit --credential flags.
   */
  readSecret?: (promptText: string) => Promise<string>;
  /** Visible-input prompt on stderr for interactive choices; TTY-only like readSecret. */
  readLine?: (promptText: string) => Promise<string>;
}

export function getConfigPath(io: CliIo): string {
  return configFilePath(io.env);
}

export function getConfig(io: CliIo): CliConfig {
  return loadConfig(getConfigPath(io));
}

export function resolveFromFlags(io: CliIo, args: ParsedArgs): ResolvedTarget {
  // An explicit env credential + target needs nothing from the stored config,
  // so a corrupt config file must not abort scripted commands.
  const envCredential = io.env['MANIFEST_API_KEY'];
  const explicitTarget = args.strings['url'] ?? io.env['MANIFEST_URL'];
  const config = envCredential && explicitTarget ? {} : getConfig(io);
  return resolveTarget(args.strings['url'], io.env, config);
}

/** Build an authenticated client, failing closed when no credential resolves. */
export function clientFromFlags(
  io: CliIo,
  args: ParsedArgs,
): { client: ApiClient; target: ResolvedTarget } {
  const target = resolveFromFlags(io, args);
  if (!target.apiKey) {
    throw new CliError(
      'not_authenticated',
      `No credential for ${target.origin}`,
      'Run mnfst login, or set MANIFEST_API_KEY',
      401,
    );
  }
  return {
    client: new ApiClient({
      origin: target.origin,
      apiKey: target.apiKey,
      fetchImpl: io.fetchImpl,
    }),
    target,
  };
}

export function printJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2));
}
