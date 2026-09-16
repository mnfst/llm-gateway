import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  FLUSH_AT_EVENTS,
  FLUSH_INTERVAL_MS,
  LOCK_STALE_MS,
  MAX_SPOOL_EVENTS,
  RETRY_BACKOFF_MS,
  reportUsage,
  spoolPath,
  telemetryAnonId,
  telemetryTarget,
  urlFlagOf,
} from './telemetry';
import { makeIo, type TestIo } from '../test/helpers';

type Call = { url: string; body: Record<string, unknown> };

function capturing(calls: Call[], status = 202): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status });
  }) as typeof fetch;
}

function on(env: Record<string, string> = {}, fetchImpl?: typeof fetch): TestIo {
  return makeIo({ env: { MANIFEST_TELEMETRY_DISABLED: '0', ...env }, fetchImpl });
}

function spoolLines(io: TestIo): string[] {
  try {
    return fs.readFileSync(spoolPath(io), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function writeState(io: TestIo, state: Record<string, string>) {
  const file = path.join(io.configDir, 'manifest', 'telemetry-state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function readState(io: TestIo): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(io.configDir, 'manifest', 'telemetry-state.json'), 'utf8'),
  );
}

describe('telemetry', () => {
  it('classifies the target as cloud or self-hosted, never as a URL', () => {
    // Fresh install, nothing configured: the CLI defaults to Cloud.
    expect(telemetryTarget(makeIo())).toBe('cloud');
    expect(
      telemetryTarget(makeIo({ env: { MANIFEST_URL: 'https://GATEWAY.manifest.build/' } })),
    ).toBe('cloud');
    expect(telemetryTarget(makeIo({ env: { MANIFEST_URL: 'http://localhost:3001' } }))).toBe(
      'self-hosted',
    );
    // The active config host counts when no env override is set.
    const configured = makeIo();
    fs.mkdirSync(path.join(configured.configDir, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(configured.configDir, 'manifest', 'config.json'),
      JSON.stringify({ activeHost: 'https://manifest.acme.internal', hosts: {} }),
    );
    expect(telemetryTarget(configured)).toBe('self-hosted');
    // A corrupt config falls through to the default; a bad URL is not Cloud.
    const corrupt = makeIo();
    fs.mkdirSync(path.join(corrupt.configDir, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(corrupt.configDir, 'manifest', 'config.json'), '{not json');
    expect(telemetryTarget(corrupt)).toBe('cloud');
    expect(telemetryTarget(makeIo({ env: { MANIFEST_URL: 'not a url' } }))).toBe('self-hosted');
    // A per-command --url outranks everything, as it does for the command itself.
    expect(
      telemetryTarget(
        makeIo({ env: { MANIFEST_URL: 'https://gateway.manifest.build' } }),
        'http://10.0.0.5:3001',
      ),
    ).toBe('self-hosted');
  });

  it('reads the --url flag out of a command line, stopping at the -- separator', () => {
    expect(urlFlagOf(['agent', 'list', '--url', 'http://localhost:3001'])).toBe(
      'http://localhost:3001',
    );
    expect(urlFlagOf(['--url=https://x.internal', 'whoami'])).toBe('https://x.internal');
    expect(
      urlFlagOf(['--agent', 'a', '--', 'node', 'tool.js', '--url', 'http://child']),
    ).toBeUndefined();
    expect(urlFlagOf(['whoami'])).toBeUndefined();
    // Mirrors parseArgs: the last occurrence wins; a missing or flag-like value does not count.
    expect(urlFlagOf(['--url', 'http://a', '--url', 'http://b'])).toBe('http://b');
    expect(urlFlagOf(['--url', '--yes'])).toBeUndefined();
    expect(urlFlagOf(['--url'])).toBeUndefined();
    expect(urlFlagOf(['--url='])).toBe('');
    expect(telemetryTarget(makeIo(), '')).toBe('self-hosted');
    expect(urlFlagOf(['--url', 'http://a', '--url'])).toBe('http://a');
  });

  it('tags the batch with the last command’s target and keeps the class off the wire events', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    writeState(io, { last_flush_at: new Date(Date.now() - FLUSH_INTERVAL_MS - 1).toISOString() });
    await reportUsage(io, 'whoami', true, 1, 'http://localhost:3001');

    expect(calls[0].body.target).toBe('self-hosted');
    const events = calls[0].body.events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('target');
  });

  it('tags a mixed spool (legacy + new events) by its latest event', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    writeState(io, { last_flush_at: '2020-01-01T00:00:00.000Z' });
    fs.mkdirSync(path.dirname(spoolPath(io)), { recursive: true });
    fs.writeFileSync(
      spoolPath(io),
      JSON.stringify({
        command: 'login',
        ok: true,
        duration_ms: 5,
        at: '2026-09-12T10:00:00.000Z',
      }) + '\n',
    );
    // Mixed spool: the legacy line has no class, the new event does — the latest wins.
    await reportUsage(io, 'whoami', true, 1);
    expect(calls[0].body.target).toBe('cloud');
    expect((calls[0].body.events as unknown[]).length).toBe(2);
  });

  it('mints a persistent anon id (0600) and reuses it', () => {
    const io = makeIo();
    const first = telemetryAnonId(io);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    const idPath = path.join(io.configDir, 'manifest', 'telemetry-id');
    expect(fs.statSync(idPath).mode & 0o777).toBe(0o600);
    expect(telemetryAnonId(io)).toBe(first);
  });

  it('first run ever: spools the event and flushes it at once (new install shows up today)', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    await reportUsage(io, 'agent create', true, 123);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(calls[0].body).toEqual({
      schema_version: 1,
      anon_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      cli_version: expect.any(String),
      os: expect.any(String),
      target: 'cloud',
      events: [
        {
          command: 'agent create',
          ok: true,
          duration_ms: 123,
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/),
        },
      ],
    });
    // Sent → spool emptied, flush stamped, file stays private.
    expect(spoolLines(io)).toHaveLength(0);
    expect(fs.statSync(spoolPath(io)).mode & 0o777).toBe(0o600);
    expect(readState(io).last_flush_at).toBeDefined();
  });

  it('within 24h of the last flush: spools locally and sends nothing', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    writeState(io, { last_flush_at: new Date(Date.now() - FLUSH_INTERVAL_MS / 2).toISOString() });

    await reportUsage(io, 'whoami', true, 1);
    await reportUsage(io, 'doctor', false, 2);

    expect(calls).toHaveLength(0);
    expect(spoolLines(io)).toHaveLength(2);
  });

  it('24h after the last flush: ships every spooled event in one request, oldest first', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    writeState(io, { last_flush_at: new Date(Date.now() - FLUSH_INTERVAL_MS - 1).toISOString() });
    fs.mkdirSync(path.dirname(spoolPath(io)), { recursive: true });
    fs.writeFileSync(
      spoolPath(io),
      [
        JSON.stringify({
          command: 'login',
          ok: true,
          duration_ms: 5,
          at: '2026-09-12T10:00:00.000Z',
        }),
        'not json {{{', // a torn line from a crashed write is skipped, not fatal
        '',
      ].join('\n'),
    );

    await reportUsage(io, 'agent list', true, 7);

    expect(calls).toHaveLength(1);
    const events = calls[0].body.events as Array<{ command: string }>;
    expect(events.map((e) => e.command)).toEqual(['login', 'agent list']);
    expect(spoolLines(io)).toHaveLength(0);
  });

  it('flushes early once the spool reaches the safety valve', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    writeState(io, { last_flush_at: new Date().toISOString() });
    for (let i = 0; i < FLUSH_AT_EVENTS - 1; i++) await reportUsage(io, 'whoami', true, 1);
    expect(calls).toHaveLength(0);

    await reportUsage(io, 'whoami', true, 1);

    expect(calls).toHaveLength(1);
    expect((calls[0].body.events as unknown[]).length).toBe(FLUSH_AT_EVENTS);
  });

  it('caps the spool, dropping the oldest events, while the endpoint is unreachable', async () => {
    const io = on({}, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    // Far in the past so every command is "due", but backoff stops the retries.
    writeState(io, { last_flush_at: '2020-01-01T00:00:00.000Z' });
    for (let i = 0; i < MAX_SPOOL_EVENTS + 5; i++) await reportUsage(io, `c${i}`, true, 1);

    const lines = spoolLines(io);
    expect(lines).toHaveLength(MAX_SPOOL_EVENTS);
    expect(JSON.parse(lines[0]).command).toBe('c5');
  });

  it('after a failed send: keeps the spool and backs off for an hour', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls, 503));
    await reportUsage(io, 'whoami', true, 1); // first run → attempts, gets 503
    expect(calls).toHaveLength(1);
    expect(spoolLines(io)).toHaveLength(1);
    expect(readState(io).last_flush_at).toBeUndefined();
    expect(readState(io).last_attempt_at).toBeDefined();

    await reportUsage(io, 'whoami', true, 1); // inside the backoff window
    expect(calls).toHaveLength(1);
    expect(spoolLines(io)).toHaveLength(2);

    // Backoff elapsed → retried with both events.
    writeState(io, {
      last_attempt_at: new Date(Date.now() - RETRY_BACKOFF_MS - 1).toISOString(),
    });
    await reportUsage(io, 'whoami', true, 1);
    expect(calls).toHaveLength(2);
    expect((calls[1].body.events as unknown[]).length).toBe(3);
  });

  it('adds agent_runtime per event only when a coding agent is driving the CLI', async () => {
    const calls: Call[] = [];
    const agent = on({ CLAUDECODE: '1' }, capturing(calls));
    await reportUsage(agent, 'doctor', true, 1);
    expect((calls[0].body.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      agent_runtime: 'claude-code',
    });

    const human = on({}, capturing(calls));
    await reportUsage(human, 'doctor', true, 1);
    expect((calls[1].body.events as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'agent_runtime',
    );
  });

  it('honors MANIFEST_TELEMETRY_DISABLED (no spool, no send) and a custom endpoint', async () => {
    const calls: Call[] = [];
    const off = makeIo({ env: { MANIFEST_TELEMETRY_DISABLED: '1' }, fetchImpl: capturing(calls) });
    await reportUsage(off, 'whoami', true, 1);
    expect(calls).toHaveLength(0);
    expect(spoolLines(off)).toHaveLength(0);

    const custom = on(
      { MANIFEST_CLI_TELEMETRY_ENDPOINT: 'http://peacock.local/v1/cli-report' },
      capturing(calls),
    );
    await reportUsage(custom, 'whoami', true, 1);
    expect(calls[0].url).toBe('http://peacock.local/v1/cli-report');
  });

  it('drains the response body so an unread socket cannot delay exit', async () => {
    const streamed = new Response('{"ok":true}', { status: 202 });
    const io = on({}, (async () => streamed) as typeof fetch);
    await reportUsage(io, 'whoami', true, 1);
    expect(streamed.bodyUsed).toBe(true);

    // A bodyless reply (204) has no stream to cancel — the arrayBuffer path.
    const empty = new Response(null, { status: 204 });
    const io2 = on({}, (async () => empty) as typeof fetch);
    await expect(reportUsage(io2, 'whoami', true, 1)).resolves.toBeUndefined();
  });

  it('swallows transport failures and clamps duration', async () => {
    const io = on({}, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    await expect(reportUsage(io, 'login', false, 9_999_999)).resolves.toBeUndefined();
    expect(JSON.parse(spoolLines(io)[0]).duration_ms).toBe(600000);
  });

  it('stays silent when the config dir is unwritable', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    // A file where the config directory should be: every mkdir/write throws.
    fs.writeFileSync(path.join(io.configDir, 'manifest'), '');
    await expect(reportUsage(io, 'whoami', true, 1)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('a concurrent run holding the lock only appends; the holder ships the batch', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    const lock = path.join(io.configDir, 'manifest', 'telemetry.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, ''); // fresh: another mnfst is mid-flush

    await reportUsage(io, 'whoami', true, 1); // first run → would flush, but not while locked

    expect(calls).toHaveLength(0);
    expect(spoolLines(io)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(true); // not ours to release
  });

  it('reclaims a stale lock left by a crashed run, then releases its own', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    const lock = path.join(io.configDir, 'manifest', 'telemetry.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    fs.utimesSync(lock, old, old);

    await reportUsage(io, 'whoami', true, 1);

    expect(calls).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
    // Rewrites go through a temp file + rename: nothing half-written is left behind.
    expect(fs.readdirSync(path.dirname(lock)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up on a stale lock it cannot reclaim (unlink fails)', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    // A non-empty directory in the lock's place with an old mtime: `wx` fails,
    // the stale check passes, and the reclaiming unlink throws.
    const lock = path.join(io.configDir, 'manifest', 'telemetry.lock');
    fs.mkdirSync(path.join(lock, 'child'), { recursive: true }); // unlink will fail (not a file)
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    fs.utimesSync(lock, old, old); // after the child: creating it would bump mtime

    await reportUsage(io, 'whoami', true, 1);

    expect(calls).toHaveLength(0);
    expect(spoolLines(io)).toHaveLength(1);
  });

  it('never removes a lock that a successor reclaimed while it was paused', async () => {
    // Slow endpoint: while this run is mid-flush, simulate a reclaim by a
    // successor that overwrote the lock with its own token.
    let lock = '';
    const io = on({}, (async () => {
      fs.writeFileSync(lock, 'successor-token');
      return new Response('{}', { status: 202 });
    }) as typeof fetch);
    lock = path.join(io.configDir, 'manifest', 'telemetry.lock');

    await reportUsage(io, 'whoami', true, 1);

    // Our release saw a foreign token and left the file alone.
    expect(fs.readFileSync(lock, 'utf8')).toBe('successor-token');
  });

  it('releases the lock and sends nothing when the spool cannot be rewritten', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    // A directory where the spool file should be: the rename over it fails.
    fs.mkdirSync(spoolPath(io), { recursive: true });

    await reportUsage(io, 'whoami', true, 1);

    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(io.configDir, 'manifest', 'telemetry.lock'))).toBe(false);
  });

  it('treats an unparsable state file and a non-object spool line as empty', async () => {
    const calls: Call[] = [];
    const io = on({}, capturing(calls));
    fs.mkdirSync(path.join(io.configDir, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(io.configDir, 'manifest', 'telemetry-state.json'), 'null');
    fs.writeFileSync(spoolPath(io), '42\n');
    await reportUsage(io, 'whoami', true, 1);
    expect((calls[0].body.events as unknown[]).length).toBe(1);
  });
});
