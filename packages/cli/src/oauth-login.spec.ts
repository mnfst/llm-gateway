import * as http from 'http';
import { EventEmitter } from 'events';
import { browserLogin, deriveCodeChallenge } from './oauth-login';
import { CliError } from './errors';
import { CliIo } from './context';

function makeIo(fetchImpl: typeof fetch, openBrowser: (url: string) => boolean): CliIo {
  return {
    env: {},
    fetchImpl,
    stdout: jest.fn(),
    stderr: jest.fn(),
    readStdin: jest.fn(),
    isTTY: true,
    openBrowser,
  };
}

/** Simulate the browser: hit the CLI's loopback callback with given params. */
function fakeBrowser(transform: (authUrl: URL) => string): (url: string) => boolean {
  return (url: string) => {
    const authUrl = new URL(url);
    const callback = transform(authUrl);
    void http.get(callback, () => undefined);
    return true;
  };
}

describe('browserLogin', () => {
  it('completes the loopback handshake and exchanges the code', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ token: 'mnfst_pat_ok', expiresAt: '2026-09-01T00:00:00Z' }),
    });
    let openedUrl = '';
    const io = makeIo(exchange as unknown as typeof fetch, (url: string) => {
      openedUrl = url;
      return fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      )(url);
    });
    const result = await browserLogin(io, 'http://localhost:3001');
    expect(result).toEqual({ token: 'mnfst_pat_ok', expiresAt: '2026-09-01T00:00:00Z' });
    const [url, init] = exchange.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/v1/cli/token');
    const body = JSON.parse(init.body);
    expect(body.code).toBe('code-abcdefghijklmnop');
    // PKCE: the auth URL advertises the S256 challenge, and the matching
    // verifier rides the exchange — never the browser redirect.
    const sentChallenge = new URL(openedUrl).searchParams.get('code_challenge');
    expect(new URL(openedUrl).searchParams.get('code_challenge_method')).toBe('S256');
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sentChallenge).toBe(deriveCodeChallenge(body.code_verifier));
  });

  it('deriveCodeChallenge produces the RFC 7636 S256 vector', () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('ignores a callback with the wrong state and times out', async () => {
    const io = makeIo(
      jest.fn() as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=x-abcdefghijklmnop&state=WRONG`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001', 300)).rejects.toThrow(CliError);
  });

  it('times out when the browser never calls back', async () => {
    const io = makeIo(jest.fn() as unknown as typeof fetch, () => true);
    await expect(browserLogin(io, 'http://localhost:3001', 200)).rejects.toThrow(
      expect.objectContaining({ code: 'login_timeout' }),
    );
  });

  it('prints the URL for manual opening when the browser fails to open', async () => {
    const io = makeIo(jest.fn() as unknown as typeof fetch, () => false);
    await expect(browserLogin(io, 'http://localhost:3001', 200)).rejects.toThrow(CliError);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('Open this URL'));
  });

  it('prints the URL even when the opener reports success', async () => {
    // Opening can still fail asynchronously (missing binary, headless box), so
    // the manual-open URL is unconditional — never only on the failure branch.
    const io = makeIo(jest.fn() as unknown as typeof fetch, () => true);
    await expect(browserLogin(io, 'http://localhost:3001', 200)).rejects.toThrow(CliError);
    const printed = (io.stderr as jest.Mock).mock.calls[0][0] as string;
    expect(printed).toContain('If nothing opens, visit:');
    expect(printed).toMatch(/http:\/\/localhost:3001\/cli\/auth\?port=\d+&state=/);
  });

  it('surfaces a server rejection of the exchange', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'Invalid or expired authorization code' }),
    });
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).rejects.toThrow(
      'Invalid or expired authorization code',
    );
  });

  it('reports a generic failure when the exchange body is not JSON', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<html>bad gateway</html>',
    });
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).rejects.toThrow(
      'Token exchange failed with HTTP 502',
    );
  });

  it('reports login_failed when the exchange returns a JSON null body', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'null',
    });
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).rejects.toMatchObject({
      code: 'login_failed',
    });
  });

  it('returns a null expiresAt when the server omits it', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 'mnfst_pat_ok' }),
    });
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).resolves.toEqual({
      token: 'mnfst_pat_ok',
      expiresAt: null,
    });
  });

  it('wraps a transport failure of the exchange as network_error', async () => {
    const exchange = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).rejects.toThrow(
      expect.objectContaining({ code: 'network_error' }),
    );
  });

  it('aborts the code exchange after its own timeout', async () => {
    // Parity with ApiClient: a hung server must not wedge the CLI holding a
    // one-time code that is expiring anyway.
    const exchange = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        }),
    );
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001', 5_000, 5)).rejects.toThrow(
      expect.objectContaining({ code: 'network_error' }),
    );
  });

  it('wraps a non-Error transport rejection as network_error', async () => {
    const exchange = jest.fn().mockRejectedValue('socket hang up');
    const io = makeIo(
      exchange as unknown as typeof fetch,
      fakeBrowser(
        (u) =>
          `http://127.0.0.1:${u.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${u.searchParams.get('state')}`,
      ),
    );
    await expect(browserLogin(io, 'http://localhost:3001')).rejects.toThrow(/socket hang up/);
  });

  it('ignores a request to a foreign path and still completes on the real callback', async () => {
    const exchange = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 'mnfst_pat_ok', expiresAt: null }),
    });
    const io = makeIo(exchange as unknown as typeof fetch, (url: string) => {
      const authUrl = new URL(url);
      const port = authUrl.searchParams.get('port');
      const state = authUrl.searchParams.get('state');
      // A stray favicon probe must not kill the login.
      http.get(`http://127.0.0.1:${port}/favicon.ico`, () => {
        http.get(
          `http://127.0.0.1:${port}/callback?code=code-abcdefghijklmnop&state=${state}`,
          () => undefined,
        );
      });
      return true;
    });
    await expect(browserLogin(io, 'http://localhost:3001')).resolves.toMatchObject({
      token: 'mnfst_pat_ok',
    });
  });

  it('falls back to defaultOpenBrowser when io.openBrowser is absent', async () => {
    // child_process is stubbed so the suite never launches a real browser; the
    // stub plays the browser instead, so the whole fallback path runs for real.
    jest.resetModules();
    const spawn = jest.fn((_cmd: string, args: string[]) => {
      // The URL is the last argument on every platform.
      const authUrl = new URL(args[args.length - 1]);
      http.get(
        `http://127.0.0.1:${authUrl.searchParams.get('port')}/callback?code=code-abcdefghijklmnop&state=${authUrl.searchParams.get('state')}`,
        () => undefined,
      );
      return Object.assign(new EventEmitter(), { unref: jest.fn() });
    });
    jest.doMock('child_process', () => ({ spawn }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      const io: CliIo = {
        env: {},
        fetchImpl: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ token: 'mnfst_pat_fallback', expiresAt: null }),
        }) as unknown as typeof fetch,
        stdout: jest.fn(),
        stderr: jest.fn(),
        readStdin: jest.fn(),
        isTTY: true,
      };
      await expect(mod.browserLogin(io, 'http://localhost:3001')).resolves.toEqual({
        token: 'mnfst_pat_fallback',
        expiresAt: null,
      });
      expect(spawn).toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
    }
  });
});

describe('defaultOpenBrowser', () => {
  it('spawns a detached opener and returns true', () => {
    jest.resetModules();
    const unref = jest.fn();
    const child = Object.assign(new EventEmitter(), { unref });
    const spawn = jest.fn().mockReturnValue(child);
    jest.doMock('child_process', () => ({ spawn }));
    try {
      // re-require after doMock so the module sees the stub
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      expect(mod.defaultOpenBrowser('http://x')).toBe(true);
      expect(spawn).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
    }
  });

  it('survives an ENOENT reported asynchronously on the child', () => {
    // spawn does NOT throw for a missing binary — it emits 'error' on the
    // ChildProcess a tick later. With no listener Node makes that fatal and the
    // CLI dies mid-login, so the opener must attach one.
    jest.resetModules();
    const child = Object.assign(new EventEmitter(), { unref: jest.fn() });
    jest.doMock('child_process', () => ({ spawn: () => child }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      expect(mod.defaultOpenBrowser('http://x')).toBe(true);
      expect(child.listenerCount('error')).toBe(1);
      // Would throw "Unhandled 'error' event" if the listener were missing.
      expect(() => child.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow();
    } finally {
      jest.dontMock('child_process');
    }
  });

  it('returns false when spawning throws synchronously', () => {
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawn: () => {
        throw new Error('EACCES');
      },
    }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      expect(mod.defaultOpenBrowser('http://x')).toBe(false);
    } finally {
      jest.dontMock('child_process');
    }
  });

  it('uses the platform-specific opener command and caret-escapes for cmd.exe', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawn: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return Object.assign(new EventEmitter(), { unref: () => undefined });
      },
    }));
    // A real auth URL: the `&state=` is what cmd would otherwise treat as a
    // command separator, silently dropping the state and breaking the login.
    const authUrl = 'http://localhost:3001/cli/auth?port=1234&state=abc';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      for (const platform of ['darwin', 'win32', 'linux']) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        mod.defaultOpenBrowser(authUrl);
      }
    } finally {
      Object.defineProperty(process, 'platform', original);
      jest.dontMock('child_process');
    }
    expect(calls.map((c) => c.cmd)).toEqual(['open', 'cmd', 'xdg-open']);
    expect(calls[0].args).toEqual([authUrl]);
    // win32: metacharacters escaped, everything else byte-identical.
    expect(calls[1].args).toEqual([
      '/c',
      'start',
      '',
      'http://localhost:3001/cli/auth?port=1234^&state=abc',
    ]);
    // Non-Windows platforms pass the URL through untouched (no stray carets).
    expect(calls[2].args).toEqual([authUrl]);
  });

  it('escapes every cmd metacharacter, not just ampersands', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const calls: string[][] = [];
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawn: (_cmd: string, args: string[]) => {
        calls.push(args);
        return Object.assign(new EventEmitter(), { unref: () => undefined });
      },
    }));
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-require after doMock
      const mod = require('./oauth-login') as typeof import('./oauth-login');
      mod.defaultOpenBrowser('http://h/?a=1&b|c^d<e>f(g)');
    } finally {
      Object.defineProperty(process, 'platform', original);
      jest.dontMock('child_process');
    }
    expect(calls[0][3]).toBe('http://h/?a=1^&b^|c^^d^<e^>f^(g^)');
  });
});
