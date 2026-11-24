import { ApiClient } from '../client';
import { CliIo, printJson } from '../context';
import { CliError } from '../errors';
import { defaultOpenBrowser } from '../oauth-login';

/**
 * Subscription (OAuth) connect flows, driven against the backend's existing
 * per-provider endpoints:
 * - redirect: GET /oauth/<p>/authorize?agentName → {url}; the provider
 *   redirects to a callback the BACKEND serves, so completion is entirely
 *   server-side — the CLI opens the browser and polls until the connection
 *   materializes.
 * - paste: POST authorize → {url, state}; the user signs in, copies the code
 *   shown by the provider, pastes it into the terminal; POST exchange.
 * - Device-code providers (Kiro, MiniMax, Copilot) are a follow-up.
 */
const OAUTH_FLOWS: Record<string, 'redirect' | 'paste' | 'device'> = {
  xai: 'redirect',
  openai: 'redirect',
  gemini: 'redirect',
  anthropic: 'paste',
  kiro: 'device',
  minimax: 'device',
};

/** Whether the CLI can run this provider's subscription sign-in today. */
export function supportsSubscription(providerId: string): boolean {
  return providerId in OAUTH_FLOWS;
}

/**
 * Poll cadence; mutable so tests can shrink the clock.
 * `intervalMs` drives the redirect flow only. The device flow obeys the
 * SERVER's suggested interval (Kiro asks for 5s, and the OAuth device spec
 * lets the server raise it mid-flow) — capping that at `intervalMs` would poll
 * faster than the provider allows. `deviceIntervalOverrideMs` is the test
 * escape hatch: when set it is used verbatim, no floor, no server value.
 */
export const OAUTH_POLL: {
  intervalMs: number;
  timeoutMs: number;
  deviceIntervalOverrideMs: number | null;
} = { intervalMs: 2000, timeoutMs: 180_000, deviceIntervalOverrideMs: null };

/** Server-suggested cadence with a 1s floor, unless a test overrides it. */
function deviceSleepMs(suggestedMs: number | undefined): number {
  if (OAUTH_POLL.deviceIntervalOverrideMs !== null) return OAUTH_POLL.deviceIntervalOverrideMs;
  return Math.max(1000, suggestedMs ?? OAUTH_POLL.intervalMs);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The provider's ACTIVE subscription connection ids. Completion is a newly
 * added or reactivated active connection — not any fingerprint change, which
 * removal or deactivation would also produce.
 */
function activeSubscriptionConnectionIds(payload: unknown, providerId: string): Set<string> {
  const providers = (payload as { providers?: unknown })?.providers;
  const ids = new Set<string>();
  if (!Array.isArray(providers)) return ids;
  for (const p of providers) {
    if (typeof p !== 'object' || p === null) continue;
    const group = p as { provider?: string; auth_type?: string; connections?: unknown };
    if (group.provider !== providerId || group.auth_type !== 'subscription') continue;
    for (const c of Array.isArray(group.connections) ? group.connections : []) {
      if (typeof c !== 'object' || c === null) continue;
      const conn = c as { id?: unknown; is_active?: unknown };
      if (typeof conn.id === 'string' && conn.is_active === true) ids.add(conn.id);
    }
  }
  return ids;
}

export async function subscriptionConnect(
  io: CliIo,
  client: ApiClient,
  providerId: string,
  agent: string,
  region?: string,
): Promise<void> {
  if (!io.isTTY) {
    throw new CliError(
      'subscription_needs_tty',
      'Subscription connect signs in through your browser and needs an interactive terminal',
      'Connect with an API key instead, or use the dashboard',
    );
  }
  const flow = OAUTH_FLOWS[providerId];
  if (!flow) {
    throw new CliError(
      'subscription_unsupported',
      `Subscription connect for ${providerId} is not supported by the CLI yet`,
      'Connect it from the dashboard (Providers → Subscriptions)',
    );
  }

  const open = io.openBrowser ?? defaultOpenBrowser;

  if (flow === 'device') {
    // Device flow is terminal-native: show the code, open the verification
    // page, poll the backend until the user approves there.
    const startQuery = new URLSearchParams({ agentName: agent });
    if (region) startQuery.set('region', region);
    const start = (await client.request(
      'POST',
      `/oauth/${providerId}/start?${startQuery.toString()}`,
    )) as { flowId: string; userCode: string; verificationUri: string; pollIntervalMs?: number };
    const opened = open(start.verificationUri);
    io.stderr(`Your code: ${start.userCode}`);
    io.stderr(
      opened
        ? `Opening ${start.verificationUri} — confirm the code there.`
        : `Open ${start.verificationUri} and enter the code.`,
    );
    let interval = deviceSleepMs(start.pollIntervalMs);
    const deadline = Date.now() + OAUTH_POLL.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(interval);
      const poll = (await client.request(
        'GET',
        `/oauth/${providerId}/poll?flowId=${encodeURIComponent(start.flowId)}`,
      )) as { status: 'pending' | 'success' | 'error'; message?: string; pollIntervalMs?: number };
      // A pending response may slow us down (slow_down in the device spec).
      if (poll.pollIntervalMs !== undefined) interval = deviceSleepMs(poll.pollIntervalMs);
      if (poll.status === 'success') {
        printJson(io, { connected: providerId, auth_type: 'subscription', agent });
        return;
      }
      if (poll.status === 'error') {
        throw new CliError('oauth_failed', poll.message ?? `${providerId} sign-in failed`);
      }
    }
    throw new CliError(
      'oauth_timeout',
      `${providerId} sign-in was not approved within ${Math.round(OAUTH_POLL.timeoutMs / 1000)}s`,
      'Run the command again to restart the flow',
    );
  }

  if (flow === 'paste') {
    if (!io.readLine) {
      throw new CliError('subscription_needs_tty', 'Interactive input unavailable');
    }
    const authorize = (await client.request(
      'POST',
      `/oauth/${providerId}/authorize?agentName=${encodeURIComponent(agent)}`,
    )) as { url: string; state: string };
    const opened = open(authorize.url);
    io.stderr(
      opened
        ? `Opening your browser to sign in… If nothing opens, visit: ${authorize.url}`
        : `Open this URL in your browser to sign in: ${authorize.url}`,
    );
    const code = (await io.readLine('Paste the code shown after sign-in: ')).trim();
    if (!code) throw new CliError('credential_empty', 'No code entered');
    await client.request(
      'POST',
      `/oauth/${providerId}/exchange?agentName=${encodeURIComponent(agent)}`,
      {
        body: { code, state: authorize.state },
      },
    );
    printJson(io, { connected: providerId, auth_type: 'subscription', agent });
    return;
  }

  // redirect flow: completion is server-side; watch a new active connection appear.
  const beforeActive = activeSubscriptionConnectionIds(
    await client.request('GET', '/providers'),
    providerId,
  );
  const authorize = (await client.request(
    'GET',
    `/oauth/${providerId}/authorize?agentName=${encodeURIComponent(agent)}`,
  )) as { url: string };
  const opened = open(authorize.url);
  io.stderr(
    opened
      ? `Opening your browser to sign in… If nothing opens, visit: ${authorize.url}`
      : `Open this URL in your browser to sign in: ${authorize.url}`,
  );

  const deadline = Date.now() + OAUTH_POLL.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(OAUTH_POLL.intervalMs);
    const afterActive = activeSubscriptionConnectionIds(
      await client.request('GET', '/providers'),
      providerId,
    );
    if ([...afterActive].some((id) => !beforeActive.has(id))) {
      printJson(io, { connected: providerId, auth_type: 'subscription', agent });
      return;
    }
  }
  throw new CliError(
    'oauth_timeout',
    `No ${providerId} subscription connection appeared within ${Math.round(OAUTH_POLL.timeoutMs / 1000)}s`,
    'Finish the browser sign-in and check mnfst provider list, or retry',
  );
}
