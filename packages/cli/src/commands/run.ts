import { spawn } from 'child_process';
import { slugifyAgentName } from '../slug';
import { CliIo } from '../context';
import { CliError } from '../errors';
import { parseArgs, requireString } from '../args';
import { resolveAgentKey } from './agent';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Credentials that must never be inherited from the parent shell into a child. */
const RESERVED_CREDENTIAL_VARS = new Set(['MANIFEST_API_KEY', 'MANIFEST_AGENT_KEY']);

/** Spawn with inherited stdio; the child owns the terminal until it exits. */
export function defaultSpawn(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.on('error', (error: Error) => {
      reject(
        new CliError(
          'spawn_failed',
          `Could not run ${cmd}: ${error.message}`,
          'Check the command exists and is on PATH',
        ),
      );
    });
    child.on('exit', (code: number | null) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * 1Password-style injection: the child process receives the agent key in its
 * environment; the key never crosses stdout, argv, or any transcript. Usage:
 *   mnfst run --agent <name> [--env VAR] [--url <base>] -- <command...>
 */
export async function runCmd(io: CliIo, argv: string[]): Promise<number> {
  const sep = argv.indexOf('--');
  if (sep === -1) {
    throw new CliError(
      'missing_separator',
      'Usage: mnfst run --agent <name> -- <command...>',
      'Everything after -- runs with the agent key injected',
    );
  }
  const command = argv.slice(sep + 1);
  if (command.length === 0) {
    throw new CliError('missing_command', 'No command given after --');
  }

  const args = parseArgs(argv.slice(0, sep), {
    strings: ['url', 'agent', 'env'],
    maxPositionals: 0,
  });
  const agentName = slugifyAgentName(requireString(args, 'agent'));
  const explicitEnv = args.strings['env'];
  const envVar = explicitEnv ?? 'MANIFEST_AGENT_KEY';
  const upperEnvVar = envVar.toUpperCase();
  // The default target is MANIFEST_AGENT_KEY; only an explicit `--env` naming a
  // reserved credential is rejected. Writing the agent key under
  // MANIFEST_API_KEY would make a child trust a scoped key as a full-workspace
  // credential.
  if (
    !ENV_NAME_RE.test(envVar) ||
    upperEnvVar === 'MANIFEST_AGENT_URL' ||
    (explicitEnv !== undefined && RESERVED_CREDENTIAL_VARS.has(upperEnvVar))
  ) {
    throw new CliError(
      'invalid_env_name',
      `Not a valid --env name: ${envVar}`,
      'MANIFEST_AGENT_URL, MANIFEST_AGENT_KEY, and MANIFEST_API_KEY are reserved',
    );
  }

  const resolved = await resolveAgentKey(io, args, agentName);
  // The child gets the agent key, not the management credential: io.env may
  // carry MANIFEST_API_KEY (a full-workspace PAT) or a stale MANIFEST_AGENT_KEY
  // from the parent shell, and either would let tools call the wrong agent.
  // Env names are case-insensitive on Windows, so compare upper-cased.
  const childEnv: Record<string, string | undefined> = {
    ...Object.fromEntries(
      Object.entries(io.env).filter(
        ([name]) => !RESERVED_CREDENTIAL_VARS.has(name.toUpperCase()),
      ),
    ),
    [envVar]: resolved.key,
    MANIFEST_AGENT_URL: `${resolved.origin}/v1`,
  };
  const spawnImpl = io.spawnImpl ?? defaultSpawn;
  return spawnImpl(command[0], command.slice(1), childEnv);
}
