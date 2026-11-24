import { parseArgs, parseBooleanFlag, requirePositional, requireString, requireYes } from './args';
import { CliError } from './errors';

describe('parseArgs', () => {
  const spec = { strings: ['name', 'url'], booleans: ['yes'] };

  it('parses positionals, valued flags, and booleans', () => {
    expect(parseArgs(['my-agent', '--name', 'x', '--yes', '--url=http://h'], spec)).toEqual({
      positionals: ['my-agent'],
      strings: { name: 'x', url: 'http://h' },
      booleans: { yes: true },
      lists: {},
    });
  });

  it('collects every occurrence of a repeatable flag in order', () => {
    const parsed = parseArgs(['--set', 'a=1', '--set=b=2', '--name', 'x'], {
      ...spec,
      repeatables: ['set'],
    });
    expect(parsed.lists).toEqual({ set: ['a=1', 'b=2'] });
    expect(parsed.strings).toEqual({ name: 'x' });
    expect(() => parseArgs(['--set'], { repeatables: ['set'] })).toThrow('requires a value');
  });

  it('lists repeatable flags in the unknown-flag hint', () => {
    try {
      parseArgs(['--nope'], { repeatables: ['set'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CliError).hint).toBe('Supported flags: --set');
    }
  });

  it('rejects unknown flags with the supported list as hint', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(CliError);
    try {
      parseArgs(['--nope'], spec);
    } catch (e) {
      expect((e as CliError).code).toBe('unknown_flag');
      expect((e as CliError).hint).toContain('--name');
    }
  });

  it('hints "no flags" for flagless commands', () => {
    try {
      parseArgs(['--x'], {});
    } catch (e) {
      expect((e as CliError).hint).toBe('This command takes no flags');
    }
  });

  it('rejects a valued flag without a value', () => {
    expect(() => parseArgs(['--name'], spec)).toThrow('requires a value');
    expect(() => parseArgs(['--name', '--yes'], spec)).toThrow('requires a value');
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['--yes=1'], spec)).toThrow('does not take a value');
  });

  it('rejects an extra positional when maxPositionals is set', () => {
    expect(parseArgs(['a', '--yes'], { ...spec, maxPositionals: 1 }).positionals).toEqual(['a']);
    try {
      parseArgs(['a', 'typo'], { maxPositionals: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CliError).code).toBe('unexpected_argument');
      expect((e as CliError).message).toContain('typo');
    }
    // Omitted cap means the remainder is consumed on purpose (e.g. routing test).
    expect(parseArgs(['a', 'b', 'c'], {}).positionals).toEqual(['a', 'b', 'c']);
  });
});

describe('require helpers', () => {
  const parsed = parseArgs(['pos0', '--name', 'n'], { strings: ['name'], booleans: ['yes'] });

  it('requireString returns present values and rejects missing/empty ones', () => {
    expect(requireString(parsed, 'name')).toBe('n');
    expect(() => requireString(parsed, 'url')).toThrow('--url is required');
    const empty = parseArgs(['--name='], { strings: ['name'] });
    expect(() => requireString(empty, 'name')).toThrow('--name is required');
  });

  it('requirePositional returns by index and names the missing argument', () => {
    expect(requirePositional(parsed, 0, '<agent>')).toBe('pos0');
    expect(() => requirePositional(parsed, 1, '<agent>')).toThrow('<agent>');
  });

  it('requireYes only passes when --yes was given', () => {
    expect(() => requireYes(parsed, 'delete it')).toThrow('Refusing to delete it');
    const withYes = parseArgs(['--yes'], { booleans: ['yes'] });
    expect(() => requireYes(withYes, 'delete it')).not.toThrow();
  });

  it('parseBooleanFlag accepts only true/false', () => {
    expect(parseBooleanFlag('true', 'enabled')).toBe(true);
    expect(parseBooleanFlag('false', 'enabled')).toBe(false);
    expect(() => parseBooleanFlag('yes', 'enabled')).toThrow('--enabled must be "true" or "false"');
  });
});
