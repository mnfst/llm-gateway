import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutofixHealthProbe } from '../autofix-health-probe';
import { AUTOFIX_URL } from '../autofix-healing-config';

const HEALTH_URL = `${AUTOFIX_URL}/api/health`;

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  return { get: jest.fn((key: string) => overrides[key]) } as unknown as ConfigService;
}

function makeProbe(overrides: Record<string, string | undefined> = {}): AutofixHealthProbe {
  return new AutofixHealthProbe(makeConfig(overrides));
}

function fakeResponse(ok: boolean, status: number): Response {
  return { ok, status } as unknown as Response;
}

describe('AutofixHealthProbe', () => {
  let fetchSpy: jest.SpyInstance;
  let previousMode: string | undefined;

  beforeEach(() => {
    previousMode = process.env.MANIFEST_MODE;
    process.env.MANIFEST_MODE = 'cloud';
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = previousMode;
    jest.restoreAllMocks();
  });

  it('does not probe outside production (NODE_ENV unset)', async () => {
    await makeProbe({}).probe();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not probe in development, even in self-hosted mode', async () => {
    // Dev runs the in-process mock, so there is no healer to reach.
    process.env.MANIFEST_MODE = 'selfhosted';
    await makeProbe({ NODE_ENV: 'development' }).probe();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no contact at all when AUTOFIX_GLOBAL_ENABLED=false', async () => {
    // This is the only opt-out left now that the healer URL is a constant, so
    // it has to cover the boot probe too, not just the heal path.
    process.env.MANIFEST_MODE = 'selfhosted';

    await makeProbe({ NODE_ENV: 'production', AUTOFIX_GLOBAL_ENABLED: 'false' }).probe();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes hosted Phoenix in self-hosted production', async () => {
    process.env.MANIFEST_MODE = 'selfhosted';
    fetchSpy.mockResolvedValue(fakeResponse(true, 200));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await makeProbe({ NODE_ENV: 'production' }).probe();

    expect(fetchSpy.mock.calls[0][0]).toBe(HEALTH_URL);
    expect(fetchSpy.mock.calls[0][1].headers).toBeUndefined();
  });

  it('probes hosted Phoenix in cloud production too, and logs success on 2xx', async () => {
    fetchSpy.mockResolvedValue(fakeResponse(true, 200));
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await makeProbe({ NODE_ENV: 'production' }).probe();

    expect(fetchSpy.mock.calls[0][0]).toBe(HEALTH_URL);
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns on a non-2xx health response', async () => {
    fetchSpy.mockResolvedValue(fakeResponse(false, 503));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await makeProbe({ NODE_ENV: 'production' }).probe();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
  });

  it('warns (never throws) when the probe fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(makeProbe({ NODE_ENV: 'production' }).probe()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('never sends x-api-key to the public health endpoint, even when a key is set', async () => {
    fetchSpy.mockResolvedValue(fakeResponse(true, 200));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await makeProbe({
      NODE_ENV: 'production',
      AUTOFIX_HEALING_API_KEY: 'secret',
    }).probe();

    // /api/health is public in the Phoenix contract; the probe must not attach
    // the key.
    expect(fetchSpy.mock.calls[0][1].headers).toBeUndefined();
  });

  it('onApplicationBootstrap fires the probe without awaiting it', () => {
    const probe = makeProbe({});
    const spy = jest.spyOn(probe, 'probe').mockResolvedValue(undefined);

    probe.onApplicationBootstrap();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
