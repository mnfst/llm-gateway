import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShutdownService } from './shutdown.service';

/** Build a ShutdownService over a fake ConfigService returning the given values. */
function makeService(values: { shutdownDrainMs?: number; nodeEnv?: string }): ShutdownService {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'app.shutdownDrainMs') return values.shutdownDrainMs;
      if (key === 'app.nodeEnv') return values.nodeEnv;
      return undefined;
    }),
  } as unknown as ConfigService;
  return new ShutdownService(config);
}

describe('ShutdownService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is not shutting down before any signal', () => {
    const service = makeService({ shutdownDrainMs: 10000, nodeEnv: 'production' });
    expect(service.isShuttingDown()).toBe(false);
  });

  it('flips isShuttingDown but skips the drain on a programmatic close (no signal)', async () => {
    const service = makeService({ shutdownDrainMs: 10000, nodeEnv: 'production' });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.beforeApplicationShutdown();

    expect(service.isShuttingDown()).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('skips the drain outside production even on a real signal', async () => {
    const service = makeService({ shutdownDrainMs: 10000, nodeEnv: 'development' });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('skips the drain when the configured window is zero', async () => {
    const service = makeService({ shutdownDrainMs: 0, nodeEnv: 'production' });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('defaults the drain window to 0 when config returns undefined', async () => {
    const service = makeService({ shutdownDrainMs: undefined, nodeEnv: 'production' });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('drains for the configured window on a real signal in production', async () => {
    const service = makeService({ shutdownDrainMs: 5, nodeEnv: 'production' });
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    await service.beforeApplicationShutdown('SIGTERM');

    expect(service.isShuttingDown()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('draining for 5ms'));
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5);
  });
});
