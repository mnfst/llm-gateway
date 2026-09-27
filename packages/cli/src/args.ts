import { CliError } from './errors';

export interface FlagSpec {
  /** Flags that take a value: `--flag value` or `--flag=value`. */
  strings?: readonly string[];
  /** Flags that are on/off: `--flag`. */
  booleans?: readonly string[];
  /** Valued flags that may repeat: `--set a=1 --set b=2`, collected in order. */
  repeatables?: readonly string[];
  /**
   * Maximum number of positionals this command accepts. Omit where the command
   * consumes the remainder on purpose (e.g. `routing test`'s prompt). A typo
   * past the last positional is then a hard error, not a silent no-op.
   */
  maxPositionals?: number;
}

export interface ParsedArgs {
  positionals: string[];
  strings: Record<string, string>;
  booleans: Record<string, boolean>;
  lists: Record<string, string[]>;
}

/**
 * Strict flag parser: every flag must be declared by the command; a valued
 * flag without a value and an unknown flag are hard errors so agents get a
 * hint instead of silently-ignored input.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const strings = new Set(spec.strings ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const repeatables = new Set(spec.repeatables ?? []);
  const out: ParsedArgs = { positionals: [], strings: {}, booleans: {}, lists: {} };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out.positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (booleans.has(name)) {
      if (eq !== -1) {
        throw new CliError('invalid_flag', `--${name} does not take a value`);
      }
      out.booleans[name] = true;
      continue;
    }
    if (!strings.has(name) && !repeatables.has(name)) {
      throw new CliError('unknown_flag', `Unknown flag --${name}`, usageHint(spec));
    }
    let value: string;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError('missing_value', `--${name} requires a value`);
      }
      value = next;
      i++;
    }
    if (repeatables.has(name)) (out.lists[name] ??= []).push(value);
    else out.strings[name] = value;
  }
  if (spec.maxPositionals !== undefined && out.positionals.length > spec.maxPositionals) {
    throw new CliError(
      'unexpected_argument',
      `Unexpected argument: ${out.positionals[spec.maxPositionals]}`,
      'Run mnfst --help for the command usage',
    );
  }
  return out;
}

function usageHint(spec: FlagSpec): string {
  const all = [...(spec.strings ?? []), ...(spec.repeatables ?? []), ...(spec.booleans ?? [])].map(
    (f) => `--${f}`,
  );
  return all.length ? `Supported flags: ${all.join(', ')}` : 'This command takes no flags';
}

export function requireString(args: ParsedArgs, name: string): string {
  const value = args.strings[name];
  if (value === undefined || value === '') {
    throw new CliError('missing_flag', `--${name} is required`);
  }
  return value;
}

export function requirePositional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new CliError('missing_argument', `Missing required argument: ${label}`);
  }
  return value;
}

export function requireYes(args: ParsedArgs, action: string): void {
  if (!args.booleans['yes']) {
    throw new CliError(
      'confirmation_required',
      `Refusing to ${action} without --yes`,
      'Re-run with --yes to authorize this destructive operation',
    );
  }
}

export function parseBooleanFlag(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliError('invalid_flag', `--${name} must be "true" or "false"`);
}
