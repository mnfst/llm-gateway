import * as fs from 'fs';
import * as path from 'path';
import { Env, configFilePath } from './config';

/**
 * CLI-managed agent-key store: `<config>/manifest/keys/<origin>/<agent>.key`,
 * files 0600 under 0700 directories. This is a cache, not the only copy —
 * the server keeps agent keys recoverable (encrypted at rest), so a lost
 * file heals via `mnfst agent key path|show`. Host-scoped like config.json
 * so a key minted on one host is never resolved for another.
 */
export function agentKeyPath(env: Env, origin: string, agentName: string): string {
  const base = path.dirname(configFilePath(env));
  return path.join(
    base,
    'keys',
    encodeURIComponent(origin),
    `${encodeURIComponent(agentName)}.key`,
  );
}

export function saveAgentKey(env: Env, origin: string, agentName: string, key: string): string {
  const filePath = agentKeyPath(env, origin, agentName);
  const originDir = path.dirname(filePath);
  const keysDir = path.dirname(originDir);
  fs.mkdirSync(originDir, { recursive: true, mode: 0o700 });
  // mkdirSync only applies mode on create, so an existing directory created
  // with broader permissions would keep them. Enforce the 0700 boundary.
  fs.chmodSync(keysDir, 0o700);
  fs.chmodSync(originDir, 0o700);
  fs.writeFileSync(filePath, key, { mode: 0o600 });
  // writeFileSync only applies mode on create — enforce on rewrite too.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export function deleteAgentKey(env: Env, origin: string, agentName: string): void {
  try {
    fs.unlinkSync(agentKeyPath(env, origin, agentName));
  } catch {
    // best-effort: nothing cached is a fine end state
  }
}

export function readAgentKey(env: Env, origin: string, agentName: string): string | null {
  try {
    const raw = fs.readFileSync(agentKeyPath(env, origin, agentName), 'utf8');
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
