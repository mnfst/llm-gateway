import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CliError } from './errors';

export const DEFAULT_URL = 'https://app.manifest.build';

export interface HostConfig {
  apiKey: string;
}

export interface CliConfig {
  activeHost?: string;
  hosts?: Record<string, HostConfig>;
}

export interface Env {
  [key: string]: string | undefined;
}

export function configFilePath(env: Env): string {
  const base = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(base, 'manifest', 'config.json');
}

/** Reduce any URL to a normalized origin — the only key credentials bind to. */
export function normalizeOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(
      'invalid_url',
      `Not a valid URL: ${url}`,
      'Pass a full origin like https://app.manifest.build',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('invalid_url', `Unsupported protocol: ${parsed.protocol}`);
  }
  return parsed.origin.toLowerCase();
}

export function loadConfig(filePath: string): CliConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      'config_corrupt',
      `Could not parse ${filePath}`,
      'Fix or delete the file, then run mnfst login again',
    );
  }
  // An array parses as an object but cannot hold hosts/apiKey, so returning it
  // (or {}) would silently drop the stored credential.
  if (Array.isArray(parsed)) {
    throw new CliError(
      'config_corrupt',
      `Invalid config shape (expected an object) in ${filePath}`,
      'Fix or delete the file, then run mnfst login again',
    );
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as CliConfig) : {};
}

export function saveConfig(filePath: string, config: CliConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync only applies mode on create — enforce on rewrite too.
  fs.chmodSync(filePath, 0o600);
}

export interface ResolvedTarget {
  origin: string;
  apiKey: string | null;
  /** Where the credential came from; null when unauthenticated. */
  source: 'env' | 'config' | null;
}

/**
 * Resolution order — url: --url flag, then MANIFEST_URL, then the active
 * config host, then Cloud. Credential: MANIFEST_API_KEY, then the stored
 * credential whose origin EXACTLY matches the target. A credential stored
 * for another host is never sent.
 */
export function resolveTarget(
  flagUrl: string | undefined,
  env: Env,
  config: CliConfig,
): ResolvedTarget {
  const origin = normalizeOrigin(
    flagUrl ?? env['MANIFEST_URL'] ?? config.activeHost ?? DEFAULT_URL,
  );
  const envKey = env['MANIFEST_API_KEY'];
  if (envKey) {
    return { origin, apiKey: envKey, source: 'env' };
  }
  const stored = config.hosts?.[origin]?.apiKey;
  if (stored) {
    return { origin, apiKey: stored, source: 'config' };
  }
  return { origin, apiKey: null, source: null };
}
