import { OAUTH_POLL, subscriptionConnect } from './oauth-connect';
import { ApiClient } from '../client';
import { CliError } from '../errors';
import { makeIo } from '../../test/helpers';

function fakeClient(replies: unknown[]): ApiClient {
  let i = 0;
  return {
    request: async () => replies[Math.min(i++, replies.length - 1)],
  } as unknown as ApiClient;
}

afterEach(() => {
  OAUTH_POLL.intervalMs = 2000;
  OAUTH_POLL.timeoutMs = 180_000;
  OAUTH_POLL.deviceIntervalOverrideMs = null;
});

describe('device flow', () => {
  it('shows the code, opens the verification page, and polls to success', async () => {
    // The device flow ignores intervalMs entirely; the override is the clock.
    OAUTH_POLL.deviceIntervalOverrideMs = 1;
    OAUTH_POLL.timeoutMs = 500;
    const opened: string[] = [];
    const io = makeIo({ isTTY: true });
    io.openBrowser = (url: string) => {
      opened.push(url);
      return true;
    };
    await subscriptionConnect(
      io,
      fakeClient([
        {
          flowId: 'f1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://kiro/verify',
          pollIntervalMs: 5000,
        },
        { status: 'pending' },
        { status: 'success' },
      ]),
      'kiro',
      'a',
    );
    expect(opened[0]).toBe('https://kiro/verify');
    expect(io.errLines.join('\n')).toContain('ABCD-1234');
    expect(io.lastJson()).toEqual({ connected: 'kiro', auth_type: 'subscription', agent: 'a' });
  });

  it("sleeps the server's interval — never capped by the redirect cadence", async () => {
    const slept: number[] = [];
    const realSetTimeout = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      slept.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout);
    try {
      OAUTH_POLL.intervalMs = 2000;
      OAUTH_POLL.timeoutMs = 5000;
      const io = makeIo({ isTTY: true });
      io.openBrowser = () => true;
      await subscriptionConnect(
        io,
        fakeClient([
          {
            flowId: 'f1',
            userCode: 'C',
            verificationUri: 'https://kiro/verify',
            // Kiro asks for 5s: honored verbatim, not clamped down to 2s.
            pollIntervalMs: 5000,
          },
          // and a pending response may slow us down further mid-flow
          { status: 'pending', pollIntervalMs: 9000 },
          { status: 'success' },
        ]),
        'kiro',
        'a',
      );
      expect(slept).toEqual([5000, 9000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('floors a too-eager server interval at 1s and defaults when absent', async () => {
    const slept: number[] = [];
    const realSetTimeout = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      slept.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout);
    try {
      OAUTH_POLL.intervalMs = 2000;
      OAUTH_POLL.timeoutMs = 5000;
      const io = makeIo({ isTTY: true });
      io.openBrowser = () => true;
      await subscriptionConnect(
        io,
        fakeClient([
          // no pollIntervalMs → falls back to intervalMs
          { flowId: 'f1', userCode: 'C', verificationUri: 'https://m/verify' },
          { status: 'pending', pollIntervalMs: 10 },
          { status: 'success' },
        ]),
        'minimax',
        'a',
      );
      expect(slept).toEqual([2000, 1000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('threads --region into the device start query', async () => {
    OAUTH_POLL.deviceIntervalOverrideMs = 1;
    OAUTH_POLL.timeoutMs = 200;
    const urls: string[] = [];
    const client = {
      request: async (method: string, url: string) => {
        urls.push(url);
        return url.includes('/start')
          ? { flowId: 'f1', userCode: 'C', verificationUri: 'https://m/verify' }
          : { status: 'success' };
      },
    } as unknown as ApiClient;
    const io = makeIo({ isTTY: true });
    io.openBrowser = () => true;
    await subscriptionConnect(io, client, 'minimax', 'a', 'cn');
    expect(urls[0]).toBe('/oauth/minimax/start?agentName=a&region=cn');
  });

  it('surfaces an error poll and times out on endless pending', async () => {
    OAUTH_POLL.deviceIntervalOverrideMs = 1;
    OAUTH_POLL.timeoutMs = 500;
    const io = makeIo({ isTTY: true });
    io.openBrowser = () => true;
    await expect(
      subscriptionConnect(
        io,
        fakeClient([
          { flowId: 'f1', userCode: 'C', verificationUri: 'https://m/verify' },
          { status: 'error', message: 'expired' },
        ]),
        'minimax',
        'a',
      ),
    ).rejects.toThrow('expired');

    OAUTH_POLL.timeoutMs = 15;
    const io2 = makeIo({ isTTY: true });
    io2.openBrowser = () => false;
    await expect(
      subscriptionConnect(
        io2,
        fakeClient([
          { flowId: 'f1', userCode: 'C', verificationUri: 'https://m/verify' },
          { status: 'pending' },
        ]),
        'kiro',
        'a',
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'oauth_timeout' }));
    expect(io2.errLines.join('\n')).toContain('Open https://m/verify');
  });
});

describe('subscriptionConnect edge paths', () => {
  it('paste flow requires readLine even on a TTY', async () => {
    const io = makeIo({ isTTY: true });
    await expect(subscriptionConnect(io, fakeClient([]), 'anthropic', 'a')).rejects.toThrow(
      CliError,
    );
  });

  it('paste flow rejects an empty pasted code', async () => {
    const io = makeIo({ isTTY: true, readLine: async () => '   ' });
    io.openBrowser = () => true;
    await expect(
      subscriptionConnect(io, fakeClient([{ url: 'https://x', state: 's' }]), 'anthropic', 'a'),
    ).rejects.toThrow(expect.objectContaining({ code: 'credential_empty' }));
  });

  it('prints the manual URL when the browser fails to open', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 5;
    const io = makeIo({ isTTY: true, readLine: async () => 'x' });
    io.openBrowser = () => false;
    await expect(
      subscriptionConnect(
        io,
        fakeClient([{ providers: 'weird' }, { url: 'https://xai/auth' }, { providers: null }]),
        'xai',
        'a',
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'oauth_timeout' }));
    expect(io.errLines.join('\n')).toContain('Open this URL');
  });

  it('detects a newly appeared subscription connection', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 500;
    const io = makeIo({ isTTY: true });
    io.openBrowser = () => true;
    await subscriptionConnect(
      io,
      fakeClient([
        { providers: [] },
        { url: 'https://xai/auth' },
        {
          providers: [
            {
              provider: 'xai',
              auth_type: 'subscription',
              connections: [{ id: 'c1', is_active: true }],
            },
            'junk',
          ],
        },
      ]),
      'xai',
      'a',
    );
    expect(io.lastJson()).toEqual({ connected: 'xai', auth_type: 'subscription', agent: 'a' });
  });

  it('does not report success when a connection is removed mid-poll', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 20;
    const io = makeIo({ isTTY: true });
    io.openBrowser = () => true;
    await expect(
      subscriptionConnect(
        io,
        fakeClient([
          {
            providers: [
              {
                provider: 'xai',
                auth_type: 'subscription',
                connections: [{ id: 'c1', is_active: true }],
              },
            ],
          },
          { url: 'https://xai/auth' },
          { providers: [] }, // the connection disappeared
        ]),
        'xai',
        'a',
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'oauth_timeout' }));
  });

  it('detects a reactivated connection (same id, inactive to active)', async () => {
    OAUTH_POLL.intervalMs = 1;
    OAUTH_POLL.timeoutMs = 500;
    const io = makeIo({ isTTY: true });
    io.openBrowser = () => true;
    await subscriptionConnect(
      io,
      fakeClient([
        {
          providers: [
            {
              provider: 'xai',
              auth_type: 'subscription',
              connections: [{ id: 'c1', is_active: false }],
            },
          ],
        },
        { url: 'https://xai/auth' },
        {
          providers: [
            {
              provider: 'xai',
              auth_type: 'subscription',
              connections: [{ id: 'c1', is_active: true }],
            },
          ],
        },
      ]),
      'xai',
      'a',
    );
    expect(io.lastJson()).toEqual({ connected: 'xai', auth_type: 'subscription', agent: 'a' });
  });
});
