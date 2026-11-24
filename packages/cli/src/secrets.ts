import * as fs from 'fs';
import * as path from 'path';
import { CliError } from './errors';
import { CliIo } from './context';

/**
 * Validate a key-file destination BEFORE the key-producing mutation runs, so
 * a bad path never strands a freshly minted secret.
 */
export function validateKeyFileDestination(keyFile: string): string {
  const absolute = path.resolve(keyFile);
  if (fs.existsSync(absolute)) {
    throw new CliError(
      'key_file_exists',
      `Refusing to overwrite existing file: ${absolute}`,
      'Pass a different --key-file path',
    );
  }
  const dir = path.dirname(absolute);
  let dirIsDirectory = false;
  try {
    dirIsDirectory = fs.statSync(dir).isDirectory();
  } catch {
    // Missing, raced, or unreadable: report it as an invalid destination
    // rather than leaking a raw internal error.
  }
  if (!dirIsDirectory) {
    throw new CliError(
      'key_file_dir_missing',
      `Not a directory: ${dir}`,
      'Create the directory first',
    );
  }
  return absolute;
}

/** Write a raw secret to disk with mode 0600. Callers print only the path + prefix. */
export function writeKeyFile(absolutePath: string, secret: string): void {
  // `wx` fails instead of following/overwriting a path that appeared (or was
  // swapped) after validation, so the fresh key can never clobber a file.
  try {
    fs.writeFileSync(absolutePath, secret, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // The file appeared between validation and now — the expected `wx` collision
    // is a normal user error, not an internal CLI bug. Check `code` directly:
    // the fs error can come from another realm, where `instanceof Error` is false.
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw new CliError(
        'key_file_exists',
        `Refusing to overwrite existing file: ${absolutePath}`,
        'Pass a different --key-file path',
      );
    }
    throw error;
  }
}

export function keyPrefixOf(secret: string): string {
  return secret.slice(0, 10);
}

/**
 * Read a credential from stdin or a named environment variable — never argv.
 * When neither source is given and the session is interactive, falls back to
 * a hidden-input prompt (io.readSecret); scripts and agents get the explicit
 * error instead.
 */
export async function readCredential(
  io: CliIo,
  useStdin: boolean,
  envName: string | undefined,
  what: string,
): Promise<string> {
  if (!useStdin && !envName && io.isTTY && io.readSecret) {
    const secret = (await io.readSecret(`Paste the ${what} (input hidden): `)).trim();
    if (!secret) {
      throw new CliError('credential_empty', `No ${what} entered`);
    }
    return secret;
  }
  if (useStdin === Boolean(envName)) {
    throw new CliError(
      'credential_source_required',
      `Provide the ${what} via exactly one of --${what === 'token' ? 'token' : 'credential'}-stdin or --${
        what === 'token' ? 'token' : 'credential'
      }-env <name>`,
      'Secrets are never accepted as command-line arguments',
    );
  }
  const raw = useStdin ? await io.readStdin() : (io.env[envName as string] ?? '');
  const secret = raw.trim();
  if (!secret) {
    throw new CliError(
      'credential_empty',
      useStdin
        ? `No ${what} received on stdin`
        : `Environment variable ${envName} is empty or unset`,
    );
  }
  return secret;
}
