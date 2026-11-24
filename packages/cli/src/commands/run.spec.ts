import { EventEmitter } from 'events';
import { runCmd } from './run';
import { CliError } from '../errors';
import { saveAgentKey } from '../keystore';
import { fetchStub, makeIo } from '../../test/helpers';

const HOST = 'http://localhost:2099';

function authedIo(
  replies: Array<{ status: number; body: unknown }>,
  spawnImpl?: (
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => Promise<number>,
) {
  const stub = fetchStub(replies);
  const io = makeIo({
    env: { MANIFEST_URL: HOST, MANIFEST_API_KEY: 'env-key' },
    fetchImpl: stub.impl,
  });
  if (spawnImpl) io.spawnImpl = spawnImpl;
  return { io, calls: stub.calls };
}

describe('runCmd', () => {
  it('injects the cached agent key into the child environment', async () => {
    const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> =
      [];
    const { io, calls } = authedIo([], async (cmd, args, env) => {
      spawned.push({ cmd, args, env });
      return 0;
    });
    saveAgentKey(io.env, HOST, 'my-bot', 'mnfst_run_secret');

    await expect(
      runCmd(io, ['--agent', 'my-bot', '--', 'some-tool', '--flag', 'value']),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(0);
    expect(spawned).toEqual([
      {
        cmd: 'some-tool',
        args: ['--flag', 'value'],
        env: expect.objectContaining({
          MANIFEST_AGENT_KEY: 'mnfst_run_secret',
          MANIFEST_AGENT_URL: `${HOST}/v1`,
        }),
      },
    ]);
    // The raw key never reaches stdout.
    expect(io.lines.join('\n')).not.toContain('mnfst_run_secret');
  });

  it('recovers the key from the server when the cache is cold', async () => {
    let env: Record<string, string | undefined> = {};
    const { io, calls } = authedIo(
      [{ status: 200, body: { keyPrefix: 'mnfst_serv', apiKey: 'mnfst_from_server' } }],
      async (_c, _a, e) => {
        env = e;
        return 0;
      },
    );
    await expect(runCmd(io, ['--agent', 'my-bot', '--', 'tool'])).resolves.toBe(0);
    expect(calls[0].url).toBe(`${HOST}/api/v1/agents/my-bot/key`);
    expect(env['MANIFEST_AGENT_KEY']).toBe('mnfst_from_server');
  });

  it('renames the injected variable with --env', async () => {
    let env: Record<string, string | undefined> = {};
    const { io } = authedIo([], async (_c, _a, e) => {
      env = e;
      return 0;
    });
    saveAgentKey(io.env, HOST, 'my-bot', 'k');
    await runCmd(io, ['--agent', 'my-bot', '--env', 'OPENAI_API_KEY', '--', 'tool']);
    expect(env['OPENAI_API_KEY']).toBe('k');
    expect(env['MANIFEST_AGENT_KEY']).toBeUndefined();
  });

  it('propagates the child exit code', async () => {
    const { io } = authedIo([], async () => 42);
    saveAgentKey(io.env, HOST, 'my-bot', 'k');
    await expect(runCmd(io, ['--agent', 'my-bot', '--', 'failing-tool'])).resolves.toBe(42);
  });

  it('strips inherited MANIFEST_AGENT_KEY and variant-case credentials', async () => {
    let env: Record<string, string | undefined> = {};
    const { io } = authedIo([], async (_c, _a, e) => {
      env = e;
      return 0;
    });
    io.env['MANIFEST_AGENT_KEY'] = 'stale-parent-key';
    io.env['manifest_api_key'] = 'lower-case-patched';
    saveAgentKey(io.env, HOST, 'my-bot', 'fresh');
    await runCmd(io, ['--agent', 'my-bot', '--env', 'ROLE_KEY', '--', 'tool']);
    expect(env['ROLE_KEY']).toBe('fresh');
    expect(env['MANIFEST_AGENT_KEY']).toBeUndefined();
    expect(env['manifest_api_key']).toBeUndefined();
  });

  it('requires the -- separator and a command', async () => {
    const { io } = authedIo([]);
    await expect(runCmd(io, ['--agent', 'my-bot', 'tool'])).rejects.toThrow(CliError);
    await expect(runCmd(io, ['--agent', 'my-bot', '--'])).rejects.toThrow(
      expect.objectContaining({ code: 'missing_command' }),
    );
  });

  it('rejects a reserved --env name', async () => {
    const { io } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'k');
    for (const name of ['MANIFEST_API_KEY', 'manifest_agent_key', 'MANIFEST_AGENT_URL']) {
      await expect(
        runCmd(io, ['--agent', 'my-bot', '--env', name, '--', 'tool']),
      ).rejects.toThrow(expect.objectContaining({ code: 'invalid_env_name' }));
    }
  });

  it('rejects an invalid --env variable name', async () => {
    const { io } = authedIo([]);
    saveAgentKey(io.env, HOST, 'my-bot', 'k');
    await expect(
      runCmd(io, ['--agent', 'my-bot', '--env', 'BAD-NAME', '--', 'tool']),
    ).rejects.toThrow(expect.objectContaining({ code: 'invalid_env_name' }));
  });
});

describe('runCmd default spawn fallback', () => {
  it('falls back to defaultSpawn when io carries no spawnImpl', async () => {
    jest.resetModules();
    const child = new EventEmitter();
    const spawn = jest.fn().mockReturnValue(child);
    jest.doMock('child_process', () => ({ spawn }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./run') as typeof import('./run');
      const { io } = authedIo([]);
      saveAgentKey(io.env, HOST, 'my-bot', 'k');
      const promise = mod.runCmd(io, ['--agent', 'my-bot', '--', 'tool']);
      // give resolveAgentKey a tick before the child exits
      await new Promise((r) => setTimeout(r, 20));
      child.emit('exit', 0, null);
      await expect(promise).resolves.toBe(0);
      expect(spawn).toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
    }
  });
});

describe('defaultSpawn', () => {
  it('spawns with inherited stdio and resolves the exit code', async () => {
    jest.resetModules();
    const child = new EventEmitter() as EventEmitter & { unref?: () => void };
    const spawn = jest.fn().mockReturnValue(child);
    jest.doMock('child_process', () => ({ spawn }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./run') as typeof import('./run');
      const promise = mod.defaultSpawn('tool', ['a'], { X: '1' });
      child.emit('exit', 7, null);
      await expect(promise).resolves.toBe(7);
      expect(spawn).toHaveBeenCalledWith('tool', ['a'], {
        stdio: 'inherit',
        env: { X: '1' },
      });
    } finally {
      jest.dontMock('child_process');
    }
  });

  it('maps a signal exit to code 1 and spawn errors to a CliError', async () => {
    jest.resetModules();
    const child = new EventEmitter();
    jest.doMock('child_process', () => ({ spawn: jest.fn().mockReturnValue(child) }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./run') as typeof import('./run');
      const bySignal = mod.defaultSpawn('tool', [], {});
      child.emit('exit', null, 'SIGKILL');
      await expect(bySignal).resolves.toBe(1);

      const failing = new EventEmitter();
      (jest.requireMock('child_process') as { spawn: jest.Mock }).spawn.mockReturnValue(failing);
      const errored = mod.defaultSpawn('missing-tool', [], {});
      failing.emit('error', new Error('ENOENT'));
      await expect(errored).rejects.toThrow('missing-tool');
    } finally {
      jest.dontMock('child_process');
    }
  });
});
