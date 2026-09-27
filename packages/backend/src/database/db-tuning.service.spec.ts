import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { DbTuningService } from './db-tuning.service';

describe('DbTuningService', () => {
  let service: DbTuningService;
  let query: jest.Mock;
  let configValue: boolean | undefined;

  async function build(): Promise<void> {
    query = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DbTuningService,
        { provide: getDataSourceToken(), useValue: { query } as unknown as DataSource },
        { provide: ConfigService, useValue: { get: () => configValue } },
      ],
    }).compile();
    service = moduleRef.get(DbTuningService);
  }

  beforeEach(() => {
    configValue = undefined;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('applies every planner default as a role-level ALTER ROLE on bootstrap', async () => {
    configValue = true;
    await build();
    await service.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(DbTuningService.SETTINGS.length);
    expect(query).toHaveBeenCalledWith('ALTER ROLE CURRENT_USER SET jit = off');
    expect(query).toHaveBeenCalledWith("ALTER ROLE CURRENT_USER SET work_mem = '24MB'");
    expect(query).toHaveBeenCalledWith('ALTER ROLE CURRENT_USER SET random_page_cost = 1.1');
  });

  it('skips tuning entirely when DB_TUNE_SESSION is disabled', async () => {
    configValue = false;
    await build();
    await service.onApplicationBootstrap();
    expect(query).not.toHaveBeenCalled();
  });

  it('continues applying remaining settings when one ALTER ROLE fails', async () => {
    configValue = true;
    await build();
    query.mockRejectedValueOnce(new Error('permission denied'));

    await expect(service.apply()).resolves.toBeUndefined();
    // All three are still attempted despite the first rejecting.
    expect(query).toHaveBeenCalledTimes(DbTuningService.SETTINGS.length);
  });

  it('swallows non-Error rejections without throwing', async () => {
    configValue = true;
    await build();
    query.mockRejectedValueOnce('boom');
    await expect(service.apply()).resolves.toBeUndefined();
  });

  it('does not log success when every ALTER ROLE fails', async () => {
    configValue = true;
    await build();
    query.mockRejectedValue(new Error('permission denied'));
    const logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');

    await expect(service.apply()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(DbTuningService.SETTINGS.length);
    // The unconditional success log must not fire when nothing was applied.
    expect(logSpy).not.toHaveBeenCalled();
  });
});
