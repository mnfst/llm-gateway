import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { keyPrefixOf, readCredential, validateKeyFileDestination, writeKeyFile } from './secrets';
import { CliError } from './errors';
import { makeIo } from '../test/helpers';

describe('key files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-secrets-'));

  it('accepts a fresh path in an existing directory and resolves it absolute', () => {
    const target = path.join(dir, 'agent.key');
    expect(validateKeyFileDestination(target)).toBe(target);
  });

  it('refuses to overwrite an existing file', () => {
    const target = path.join(dir, 'existing.key');
    fs.writeFileSync(target, 'x');
    expect(() => validateKeyFileDestination(target)).toThrow('Refusing to overwrite');
  });

  it('refuses a destination whose directory does not exist', () => {
    expect(() => validateKeyFileDestination(path.join(dir, 'missing-dir', 'agent.key'))).toThrow(
      'Not a directory',
    );
  });

  it('refuses a destination whose parent is a regular file', () => {
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(() => validateKeyFileDestination(path.join(file, 'agent.key'))).toThrow(
      'Not a directory',
    );
  });

  it('refuses to write when the destination appeared after validation', () => {
    const target = path.join(dir, 'raced.key');
    validateKeyFileDestination(target);
    // Another process creates the file between validation and write.
    fs.writeFileSync(target, 'someone-else');
    let error: unknown;
    try {
      writeKeyFile(target, 'mnfst_super_secret');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('key_file_exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('someone-else');
  });

  it('writes the secret with mode 0600', () => {
    const target = path.join(dir, 'written.key');
    writeKeyFile(target, 'mnfst_super_secret');
    expect(fs.readFileSync(target, 'utf8')).toBe('mnfst_super_secret');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('keyPrefixOf keeps only the first 10 characters', () => {
    expect(keyPrefixOf('mnfst_abcdefghij')).toBe('mnfst_abcd');
  });
});

describe('readCredential', () => {
  it('requires exactly one source', async () => {
    const io = makeIo();
    await expect(readCredential(io, false, undefined, 'token')).rejects.toThrow('exactly one');
    await expect(readCredential(io, true, 'VAR', 'token')).rejects.toThrow('exactly one');
  });

  it('reads and trims from stdin', async () => {
    const io = makeIo({ stdin: '  the-token\n' });
    expect(await readCredential(io, true, undefined, 'token')).toBe('the-token');
  });

  it('reads from a named environment variable', async () => {
    const io = makeIo({ env: { MY_KEY: 'env-token' } });
    expect(await readCredential(io, false, 'MY_KEY', 'credential')).toBe('env-token');
  });

  it('rejects empty stdin and unset env vars', async () => {
    await expect(readCredential(makeIo({ stdin: '\n' }), true, undefined, 'token')).rejects.toThrow(
      'No token received on stdin',
    );
    await expect(readCredential(makeIo(), false, 'UNSET_VAR', 'token')).rejects.toThrow(
      'UNSET_VAR',
    );
  });
});
