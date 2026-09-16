import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentKeyPath, readAgentKey, saveAgentKey } from './keystore';

describe('keystore', () => {
  let dir: string;
  const env = () => ({ XDG_CONFIG_HOME: dir });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-keystore-'));
  });

  it('derives a host- and agent-scoped path under the config dir', () => {
    const p = agentKeyPath(env(), 'http://localhost:39412', 'my-bot');
    expect(p).toBe(
      path.join(dir, 'manifest', 'keys', 'http%3A%2F%2Flocalhost%3A39412', 'my-bot.key'),
    );
  });

  it('encodes agent names that need it (spaces stay unambiguous)', () => {
    const p = agentKeyPath(env(), 'https://app.manifest.build', 'My Bot 2');
    expect(path.basename(p)).toBe('My%20Bot%202.key');
  });

  it('saves 0600 under a 0700 tree and reads back', () => {
    const origin = 'http://localhost:39412';
    const p = saveAgentKey(env(), origin, 'my-bot', 'mnfst_secret');
    expect(fs.readFileSync(p, 'utf8')).toBe('mnfst_secret');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
    expect(readAgentKey(env(), origin, 'my-bot')).toBe('mnfst_secret');
  });

  it('overwrite keeps 0600 and returns the new value', () => {
    const origin = 'http://localhost:39412';
    saveAgentKey(env(), origin, 'my-bot', 'old');
    const p = saveAgentKey(env(), origin, 'my-bot', 'new');
    expect(fs.readFileSync(p, 'utf8')).toBe('new');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('readAgentKey returns null when missing or empty', () => {
    const origin = 'http://localhost:39412';
    expect(readAgentKey(env(), origin, 'ghost')).toBeNull();
    const p = saveAgentKey(env(), origin, 'blank', '');
    expect(fs.readFileSync(p, 'utf8')).toBe('');
    expect(readAgentKey(env(), origin, 'blank')).toBeNull();
  });

  it('keys for different hosts never collide', () => {
    saveAgentKey(env(), 'http://localhost:1111', 'bot', 'key-a');
    saveAgentKey(env(), 'http://localhost:2222', 'bot', 'key-b');
    expect(readAgentKey(env(), 'http://localhost:1111', 'bot')).toBe('key-a');
    expect(readAgentKey(env(), 'http://localhost:2222', 'bot')).toBe('key-b');
  });
});
