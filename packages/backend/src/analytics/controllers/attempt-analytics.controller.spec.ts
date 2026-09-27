import { CacheModule } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { AttemptAnalyticsController } from './attempt-analytics.controller';
import { AttemptStatsService } from '../services/attempt-stats.service';

describe('AttemptAnalyticsController', () => {
  let controller: AttemptAnalyticsController;
  let attemptStats: { getStats: jest.Mock; getTimeseries: jest.Mock };
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

  beforeEach(async () => {
    attemptStats = {
      getStats: jest.fn().mockResolvedValue({ total_attempts: { value: 3, previous: 2 } }),
      getTimeseries: jest.fn().mockResolvedValue({
        range: '7d',
        by: 'metric',
        keys: [],
        buckets: [],
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AttemptAnalyticsController],
      providers: [{ provide: AttemptStatsService, useValue: attemptStats }],
    }).compile();
    controller = module.get(AttemptAnalyticsController);
  });

  it('forwards stats range, agent, and tenant scope', async () => {
    await expect(
      controller.getStats({ range: '30d', agent_name: 'bot-1' }, ctx as never),
    ).resolves.toEqual({ total_attempts: { value: 3, previous: 2 } });
    expect(attemptStats.getStats).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      range: '30d',
      agentName: 'bot-1',
    });
  });

  it('forwards optional timeseries query values', async () => {
    await expect(controller.getTimeseries({}, ctx as never)).resolves.toEqual({
      range: '7d',
      by: 'metric',
      keys: [],
      buckets: [],
    });
    expect(attemptStats.getTimeseries).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      range: undefined,
      agentName: undefined,
    });
  });
});
