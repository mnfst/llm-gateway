import * as http from 'http';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { CliError } from './errors';
import { CliIo } from './context';

export const LOGIN_TIMEOUT_MS = 120_000;
const EXCHANGE_TIMEOUT_MS = 30_000;

/** PKCE S256: base64url(SHA-256(verifier)) — RFC 7636 §4.2. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Manifest CLI</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>&#10003; Connected</h1><p>You can close this page and return to the terminal.</p></div></body>`;
const FAILURE_HTML = `<!doctype html><meta charset="utf-8"><title>Manifest CLI</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>Login failed</h1><p>State mismatch &mdash; return to the terminal and retry.</p></div></body>`;

/**
 * Open a URL with the platform opener, detached so the CLI never blocks on it.
 *
 * The return value is best-effort only: a missing opener binary surfaces as an
 * ASYNCHRONOUS 'error' event on the child, long after this function has already
 * returned true. The listener below swallows it — without one, Node treats an
 * unhandled 'error' as fatal and the CLI dies with a raw stack mid-login. That
 * is also why browserLogin always prints the URL for manual opening.
 */
export function defaultOpenBrowser(url: string): boolean {
  const win32 = process.platform === 'win32';
  const cmd = process.platform === 'darwin' ? 'open' : win32 ? 'cmd' : 'xdg-open';
  // `cmd /c start` re-parses its arguments, so &, |, ^, <, > and parens must be
  // caret-escaped or the query string is truncated at the first `&state=…`.
  const args = win32 ? ['/c', 'start', '', escapeForCmd(url)] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* opener missing or blocked — the manual-open URL is already on stderr */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Caret-escape the cmd.exe metacharacters that would otherwise split the URL. */
function escapeForCmd(url: string): string {
  return url.replace(/[&|^<>()]/g, '^$&');
}

/**
 * Browser half of `mnfst login`: loopback listener + one-time code exchange.
 * The raw PAT travels only over the direct CLI→server exchange, never through
 * the browser. Human-readable progress goes to stderr; stdout stays JSON-only.
 */
export async function browserLogin(
  io: CliIo,
  origin: string,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
  exchangeTimeoutMs: number = EXCHANGE_TIMEOUT_MS,
): Promise<{ token: string; expiresAt: string | null }> {
  const state = randomBytes(24).toString('base64url');
  // PKCE binds the one-time code to this process: the verifier never leaves the
  // CLI, so a code captured from the browser redirect (history, extension, log)
  // is inert without it.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const authUrl = `${origin}/cli/auth?port=${port}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new CliError(
            'login_timeout',
            `No browser authorization received within ${Math.round(timeoutMs / 1000)}s`,
            'Try again, or use mnfst login --token-stdin',
          ),
        );
      }, timeoutMs);
      server.on('request', (req, res) => {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        } catch {
          // A malformed request from any local process must not throw out of
          // the handler (that would crash the login); answer and keep waiting.
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(FAILURE_HTML);
          return;
        }
        const gotCode = url.searchParams.get('code');
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !gotCode) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(FAILURE_HTML);
          return; // keep listening — a stray request must not kill the login
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // The one-time code rides in this request's URL — keep it out of caches.
        res.setHeader('Cache-Control', 'no-store');
        res.end(SUCCESS_HTML);
        clearTimeout(timer);
        resolve(gotCode);
      });
      // Always print the URL: opening the browser can fail asynchronously (or
      // silently, in a container or over SSH), so the user must never be left
      // staring at a spinner with no way to continue by hand.
      const opened = (io.openBrowser ?? defaultOpenBrowser)(authUrl);
      io.stderr(
        opened
          ? `Opening your browser to authorize the CLI… If nothing opens, visit: ${authUrl}`
          : `Open this URL in your browser to authorize the CLI: ${authUrl}`,
      );
    });
  } finally {
    server.close();
  }

  // Exchange the one-time code — a public endpoint, so no X-API-Key here.
  // Bounded by the same 30s budget ApiClient uses, so a hung server cannot
  // wedge the CLI forever holding a code that is about to expire anyway.
  const controller = new AbortController();
  const exchangeTimer = setTimeout(() => controller.abort(), exchangeTimeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await io.fetchImpl(`${origin}/api/v1/cli/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state, code_verifier: codeVerifier }),
      signal: controller.signal,
    });
    // Consume the body inside the abort scope: a server that sends headers then
    // stalls must not hang the CLI holding a code that is about to expire.
    text = await response.text();
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${origin}: ${error instanceof Error ? error.message : String(error)}`,
      'Check the URL and that the Manifest server is running',
    );
  } finally {
    clearTimeout(exchangeTimer);
  }
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text);
    // A JSON `null` or primitive would make the property reads below throw.
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    /* non-JSON body → fall through to generic error */
  }
  if (!response.ok || typeof parsed['token'] !== 'string') {
    const message =
      typeof parsed['message'] === 'string'
        ? (parsed['message'] as string)
        : `Token exchange failed with HTTP ${response.status}`;
    throw new CliError('login_failed', message, 'Run mnfst login again');
  }
  return {
    token: parsed['token'] as string,
    expiresAt: typeof parsed['expiresAt'] === 'string' ? (parsed['expiresAt'] as string) : null,
  };
}
