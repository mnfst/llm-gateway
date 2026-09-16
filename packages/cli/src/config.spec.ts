import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configFilePath,
  DEFAULT_URL,
  loadConfig,
  normalizeOrigin,
  resolveTarget,
  saveConfig,
} from './config';
import { CliError } from './errors';

function tmpFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-config-')),
    'manifest',
    'config.json',
  );
}

describe('configFilePath', () => {
  it('prefers XDG_CONFIG_HOME and falls back to ~/.config', () => {
    expect(configFilePath({ XDG_CONFIG_HOME: '/xdg' })).toBe(
      path.join('/xdg', 'manifest', 'config.json'),
    );
    expect(configFilePath({})).toBe(path.join(os.homedir(), '.config', 'manifest', 'config.json'));
  });
});

describe('normalizeOrigin', () => {
  it('reduces URLs to a lowercase origin', () => {
    expect(normalizeOrigin('HTTPS://App.Manifest.Build/dashboard?x=1')).toBe(
      'https://app.manifest.build',
    );
    expect(normalizeOrigin('http://localhost:2099/api')).toBe('http://localhost:2099');
  });

  it('rejects invalid URLs and non-http protocols', () => {
    expect(() => normalizeOrigin('not a url')).toThrow(CliError);
    expect(() => normalizeOrigin('ftp://host')).toThrow('Unsupported protocol');
  });
});

describe('loadConfig / saveConfig', () => {
  it('returns {} for a missing file', () => {
    expect(loadConfig(tmpFile())).toEqual({});
  });

  it('round-trips config and enforces mode 0600', () => {
    const file = tmpFile();
    saveConfig(file, {
      activeHost: 'http://localhost:2099',
      hosts: { 'http://localhost:2099': { apiKey: 'k' } },
    });
    expect(loadConfig(file)).toEqual({
      activeHost: 'http://localhost:2099',
      hosts: { 'http://localhost:2099': { apiKey: 'k' } },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('re-tightens permissions when overwriting an existing file', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    saveConfig(file, {});
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('raises config_corrupt on unparseable JSON and {} on a non-object', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json');
    expect(() => loadConfig(file)).toThrow('Could not parse');
    fs.writeFileSync(file, 'null');
    expect(loadConfig(file)).toEqual({});
    // A JSON array cannot hold config keys: it is reported, not silently dropped.
    fs.writeFileSync(file, '[]');
    let error: unknown;
    try {
      loadConfig(file);
    } catch (e) {
      error = e;
    }
    expect((error as CliError).code).toBe('config_corrupt');
  });
});

describe('resolveTarget', () => {
  const config = {
    activeHost: 'http://active:1000',
    hosts: {
      'http://active:1000': { apiKey: 'active-key' },
      'http://other:2000': { apiKey: 'other-key' },
    },
  };

  it('resolves url as flag > MANIFEST_URL > activeHost > cloud default', () => {
    expect(resolveTarget('http://flag:1', { MANIFEST_URL: 'http://env:2' }, config).origin).toBe(
      'http://flag:1',
    );
    expect(resolveTarget(undefined, { MANIFEST_URL: 'http://env:2' }, config).origin).toBe(
      'http://env:2',
    );
    expect(resolveTarget(undefined, {}, config).origin).toBe('http://active:1000');
    expect(resolveTarget(undefined, {}, {})).toEqual({
      origin: DEFAULT_URL,
      apiKey: null,
      source: null,
    });
  });

  it('prefers MANIFEST_API_KEY over the stored credential', () => {
    expect(resolveTarget(undefined, { MANIFEST_API_KEY: 'env-key' }, config)).toEqual({
      origin: 'http://active:1000',
      apiKey: 'env-key',
      source: 'env',
    });
  });

  it('uses only the credential stored for the exact target origin', () => {
    expect(resolveTarget(undefined, {}, config)).toEqual({
      origin: 'http://active:1000',
      apiKey: 'active-key',
      source: 'config',
    });
    // URL override with no matching stored credential: never borrow another host's key.
    expect(resolveTarget('http://unknown:3000', {}, config)).toEqual({
      origin: 'http://unknown:3000',
      apiKey: null,
      source: null,
    });
  });
});
