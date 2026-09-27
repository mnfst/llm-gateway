import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { AgentAnalyticsController } from './agent-analytics.controller';
import { AgentAnalyticsService } from '../services/agent-analytics.service';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';

describe('AgentAnalyticsController', () => {
  let controller: AgentAnalyticsController;
  let mockGetUsage: jest.Mock;
  let mockGetCosts: jest.Mock;

  const ingestionContext = {
    tenantId: 't1',
    agentId: 'a1',
    agentName: 'test-agent',
    userId: 'user-1',
  };
  const mockReq = { ingestionContext } as never;

  beforeEach(async () => {
    mockGetUsage = jest.fn().mockResolvedValue({
      range: '24h',
      total_tokens: 5000,
      input_tokens: 3000,
      output_tokens: 2000,
      cache_read_tokens: 1000,
      cache_creation_tokens: 250,
      cache_read_rate: 1 / 3,
      cache_write_rate: 1 / 12,
      message_count: 10,
      trend_pct: -15,
    });

    mockGetCosts = jest.fn().mockResolvedValue({
      range: '7d',
      total_cost_usd: 1.5,
      trend_pct: 10,
      by_model: [{ model: 'gpt-4o', cost_usd: 1.5, input_tokens: 5000, output_tokens: 2000 }],
    });

    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentAnalyticsController],
      providers: [
        {
          provide: AgentAnalyticsService,
          useValue: { getUsage: mockGetUsage, getCosts: mockGetCosts },
        },
      ],
    })
      .overrideGuard(AgentKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AgentAnalyticsController>(AgentAnalyticsController);
  });

  describe('GET /api/v1/agent/usage', () => {
    it('returns usage with default 24h range', async () => {
      const result = await controller.getUsage({}, mockReq);

      expect(mockGetUsage).toHaveBeenCalledWith('24h', ingestionContext);
      expect(result.total_tokens).toBe(5000);
      expect(result.input_tokens).toBe(3000);
      expect(result.message_count).toBe(10);
      expect(result.agentName).toBe('test-agent');
    });

    it('passes custom range', async () => {
      await controller.getUsage({ range: '7d' }, mockReq);

      expect(mockGetUsage).toHaveBeenCalledWith('7d', ingestionContext);
    });
  });

  describe('GET /api/v1/agent/costs', () => {
    it('returns costs with default 7d range', async () => {
      const result = await controller.getCosts({}, mockReq);

      expect(mockGetCosts).toHaveBeenCalledWith('7d', ingestionContext);
      expect(result.total_cost_usd).toBe(1.5);
      expect(result.by_model).toHaveLength(1);
    });

    it('passes custom range', async () => {
      await controller.getCosts({ range: '30d' }, mockReq);

      expect(mockGetCosts).toHaveBeenCalledWith('30d', ingestionContext);
    });
  });
});
