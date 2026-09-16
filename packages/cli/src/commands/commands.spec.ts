import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { run } from '../index';
import { CLI_AGENT_PLATFORMS } from './agent';
import { agentKeyPath, saveAgentKey } from '../keystore';
import { OAUTH_POLL } from './oauth-connect';
import { fetchStub, makeIo, writeConfig } from '../../test/helpers';
import { SKILL_MD, SKILL_VERSION } from '../skill-content.gen';
import { SKILL_NUDGE } from './skill';
import { detectAgentRuntime, resolveHomePath } from '../agent-runtime';

const ME = { tenantId: 't1', userId: 'u1', authMethod: 'api_key', expiresAt: null };
const HOST = 'http://localhost:2099';

function authedIo(
  replies: Array<{ status: number; body: unknown }>,
  extra: Record<string, string> = {},
) {
  const stub = fetchStub(replies);
  const io = makeIo({
    env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key', ...extra },
    fetchImpl: stub.impl,
  });
  return { io, calls: stub.calls };
}

/** The /available-models payload shape, for the commands that validate models. */
const DISCOVERED = (names: string[]) => names.map((model_name) => ({ model_name }));

describe('auth commands', () => {
  it('login --token-env validates via /me, stores host-bound, never echoes the token', async () => {
    const stub = fetchStub([{ status: 200, body: ME }]);
    const io = makeIo({
      env: { MNFST_TOKEN: 'tok-123', MANIFEST_URL: HOST },
      fetchImpl: stub.impl,
    });
    expect(await run(io, ['login', '--token-env', 'MNFST_TOKEN'])).toBe(0);

    expect(stub.calls[0].url).toBe(`${HOST}/api/v1/me`);
    expect(io.lastJson()).toEqual({
      authenticated: true,
      url: HOST,
      tenantId: 't1',
      userId: 'u1',
      authMethod: 'api_key',
      expiresAt: null,
      source: 'config',
    });
    expect(io.lines.join('\n')).not.toContain('tok-123');

    const configFile = path.join(io.configDir, 'manifest', 'config.json');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      activeHost: HOST,
      hosts: { [HOST]: { apiKey: 'tok-123' } },
    });
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
  });

  it('login --token-stdin reads the token from stdin', async () => {
    const stub = fetchStub([{ status: 200, body: ME }]);
    const io = makeIo({ stdin: 'tok-stdin\n', env: { MANIFEST_URL: HOST }, fetchImpl: stub.impl });
    expect(await run(io, ['login', '--token-stdin'])).toBe(0);
    expect(stub.calls[0].headers['X-API-Key']).toBe('tok-stdin');
  });

  it('login with an invalid token surfaces the 401 and stores nothing', async () => {
    const stub = fetchStub([{ status: 401, body: { message: 'Invalid API key' } }]);
    const io = makeIo({ env: { MNFST_TOKEN: 'bad', MANIFEST_URL: HOST }, fetchImpl: stub.impl });
    expect(await run(io, ['login', '--token-env', 'MNFST_TOKEN'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: expect.any(String),
      message: 'Invalid API key',
      status: 401,
    });
    expect(fs.existsSync(path.join(io.configDir, 'manifest', 'config.json'))).toBe(false);
  });

  it('login with both token sources fails with the no-argv rule', async () => {
    const io = makeIo({ env: { MNFST_TOKEN: 't' } });
    expect(await run(io, ['login', '--token-stdin', '--token-env', 'MNFST_TOKEN'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'credential_source_required' });
  });

  it('login with no flags refuses browser login outside a TTY', async () => {
    const io = makeIo({ env: { MANIFEST_URL: HOST }, isTTY: false });
    expect(await run(io, ['login'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'no_tty',
      hint: expect.stringContaining('--token-stdin'),
    });
  });

  it('login with no flags runs the browser handshake and stores the minted token', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.endsWith('/api/v1/cli/token')) {
        return new Response(
          JSON.stringify({ token: 'mnfst_pat_browser', expiresAt: '2026-09-01T00:00:00.000Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ...ME, expiresAt: '2026-09-01T00:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const io = makeIo({
      env: { MANIFEST_URL: HOST },
      fetchImpl,
      isTTY: true,
      openBrowser: (url: string) => {
        const authUrl = new URL(url);
        expect(authUrl.pathname).toBe('/cli/auth');
        http.get(
          `http://127.0.0.1:${authUrl.searchParams.get('port')}/callback?code=${encodeURIComponent(
            'code-abcdefghijklmnop',
          )}&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
          () => undefined,
        );
        return true;
      },
    });

    expect(await run(io, ['login'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/cli/token`);
    expect(JSON.parse(calls[0].body!).code).toBe('code-abcdefghijklmnop');
    expect(calls[1].url).toBe(`${HOST}/api/v1/me`);
    expect(io.lastJson()).toEqual({
      authenticated: true,
      url: HOST,
      tenantId: 't1',
      userId: 'u1',
      authMethod: 'api_key',
      expiresAt: '2026-09-01T00:00:00.000Z',
      source: 'config',
    });
    // The raw PAT is never echoed on stdout, only stored.
    expect(io.lines.join('\n')).not.toContain('mnfst_pat_browser');
    expect(io.errLines.join('\n')).toContain('/cli/auth');
    const config = JSON.parse(
      fs.readFileSync(path.join(io.configDir, 'manifest', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({
      activeHost: HOST,
      hosts: { [HOST]: { apiKey: 'mnfst_pat_browser' } },
    });
  });

  it('login falls back to the code expiry when /me omits one', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith('/api/v1/cli/token')
        ? { token: 'mnfst_pat_browser', expiresAt: '2026-10-01T00:00:00.000Z' }
        : { ...ME, expiresAt: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const io = makeIo({
      env: { MANIFEST_URL: HOST },
      fetchImpl,
      isTTY: true,
      openBrowser: (url: string) => {
        const authUrl = new URL(url);
        http.get(
          `http://127.0.0.1:${authUrl.searchParams.get('port')}/callback?code=c-abcdefghijklmnop&state=${authUrl.searchParams.get('state')}`,
          () => undefined,
        );
        return true;
      },
    });
    expect(await run(io, ['login'])).toBe(0);
    expect(io.lastJson()).toMatchObject({ expiresAt: '2026-10-01T00:00:00.000Z' });
  });

  it('login honors --url over MANIFEST_URL', async () => {
    const stub = fetchStub([{ status: 200, body: ME }]);
    const io = makeIo({
      env: { MNFST_TOKEN: 't', MANIFEST_URL: 'http://env-host:1' },
      fetchImpl: stub.impl,
    });
    expect(
      await run(io, ['login', '--token-env', 'MNFST_TOKEN', '--url', 'http://flag-host:2']),
    ).toBe(0);
    expect(stub.calls[0].url).toBe('http://flag-host:2/api/v1/me');
  });

  it('browser login stores the minted token even when /me then fails', async () => {
    // The server just minted this PAT, so it is live. Bailing out without
    // storing it would strand a 30-day credential the user cannot revoke.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v1/cli/token')) {
        return new Response(JSON.stringify({ token: 'mnfst_pat_orphan', expiresAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Service Unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const io = makeIo({
      env: { MANIFEST_URL: HOST },
      fetchImpl,
      isTTY: true,
      openBrowser: (url: string) => {
        const authUrl = new URL(url);
        http.get(
          `http://127.0.0.1:${authUrl.searchParams.get('port')}/callback?code=c-abcdefghijklmnop&state=${authUrl.searchParams.get('state')}`,
          () => undefined,
        );
        return true;
      },
    });

    expect(await run(io, ['login'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'login_validation_failed',
      message: 'Service Unavailable',
      hint: expect.stringContaining('mnfst logout'),
    });
    // Stored anyway, so `mnfst logout` can still revoke it server-side.
    const config = JSON.parse(
      fs.readFileSync(path.join(io.configDir, 'manifest', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({ activeHost: HOST, hosts: { [HOST]: { apiKey: 'mnfst_pat_orphan' } } });
  });

  it('browser login reports a non-Error validation failure without losing the token', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/v1/cli/token')) {
        return new Response(JSON.stringify({ token: 'mnfst_pat_weird', expiresAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // A body that rejects with a bare string, not an Error.
      return { ok: true, status: 200, text: () => Promise.reject('stream torn') } as Response;
    }) as typeof fetch;
    const io = makeIo({
      env: { MANIFEST_URL: HOST },
      fetchImpl,
      isTTY: true,
      openBrowser: (url: string) => {
        const authUrl = new URL(url);
        http.get(
          `http://127.0.0.1:${authUrl.searchParams.get('port')}/callback?code=c-abcdefghijklmnop&state=${authUrl.searchParams.get('state')}`,
          () => undefined,
        );
        return true;
      },
    });
    expect(await run(io, ['login'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'login_validation_failed',
      message: expect.stringContaining('stream torn'),
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(io.configDir, 'manifest', 'config.json'), 'utf8'),
    );
    expect(config.hosts[HOST].apiKey).toBe('mnfst_pat_weird');
  });

  it('token-flag login stores nothing when /me rejects the user-supplied token', async () => {
    // Mirror image of the browser path: a token the user typed may be garbage,
    // so it must prove itself before it is written to disk.
    const stub = fetchStub([{ status: 401, body: { message: 'Invalid API key' } }]);
    const io = makeIo({ env: { MNFST_TOKEN: 'bad', MANIFEST_URL: HOST }, fetchImpl: stub.impl });
    expect(await run(io, ['login', '--token-env', 'MNFST_TOKEN'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ message: 'Invalid API key', status: 401 });
    expect(fs.existsSync(path.join(io.configDir, 'manifest', 'config.json'))).toBe(false);
  });

  it('logout on a host with nothing stored reports loggedOut: false and never calls the server', async () => {
    const stub = fetchStub([{ status: 200, body: { revoked: true } }]);
    const io = makeIo({ env: { MANIFEST_URL: HOST }, fetchImpl: stub.impl });
    expect(await run(io, ['logout'])).toBe(0);
    expect(io.lastJson()).toEqual({ loggedOut: false, revoked: false, url: HOST });
    expect(stub.calls).toHaveLength(0);
  });

  it('logout revokes the stored token server-side before deleting it locally', async () => {
    const stub = fetchStub([{ status: 200, body: { revoked: true } }]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, { activeHost: HOST, hosts: { [HOST]: { apiKey: 'stored-pat' } } });
    expect(await run(io, ['logout', '--url', HOST])).toBe(0);
    expect(stub.calls[0]).toMatchObject({
      url: `${HOST}/api/v1/cli/token`,
      method: 'DELETE',
    });
    expect(stub.calls[0].headers['X-API-Key']).toBe('stored-pat');
    expect(io.lastJson()).toEqual({ loggedOut: true, revoked: true, url: HOST });
  });

  it('logout still succeeds locally when the revoke call fails', async () => {
    const stub = fetchStub([{ status: 500, body: { message: 'boom' } }]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, { activeHost: HOST, hosts: { [HOST]: { apiKey: 'stored-pat' } } });
    expect(await run(io, ['logout', '--url', HOST])).toBe(0);
    expect(io.lastJson()).toEqual({ loggedOut: true, revoked: false, url: HOST });
    const config = JSON.parse(
      fs.readFileSync(path.join(io.configDir, 'manifest', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({ hosts: {} });
  });

  it('logout removes only the target host credential', async () => {
    const stub = fetchStub([{ status: 200, body: { revoked: false } }]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, {
      activeHost: HOST,
      hosts: { [HOST]: { apiKey: 'a' }, 'http://other:1': { apiKey: 'b' } },
    });
    expect(await run(io, ['logout', '--url', HOST])).toBe(0);
    expect(io.lastJson()).toEqual({ loggedOut: true, revoked: false, url: HOST });
    const config = JSON.parse(
      fs.readFileSync(path.join(io.configDir, 'manifest', 'config.json'), 'utf8'),
    );
    expect(config).toEqual({ hosts: { 'http://other:1': { apiKey: 'b' } } });
  });

  it('auth status reports unauthenticated with exit 1 and no fetch', async () => {
    const io = makeIo({ env: { MANIFEST_URL: HOST } });
    expect(await run(io, ['auth', 'status'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      authenticated: false,
      url: HOST,
      hint: expect.stringContaining('login'),
    });
  });

  it('auth status and whoami report identity from /me', async () => {
    const { io } = authedIo([{ status: 200, body: ME }]);
    expect(await run(io, ['auth', 'status'])).toBe(0);
    expect(io.lastJson()).toMatchObject({ authenticated: true, source: 'env', tenantId: 't1' });

    const { io: io2 } = authedIo([{ status: 200, body: ME }]);
    expect(await run(io2, ['whoami'])).toBe(0);
    expect(io2.lastJson()).toEqual({ url: HOST, ...ME });
  });

  it('auth status surfaces the token expiry reported by /me', async () => {
    const { io } = authedIo([
      { status: 200, body: { ...ME, expiresAt: '2026-09-01T00:00:00.000Z' } },
    ]);
    expect(await run(io, ['auth', 'status'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      authenticated: true,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('config path prints the resolved config location', async () => {
    const io = makeIo();
    expect(await run(io, ['config', 'path'])).toBe(0);
    expect(io.lastJson()).toEqual({ path: path.join(io.configDir, 'manifest', 'config.json') });
  });

  it('stored config credential is used when no env key is set', async () => {
    const stub = fetchStub([{ status: 200, body: { agents: [] } }]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, { activeHost: HOST, hosts: { [HOST]: { apiKey: 'stored-key' } } });
    expect(await run(io, ['agent', 'list'])).toBe(0);
    expect(stub.calls[0].headers['X-API-Key']).toBe('stored-key');
  });

  it('commands fail closed when no credential resolves for the target host', async () => {
    const io = makeIo({ env: { MANIFEST_URL: HOST } });
    expect(await run(io, ['agent', 'list'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'not_authenticated', status: 401 });
  });
});

describe('agent commands', () => {
  it('agent list forwards includePlayground', async () => {
    const { io, calls } = authedIo([{ status: 200, body: { agents: [] } }]);
    expect(await run(io, ['agent', 'list', '--include-playground'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents?includePlayground=true`);
  });

  it('agent list strips dashboard-only sparkline data', async () => {
    const { io } = authedIo([
      {
        status: 200,
        body: {
          agents: [
            { id: 'a1', name: 'bot-1', sparkline: [0, 3, 12, 8] },
            { id: 'a2', name: 'bot-2', sparkline: [] },
          ],
        },
      },
    ]);
    expect(await run(io, ['agent', 'list'])).toBe(0);
    expect(io.lastJson()).toEqual({
      agents: [
        { id: 'a1', name: 'bot-1' },
        { id: 'a2', name: 'bot-2' },
      ],
    });
  });

  it('agent list passes non-object payloads through untouched', async () => {
    const { io } = authedIo([{ status: 200, body: { agents: 'unexpected' } }]);
    expect(await run(io, ['agent', 'list'])).toBe(0);
    expect(io.lastJson()).toEqual({ agents: 'unexpected' });
  });

  it('agent list passes a null body and non-object agent entries through untouched', async () => {
    const { io } = authedIo([{ status: 200, body: null }]);
    expect(await run(io, ['agent', 'list'])).toBe(0);
    expect(io.lastJson()).toBeNull();

    const { io: io2 } = authedIo([{ status: 200, body: { agents: ['weird', null] } }]);
    expect(await run(io2, ['agent', 'list'])).toBe(0);
    expect(io2.lastJson()).toEqual({ agents: ['weird', null] });
  });

  it('agent create writes the key file 0600 and prints only the prefix', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-agent-'));
    const keyFile = path.join(dir, 'coding.key');
    const { io, calls } = authedIo([
      {
        status: 201,
        body: { agent: { id: 'a1', name: 'coding' }, apiKey: 'mnfst_secret_full_key' },
      },
    ]);
    expect(
      await run(io, [
        'agent',
        'create',
        '--name',
        'coding',
        '--key-file',
        keyFile,
        '--platform',
        'claude-code',
        '--category',
        'coding',
      ]),
    ).toBe(0);

    expect(JSON.parse(calls[0].body!)).toEqual({
      name: 'coding',
      agent_platform: 'claude-code',
      agent_category: 'coding',
    });
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('mnfst_secret_full_key');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    // --key-file is an ADDITIONAL copy; the keystore cache is always refreshed
    expect(fs.readFileSync(agentKeyPath(io.env, HOST, 'coding'), 'utf8')).toBe(
      'mnfst_secret_full_key',
    );
    expect(io.lastJson()).toMatchObject({
      agent: { id: 'a1', name: 'coding' },
      keyPrefix: 'mnfst_secr',
      keyFile,
      keyPath: agentKeyPath(io.env, HOST, 'coding'),
    });
    expect(io.lines.join('\n')).not.toContain('mnfst_secret_full_key');
  });

  it('agent create omits absent optional category', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-agent-'));
    const keyFile = path.join(dir, 'p.key');
    const { io, calls } = authedIo([
      { status: 201, body: { agent: { name: 'p' }, apiKey: 'mnfst_k' } },
    ]);
    expect(
      await run(io, [
        'agent',
        'create',
        '--name',
        'p',
        '--key-file',
        keyFile,
        '--platform',
        'openclaw',
      ]),
    ).toBe(0);
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'p', agent_platform: 'openclaw' });
  });

  it('agent create without --platform fails with the platform list before any API call', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }]);
    expect(await run(io, ['agent', 'create', '--name', 'x', '--key-file', '/tmp/x.key'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'missing_platform' });
    expect((io.lastJson() as { message: string }).message).toContain('openclaw');
    expect((io.lastJson() as { message: string }).message).toContain('other');
    expect(calls).toHaveLength(0);
  });

  it('agent create with an unknown --platform fails listing valid ones', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }]);
    expect(
      await run(io, [
        'agent',
        'create',
        '--name',
        'x',
        '--key-file',
        '/tmp/x.key',
        '--platform',
        'skynet',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_platform' });
    expect((io.lastJson() as { message: string }).message).toContain('claude-code');
    expect(calls).toHaveLength(0);
  });

  it('agent create with an unknown --category fails before any API call', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }]);
    expect(
      await run(io, [
        'agent',
        'create',
        '--name',
        'x',
        '--platform',
        'curl',
        '--category',
        'devops',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'invalid_category',
      message: expect.stringContaining('personal, automation, app, coding'),
    });
    expect(calls).toHaveLength(0);
  });

  it('agent update with an unknown --category fails before any API call', async () => {
    const { io, calls } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io, ['agent', 'update', 'a', '--category', 'devops'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_category' });
    expect(calls).toHaveLength(0);
  });

  it('agent platforms lists valid platforms without touching the network', async () => {
    const stub = fetchStub([]);
    const io = makeIo({ fetchImpl: stub.impl });
    expect(await run(io, ['agent', 'platforms'])).toBe(0);
    expect(io.lastJson()).toEqual({ platforms: [...CLI_AGENT_PLATFORMS] });
    expect(stub.calls).toHaveLength(0);
  });

  it('CLI platform catalog matches manifest-shared, surfaces included (drift guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shared = require('manifest-shared') as {
      AGENT_PLATFORMS: readonly string[];
      PLATFORM_API_SURFACES: Record<string, string>;
    };
    expect(CLI_AGENT_PLATFORMS).toEqual([...shared.AGENT_PLATFORMS]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { derivePlatforms } = require('../../scripts/generate-provider-catalog.cjs') as {
      derivePlatforms: (s: unknown) => unknown;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gen = require('../provider-catalog.gen') as { PLATFORM_CATALOG: unknown };
    expect(JSON.parse(JSON.stringify(gen.PLATFORM_CATALOG))).toEqual(derivePlatforms(shared));
  });

  it('agent update maps --category alone', async () => {
    const { io, calls } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io, ['agent', 'update', 'a', '--category', 'coding'])).toBe(0);
    expect(JSON.parse(calls[0].body!)).toEqual({ agent_category: 'coding' });
  });

  it('agent create validates the key file before calling the API', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }]);
    expect(
      await run(io, [
        'agent',
        'create',
        '--name',
        'x',
        '--platform',
        'claude-code',
        '--key-file',
        '/nonexistent-dir-xyz/k.key',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'key_file_dir_missing' });
    expect(calls).toHaveLength(0);
  });

  it('agent get normalizes the 200 {agent:null} miss into not_found', async () => {
    const { io } = authedIo([{ status: 200, body: { agent: null } }]);
    expect(await run(io, ['agent', 'get', 'ghost'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'not_found', status: 404 });

    const { io: hit } = authedIo([{ status: 200, body: { agent: { name: 'real' } } }]);
    expect(await run(hit, ['agent', 'get', 'real'])).toBe(0);
    expect(hit.lastJson()).toEqual({ agent: { name: 'real' } });
  });

  it('agent update requires at least one field and maps flags', async () => {
    const none = makeIo({ env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'k' } });
    expect(await run(none, ['agent', 'update', 'a'])).toBe(1);
    expect(none.lastJson()).toMatchObject({ error: 'missing_flag' });

    const { io, calls } = authedIo([{ status: 200, body: { renamed: true } }]);
    expect(await run(io, ['agent', 'update', 'a', '--name', 'b', '--platform', 'openclaw'])).toBe(
      0,
    );
    expect(calls[0].method).toBe('PATCH');
    expect(JSON.parse(calls[0].body!)).toEqual({ name: 'b', agent_platform: 'openclaw' });
  });

  it('agent delete and rotate-key demand --yes', async () => {
    const io = makeIo({ env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'k' } });
    expect(await run(io, ['agent', 'delete', 'a'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'confirmation_required' });

    const { io: deleted, calls } = authedIo([{ status: 200, body: { deleted: true } }]);
    expect(await run(deleted, ['agent', 'delete', 'a', '--yes'])).toBe(0);
    expect(calls[0].method).toBe('DELETE');
  });

  it('agent rotate-key writes the fresh key to the key file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-rotate-'));
    const keyFile = path.join(dir, 'rotated.key');
    const { io, calls } = authedIo([{ status: 200, body: { apiKey: 'mnfst_rotated_key_value' } }]);
    saveAgentKey(io.env, HOST, 'a', 'mnfst_STALE_REVOKED');
    expect(await run(io, ['agent', 'rotate-key', 'a', '--key-file', keyFile, '--yes'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents/a/rotate-key`);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('mnfst_rotated_key_value');
    // regression (sim-B): --key-file must not leave the keystore serving the
    // revoked key through mnfst run / agent key show
    expect(fs.readFileSync(agentKeyPath(io.env, HOST, 'a'), 'utf8')).toBe(
      'mnfst_rotated_key_value',
    );
    expect(io.lastJson()).toEqual({
      rotated: true,
      keyPrefix: 'mnfst_rota',
      keyFile,
      keyPath: agentKeyPath(io.env, HOST, 'a'),
    });
  });

  it('agent delete drops the local keystore entry', async () => {
    const { io } = authedIo([{ status: 200, body: { ok: true } }]);
    const p = saveAgentKey(io.env, HOST, 'gone-bot', 'mnfst_dead');
    expect(await run(io, ['agent', 'delete', 'gone-bot', '--yes'])).toBe(0);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('agent create --if-absent succeeds on conflict by resolving the existing agent', async () => {
    const { io, calls } = authedIo([
      { status: 409, body: { message: 'Agent "kept" already exists', error: 'Conflict' } },
      { status: 200, body: { agent: { agent_name: 'kept' } } },
      { status: 200, body: { keyPrefix: 'mnfst_serv', apiKey: 'mnfst_recovered_key' } },
    ]);
    expect(
      await run(io, ['agent', 'create', '--name', 'kept', '--platform', 'curl', '--if-absent']),
    ).toBe(0);
    expect(calls[1].url).toBe(`${HOST}/api/v1/agents/kept`);
    expect(io.lastJson()).toMatchObject({
      existed: true,
      keyPrefix: 'mnfst_reco',
      agent: { agent_name: 'kept' },
    });
    // the recovered key lands in the keystore for run/key path
    expect(fs.readFileSync(agentKeyPath(io.env, HOST, 'kept'), 'utf8')).toBe('mnfst_recovered_key');
    // an --if-absent re-run is the idempotent setup path: it must carry the
    // same wiring instructions the create path prints
    const setup = (io.lastJson() as { setup: string }).setup;
    expect(setup).toContain('base URL');
    expect(setup).toContain(
      `<MNFST_AGENT_KEY — run: mnfst agent key show kept --raw --url ${HOST}>`,
    );
    expect(setup).not.toContain('mnfst_recovered_key');
  });

  it('agent create --if-absent renders setup from the EXISTING agent platform', async () => {
    const { io } = authedIo([
      { status: 409, body: { message: 'exists', error: 'Conflict' } },
      { status: 200, body: { agent: { agent_name: 'kept', agent_platform: 'openclaw' } } },
      { status: 200, body: { keyPrefix: 'mnfst_serv', apiKey: 'mnfst_recovered_key' } },
    ]);
    // asked for curl, but the stored agent is an openclaw one — the record wins
    expect(
      await run(io, ['agent', 'create', '--name', 'kept', '--platform', 'curl', '--if-absent']),
    ).toBe(0);
    expect((io.lastJson() as { setup: string }).setup).toContain(
      'openclaw config set models.providers.manifest',
    );
  });

  it('agent create without --if-absent still fails on conflict', async () => {
    const { io } = authedIo([
      { status: 409, body: { message: 'Agent "kept" already exists', error: 'Conflict' } },
    ]);
    expect(await run(io, ['agent', 'create', '--name', 'kept', '--platform', 'curl'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ status: 409 });
  });

  it('agent create without --key-file stores the key in the managed keystore', async () => {
    const { io } = authedIo([
      { status: 201, body: { agent: { name: 'kept' }, apiKey: 'mnfst_kept_secret' } },
    ]);
    expect(await run(io, ['agent', 'create', '--name', 'kept', '--platform', 'claude-code'])).toBe(
      0,
    );
    const expected = agentKeyPath(io.env, HOST, 'kept');
    expect(fs.readFileSync(expected, 'utf8')).toBe('mnfst_kept_secret');
    expect(fs.statSync(expected).mode & 0o777).toBe(0o600);
    expect(io.lastJson()).toMatchObject({
      agent: { name: 'kept' },
      keyPrefix: 'mnfst_kept',
      keyPath: expected,
    });
    // setup instructions ride along, platform-templated, key masked
    const setup = (io.lastJson() as { setup: string }).setup;
    expect(setup).toContain('ANTHROPIC_BASE_URL');
    expect(setup).toContain(HOST);
    // A literal placeholder, not a command substitution: the snippets embed it
    // in JSON / single-quoted contexts where no shell would expand it.
    expect(setup).toContain(
      `<MNFST_AGENT_KEY — run: mnfst agent key show kept --raw --url ${HOST}>`,
    );
    expect(setup).not.toContain('$(');
    expect(setup).not.toContain('mnfst_kept_secret');
    expect(io.lines.join('\n')).not.toContain('mnfst_kept_secret');
  });

  it('agent rotate-key without --key-file refreshes the keystore entry', async () => {
    const { io } = authedIo([{ status: 200, body: { apiKey: 'mnfst_fresh_secret' } }]);
    saveAgentKey(io.env, HOST, 'a', 'mnfst_stale');
    expect(await run(io, ['agent', 'rotate-key', 'a', '--yes'])).toBe(0);
    const expected = agentKeyPath(io.env, HOST, 'a');
    expect(fs.readFileSync(expected, 'utf8')).toBe('mnfst_fresh_secret');
    expect(io.lastJson()).toEqual({ rotated: true, keyPrefix: 'mnfst_fres', keyPath: expected });
  });

  it('agent key path serves the cached keystore entry without the network', async () => {
    const { io, calls } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'mnfst_cached');
    expect(await run(io, ['agent', 'key', 'path', 'my-bot'])).toBe(0);
    expect(io.lastJson()).toEqual({
      agent: 'my-bot',
      path: agentKeyPath(io.env, HOST, 'my-bot'),
      source: 'keystore',
    });
    expect(calls).toHaveLength(0);
  });

  it('agent key path self-heals from the server when the cache is missing', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { keyPrefix: 'mnfst_serv', apiKey: 'mnfst_server_copy' } },
    ]);
    expect(await run(io, ['agent', 'key', 'path', 'my-bot'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents/my-bot/key`);
    const expected = agentKeyPath(io.env, HOST, 'my-bot');
    expect(fs.readFileSync(expected, 'utf8')).toBe('mnfst_server_copy');
    expect(io.lastJson()).toEqual({ agent: 'my-bot', path: expected, source: 'server' });
    expect(io.lines.join('\n')).not.toContain('mnfst_server_copy');
  });

  it('agent key path fails with a rotate hint when the server cannot recover the key', async () => {
    const { io } = authedIo([{ status: 200, body: { keyPrefix: 'mnfst_lega' } }]);
    expect(await run(io, ['agent', 'key', 'path', 'legacy-bot'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'key_unrecoverable',
      hint: expect.stringContaining('rotate-key'),
    });
  });

  it('agent setup renders the platform template masked, --reveal embeds the key', async () => {
    const { io } = authedIo([
      { status: 200, body: { agent: { agent_name: 'bot', agent_platform: 'openclaw' } } },
    ]);
    expect(await run(io, ['agent', 'setup', 'bot'])).toBe(0);
    const out = io.lastJson() as { setup: string; hint?: string };
    expect(out.setup).toContain('openclaw config set models.providers.manifest');
    expect(out.setup).toContain(`${HOST}/v1`);
    expect(out.setup).toContain(
      `<MNFST_AGENT_KEY — run: mnfst agent key show bot --raw --url ${HOST}>`,
    );
    expect(out.hint).toContain('--reveal');

    const { io: io2 } = authedIo([
      { status: 200, body: { agent: { agent_name: 'bot', agent_platform: 'openclaw' } } },
    ]);
    saveAgentKey(io2.env, HOST, 'bot', 'mnfst_real_key');
    expect(await run(io2, ['agent', 'setup', 'bot', '--reveal'])).toBe(0);
    expect((io2.lastJson() as { setup: string }).setup).toContain('mnfst_real_key');
  });

  it('agent setup 404s for a missing agent', async () => {
    const { io } = authedIo([{ status: 200, body: { agent: null } }]);
    expect(await run(io, ['agent', 'setup', 'ghost'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'not_found', status: 404 });
  });

  it('agent setup falls back to generic wiring for platforms without a template', async () => {
    const { io } = authedIo([
      { status: 200, body: { agent: { agent_name: 'bot', agent_platform: 'langchain' } } },
    ]);
    expect(await run(io, ['agent', 'setup', 'bot'])).toBe(0);
    const out = io.lastJson() as { setup: string };
    expect(out.setup).toContain('base URL');
    expect(out.setup).toContain(`${HOST}/v1`);
  });

  it('agent env emits dotenv lines, and --export shell lines', async () => {
    const { io, calls } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'mnfst_env_secret');
    expect(await run(io, ['agent', 'env', 'My Bot'])).toBe(0);
    expect(io.lines.slice(-2)).toEqual([
      'MANIFEST_AGENT_KEY=mnfst_env_secret',
      `MANIFEST_AGENT_URL=${HOST}/v1`,
    ]);
    expect(calls).toHaveLength(0);

    const { io: io2 } = authedIo([]);
    saveAgentKey(io2.env, HOST, 'my-bot', 'k2');
    expect(await run(io2, ['agent', 'env', 'my-bot', '--export'])).toBe(0);
    expect(io2.lines.slice(-2)[0]).toBe('export MANIFEST_AGENT_KEY=k2');
  });

  it('agent key show prints the raw key as a deliberate act', async () => {
    const { io, calls } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'mnfst_cached_secret');
    expect(await run(io, ['agent', 'key', 'show', 'my-bot'])).toBe(0);
    expect(io.lastJson()).toEqual({ agent: 'my-bot', apiKey: 'mnfst_cached_secret' });
    expect(calls).toHaveLength(0);
  });

  it('agent key show --raw prints the bare key with no JSON envelope', async () => {
    const { io } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'mnfst_cached_secret');
    expect(await run(io, ['agent', 'key', 'show', 'my-bot', '--raw'])).toBe(0);
    // exactly the key — substitutable into a config file, pipeable
    expect(io.lines).toEqual(['mnfst_cached_secret']);
  });

  it('agent commands slugify display-name input like the backend does', async () => {
    const { io, calls } = authedIo([{ status: 200, body: { agent: { agent_name: 'john' } } }]);
    expect(await run(io, ['agent', 'get', 'John'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents/john`);

    const { io: io2, calls: calls2 } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io2, ['agent', 'delete', 'My Cool Agent', '--yes'])).toBe(0);
    expect(calls2[0].url).toBe(`${HOST}/api/v1/agents/my-cool-agent`);
  });

  it('routing and run take display names too', async () => {
    const { io, calls } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io, ['routing', 'status', 'John'])).toBe(0);
    expect(calls[0].url).toContain('/routing/john/');

    const { io: io2 } = authedIo([]);
    saveAgentKey(io2.env, HOST, 'john', 'k');
    io2.spawnImpl = async () => 0;
    expect(await run(io2, ['run', '--agent', 'John', '--', 'tool'])).toBe(0);
  });

  it('create with a spaced name stores the keystore entry under the slug', async () => {
    const { io } = authedIo([
      { status: 201, body: { agent: { display_name: 'My Cool Agent' }, apiKey: 'mnfst_spaced' } },
    ]);
    expect(
      await run(io, ['agent', 'create', '--name', 'My Cool Agent', '--platform', 'other']),
    ).toBe(0);
    const expected = agentKeyPath(io.env, HOST, 'my-cool-agent');
    expect(fs.readFileSync(expected, 'utf8')).toBe('mnfst_spaced');
    expect((io.lastJson() as { keyPath: string }).keyPath).toBe(expected);
  });

  it('a name that slugifies to nothing fails fast', async () => {
    const { io, calls } = authedIo([]);
    expect(await run(io, ['agent', 'get', '!!!'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_agent_name' });
    expect(calls).toHaveLength(0);
  });

  it('agent key show falls back to the server and caches the result', async () => {
    const { io } = authedIo([
      { status: 200, body: { keyPrefix: 'mnfst_serv', apiKey: 'mnfst_server_secret' } },
    ]);
    expect(await run(io, ['agent', 'key', 'show', 'my-bot'])).toBe(0);
    expect(io.lastJson()).toEqual({ agent: 'my-bot', apiKey: 'mnfst_server_secret' });
    expect(fs.readFileSync(agentKeyPath(io.env, HOST, 'my-bot'), 'utf8')).toBe(
      'mnfst_server_secret',
    );
  });
});

describe('provider commands', () => {
  it('provider list hits the tenant-level endpoint', async () => {
    const { io, calls } = authedIo([{ status: 200, body: { providers: [] } }]);
    expect(await run(io, ['provider', 'list'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/providers`);
  });

  it('provider list strips dashboard-only noise but keeps operational signals', async () => {
    const { io } = authedIo([
      {
        status: 200,
        body: {
          providers: [
            {
              provider: 'openai',
              auth_type: 'api_key',
              display_name: null,
              connection_count: 1,
              connections: [
                {
                  id: 'conn-1',
                  label: 'Default',
                  key_prefix: 'sk-fake-',
                  priority: 0,
                  connected_at: '2026-08-02T07:25:48.318Z',
                  models_fetched_at: '2026-08-02T09:29:54.928Z',
                  cached_model_count: 38,
                  is_active: true,
                },
              ],
              total_models: 38,
            },
            {
              provider: 'custom:abc',
              auth_type: 'api_key',
              display_name: 'My LiteLLM',
              connection_count: 1,
              connections: [
                {
                  id: 'conn-2',
                  label: 'Default',
                  key_prefix: null,
                  priority: 2,
                  connected_at: '2026-08-02T07:25:48.318Z',
                  models_fetched_at: null,
                  cached_model_count: 0,
                  is_active: false,
                },
              ],
              total_models: 0,
            },
          ],
          model_counts: { openai: 84, anthropic: 21 },
        },
      },
    ]);
    expect(await run(io, ['provider', 'list'])).toBe(0);
    expect(io.lastJson()).toEqual({
      providers: [
        {
          provider: 'openai',
          auth_type: 'api_key',
          connection_count: 1,
          connections: [
            {
              id: 'conn-1',
              label: 'Default',
              connected_at: '2026-08-02T07:25:48.318Z',
              cached_model_count: 38,
              is_active: true,
            },
          ],
        },
        {
          provider: 'custom:abc',
          auth_type: 'api_key',
          display_name: 'My LiteLLM',
          connection_count: 1,
          connections: [
            {
              id: 'conn-2',
              label: 'Default',
              connected_at: '2026-08-02T07:25:48.318Z',
              cached_model_count: 0,
              is_active: false,
            },
          ],
        },
      ],
    });
  });

  it('provider list passes unexpected payload shapes through untouched', async () => {
    const { io } = authedIo([{ status: 200, body: { providers: 'weird' } }]);
    expect(await run(io, ['provider', 'list'])).toBe(0);
    expect(io.lastJson()).toEqual({ providers: 'weird' });

    const { io: io2 } = authedIo([{ status: 200, body: null }]);
    expect(await run(io2, ['provider', 'list'])).toBe(0);
    expect(io2.lastJson()).toBeNull();

    const { io: io3 } = authedIo([
      { status: 200, body: { providers: ['weird', { provider: 'x', connections: [null, 'w'] }] } },
    ]);
    expect(await run(io3, ['provider', 'list'])).toBe(0);
    expect(io3.lastJson()).toEqual({
      providers: ['weird', { provider: 'x', connections: [null, 'w'] }],
    });
  });

  it('provider catalog lists connectable providers without auth or network', async () => {
    const stub = fetchStub([]);
    const io = makeIo({ fetchImpl: stub.impl });
    expect(await run(io, ['provider', 'catalog'])).toBe(0);
    const out = io.lastJson() as { providers: Array<Record<string, unknown>> };
    expect(out.providers.length).toBeGreaterThan(20);
    expect(out.providers.some((p) => p['id'] === 'openai')).toBe(true);
    // Subscription is only advertised when the CLI can drive that sign-in.
    const byId = new Map(out.providers.map((p) => [p['id'], p]));
    expect(byId.get('xai')?.['authTypes']).toContain('subscription');
    expect(byId.get('qwen')?.['authTypes']).not.toContain('subscription');
    // display-only noise stays out of the CLI surface
    for (const p of out.providers) {
      expect(Object.keys(p).sort()).toEqual(['authTypes', 'displayName', 'id']);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('provider connect resolves aliases and rejects unknown providers early', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }], { CRED: 'g-key' });
    expect(
      await run(io, [
        'provider',
        'connect',
        '--provider',
        'google',
        '--agent',
        'a',
        '--credential-env',
        'CRED',
      ]),
    ).toBe(0);
    expect(JSON.parse(calls[0].body!).provider).toBe('gemini');

    const { io: io2, calls: calls2 } = authedIo([]);
    expect(
      await run(io2, [
        'provider',
        'connect',
        '--provider',
        'skynet-llc',
        '--agent',
        'a',
        '--credential-env',
        'CRED',
      ]),
    ).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'unknown_provider' });
    expect(calls2).toHaveLength(0);
  });

  it('provider list --agent annotates connections with the agent enabled set', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: {
          providers: [
            {
              provider: 'openai',
              auth_type: 'api_key',
              connections: [
                { id: 'conn-on', label: 'A', is_active: true },
                { id: 'conn-off', label: 'B', is_active: true },
              ],
            },
          ],
        },
      },
      { status: 200, body: { agent: { agent_name: 'john' } } },
      { status: 200, body: { enabled: ['conn-on'] } },
    ]);
    expect(await run(io, ['provider', 'list', '--agent', 'John'])).toBe(0);
    expect(calls[1].url).toBe(`${HOST}/api/v1/agents/john`);
    expect(calls[2].url).toBe(`${HOST}/api/v1/agents/john/enabled-providers`);
    const out = io.lastJson() as {
      agent: string;
      providers: Array<{ connections: Array<{ id: string; enabled: boolean }> }>;
    };
    expect(out.agent).toBe('john');
    expect(out.providers[0].connections).toEqual([
      { id: 'conn-on', label: 'A', is_active: true, enabled: true },
      { id: 'conn-off', label: 'B', is_active: true, enabled: false },
    ]);
  });

  it('provider list --agent 404s for a missing agent', async () => {
    const { io } = authedIo([
      { status: 200, body: { providers: [] } },
      { status: 200, body: { agent: null } },
    ]);
    expect(await run(io, ['provider', 'list', '--agent', 'ghost'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'not_found', status: 404 });
  });

  it('provider connect takes the provider as a positional', async () => {
    const { io, calls } = authedIo([{ status: 201, body: { id: 'p1' } }], { K: 'xai-secret' });
    expect(
      await run(io, ['provider', 'connect', 'xai', '--agent', 'a', '--credential-env', 'K']),
    ).toBe(0);
    expect(JSON.parse(calls[0].body!).provider).toBe('xai');
    expect((io.lastJson() as { agent: string }).agent).toBe('a');
  });

  it('provider connect rejects provider given both ways, and neither way', async () => {
    const { io } = authedIo([]);
    expect(
      await run(io, ['provider', 'connect', 'xai', '--provider', 'openai', '--agent', 'a']),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_flag' });

    const { io: io2 } = authedIo([]);
    expect(await run(io2, ['provider', 'connect', '--agent', 'a'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({
      error: 'missing_positional',
      hint: expect.stringContaining('provider catalog'),
    });
  });

  it('provider connect auto-picks an agent (tenant-wide effect) when --agent is omitted', async () => {
    const { io, calls } = authedIo(
      [
        { status: 200, body: { agents: [{ agent_name: 'john' }, { agent_name: 'other' }] } },
        { status: 201, body: { id: 'p1' } },
      ],
      { K: 'xai-secret' },
    );
    expect(await run(io, ['provider', 'connect', 'xai', '--credential-env', 'K'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents`);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/providers`);
    expect((io.lastJson() as { agent: string }).agent).toBe('john');
  });

  it('provider connect with no agents at all explains what to do', async () => {
    const { io } = authedIo([{ status: 200, body: { agents: [] } }], { K: 'k' });
    expect(await run(io, ['provider', 'connect', 'xai', '--credential-env', 'K'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'no_agents',
      hint: expect.stringContaining('agent create'),
    });
  });

  it('provider connect prompts with hidden input on a TTY when no source is given', async () => {
    const prompts: string[] = [];
    const stub = fetchStub([{ status: 201, body: { id: 'p1' } }]);
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: stub.impl,
      isTTY: true,
      readSecret: async (promptText: string) => {
        prompts.push(promptText);
        return 'sk-typed-secretly\n';
      },
    });
    expect(
      await run(io, ['provider', 'connect', 'openai', '--agent', 'a', '--auth-type', 'api_key']),
    ).toBe(0);
    expect(prompts[0]).toContain('input hidden');
    expect(JSON.parse(stub.calls[0].body!).apiKey).toBe('sk-typed-secretly');
    expect(io.lines.join('\n')).not.toContain('sk-typed-secretly');
  });

  it('provider connect requires --auth-type when the provider offers a real choice', async () => {
    const { io, calls } = authedIo([]);
    expect(await run(io, ['provider', 'connect', 'xai', '--agent', 'a'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'missing_auth_type',
      message: expect.stringContaining('api_key, subscription'),
    });
    expect(calls).toHaveLength(0);
  });

  afterEach(() => {
    OAUTH_POLL.intervalMs = 2000;
    OAUTH_POLL.timeoutMs = 180_000;
  });

  it('subscription connect (redirect flow) opens the browser and polls to completion', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 500;
    const opened: string[] = [];
    const stub = fetchStub([
      { status: 200, body: { providers: [] } }, // baseline
      { status: 200, body: { url: 'https://accounts.x.ai/authorize?x=1' } },
      { status: 200, body: { providers: [] } }, // first poll: not yet
      {
        status: 200,
        body: {
          providers: [
            {
              provider: 'xai',
              auth_type: 'subscription',
              connections: [{ id: 'c1', is_active: true }],
            },
          ],
        },
      },
    ]);
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: stub.impl,
      isTTY: true,
      openBrowser: (url: string) => {
        opened.push(url);
        return true;
      },
    });
    expect(
      await run(io, ['provider', 'connect', 'xai', '--agent', 'a', '--auth-type', 'subscription']),
    ).toBe(0);
    expect(stub.calls[1].url).toBe(`${HOST}/api/v1/oauth/xai/authorize?agentName=a`);
    expect(opened[0]).toContain('accounts.x.ai');
    expect(io.lastJson()).toEqual({ connected: 'xai', auth_type: 'subscription', agent: 'a' });
  });

  it('subscription connect (redirect flow) times out with a helpful error', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 20;
    const stub = fetchStub(
      Array.from({ length: 60 }, (_, i) =>
        i === 1
          ? { status: 200, body: { url: 'https://accounts.x.ai/a' } }
          : { status: 200, body: { providers: [] } },
      ),
    );
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: stub.impl,
      isTTY: true,
      openBrowser: () => true,
    });
    expect(
      await run(io, ['provider', 'connect', 'xai', '--agent', 'a', '--auth-type', 'subscription']),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'oauth_timeout' });
  });

  it('subscription connect (paste flow) exchanges the pasted code', async () => {
    const stub = fetchStub([
      { status: 200, body: { url: 'https://claude.ai/oauth/authorize?x=1', state: 'st-1' } },
      { status: 200, body: { ok: true } },
    ]);
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: stub.impl,
      isTTY: true,
      readLine: async () => 'the-pasted-code#st-1',
      openBrowser: () => true,
    });
    expect(
      await run(io, [
        'provider',
        'connect',
        'anthropic',
        '--agent',
        'a',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(0);
    expect(stub.calls[0].url).toBe(`${HOST}/api/v1/oauth/anthropic/authorize?agentName=a`);
    expect(JSON.parse(stub.calls[1].body!)).toEqual({
      code: 'the-pasted-code#st-1',
      state: 'st-1',
    });
    expect(io.lastJson()).toEqual({
      connected: 'anthropic',
      auth_type: 'subscription',
      agent: 'a',
    });
  });

  it('subscription connect refuses device-flow providers and non-TTY sessions', async () => {
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: fetchStub([]).impl,
      isTTY: true,
    });
    expect(
      await run(io, [
        'provider',
        'connect',
        'copilot',
        '--agent',
        'a',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'subscription_unsupported' });

    const { io: io2 } = authedIo([]);
    expect(
      await run(io2, ['provider', 'connect', 'xai', '--agent', 'a', '--auth-type', 'subscription']),
    ).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'subscription_needs_tty' });
  });

  it('provider connect never prompts when a credential flag signals scripting (pty-safe)', async () => {
    // Agents under a pty look interactive; an explicit --credential-env must
    // keep the run fully non-blocking.
    const stub = fetchStub([{ status: 201, body: { id: 'p1' } }]);
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key', K: 'xai-secret' },
      fetchImpl: stub.impl,
      isTTY: true,
      readLine: async () => {
        throw new Error('must not prompt');
      },
      readSecret: async () => {
        throw new Error('must not prompt');
      },
    });
    expect(
      await run(io, ['provider', 'connect', 'xai', '--agent', 'a', '--credential-env', 'K']),
    ).toBe(0);
    // a credential source can only mean api_key — inferred, never prompted
    expect(JSON.parse(stub.calls[0].body!).authType).toBe('api_key');
  });

  it('provider connect infers local for local-only providers without prompting', async () => {
    const { io, calls } = authedIo([{ status: 201, body: { id: 'p1' } }]);
    expect(await run(io, ['provider', 'connect', 'ollama', '--agent', 'a'])).toBe(0);
    const body = JSON.parse(calls[0].body!);
    expect(body.authType).toBe('local');
    expect(body).not.toHaveProperty('apiKey');
  });

  it('provider connect validates --auth-type against the catalog', async () => {
    const { io, calls } = authedIo([], { K: 'k' });
    expect(
      await run(io, [
        'provider',
        'connect',
        'openrouter',
        '--agent',
        'a',
        '--auth-type',
        'local',
        '--credential-env',
        'K',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_auth_type' });
    expect(calls).toHaveLength(0);
  });

  it('provider connect treats an empty prompted secret as an error', async () => {
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: fetchStub([]).impl,
      isTTY: true,
      readSecret: async () => '   ',
    });
    expect(
      await run(io, ['provider', 'connect', 'openai', '--agent', 'a', '--auth-type', 'api_key']),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'credential_empty' });
  });

  it('provider connect wraps a non-object response body with the agent used', async () => {
    const { io } = authedIo([{ status: 201, body: null }], { K: 'k' });
    expect(
      await run(io, ['provider', 'connect', 'xai', '--agent', 'a', '--credential-env', 'K']),
    ).toBe(0);
    expect(io.lastJson()).toEqual({ agent: 'a', result: null });
  });

  it('provider connect sends the credential from a named env var, never argv', async () => {
    const { io, calls } = authedIo([{ status: 201, body: { id: 'p1', provider: 'openai' } }], {
      OPENAI_KEY: 'sk-secret',
    });
    expect(
      await run(io, [
        'provider',
        'connect',
        '--provider',
        'openai',
        '--agent',
        'coding',
        '--credential-env',
        'OPENAI_KEY',
        '--label',
        'Main',
      ]),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/coding/providers`);
    expect(JSON.parse(calls[0].body!)).toEqual({
      provider: 'openai',
      apiKey: 'sk-secret',
      authType: 'api_key',
      label: 'Main',
    });
    expect(io.lines.join('\n')).not.toContain('sk-secret');
  });

  it('provider connect --auth-type local needs no credential', async () => {
    const { io, calls } = authedIo([{ status: 201, body: { id: 'p1', provider: 'ollama' } }]);
    expect(
      await run(io, [
        'provider',
        'connect',
        '--provider',
        'ollama',
        '--agent',
        'coding',
        '--auth-type',
        'local',
      ]),
    ).toBe(0);
    expect(JSON.parse(calls[0].body!)).toEqual({ provider: 'ollama', authType: 'local' });
  });

  it('provider connect without a credential source fails before any request', async () => {
    const { io, calls } = authedIo([{ status: 201, body: {} }]);
    expect(
      await run(io, [
        'provider',
        'connect',
        '--provider',
        'openai',
        '--agent',
        'coding',
        '--auth-type',
        'api_key',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'credential_source_required' });
    expect(calls).toHaveLength(0);
  });

  it('provider disconnect requires --yes and forwards authType/label', async () => {
    const io = makeIo({ env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'k' } });
    expect(await run(io, ['provider', 'disconnect', '--provider', 'openai', '--agent', 'a'])).toBe(
      1,
    );

    const { io: ok, calls } = authedIo([{ status: 200, body: { ok: true } }]);
    expect(
      await run(ok, [
        'provider',
        'disconnect',
        '--provider',
        'openai',
        '--agent',
        'a',
        '--auth-type',
        'api_key',
        '--label',
        'Main',
        '--yes',
      ]),
    ).toBe(0);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      `${HOST}/api/v1/routing/a/providers/openai?authType=api_key&label=Main`,
    );
  });
});

describe('models command', () => {
  it('lists routable models trimmed to tier-set fields', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          {
            model_name: 'grok-4',
            provider: 'xai',
            auth_type: 'api_key',
            context_window: 256000,
            input_price_per_token: 0.000003,
            output_price_per_token: 0.000015,
            capability_reasoning: true,
            input_modalities: ['text'],
          },
          'junk',
        ],
      },
    ]);
    expect(await run(io, ['models', 'John'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/available-models`);
    // default mirrors /v1/models: identity only
    expect(io.lastJson()).toEqual({
      agent: 'john',
      count: 1,
      models: [{ model: 'grok-4', provider: 'xai', auth_type: 'api_key' }],
    });
  });

  it('opts into cost and capabilities like /v1/models', async () => {
    const row = {
      model_name: 'grok-4',
      provider: 'xai',
      auth_type: 'api_key',
      context_window: 256000,
      input_price_per_token: 0.000003,
      output_price_per_token: 0.000015,
      capability_reasoning: true,
      capability_code: true,
      input_modalities: ['text'],
    };
    const { io } = authedIo([{ status: 200, body: [row] }]);
    expect(await run(io, ['models', 'john', '--cost'])).toBe(0);
    expect((io.lastJson() as { models: object[] }).models[0]).toEqual({
      model: 'grok-4',
      provider: 'xai',
      auth_type: 'api_key',
      input_price_per_token: 0.000003,
      output_price_per_token: 0.000015,
    });

    const { io: io2 } = authedIo([{ status: 200, body: [row] }]);
    expect(await run(io2, ['models', 'john', '--capabilities'])).toBe(0);
    expect((io2.lastJson() as { models: object[] }).models[0]).toEqual({
      model: 'grok-4',
      provider: 'xai',
      auth_type: 'api_key',
      context_window: 256000,
      capability_reasoning: true,
      capability_code: true,
      input_modalities: ['text'],
    });
  });

  it('filters by provider (alias-aware) and requires the agent explicitly', async () => {
    const { io } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'gemini-3-pro', provider: 'gemini', auth_type: 'api_key' },
          { model_name: 'grok-4', provider: 'xai', auth_type: 'api_key' },
        ],
      },
    ]);
    expect(await run(io, ['models', 'john', '--provider', 'google'])).toBe(0);
    const out = io.lastJson() as { count: number; models: Array<{ model: string }> };
    expect(out.count).toBe(1);
    expect(out.models[0].model).toBe('gemini-3-pro');

    const { io: io2, calls: calls2 } = authedIo([]);
    expect(await run(io2, ['models'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'missing_argument' });
    expect(calls2).toHaveLength(0);
  });

  it('surfaces cost_per_request and tolerates absent capability fields', async () => {
    const row = {
      model_name: 'gpt-6-codex',
      provider: 'opencode-go',
      auth_type: 'subscription',
      cost_per_request: 0.004,
      input_price_per_token: 0,
      output_price_per_token: 0,
      context_window: 400000,
      capability_reasoning: true,
      capability_code: true,
    };
    const { io } = authedIo([{ status: 200, body: [row] }]);
    expect(await run(io, ['models', 'john', '--cost', '--capabilities'])).toBe(0);
    const m = (io.lastJson() as { models: Array<Record<string, unknown>> }).models[0];
    expect(m['cost_per_request']).toBe(0.004);
    expect(m).not.toHaveProperty('capabilities');
    expect(m).not.toHaveProperty('input_modalities');
  });

  it('handles a non-array payload as zero models, with a hint', async () => {
    const { io } = authedIo([{ status: 200, body: { unexpected: true } }]);
    expect(await run(io, ['models', 'a'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      count: 0,
      models: [],
      hint: expect.stringContaining('provider list --agent a'),
    });
  });
});

describe('agent provider enable/disable', () => {
  const groups = {
    providers: [
      {
        provider: 'openai',
        auth_type: 'api_key',
        connections: [{ id: 'conn-a', label: 'Default' }],
      },
      {
        provider: 'openai',
        auth_type: 'subscription',
        connections: [{ id: 'conn-b', label: 'Default' }],
      },
      {
        provider: 'custom:abc',
        auth_type: 'api_key',
        display_name: 'My LiteLLM',
        connections: [{ id: 'conn-c', label: 'Default' }],
      },
    ],
  };

  it('enable resolves a unique connection and PUTs the junction', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: groups },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io, ['agent', 'provider', 'enable', 'John', 'openai', '--auth-type', 'api_key']),
    ).toBe(0);
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].url).toBe(`${HOST}/api/v1/agents/john/enabled-providers/conn-a`);
    expect(io.lastJson()).toMatchObject({ agent: 'john', enabled: true, connection: 'conn-a' });
  });

  it('enable matches custom providers by display name', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: groups },
      { status: 200, body: { ok: true } },
    ]);
    expect(await run(io, ['agent', 'provider', 'enable', 'john', 'my litellm'])).toBe(0);
    expect(calls[1].url).toBe(`${HOST}/api/v1/agents/john/enabled-providers/conn-c`);
  });

  it('ambiguous matches demand a filter; zero matches 404', async () => {
    const { io } = authedIo([{ status: 200, body: groups }]);
    expect(await run(io, ['agent', 'provider', 'enable', 'john', 'openai'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'ambiguous',
      hint: expect.stringContaining('--auth-type'),
    });

    const { io: io2 } = authedIo([{ status: 200, body: groups }]);
    expect(await run(io2, ['agent', 'provider', 'enable', 'john', 'groq'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'not_found' });
  });

  it('disable demands --yes and --agent, and surfaces the route-conflict 409', async () => {
    const { io } = authedIo([]);
    expect(await run(io, ['agent', 'provider', 'disable', 'john', 'openai'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'confirmation_required' });

    const { io: io2 } = authedIo([]);
    expect(await run(io2, ['agent', 'provider', 'disable', 'john', '--yes'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'missing_argument' });

    const { io: io3 } = authedIo([
      { status: 200, body: groups },
      { status: 409, body: { message: "Can't disable provider while its models are assigned" } },
    ]);
    expect(
      await run(io3, [
        'agent',
        'provider',
        'disable',
        'john',
        'openai',
        '--auth-type',
        'api_key',
        '--yes',
      ]),
    ).toBe(1);
    expect((io3.lastJson() as { message: string }).message).toContain("Can't disable");
  });
});

describe('provider custom', () => {
  it('add probes first, then registers with the discovered models', async () => {
    const { io, calls } = authedIo(
      [
        { status: 200, body: { agents: [{ agent_name: 'john' }] } },
        { status: 200, body: { models: [{ model_name: 'llama-4' }, { model_name: 'qwen-3' }] } },
        { status: 201, body: { id: 'cp-1', name: 'My LiteLLM' } },
      ],
      { LK: 'sk-litellm' },
    );
    expect(
      await run(io, [
        'provider',
        'custom',
        'add',
        '--name',
        'My LiteLLM',
        '--endpoint',
        'http://gateway.internal:4000',
        '--credential-env',
        'LK',
      ]),
    ).toBe(0);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/custom-providers/probe`);
    expect(JSON.parse(calls[1].body!)).toMatchObject({
      base_url: 'http://gateway.internal:4000',
      apiKey: 'sk-litellm',
    });
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/custom-providers`);
    const created = JSON.parse(calls[2].body!);
    expect(created.models).toEqual([{ model_name: 'llama-4' }, { model_name: 'qwen-3' }]);
    expect(io.lastJson()).toMatchObject({ probed_models: 2 });
    expect(io.lines.join('\n')).not.toContain('sk-litellm');
  });

  it('add fails when the probe finds no models', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { agents: [{ agent_name: 'john' }] } },
      { status: 200, body: { models: [] } },
    ]);
    expect(
      await run(io, ['provider', 'custom', 'add', '--name', 'dead', '--endpoint', 'http://x:1']),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'probe_empty' });
    expect(calls).toHaveLength(2); // never registered
  });

  it('add rejects an unknown --api kind; remove 404s on unknown names', async () => {
    const { io } = authedIo([]);
    expect(
      await run(io, [
        'provider',
        'custom',
        'add',
        '--name',
        'x',
        '--endpoint',
        'http://x:1',
        '--api',
        'grpc',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_flag' });

    const { io: io2 } = authedIo([
      { status: 200, body: { agents: [{ agent_name: 'john' }] } },
      { status: 200, body: [] },
    ]);
    expect(await run(io2, ['provider', 'custom', 'remove', 'ghost', '--yes'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'not_found' });
  });

  it('disable succeeds end-to-end when no route depends on the connection', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: {
          providers: [
            {
              provider: 'gemini',
              auth_type: 'api_key',
              connections: [{ id: 'conn-g', label: 'Default' }],
            },
          ],
        },
      },
      { status: 200, body: { ok: true } },
    ]);
    expect(await run(io, ['agent', 'provider', 'disable', 'john', 'google', '--yes'])).toBe(0);
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toBe(`${HOST}/api/v1/agents/john/enabled-providers/conn-g`);
    expect(io.lastJson()).toMatchObject({ enabled: false, provider: 'gemini' });
  });

  it('list and remove resolve by name with confirmation', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { agents: [{ agent_name: 'john' }] } },
      { status: 200, body: [{ id: 'cp-1', name: 'My LiteLLM' }] },
      { status: 200, body: { ok: true } },
    ]);
    expect(await run(io, ['provider', 'custom', 'remove', 'my litellm', '--yes'])).toBe(0);
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/custom-providers/cp-1`);

    const { io: io2, calls: calls2 } = authedIo([
      { status: 200, body: { agents: [{ agent_name: 'john' }] } },
      { status: 200, body: [{ id: 'cp-1', name: 'x' }] },
    ]);
    expect(await run(io2, ['provider', 'custom', 'list'])).toBe(0);
    expect(calls2[1].url).toBe(`${HOST}/api/v1/routing/john/custom-providers`);
  });
});

describe('routing test', () => {
  const completion = (content: string, model = 'grok-build-0.1') => ({
    status: 200,
    body: {
      model,
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  });

  it('sends one canned request through the route and reports facts', async () => {
    const { io, calls } = authedIo([completion('OK')]);
    saveAgentKey(io.env, HOST, 'john', 'mnfst_test_key');
    expect(await run(io, ['routing', 'test', 'John', '--as', 'openclaw'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/v1/chat/completions`);
    expect(calls[0].headers['Authorization']).toBe('Bearer mnfst_test_key');
    const body = JSON.parse(calls[0].body!);
    expect(body.model).toBe('auto');
    expect(body.messages[0].content).toContain('Reply with exactly: OK');
    expect(io.lastJson()).toMatchObject({
      agent: 'john',
      ok: true,
      surface: 'chat_completions',
      platform: 'openclaw',
      requested_model: 'auto',
      served_model: 'grok-build-0.1',
      tokens: 15,
      reply: 'OK',
    });
  });

  it('proves tier escalation and explicit models, with a custom prompt', async () => {
    const { io, calls } = authedIo([completion('pong', 'grok-4.5')]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(
      await run(io, [
        'routing',
        'test',
        'john',
        'custom',
        'ping',
        '--as',
        'openclaw',
        '--tier',
        'thorough',
        '--model',
        'grok-4.5',
      ]),
    ).toBe(0);
    expect(calls[0].headers['x-manifest-tier']).toBe('thorough');
    const body = JSON.parse(calls[0].body!);
    expect(body.model).toBe('grok-4.5');
    expect(body.messages[0].content).toBe('custom ping');
    expect(io.lastJson()).toMatchObject({ tier: 'thorough', served_model: 'grok-4.5' });
  });

  it('tests anthropic-family agents through /v1/messages with an Anthropic body', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { agent: { agent_name: 'john', agent_platform: 'claude-code' } } },
      {
        status: 200,
        body: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'OK' }],
          usage: { input_tokens: 12, output_tokens: 2 },
        },
      },
    ]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john'])).toBe(0);
    // platform discovered from the agent record, then the messages surface used
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents/john`);
    expect(calls[1].url).toBe(`${HOST}/v1/messages`);
    expect(calls[1].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[1].headers['User-Agent']).toMatch(/^mnfst-cli\/\d+\.\d+\.\d+/);
    const body = JSON.parse(calls[1].body!);
    expect(body.max_tokens).toBe(64);
    // "auto" routes on /v1/messages exactly like the completions surface —
    // only a concrete model is an explicit route override there.
    expect(body.model).toBe('auto');
    expect(io.lastJson()).toMatchObject({
      surface: 'messages',
      platform: 'claude-code',
      requested_model: 'auto',
      served_model: 'claude-sonnet-5',
      tokens: 14,
      reply: 'OK',
    });
  });

  it('--model overrides the route on the messages surface too', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: { model: 'claude-opus-5', content: [{ type: 'text', text: 'OK' }] },
      },
    ]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(
      await run(io, ['routing', 'test', 'john', '--as', 'claude-code', '--model', 'claude-opus-5']),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/v1/messages`);
    expect(JSON.parse(calls[0].body!).model).toBe('claude-opus-5');
    expect(io.lastJson()).toMatchObject({ requested_model: 'claude-opus-5' });
  });

  it('tests Codex through /v1/responses with a Responses body', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: {
          model: 'gpt-5.3-codex',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      },
    ]);
    saveAgentKey(io.env, HOST, 'john', 'mnfst_test_key');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'codex'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/v1/responses`);
    const body = JSON.parse(calls[0].body!);
    expect(body.model).toBe('auto');
    expect(body.input).toContain('Reply with exactly: OK');
    expect(io.lastJson()).toMatchObject({
      surface: 'responses',
      platform: 'codex',
      requested_model: 'auto',
      served_model: 'gpt-5.3-codex',
      tokens: 11,
      reply: 'OK',
    });
  });

  it('rejects an unknown --as before any network call', async () => {
    const { io, calls } = authedIo([{ status: 200, body: {} }]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'skynet'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'invalid_platform',
      message: expect.stringContaining('claude-code'),
      hint: expect.stringContaining('agent platforms'),
    });
    expect(calls).toHaveLength(0);
  });

  it('unmasks fake-200 Manifest errors as loud failures', async () => {
    const { io } = authedIo([completion('[🦚 Manifest M101] No providers configured. docs')]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'openclaw'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'route_test_failed',
      message: expect.stringContaining('M101'),
      hint: expect.stringContaining('routing status john'),
    });
  });

  it('rejects a 2xx whose surface payload is empty', async () => {
    const { io } = authedIo([{ status: 200, body: { choices: [] } }]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'openclaw'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'route_test_failed',
      message: expect.stringContaining('no chat_completions payload'),
    });
  });

  it('routing custom create rolls back the tier when the route write fails', async () => {
    const { io, calls } = authedIo([
      { status: 201, body: { id: 't1' } }, // POST header-tiers
      { status: 500, body: { message: 'boom' } }, // PUT override
      { status: 200, body: {} }, // DELETE rollback
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'a',
        '--name',
        't',
        '--model',
        'm',
        '--provider',
        'p',
        '--force',
      ]),
    ).toBe(1);
    const last = calls[calls.length - 1];
    expect(last.method).toBe('DELETE');
    expect(last.url).toContain('/header-tiers/t1');
  });

  it('surfaces real HTTP errors and transport failures', async () => {
    const { io } = authedIo([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'openclaw'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'route_test_failed', status: 429 });

    const io2 = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    saveAgentKey(io2.env, HOST, 'john', 'k');
    expect(await run(io2, ['routing', 'test', 'john', '--as', 'openclaw'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'network_error' });
  });

  it('tolerates a non-JSON success body as a loud failure', async () => {
    const { io } = authedIo([{ status: 502, body: null }]);
    saveAgentKey(io.env, HOST, 'john', 'k');
    expect(await run(io, ['routing', 'test', 'john', '--as', 'openclaw'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'route_test_failed', status: 502 });
  });
});

describe('requests get', () => {
  it('passes filters through and surfaces the pagination envelope untouched', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: {
          items: [{ id: 'r1' }, { id: 'r2' }],
          next_cursor: 'opaque-cursor-abc',
          total_count: 41,
          total_count_exact: true,
        },
      },
    ]);
    expect(
      await run(io, [
        'requests',
        'get',
        '--agent',
        'John',
        '--range',
        '24h',
        '--status',
        'error',
        '--limit',
        '2',
      ]),
    ).toBe(0);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/messages');
    expect(url.searchParams.get('agent_name')).toBe('john');
    expect(url.searchParams.get('range')).toBe('24h');
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('limit')).toBe('2');
    expect(io.lastJson()).toEqual({
      agent: 'john',
      count: 2,
      next_cursor: 'opaque-cursor-abc',
      total_count: 41,
      total_count_exact: true,
      requests: [{ id: 'r1' }, { id: 'r2' }],
    });
  });

  it('trims rows to decision fields, omitting nulls; --full passes everything', async () => {
    const row = {
      id: 'r1',
      agent_name: 'john',
      timestamp: 't',
      status: 'failed',
      model: 'auto',
      provider: null,
      auth_type: null,
      cost: '0',
      input_tokens: '0',
      output_tokens: '0',
      duration_ms: 3,
      attempt_count: 0,
      error_code: 'M101',
      error_message: 'no providers',
      error_origin: 'config',
      error_http_status: null,
      error_class: 'no_provider',
      feedback_rating: null,
      display_name: 'auto',
      routing_tier: null,
      routing_reason: null,
      specificity_category: null,
      fallback_from_model: null,
      fallback_index: null,
      header_tier_id: null,
      header_tier_name: null,
      header_tier_color: null,
      provider_key_label: null,
      custom_provider_name: null,
      autofix_applied: false,
      autofix_role: null,
      cache_read_tokens: '0',
      cache_creation_tokens: '0',
    };
    const { io } = authedIo([{ status: 200, body: { items: [row], next_cursor: null } }]);
    expect(await run(io, ['requests', 'get'])).toBe(0);
    expect((io.lastJson() as { requests: object[] }).requests[0]).toEqual({
      id: 'r1',
      agent_name: 'john',
      timestamp: 't',
      status: 'failed',
      model: 'auto',
      provider: null,
      auth_type: null,
      cost: '0',
      input_tokens: '0',
      output_tokens: '0',
      duration_ms: 3,
      attempt_count: 0,
      error_code: 'M101',
      error_message: 'no providers',
      error_origin: 'config',
    });

    const { io: io2 } = authedIo([{ status: 200, body: { items: [row], next_cursor: null } }]);
    expect(await run(io2, ['requests', 'get', '--full'])).toBe(0);
    const full = (io2.lastJson() as { requests: Record<string, unknown>[] }).requests[0];
    expect(full).toHaveProperty('header_tier_color');
    expect(full).toHaveProperty('cache_read_tokens');
  });

  it('keeps meaningful conditionals: custom tier, fallback, autofix', async () => {
    const row = {
      id: 'r2',
      status: 'ok',
      header_tier_name: 'deep',
      fallback_from_model: 'grok-4.5',
      autofix_applied: true,
      custom_provider_name: 'My LiteLLM',
    };
    const { io } = authedIo([{ status: 200, body: { items: [row], next_cursor: null } }]);
    expect(await run(io, ['requests', 'get'])).toBe(0);
    expect((io.lastJson() as { requests: object[] }).requests[0]).toMatchObject({
      header_tier_name: 'deep',
      fallback_from_model: 'grok-4.5',
      autofix_applied: true,
      custom_provider_name: 'My LiteLLM',
    });
  });

  it('pages with the opaque cursor and reports the last page as null', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { items: [{ id: 'r3' }], next_cursor: null, total_count: 41 } },
    ]);
    expect(await run(io, ['requests', 'get', '--cursor', 'opaque-cursor-abc'])).toBe(0);
    expect(new URL(calls[0].url).searchParams.get('cursor')).toBe('opaque-cursor-abc');
    expect(io.lastJson()).toMatchObject({ count: 1, next_cursor: null });
  });

  it('validates --limit against the API cap', async () => {
    const { io, calls } = authedIo([]);
    expect(await run(io, ['requests', 'get', '--limit', '500'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'invalid_flag' });
    const { io: io2 } = authedIo([]);
    expect(await run(io2, ['requests', 'get', '--limit', 'many'])).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('validates --range against the known windows', async () => {
    const { io, calls } = authedIo([]);
    expect(await run(io, ['requests', 'get', '--range', 'bogus'])).toBe(1);
    expect((io.lastJson() as { message: string }).message).toContain('24h');
    expect(calls).toHaveLength(0);
  });

  it('passes non-object rows through untouched', async () => {
    const { io } = authedIo([{ status: 200, body: { items: ['junk', null], next_cursor: null } }]);
    expect(await run(io, ['requests', 'get'])).toBe(0);
    expect((io.lastJson() as { requests: unknown[] }).requests).toEqual(['junk', null]);
  });

  it('tolerates a null body', async () => {
    const { io } = authedIo([{ status: 200, body: null }]);
    expect(await run(io, ['requests', 'get'])).toBe(0);
    expect(io.lastJson()).toMatchObject({ count: 0, next_cursor: null, requests: [] });
  });
});

describe('routing commands', () => {
  it('status composes the real config: default route, custom tiers, toggles', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { tier: 'simple', override_route: { model: 'old' } },
          {
            tier: 'default',
            override_route: { model: 'grok-4.5', provider: 'xai', authType: 'subscription' },
            fallback_routes: [{ model: 'grok-4.3', provider: 'xai' }],
          },
        ],
      },
      {
        status: 200,
        body: [
          {
            id: 'ht-1',
            name: 'deep',
            header_key: 'x-manifest-tier',
            header_value: 'deep',
            enabled: true,
            override_route: { model: 'grok-4.5' },
            fallback_routes: null,
          },
        ],
      },
      { status: 200, body: { enabled: true } },
      { status: 200, body: { enabled: false } },
    ]);
    expect(await run(io, ['routing', 'status', 'John'])).toBe(0);
    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual(
      [
        `${HOST}/api/v1/routing/john/tiers`,
        `${HOST}/api/v1/routing/john/header-tiers`,
        `${HOST}/api/v1/routing/john/autofix`,
        `${HOST}/api/v1/routing/john/recording`,
      ].sort(),
    );
    expect(io.lastJson()).toEqual({
      agent: 'john',
      default: {
        route: { model: 'grok-4.5', provider: 'xai', authType: 'subscription' },
        fallbacks: [{ model: 'grok-4.3', provider: 'xai' }],
      },
      custom_tiers: [
        {
          name: 'deep',
          trigger: 'x-manifest-tier: deep',
          enabled: true,
          route: { model: 'grok-4.5' },
          fallbacks: [],
        },
      ],
      autofix: true,
      recording: false,
    });
  });

  it('status tolerates an unconfigured agent', async () => {
    const { io } = authedIo([
      { status: 200, body: [] },
      { status: 200, body: [] },
      { status: 200, body: { enabled: false } },
      { status: 200, body: { enabled: false } },
    ]);
    expect(await run(io, ['routing', 'status', 'john'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      default: { route: null, fallbacks: [] },
      custom_tiers: [],
    });
  });

  it('agent configure writes the default route with fallbacks from --models', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: DISCOVERED(['grok-4.5', 'm2', 'm3']) },
      { status: 200, body: { ok: true } },
      { status: 200, body: { models: ['m2', 'm3'] } },
    ]);
    expect(
      await run(io, [
        'agent',
        'configure',
        'John',
        '--models',
        'grok-4.5, m2, m3',
        '--provider',
        'xai',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/available-models`);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/tiers/default`);
    expect(JSON.parse(calls[1].body!)).toEqual({
      model: 'grok-4.5',
      provider: 'xai',
      authType: 'subscription',
    });
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/tiers/default/fallbacks`);
    expect(JSON.parse(calls[2].body!)).toEqual({ models: ['m2', 'm3'] });
    expect(io.lastJson()).toMatchObject({ agent: 'john', route: { ok: true } });
  });

  it('agent configure with a single model clears existing fallbacks', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: DISCOVERED(['solo']) },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io, ['agent', 'configure', 'john', '--models', 'solo', '--provider', 'openai']),
    ).toBe(0);
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/tiers/default/fallbacks`);
    expect((io.lastJson() as { fallbacks: unknown }).fallbacks).toEqual([]);
  });

  it('agent configure --tier upserts the named custom tier', async () => {
    // existing tier: found by name, no create
    const { io, calls } = authedIo([
      { status: 200, body: DISCOVERED(['grok-4.5', 'fb']) },
      { status: 200, body: [{ id: 'ht-9', name: 'Test' }] },
      { status: 200, body: { ok: true } },
      { status: 200, body: { models: ['fb'] } },
    ]);
    expect(
      await run(io, [
        'agent',
        'configure',
        'john',
        '--tier',
        'test',
        '--models',
        'grok-4.5,fb',
        '--provider',
        'xai',
      ]),
    ).toBe(0);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/header-tiers`);
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/header-tiers/ht-9/override`);
    expect((io.lastJson() as { tier: { created: boolean } }).tier.created).toBe(false);

    // missing tier: created with the default trigger
    const { io: io2, calls: calls2 } = authedIo([
      { status: 200, body: DISCOVERED(['big-model']) },
      { status: 200, body: [] },
      { status: 201, body: { id: 'ht-new' } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io2, [
        'agent',
        'configure',
        'john',
        '--tier',
        'heavy',
        '--models',
        'big-model',
        '--provider',
        'openai',
      ]),
    ).toBe(0);
    expect(JSON.parse(calls2[2].body!)).toEqual({
      name: 'heavy',
      header_key: 'x-manifest-tier',
      header_value: 'heavy',
      badge_color: 'indigo',
    });
    expect((io2.lastJson() as { tier: { created: boolean } }).tier.created).toBe(true);
  });

  it('agent configure refuses undiscovered models and names both remedies', async () => {
    const { io, calls } = authedIo([{ status: 200, body: DISCOVERED(['grok-4.5']) }]);
    expect(
      await run(io, [
        'agent',
        'configure',
        'john',
        '--models',
        'grok-4.5,typo-model',
        '--provider',
        'xai',
      ]),
    ).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/available-models`);
    const failure = io.lastJson() as { error: string; message: string; hint: string };
    expect(failure.error).toBe('unknown_model');
    expect(failure.message).toContain('typo-model');
    expect(failure.hint).toContain('mnfst provider refresh');
    expect(failure.hint).toContain('--force');

    // A payload that is not a model array is treated as "nothing discovered".
    const { io: io2 } = authedIo([{ status: 200, body: { models: 'weird' } }]);
    expect(
      await run(io2, ['agent', 'configure', 'john', '--models', 'm', '--provider', 'xai']),
    ).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'unknown_model' });

    // Rows without a usable model_name are ignored rather than trusted.
    const { io: io3 } = authedIo([{ status: 200, body: [null, 'x', { model_name: 7 }] }]);
    expect(
      await run(io3, ['agent', 'configure', 'john', '--models', 'm', '--provider', 'xai']),
    ).toBe(1);
    expect(io3.lastJson()).toMatchObject({ error: 'unknown_model' });
  });

  it('agent configure requires the requested auth type on the primary model', async () => {
    const rows = [{ model_name: 'grok-4', provider: 'xai', auth_type: 'subscription' }];

    const mismatched = authedIo([{ status: 200, body: rows }]);
    expect(
      await run(mismatched.io, [
        'agent',
        'configure',
        'john',
        '--models',
        'grok-4',
        '--provider',
        'xai',
        '--auth-type',
        'api_key',
      ]),
    ).toBe(1);
    expect(mismatched.io.lastJson()).toMatchObject({ error: 'auth_type_mismatch' });

    // A custom provider resolves no catalog id, but the auth-type gate still
    // applies to the primary.
    const custom = authedIo([
      {
        status: 200,
        body: [{ model_name: 'm', provider: 'custom:abc', auth_type: 'subscription' }],
      },
    ]);
    expect(
      await run(custom.io, [
        'agent',
        'configure',
        'john',
        '--models',
        'm',
        '--provider',
        'custom:abc',
        '--auth-type',
        'api_key',
      ]),
    ).toBe(1);
    expect(custom.io.lastJson()).toMatchObject({ error: 'auth_type_mismatch' });

    // Rows that carry auth data but omit provider still gate the primary.
    const noProvider = authedIo([
      { status: 200, body: [{ model_name: 'm', auth_type: 'subscription' }] },
    ]);
    expect(
      await run(noProvider.io, [
        'agent',
        'configure',
        'john',
        '--models',
        'm',
        '--provider',
        'custom:abc',
        '--auth-type',
        'api_key',
      ]),
    ).toBe(1);
    expect(noProvider.io.lastJson()).toMatchObject({ error: 'auth_type_mismatch' });

    // A same-named model under another provider must not raise a false mismatch
    // for a custom provider that has not discovered it.
    const otherProvider = authedIo([
      { status: 200, body: [{ model_name: 'm', provider: 'openai', auth_type: 'api_key' }] },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    expect(
      await run(otherProvider.io, [
        'agent',
        'configure',
        'john',
        '--models',
        'm',
        '--provider',
        'custom:abc',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(0);

    const matched = authedIo([
      { status: 200, body: rows },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    expect(
      await run(matched.io, [
        'agent',
        'configure',
        'john',
        '--models',
        'grok-4',
        '--provider',
        'xai',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(0);
  });

  it('agent configure --force skips the model check entirely', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io, [
        'agent',
        'configure',
        'john',
        '--models',
        'brand-new-model',
        '--provider',
        'openai',
        '--force',
      ]),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/tiers/default`);
  });

  it('agent configure toggles autofix/recording, alone or combined', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { enabled: true } },
      { status: 200, body: { enabled: false } },
    ]);
    expect(
      await run(io, ['agent', 'configure', 'john', '--autofix', 'true', '--recording', 'false']),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/autofix`);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/recording`);
    expect(io.lastJson()).toMatchObject({
      autofix: { enabled: true },
      recording: { enabled: false },
    });
  });

  it('agent configure validates its input combinations', async () => {
    const { io } = authedIo([]);
    expect(await run(io, ['agent', 'configure', 'john'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'missing_flag' });

    const { io: io2 } = authedIo([]);
    // --autofix keeps the command non-empty so the tier-needs-route rule fires
    expect(
      await run(io2, ['agent', 'configure', 'john', '--tier', 'test', '--autofix', 'true']),
    ).toBe(1);
    expect((io2.lastJson() as { message: string }).message).toContain('--tier needs');

    const { io: io3 } = authedIo([]);
    expect(
      await run(io3, ['agent', 'configure', 'john', '--models', ' , ', '--provider', 'x']),
    ).toBe(1);
    expect(io3.lastJson()).toMatchObject({ error: 'missing_flag' });
  });

  it('the deprecated complexity-tier commands are gone', async () => {
    const { io } = authedIo([]);
    expect(await run(io, ['routing', 'tier', 'set', 'john', '--tier', 'simple'])).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'unknown_command' });
    const { io: io2 } = authedIo([]);
    expect(await run(io2, ['routing', 'tiers', 'john'])).toBe(1);
    expect(io2.lastJson()).toMatchObject({ error: 'unknown_command' });
  });

  it('fallbacks get/clear target the default route (writes live in agent configure)', async () => {
    const { io, calls } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io, ['routing', 'fallbacks', 'get', 'john'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/tiers/default/fallbacks`);

    const { io: io2 } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io2, ['routing', 'fallbacks', 'clear', 'john'])).toBe(1); // no --yes
    const { io: io3, calls: calls3 } = authedIo([{ status: 200, body: {} }]);
    expect(await run(io3, ['routing', 'fallbacks', 'clear', 'john', '--yes'])).toBe(0);
    expect(calls3[0].url).toBe(`${HOST}/api/v1/routing/john/tiers/default/fallbacks`);

    const { io: io4 } = authedIo([]);
    expect(await run(io4, ['routing', 'fallbacks', 'set', 'john', '--models', 'a'])).toBe(1);
    expect(io4.lastJson()).toMatchObject({ error: 'unknown_command' });
  });

  it('custom create makes the tier, routes it, and sets fallbacks', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: DISCOVERED(['grok-4.5', 'fb-1']) },
      { status: 201, body: { id: 'ht-1', name: 'test' } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { models: ['fb-1'] } },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'test',
        '--model',
        'grok-4.5',
        '--provider',
        'xai',
        '--fallbacks',
        'fb-1',
      ]),
    ).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/available-models`);
    expect(calls[1].url).toBe(`${HOST}/api/v1/routing/john/header-tiers`);
    expect(JSON.parse(calls[1].body!)).toEqual({
      name: 'test',
      header_key: 'x-manifest-tier',
      header_value: 'test',
      badge_color: 'indigo',
    });
    expect(calls[2].url).toBe(`${HOST}/api/v1/routing/john/header-tiers/ht-1/override`);
    expect(JSON.parse(calls[2].body!)).toEqual({
      model: 'grok-4.5',
      provider: 'xai',
      authType: 'api_key',
    });
    expect(calls[3].url).toBe(`${HOST}/api/v1/routing/john/header-tiers/ht-1/fallbacks`);
    expect(io.lastJson()).toMatchObject({ agent: 'john', tier: { id: 'ht-1' } });
  });

  it('custom create rejects an empty --fallbacks list', async () => {
    const { io } = authedIo([
      { status: 201, body: { id: 'ht-x' } },
      { status: 200, body: {} },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'm',
        '--provider',
        'p',
        '--fallbacks',
        ' , ',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'missing_flag' });
  });

  it('custom create honors custom header key/value', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: DISCOVERED(['m']) },
      { status: 201, body: { id: 'ht-2' } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'heavy',
        '--model',
        'm',
        '--provider',
        'openai',
        '--header-key',
        'x-task',
        '--header-value',
        'big',
      ]),
    ).toBe(0);
    expect(JSON.parse(calls[1].body!)).toMatchObject({ header_key: 'x-task', header_value: 'big' });
  });

  it('custom create refuses a model the agent has not discovered, and --force overrides', async () => {
    const { io, calls } = authedIo([{ status: 200, body: DISCOVERED(['known']) }]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'known',
        '--provider',
        'openai',
        '--fallbacks',
        'ghost-1,ghost-2',
      ]),
    ).toBe(1);
    // Nothing was written: the tier is not created before the models check.
    expect(calls).toHaveLength(1);
    expect(io.lastJson()).toMatchObject({
      error: 'unknown_model',
      message: 'Not in the models discovered for "john": ghost-1, ghost-2',
      hint: expect.stringContaining('mnfst provider refresh'),
    });
    expect((io.lastJson() as { hint: string }).hint).toContain('--force');

    const { io: io2, calls: calls2 } = authedIo([
      { status: 201, body: { id: 'ht-f' } },
      { status: 200, body: { ok: true } },
    ]);
    expect(
      await run(io2, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'brand-new',
        '--provider',
        'openai',
        '--force',
      ]),
    ).toBe(0);
    // --force skips the lookup entirely — the tier POST is the first call.
    expect(calls2[0].url).toBe(`${HOST}/api/v1/routing/john/header-tiers`);
  });

  it('custom create rejects a model discovered only under another provider', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'claude-x', provider: 'anthropic' },
          { model_name: 'gpt-4o', provider: 'openai' },
        ],
      },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'claude-x',
        '--provider',
        'openai',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'unknown_model',
      message: expect.stringContaining('under openai'),
    });
    // Only the discovery call ran; no tier was written.
    expect(calls).toHaveLength(1);
  });

  it('custom create accepts a provider-qualified model under its own provider', async () => {
    const { io } = authedIo([
      { status: 200, body: [{ model_name: 'gpt-4o', provider: 'openai' }] },
      { status: 201, body: { id: 't1' } },
      { status: 200, body: {} },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'openai/gpt-4o',
        '--provider',
        'openai',
      ]),
    ).toBe(0);
  });

  it('custom create allows a fallback discovered under another provider', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'gpt-4o', provider: 'openai' },
          { model_name: 'claude-sonnet-4', provider: 'anthropic' },
        ],
      },
      { status: 201, body: { id: 't1' } }, // POST header-tiers
      { status: 200, body: {} }, // PUT override
      { status: 200, body: {} }, // PUT fallbacks
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'gpt-4o',
        '--provider',
        'openai',
        '--fallbacks',
        'claude-sonnet-4',
      ]),
    ).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[3].url).toBe(`${HOST}/api/v1/routing/john/header-tiers/t1/fallbacks`);
    expect(JSON.parse(calls[3].body!)).toEqual({ models: ['claude-sonnet-4'] });
  });

  it('custom create rejects an ambiguous fallback before writing anything', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'gpt-4o', provider: 'openai' },
          { model_name: 'shared-model', provider: 'openai' },
          { model_name: 'shared-model', provider: 'anthropic' },
        ],
      },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'gpt-4o',
        '--provider',
        'openai',
        '--fallbacks',
        'shared-model',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'ambiguous_model' });
    // Discovery only; the tier was never created.
    expect(calls).toHaveLength(1);
  });

  it('custom create rejects a fallback exposed by two auth types of one provider', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'gpt-4o', provider: 'openai', auth_type: 'api_key' },
          { model_name: 'shared', provider: 'openai', auth_type: 'api_key' },
          { model_name: 'shared', provider: 'openai', auth_type: 'subscription' },
        ],
      },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'gpt-4o',
        '--provider',
        'openai',
        '--fallbacks',
        'shared',
      ]),
    ).toBe(1);
    expect(io.lastJson()).toMatchObject({ error: 'ambiguous_model' });
    expect(calls).toHaveLength(1);
  });

  it('custom create normalizes a provider-qualified fallback to its bare id', async () => {
    const { io, calls } = authedIo([
      {
        status: 200,
        body: [
          { model_name: 'gpt-4o', provider: 'openai', auth_type: 'api_key' },
          { model_name: 'claude-sonnet-4', provider: 'anthropic', auth_type: 'api_key' },
        ],
      },
      { status: 201, body: { id: 't1' } },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'gpt-4o',
        '--provider',
        'openai',
        '--fallbacks',
        'anthropic/claude-sonnet-4',
      ]),
    ).toBe(0);
    // The backend matches fallbacks by exact model id, so the bare id is written.
    expect(JSON.parse(calls[3].body!)).toEqual({ models: ['claude-sonnet-4'] });
  });

  it('custom create accepts a native model id that already carries its provider prefix', async () => {
    const { io } = authedIo([
      { status: 200, body: [{ model_name: 'openai/gpt-4o', provider: 'openai' }] },
      { status: 201, body: { id: 't1' } },
      { status: 200, body: {} },
    ]);
    expect(
      await run(io, [
        'routing',
        'custom',
        'create',
        'john',
        '--name',
        'x',
        '--model',
        'openai/gpt-4o',
        '--provider',
        'openai',
      ]),
    ).toBe(0);
  });

  it('custom list and delete resolve tiers by name', async () => {
    const { io, calls } = authedIo([{ status: 200, body: [{ id: 'ht-1', name: 'test' }] }]);
    expect(await run(io, ['routing', 'custom', 'list', 'john'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/header-tiers`);

    const { io: io2, calls: calls2 } = authedIo([
      { status: 200, body: [{ id: 'ht-1', name: 'Test' }] },
      { status: 200, body: { ok: true } },
    ]);
    expect(await run(io2, ['routing', 'custom', 'delete', 'john', 'test', '--yes'])).toBe(0);
    expect(calls2[1].url).toBe(`${HOST}/api/v1/routing/john/header-tiers/ht-1`);

    const { io: io3 } = authedIo([{ status: 200, body: [] }]);
    expect(await run(io3, ['routing', 'custom', 'delete', 'john', 'ghost', '--yes'])).toBe(1);
    expect(io3.lastJson()).toMatchObject({ error: 'not_found' });
  });

  it('autofix and recording get/set wrap GET/PATCH with a strict boolean', async () => {
    const { io, calls } = authedIo([{ status: 200, body: { enabled: true } }]);
    expect(await run(io, ['routing', 'autofix', 'get', 'a'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/a/autofix`);

    const { io: io2, calls: calls2 } = authedIo([{ status: 200, body: { enabled: false } }]);
    expect(await run(io2, ['routing', 'recording', 'set', 'a', '--enabled', 'false'])).toBe(0);
    expect(JSON.parse(calls2[0].body!)).toEqual({ enabled: false });

    const { io: io3 } = authedIo([]);
    expect(await run(io3, ['routing', 'autofix', 'set', 'a', '--enabled', 'maybe'])).toBe(1);
  });
});

describe('provider refresh', () => {
  const CONNECTIONS = {
    providers: [
      {
        provider: 'openai',
        auth_type: 'api_key',
        connections: [
          { id: 'c1', label: 'Default', is_active: true, cached_model_count: 38 },
          { id: 'c2', is_active: false, cached_model_count: 0 },
        ],
      },
    ],
  };

  it('refreshes every connection when no provider is named, then reports counts', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { agents: [{ agent_name: 'john' }] } },
      { status: 200, body: { refreshed: 2 } },
      { status: 200, body: CONNECTIONS },
    ]);
    expect(await run(io, ['provider', 'refresh'])).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${HOST}/api/v1/agents`,
      `POST ${HOST}/api/v1/routing/john/refresh-models`,
      `GET ${HOST}/api/v1/providers`,
    ]);
    expect(io.lastJson()).toEqual({
      agent: 'john',
      refresh: { refreshed: 2 },
      connections: [
        {
          provider: 'openai',
          auth_type: 'api_key',
          label: 'Default',
          is_active: true,
          cached_model_count: 38,
        },
        { provider: 'openai', auth_type: 'api_key', is_active: false, cached_model_count: 0 },
      ],
    });
  });

  it('scopes to one provider (aliases resolved) with --auth-type and --agent', async () => {
    const { io, calls } = authedIo([
      { status: 200, body: { ok: true } },
      { status: 200, body: CONNECTIONS },
    ]);
    expect(
      await run(io, [
        'provider',
        'refresh',
        'google',
        '--agent',
        'John Doe',
        '--auth-type',
        'subscription',
      ]),
    ).toBe(0);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      `${HOST}/api/v1/routing/john-doe/providers/gemini/refresh-models?authType=subscription`,
    );
    expect(io.lastJson()).toMatchObject({ agent: 'john-doe', provider: 'gemini' });
  });

  it('rejects an unknown provider before any network call', async () => {
    const { io, calls } = authedIo([]);
    expect(await run(io, ['provider', 'refresh', 'nope-ai'])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(io.lastJson()).toMatchObject({ error: 'unknown_provider' });
  });

  it('tolerates a providers payload with no usable rows', async () => {
    const { io } = authedIo([
      { status: 200, body: { ok: true } },
      { status: 200, body: { providers: ['weird', { provider: 'x', connections: 'nope' }, null] } },
    ]);
    expect(await run(io, ['provider', 'refresh', 'openai', '--agent', 'a'])).toBe(0);
    expect(io.lastJson()).toMatchObject({ connections: [] });

    const { io: io2 } = authedIo([
      { status: 200, body: { ok: true } },
      { status: 200, body: null },
    ]);
    expect(await run(io2, ['provider', 'refresh', 'openai', '--agent', 'a'])).toBe(0);
    expect(io2.lastJson()).toMatchObject({ connections: [] });
  });
});

describe('model prices', () => {
  const PRICES = {
    models: [
      {
        model_name: 'gpt-5',
        provider: 'OpenAI',
        input_price_per_million: 1.25,
        output_price_per_million: 10,
        display_name: 'GPT-5',
        validated: true,
      },
      {
        model_name: 'gemini-3-pro',
        provider: 'Google',
        input_price_per_million: 15,
        output_price_per_million: 75,
        display_name: null,
        validated: false,
      },
    ],
    lastSyncedAt: '2026-08-02T09:00:00.000Z',
  };

  it('lists trimmed price rows without needing an agent', async () => {
    const { io, calls } = authedIo([{ status: 200, body: PRICES }]);
    expect(await run(io, ['model', 'prices'])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HOST}/api/v1/model-prices`);
    expect(io.lastJson()).toEqual({
      count: 2,
      last_synced_at: '2026-08-02T09:00:00.000Z',
      models: [
        {
          model: 'gpt-5',
          provider: 'OpenAI',
          input_price_per_million: 1.25,
          output_price_per_million: 10,
        },
        {
          model: 'gemini-3-pro',
          provider: 'Google',
          input_price_per_million: 15,
          output_price_per_million: 75,
        },
      ],
    });
  });

  it('collapses IEEE float noise in prices and passes non-numbers through', async () => {
    const noisy = {
      models: [
        {
          model_name: 'grok-5-mini',
          provider: 'xAI',
          input_price_per_million: 0.09999999999999999,
          output_price_per_million: null,
        },
      ],
      lastSyncedAt: null,
    };
    const { io } = authedIo([{ status: 200, body: noisy }]);
    expect(await run(io, ['model', 'prices'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      models: [
        { model: 'grok-5-mini', input_price_per_million: 0.1, output_price_per_million: null },
      ],
    });
  });

  it('--provider filters by id or alias against the display name the API returns', async () => {
    const { io } = authedIo([{ status: 200, body: PRICES }]);
    expect(await run(io, ['model', 'prices', '--provider', 'openai'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      provider: 'openai',
      count: 1,
      models: [{ model: 'gpt-5' }],
    });

    // Alias in, canonical id out — and the row's display name ("Google") is
    // what the endpoint labels it with, not the catalog id.
    const { io: io2 } = authedIo([{ status: 200, body: PRICES }]);
    expect(await run(io2, ['model', 'prices', '--provider', 'google'])).toBe(0);
    expect(io2.lastJson()).toMatchObject({
      provider: 'gemini',
      count: 1,
      models: [{ model: 'gemini-3-pro' }],
    });

    const { io: io3 } = authedIo([]);
    expect(await run(io3, ['model', 'prices', '--provider', 'nope-ai'])).toBe(1);
    expect(io3.lastJson()).toMatchObject({ error: 'unknown_provider' });
  });

  it('tolerates a payload with no models', async () => {
    const { io } = authedIo([{ status: 200, body: null }]);
    expect(await run(io, ['model', 'prices'])).toBe(0);
    expect(io.lastJson()).toEqual({ count: 0, last_synced_at: null, models: [] });

    const { io: io2 } = authedIo([{ status: 200, body: { models: [null, 'weird'] } }]);
    expect(await run(io2, ['model', 'prices'])).toBe(0);
    expect(io2.lastJson()).toMatchObject({ count: 0 });
  });

  it('does not shadow the per-agent models command', async () => {
    const { io, calls } = authedIo([{ status: 200, body: [] }]);
    expect(await run(io, ['models', 'john'])).toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/routing/john/available-models`);
  });
});

describe('doctor', () => {
  const HEALTHY = { status: 200, body: { status: 'healthy', uptime_seconds: 42 } };
  const ONE_AGENT = { status: 200, body: { agents: [{ agent_name: 'john' }] } };
  const LIVE_PROVIDER = {
    status: 200,
    body: {
      providers: [
        {
          provider: 'openai',
          auth_type: 'api_key',
          connections: [{ is_active: true, cached_model_count: 38 }],
        },
      ],
    },
  };

  /** A HOME with no skill installed, so the informational check is stable. */
  const BARE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-bare-home-'));

  function checksOf(io: { lastJson(): unknown }) {
    return (io.lastJson() as { checks: Array<Record<string, unknown>> }).checks;
  }

  it('reports every check green against a healthy install (env credential)', async () => {
    const { io, calls } = authedIo([HEALTHY, ONE_AGENT, LIVE_PROVIDER], { HOME: BARE_HOME });
    expect(await run(io, ['doctor'])).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      `${HOST}/api/v1/health`,
      `${HOST}/api/v1/agents`,
      `${HOST}/api/v1/providers`,
    ]);
    // The health probe is public — doctor must not send the key to prove that.
    expect(calls[1].headers['X-API-Key']).toBe('env-key');
    expect(io.lastJson()).toEqual({
      ok: true,
      checks: [
        {
          name: 'config',
          ok: true,
          detail: `credential from MANIFEST_API_KEY (env) · origin ${HOST} (from MANIFEST_URL)`,
        },
        { name: 'host', ok: true, detail: `${HOST}/api/v1/health → healthy` },
        { name: 'auth', ok: true, detail: `credential accepted by ${HOST}` },
        { name: 'providers', ok: true, detail: '1 connection(s) across 1 provider(s)' },
        { name: 'agents', ok: true, detail: '1 agent(s)' },
        { name: 'skill', ok: true, detail: 'not_found', hint: 'mnfst skill install' },
      ],
    });
  });

  it('reports the skill as informational: found, never failing the run', async () => {
    // Installed under the detected runtime's directory.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-home-'));
    const file = path.join(home, '.claude', 'skills', 'mnfst-cli', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SKILL_MD);
    const { io } = authedIo([HEALTHY, ONE_AGENT, LIVE_PROVIDER], {
      HOME: home,
      CLAUDECODE: '1',
    });
    expect(await run(io, ['doctor'])).toBe(0);
    expect(checksOf(io)[5]).toEqual({
      name: 'skill',
      ok: true,
      detail: `installed at ${file} · Claude Code detected`,
    });

    // Missing, with a runtime detected: still ok, still exit 0.
    const { io: io2 } = authedIo([HEALTHY, ONE_AGENT, LIVE_PROVIDER], {
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-home-')),
      CURSOR_TRACE_ID: 'x',
    });
    expect(await run(io2, ['doctor'])).toBe(0);
    expect(checksOf(io2)[5]).toEqual({
      name: 'skill',
      ok: true,
      detail: 'not_found · Cursor detected',
      hint: 'mnfst skill install',
    });
  });

  it('names the stored login and the --url flag as the origin source', async () => {
    const stub = fetchStub([HEALTHY, ONE_AGENT, LIVE_PROVIDER]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, { activeHost: HOST, hosts: { [HOST]: { apiKey: 'stored-key' } } });
    expect(await run(io, ['doctor'])).toBe(0);
    expect(checksOf(io)[0].detail).toBe(
      `credential from stored login · origin ${HOST} (from stored login)`,
    );

    const stub2 = fetchStub([HEALTHY, ONE_AGENT, LIVE_PROVIDER]);
    const io2 = makeIo({ env: { MANIFEST_API_KEY: 'k' }, fetchImpl: stub2.impl });
    expect(await run(io2, ['doctor', '--url', HOST])).toBe(0);
    expect(checksOf(io2)[0].detail).toContain('(from --url)');
  });

  it('fails closed with no credential at all, skipping everything downstream', async () => {
    const stub = fetchStub([HEALTHY]);
    const io = makeIo({ fetchImpl: stub.impl, env: { HOME: BARE_HOME } });
    expect(await run(io, ['doctor'])).toBe(1);
    const checks = checksOf(io);
    expect(checks[0]).toEqual({
      name: 'config',
      ok: false,
      detail: 'no credential for https://app.manifest.build (origin from default)',
      hint: 'Run mnfst login, or set MANIFEST_URL + MANIFEST_API_KEY',
    });
    expect(checks[1].ok).toBe(true);
    expect(checks.slice(2, 5)).toEqual([
      { name: 'auth', ok: null, skipped: true, detail: 'skipped — no credential resolved' },
      { name: 'providers', ok: null, skipped: true, detail: 'skipped — auth check did not pass' },
      { name: 'agents', ok: null, skipped: true, detail: 'skipped — auth check did not pass' },
    ]);
    // The informational skill check never turns a run red on its own.
    expect(checks[5]).toMatchObject({ name: 'skill', ok: true });
  });

  it('calls an unreachable host by its name, and skips auth rather than blaming the key', async () => {
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key', MANIFEST_TELEMETRY_DISABLED: '1' },
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await run(io, ['doctor'])).toBe(1);
    const checks = checksOf(io);
    expect(checks[1]).toEqual({
      name: 'host',
      ok: false,
      detail: `${HOST}/api/v1/health → ECONNREFUSED`,
      hint: 'host unreachable — is MANIFEST_URL correct?',
    });
    expect(checks[2]).toMatchObject({ detail: 'skipped — host check failed' });
  });

  it('stringifies a non-Error transport failure', async () => {
    const io = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'k', MANIFEST_TELEMETRY_DISABLED: '1' },
      fetchImpl: (() => Promise.reject('dns exploded')) as unknown as typeof fetch,
    });
    expect(await run(io, ['doctor'])).toBe(1);
    expect(checksOf(io)[1].detail).toBe(`${HOST}/api/v1/health → dns exploded`);
  });

  it('treats a draining or non-JSON health response as unhealthy', async () => {
    const { io } = authedIo([{ status: 503, body: { status: 'shutting_down' } }]);
    expect(await run(io, ['doctor'])).toBe(1);
    expect(checksOf(io)[1]).toEqual({
      name: 'host',
      ok: false,
      detail: `${HOST}/api/v1/health → HTTP 503 (shutting_down)`,
      hint: 'the server answered but is not healthy — check the install is running and not draining',
    });

    const io2 = makeIo({
      env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'k', MANIFEST_TELEMETRY_DISABLED: '1' },
      fetchImpl: (async () =>
        new Response('<html>gateway</html>', { status: 502 })) as typeof fetch,
    });
    expect(await run(io2, ['doctor'])).toBe(1);
    expect(checksOf(io2)[1].detail).toBe(`${HOST}/api/v1/health → HTTP 502`);
  });

  it('blames the host/key pairing — not the login — when a live host rejects an env key', async () => {
    const { io } = authedIo([HEALTHY, { status: 401, body: { message: 'Invalid API key' } }]);
    expect(await run(io, ['doctor'])).toBe(1);
    const auth = checksOf(io)[2];
    expect(auth).toMatchObject({ name: 'auth', ok: false, detail: 'Invalid API key' });
    expect(auth.hint).toBe(
      `${HOST} is alive but this credential is not valid on it — wrong install or wrong key` +
        ' (check MANIFEST_API_KEY belongs to this host)',
    );
    expect(auth.hint).not.toContain('Run mnfst login');
    // Downstream checks are skipped, not failed.
    expect(
      checksOf(io)
        .slice(3, 5)
        .map((c) => c.ok),
    ).toEqual([null, null]);
  });

  it('points a stored-login 401 at re-authentication instead', async () => {
    const stub = fetchStub([HEALTHY, { status: 401, body: { message: 'Invalid API key' } }]);
    const io = makeIo({ fetchImpl: stub.impl });
    writeConfig(io, { activeHost: HOST, hosts: { [HOST]: { apiKey: 'stale' } } });
    expect(await run(io, ['doctor'])).toBe(1);
    expect(checksOf(io)[2].hint).toContain('mnfst login re-authenticates');
  });

  it('passes a non-401 auth failure through with the client hint', async () => {
    const { io } = authedIo([HEALTHY, { status: 500, body: { message: 'boom' } }]);
    expect(await run(io, ['doctor'])).toBe(1);
    expect(checksOf(io)[2]).toEqual({ name: 'auth', ok: false, detail: 'boom' });

    const { io: io2 } = authedIo([HEALTHY, { status: 404, body: { message: 'gone' } }]);
    expect(await run(io2, ['doctor'])).toBe(1);
    expect(checksOf(io2)[2].hint).toContain('Check the resource name');
  });

  it('flags hollow connections by name and prescribes provider refresh', async () => {
    const { io } = authedIo([
      HEALTHY,
      ONE_AGENT,
      {
        status: 200,
        body: {
          providers: [
            {
              provider: 'openai',
              auth_type: 'api_key',
              connections: [
                { is_active: true, cached_model_count: 0, label: 'Work' },
                { is_active: true, cached_model_count: 12 },
                // Inactive with 0 models is disabled, not hollow.
                { is_active: false, cached_model_count: 0 },
                'weird',
              ],
            },
            { provider: 'xai', auth_type: 'subscription', connections: 'nope' },
            null,
          ],
        },
      },
    ]);
    expect(await run(io, ['doctor'])).toBe(1);
    const providers = checksOf(io)[3];
    expect(providers).toMatchObject({ ok: false, detail: '3 connection(s) across 2 provider(s)' });
    expect(providers.hint).toBe(
      'hollow (no discovered models — reconnect with a working credential or run: mnfst provider refresh): openai/api_key/Work',
    );
  });

  it('calls out an install with nothing connected and no agents', async () => {
    const { io } = authedIo([
      HEALTHY,
      { status: 200, body: { agents: [] } },
      { status: 200, body: {} },
    ]);
    expect(await run(io, ['doctor'])).toBe(0);
    expect(checksOf(io)[3]).toEqual({
      name: 'providers',
      ok: true,
      detail: '0 connection(s) across 0 provider(s)',
      hint: 'nothing to route through yet — mnfst provider connect <provider>',
    });
    expect(checksOf(io)[4]).toEqual({
      name: 'agents',
      ok: true,
      detail: '0 agent(s)',
      hint: 'no agent yet — mnfst agent create --name <name> --platform <p>',
    });
  });

  it('fails the providers check when the providers call itself errors', async () => {
    const { io } = authedIo([HEALTHY, ONE_AGENT, { status: 500, body: { message: 'db down' } }]);
    expect(await run(io, ['doctor'])).toBe(1);
    expect(checksOf(io)[3]).toEqual({ name: 'providers', ok: false, detail: 'db down' });
    // The agents check still reports — it reuses the list auth already fetched.
    expect(checksOf(io)[4]).toMatchObject({ name: 'agents', ok: true });
  });

  it('tolerates an agents payload without an array', async () => {
    const { io } = authedIo([HEALTHY, { status: 200, body: { agents: 'weird' } }, LIVE_PROVIDER]);
    expect(await run(io, ['doctor'])).toBe(0);
    expect(checksOf(io)[4]).toMatchObject({ detail: '0 agent(s)' });
  });
});

describe('skill', () => {
  /** A throwaway HOME so nothing reads or writes the developer's real one. */
  function tempHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-home-'));
  }
  const skillFile = (base: string, ...segments: string[]) =>
    path.join(base, ...segments, 'mnfst-cli', 'SKILL.md');

  it('skill show prints raw markdown on stdout, and bare `skill` is the same command', async () => {
    const io = makeIo();
    expect(await run(io, ['skill', 'show'])).toBe(0);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toBe(SKILL_MD);
    // Deliberately not JSON — the second exception after `agent env`.
    expect(() => JSON.parse(io.lines[0])).toThrow();

    const io2 = makeIo();
    expect(await run(io2, ['skill'])).toBe(0);
    expect(io2.lines[0]).toBe(SKILL_MD);
  });

  it('skill install writes ~/.claude/skills/mnfst-cli/SKILL.md and is idempotent', async () => {
    const home = tempHome();
    const io = makeIo({ env: { HOME: home } });
    expect(await run(io, ['skill', 'install'])).toBe(0);
    const expected = skillFile(home, '.claude', 'skills');
    expect(io.lastJson()).toEqual({
      path: expected,
      updated: true,
      target: 'default',
      version: SKILL_VERSION,
    });
    expect(fs.readFileSync(expected, 'utf8')).toBe(SKILL_MD);

    // Second run: identical content, so nothing is rewritten.
    const io2 = makeIo({ env: { HOME: home } });
    expect(await run(io2, ['skill', 'install'])).toBe(0);
    expect(io2.lastJson()).toMatchObject({ updated: false, target: 'default' });

    // A drifted copy is replaced — the command owns exactly this one file.
    fs.writeFileSync(expected, 'stale');
    const io3 = makeIo({ env: { HOME: home } });
    expect(await run(io3, ['skill', 'install'])).toBe(0);
    expect(io3.lastJson()).toMatchObject({ updated: true });
    expect(fs.readFileSync(expected, 'utf8')).toBe(SKILL_MD);
  });

  it('flags outrank detection, detection outranks the default', async () => {
    const home = tempHome();
    // --agents-dir wins even though Claude Code is detected.
    const io = makeIo({ env: { HOME: home, CLAUDECODE: '1' } });
    expect(await run(io, ['skill', 'install', '--agents-dir'])).toBe(0);
    expect(io.lastJson()).toMatchObject({
      path: skillFile(home, '.agents', 'skills'),
      target: 'flag',
    });

    // Detected runtime decides when no flag is given.
    const home2 = tempHome();
    const io2 = makeIo({ env: { HOME: home2, CURSOR_TRACE_ID: 'x' } });
    expect(await run(io2, ['skill', 'install'])).toBe(0);
    expect(io2.lastJson()).toMatchObject({
      path: skillFile(home2, '.agents', 'skills'),
      target: 'detected:cursor',
    });

    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-project-'));
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(project);
    try {
      const io3 = makeIo({ env: { HOME: tempHome() } });
      expect(await run(io3, ['skill', 'install', '--project'])).toBe(0);
      expect(io3.lastJson()).toMatchObject({
        path: skillFile(project, '.claude', 'skills'),
        target: 'flag',
      });
      expect(fs.readFileSync(skillFile(project, '.claude', 'skills'), 'utf8')).toBe(SKILL_MD);
    } finally {
      cwd.mockRestore();
    }
  });

  it('refuses two destinations at once', async () => {
    const io = makeIo({ env: { HOME: tempHome() } });
    expect(await run(io, ['skill', 'install', '--agents-dir', '--project'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'invalid_flag',
      message: 'Pass one destination: --agents-dir or --project, not both',
    });
  });

  it('fails with a clear error when the destination cannot be written', async () => {
    const home = tempHome();
    // A FILE where the skills tree needs a directory: mkdir -p fails.
    fs.writeFileSync(path.join(home, '.claude'), 'not a directory');
    const io = makeIo({ env: { HOME: home } });
    expect(await run(io, ['skill', 'install'])).toBe(1);
    expect(io.lastJson()).toMatchObject({
      error: 'write_failed',
      message: expect.stringContaining('Could not write'),
      hint: expect.stringContaining('--project'),
    });
  });

  it('login nudges about the skill on stderr, never on stdout', async () => {
    const stub = fetchStub([{ status: 200, body: ME }]);
    const io = makeIo({
      env: { MNFST_TOKEN: 'tok-123', MANIFEST_URL: HOST, HOME: tempHome() },
      fetchImpl: stub.impl,
    });
    expect(await run(io, ['login', '--token-env', 'MNFST_TOKEN'])).toBe(0);
    expect(io.errLines).toContain(SKILL_NUDGE);
    expect(io.lines.join('\n')).not.toContain(SKILL_NUDGE);
  });
});

describe('agent runtime detection', () => {
  it('maps each marker to its runtime and skills directory', () => {
    expect(detectAgentRuntime({ CLAUDECODE: '1' })).toEqual({
      id: 'claude-code',
      name: 'Claude Code',
      skillsDir: '~/.claude/skills',
    });
    expect(detectAgentRuntime({ CURSOR_TRACE_ID: 'abc' })).toMatchObject({ id: 'cursor' });
    expect(detectAgentRuntime({ CODEX_SANDBOX: 'seatbelt' })).toMatchObject({ id: 'codex' });
    expect(detectAgentRuntime({ CODEX_HOME: '/tmp/codex' })).toMatchObject({
      id: 'codex',
      name: 'Codex CLI',
      skillsDir: '~/.agents/skills',
    });
  });

  it('detects nothing for a human shell, and ignores empty markers', () => {
    expect(detectAgentRuntime({})).toBeNull();
    expect(detectAgentRuntime({ PATH: '/usr/bin', CLAUDECODE: '' })).toBeNull();
  });

  it('expands a leading ~ from HOME, and leaves absolute paths alone', () => {
    expect(resolveHomePath({ HOME: '/home/me' }, '~/.claude/skills')).toBe(
      '/home/me/.claude/skills',
    );
    expect(resolveHomePath({ HOME: '/home/me' }, '/etc/skills')).toBe('/etc/skills');
    // No HOME → the OS answer, which is what os.homedir() is for.
    expect(resolveHomePath({}, '~/x')).toBe(path.join(os.homedir(), 'x'));
  });
});

describe('skill nudge', () => {
  function nudgeIo(env: Record<string, string | undefined> = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-home-'));
    return { home, io: makeIo({ env: { HOME: home, CLAUDECODE: '1', ...env } }) };
  }
  const HINT = /Claude Code detected — run 'mnfst skill install'/;

  it('fires once per runtime after a successful command, then stays silent', async () => {
    const { home, io } = nudgeIo();
    const cfg = io.configDir;
    expect(await run(io, ['config', 'path'])).toBe(0);
    expect(io.errLines.join('\n')).toMatch(HINT);
    expect(io.errLines.join('\n')).toContain('Shown once.');
    expect(io.lines.join('\n')).not.toMatch(HINT);

    // State persisted next to the config — a later run says nothing.
    const state = JSON.parse(
      fs.readFileSync(path.join(cfg, 'manifest', 'skill-nudge.json'), 'utf8'),
    ) as { shown: Record<string, string> };
    expect(Date.parse(state.shown['claude-code'])).not.toBeNaN();

    const io2 = makeIo({ env: { HOME: home, CLAUDECODE: '1', XDG_CONFIG_HOME: cfg } });
    expect(await run(io2, ['config', 'path'])).toBe(0);
    expect(io2.errLines.join('\n')).not.toMatch(HINT);

    // A different runtime on the same machine is nudged on its own terms.
    const io3 = makeIo({ env: { HOME: home, CURSOR_TRACE_ID: 'x', XDG_CONFIG_HOME: cfg } });
    expect(await run(io3, ['config', 'path'])).toBe(0);
    expect(io3.errLines.join('\n')).toMatch(/Cursor detected/);
  });

  it('stays silent for humans, for the skill commands, and on failure', async () => {
    const noRuntime = makeIo({ env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'h-')) } });
    expect(await run(noRuntime, ['config', 'path'])).toBe(0);
    expect(noRuntime.errLines.join('\n')).not.toMatch(HINT);

    const { io: onSkill } = nudgeIo();
    expect(await run(onSkill, ['skill', 'install'])).toBe(0);
    expect(onSkill.errLines.join('\n')).not.toMatch(HINT);

    const { io: onShow } = nudgeIo();
    expect(await run(onShow, ['skill'])).toBe(0);
    expect(onShow.errLines.join('\n')).not.toMatch(HINT);

    const { io: onFailure } = nudgeIo();
    expect(await run(onFailure, ['agent', 'delete', 'x'])).toBe(1);
    expect(onFailure.errLines.join('\n')).not.toMatch(HINT);
  });

  it('stays silent once the runtime already has the skill', async () => {
    const { home, io } = nudgeIo();
    const file = path.join(home, '.claude', 'skills', 'mnfst-cli', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SKILL_MD);
    expect(await run(io, ['config', 'path'])).toBe(0);
    expect(io.errLines.join('\n')).not.toMatch(HINT);
  });

  it('tolerates corrupt state, and swallows an unwritable state file', async () => {
    // Corrupt JSON → treated as "never shown", so the hint still fires.
    const { io } = nudgeIo();
    const configDir = path.join(io.configDir, 'manifest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'skill-nudge.json'), '{not json');
    expect(await run(io, ['config', 'path'])).toBe(0);
    expect(io.errLines.join('\n')).toMatch(HINT);

    // Unwritable state (a FILE where the config dir must be): hint still
    // printed, command still succeeds, nothing thrown.
    const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-home-'));
    const brokenConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-cfg-'));
    fs.writeFileSync(path.join(brokenConfig, 'manifest'), 'not a directory');
    const io2 = makeIo({
      env: { HOME: brokenHome, CLAUDECODE: '1', XDG_CONFIG_HOME: brokenConfig },
    });
    expect(await run(io2, ['config', 'path'])).toBe(0);
    expect(io2.errLines.join('\n')).toMatch(HINT);
  });
});
