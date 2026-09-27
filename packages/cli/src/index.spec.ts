import * as fs from 'fs';
import * as path from 'path';
import { COMMANDS, resolveCommand, run, USAGE } from './index';
import { VERSION } from './version';
import { makeIo } from '../test/helpers';

describe('resolveCommand', () => {
  it('prefers the longest matching verb path', () => {
    expect(resolveCommand(['routing', 'custom', 'create', 'coding'])).toEqual({
      handler: COMMANDS['routing custom create'],
      key: 'routing custom create',
      rest: ['coding'],
    });
    expect(resolveCommand(['agent', 'list', '--include-playground'])).toEqual({
      handler: COMMANDS['agent list'],
      key: 'agent list',
      rest: ['--include-playground'],
    });
    expect(resolveCommand(['whoami'])).toEqual({
      handler: COMMANDS['whoami'],
      key: 'whoami',
      rest: [],
    });
  });

  it('returns null for unknown commands, including prototype members', () => {
    expect(resolveCommand(['nope'])).toBeNull();
    expect(resolveCommand(['toString'])).toBeNull();
    expect(resolveCommand(['constructor'])).toBeNull();
  });
});

describe('run', () => {
  it('prints usage on no args, help, and --help', async () => {
    for (const argv of [[], ['help'], ['--help']]) {
      const io = makeIo();
      expect(await run(io, argv as string[])).toBe(0);
      expect(io.lines[0]).toBe(USAGE);
    }
  });

  it('prints the version', async () => {
    const io = makeIo();
    expect(await run(io, ['--version'])).toBe(0);
    expect(io.lastJson()).toEqual({ version: VERSION });
  });

  it('reports unknown commands as error JSON with exit 1', async () => {
    const io = makeIo();
    expect(await run(io, ['frobnicate', 'now'])).toBe(1);
    expect(io.lastJson()).toEqual({
      error: 'unknown_command',
      message: 'Unknown command: frobnicate now',
      hint: 'Run mnfst --help',
    });
  });

  it('serializes CliError to the stable error contract', async () => {
    const io = makeIo();
    expect(await run(io, ['agent', 'delete', 'x'])).toBe(1);
    expect(io.lastJson()).toEqual({
      error: 'confirmation_required',
      message: 'Refusing to delete agent "x" without --yes',
      hint: 'Re-run with --yes to authorize this destructive operation',
    });
  });

  it('wraps unexpected exceptions as internal_error', async () => {
    const io = makeIo();
    // Corrupt config triggers CliError; force a non-CliError instead via a
    // fetch that throws a plain object (client wraps Errors, so break JSON).
    const originalStringify = JSON.stringify.bind(JSON);
    const spy = jest
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown, ...rest: unknown[]) => {
        if (
          typeof value === 'object' &&
          value !== null &&
          'path' in (value as Record<string, unknown>)
        ) {
          throw new Error('boom');
        }
        return originalStringify(value as never, ...(rest as [never, never]));
      });
    try {
      expect(await run(io, ['config', 'path'])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(io.lastJson()).toMatchObject({ error: 'internal_error', message: 'boom' });
  });

  it('usage documents every registered command group', () => {
    for (const key of Object.keys(COMMANDS)) {
      const firstWord = key.split(' ')[0];
      expect(USAGE).toContain(firstWord);
    }
  });

  it('usage advertises only flags the commands actually accept', () => {
    // `enable` has no --yes (nothing destructive to confirm); `disable` requires it.
    expect(USAGE).toContain(
      'mnfst agent provider enable <name> <provider> [--auth-type <a>] [--label <l>]\n',
    );
    expect(USAGE).toContain('mnfst agent provider disable <name> <provider>');
    expect(USAGE).toMatch(/agent provider disable[^\n]*--yes/);
    // Flags that existed but went undocumented.
    expect(USAGE).toMatch(/agent configure[^\n]*--key-label/);
    expect(USAGE).toMatch(/provider custom add[^\n]*--agent <name>/);
    expect(USAGE).toMatch(/provider custom list \[--agent <name>\]/);
    expect(USAGE).toMatch(/provider custom remove[^\n]*--agent <name>/);
    expect(USAGE).toMatch(/agent key show <name> \[--raw\]/);
    // --enabled belongs to `set`, not `get`.
    expect(USAGE).toContain(
      'mnfst routing autofix get <agent> | mnfst routing autofix set <agent> --enabled true|false',
    );
    expect(USAGE).toContain(
      'mnfst routing recording get <agent> | mnfst routing recording set <agent> --enabled true|false',
    );
    expect(USAGE).toContain('mnfst routing params get <agent> [--tier <t>] [--model <m>]\n');
    expect(USAGE).toMatch(
      /routing params set <agent>[^\n]*--set <path>=<value>[^\n]*--unset <path>/,
    );
  });

  it('usage names the persistent anonymous install id in the telemetry notice', () => {
    expect(USAGE).toContain('~/.config/manifest/telemetry-id');
    expect(USAGE).toContain('MANIFEST_TELEMETRY_DISABLED=1');
  });
});

describe('version constant', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});
