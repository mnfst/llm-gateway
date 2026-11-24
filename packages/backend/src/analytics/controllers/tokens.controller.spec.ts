import { AnalyticsScopeService } from '../services/analytics-scope.service';
import { mockScopeResolver, selectedAgent } from '../__tests__/scope.fixture';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { TokensController } from './tokens.controller';
import { AggregationService } from '../services/aggregation.service';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';

describe('TokensController', () => {
  let controller: TokensController;
  let mockGetPreviousTokenTotal: jest.Mock;
  let mockGetTimeseries: jest.Mock;

  beforeEach(async () => {
    mockGetPreviousTokenTotal = jest.fn().mockResolvedValue(4000);
    mockGetTimeseries = jest.fn().mockImplementation((_range, _userId, hourly) => {
      if (hourly) {
        return Promise.resolve({
          tokenUsage: [{ hour: '2026-02-16T10:00:00', input_tokens: 3000, output_tokens: 2000 }],
          costUsage: [{ hour: '2026-02-16T10:00:00', cost: 1.5 }],
          messageUsage: [{ hour: '2026-02-16T10:00:00', count: 5 }],
        });
      }
      return Promise.resolve({
        tokenUsage: [{ date: '2026-02-16', input_tokens: 1000, output_tokens: 500 }],
        costUsage: [{ date: '2026-02-16', cost: 0.5 }],
        messageUsage: [{ date: '2026-02-16', count: 2 }],
      });
    });

    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [TokensController],
      providers: [
        { provide: AnalyticsScopeService, useValue: mockScopeResolver() },
        {
          provide: AggregationService,
          useValue: { getPreviousTokenTotal: mockGetPreviousTokenTotal },
        },
        {
          provide: TimeseriesQueriesService,
          useValue: { getTimeseries: mockGetTimeseries },
        },
      ],
    }).compile();

    controller = module.get<TokensController>(TokensController);
  });

  const ctx = { tenantId: 'tenant-1', userId: 'u1' };

  it('returns token summary derived from hourly data with trend', async () => {
    const result = await controller.getTokens({ range: '24h' }, ctx as never);

    expect(result.summary.total_tokens.value).toBe(5000);
    expect(result.summary.total_tokens.trend_pct).toBe(25);
    expect(result.summary.total_tokens.sub_values).toEqual({ input: 3000, output: 2000 });
    expect(result.summary.input_tokens).toBe(3000);
    expect(result.summary.output_tokens).toBe(2000);
    expect(result.hourly).toHaveLength(1);
    expect(result.daily).toHaveLength(1);
  });

  it('defaults range to 24h', async () => {
    await controller.getTokens({}, ctx as never);

    expect(mockGetPreviousTokenTotal).toHaveBeenCalledWith('24h', 'tenant-1', undefined);
  });

  it('passes agent_name to service calls', async () => {
    await controller.getTokens({ range: '7d', agent_name: 'bot' }, ctx as never);

    expect(mockGetPreviousTokenTotal).toHaveBeenCalledWith(
      '7d',
      'tenant-1',
      selectedAgent('tenant-1', 'bot'),
    );
    expect(mockGetTimeseries).toHaveBeenCalledWith(
      '7d',
      'tenant-1',
      true,
      selectedAgent('tenant-1', 'bot'),
    );
    expect(mockGetTimeseries).toHaveBeenCalledWith(
      '7d',
      'tenant-1',
      false,
      selectedAgent('tenant-1', 'bot'),
    );
  });

  it('returns zero trend when previous tokens is zero', async () => {
    mockGetPreviousTokenTotal.mockResolvedValue(0);
    const result = await controller.getTokens({ range: '24h' }, ctx as never);

    expect(result.summary.total_tokens.trend_pct).toBe(0);
  });

  it('computes summary from multiple hourly buckets', async () => {
    mockGetTimeseries.mockImplementation((_range: string, _userId: string, hourly: boolean) => {
      if (hourly) {
        return Promise.resolve({
          tokenUsage: [
            { hour: '2026-02-16T10:00:00', input_tokens: 100, output_tokens: 50 },
            { hour: '2026-02-16T11:00:00', input_tokens: 200, output_tokens: 100 },
          ],
          costUsage: [],
          messageUsage: [],
        });
      }
      return Promise.resolve({ tokenUsage: [], costUsage: [], messageUsage: [] });
    });
    const result = await controller.getTokens({ range: '24h' }, ctx as never);

    expect(result.summary.total_tokens.value).toBe(450);
    expect(result.summary.input_tokens).toBe(300);
    expect(result.summary.output_tokens).toBe(150);
  });
});
