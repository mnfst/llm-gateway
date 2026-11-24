import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentAnalyticsService } from './agent-analytics.service';
import { AgentMessage } from '../../entities/agent-message.entity';

describe('AgentAnalyticsService', () => {
  let service: AgentAnalyticsService;
  let mockGetRawOne: jest.Mock;
  let mockGetRawMany: jest.Mock;
  let mockSelect: jest.Mock;
  let mockAddSelect: jest.Mock;

  const scope = { tenantId: 't1', agentId: 'a1' };

  beforeEach(async () => {
    mockGetRawOne = jest.fn();
    mockGetRawMany = jest.fn();
    mockSelect = jest.fn().mockReturnThis();
    mockAddSelect = jest.fn().mockReturnThis();

    const mockQb = {
      select: mockSelect,
      addSelect: mockAddSelect,
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawOne: mockGetRawOne,
      getRawMany: mockGetRawMany,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentAnalyticsService,
        {
          provide: getRepositoryToken(AgentMessage),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(mockQb) },
        },
      ],
    }).compile();

    service = module.get<AgentAnalyticsService>(AgentAnalyticsService);
  });

  describe('getUsage', () => {
    it('returns token usage with trend', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({
          input: 3000,
          output: 2000,
          cache_read: 500,
          cache_creation: 300,
          messages: 10,
        })
        .mockResolvedValueOnce({ total: 4000 });

      const result = await service.getUsage('24h', scope);

      expect(result.range).toBe('24h');
      expect(result.total_tokens).toBe(5000);
      expect(result.input_tokens).toBe(3000);
      expect(result.output_tokens).toBe(2000);
      expect(result.cache_read_tokens).toBe(500);
      expect(result.cache_creation_tokens).toBe(300);
      expect(result.cache_read_rate).toBeCloseTo(1 / 6);
      expect(result.cache_write_rate).toBe(0.1);
      expect(result.message_count).toBe(10);
      expect(result.trend_pct).toBe(25);
    });

    it('handles zero previous period', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({
          input: 100,
          output: 50,
          cache_read: 0,
          cache_creation: 0,
          messages: 1,
        })
        .mockResolvedValueOnce({ total: 0 });

      const result = await service.getUsage('24h', scope);

      expect(result.trend_pct).toBe(0);
    });

    it('passes tenant and agent params to queries', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          messages: 0,
        })
        .mockResolvedValueOnce({ total: 0 });

      await service.getUsage('7d', scope);

      // Both calls should have been made (current and previous)
      expect(mockGetRawOne).toHaveBeenCalledTimes(2);
    });

    it('returns zero cache rates when there are no input tokens', async () => {
      mockGetRawOne
        .mockResolvedValueOnce({
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          messages: 0,
        })
        .mockResolvedValueOnce({ total: 0 });

      const result = await service.getUsage('24h', scope);

      expect(result.cache_read_rate).toBe(0);
      expect(result.cache_write_rate).toBe(0);
    });
  });

  describe('getCosts', () => {
    it('returns cost breakdown by model', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 2.5 }).mockResolvedValueOnce({ total: 2.0 });
      mockGetRawMany.mockResolvedValueOnce([
        { model: 'gpt-4o', cost_usd: 1.5, input_tokens: 5000, output_tokens: 2000 },
        { model: 'claude-sonnet-4-5', cost_usd: 1.0, input_tokens: 3000, output_tokens: 1000 },
      ]);

      const result = await service.getCosts('7d', scope);

      expect(result.range).toBe('7d');
      expect(result.total_cost_usd).toBe(2.5);
      expect(result.trend_pct).toBe(25);
      expect(result.by_model).toHaveLength(2);
      expect(result.by_model[0].model).toBe('gpt-4o');
      expect(result.by_model[0].cost_usd).toBe(1.5);
    });

    it('handles empty model breakdown', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 0 });
      mockGetRawMany.mockResolvedValueOnce([]);

      const result = await service.getCosts('24h', scope);

      expect(result.total_cost_usd).toBe(0);
      expect(result.by_model).toEqual([]);
    });

    it('sanitizes negative costs (failed pricing lookups) in every cost sum', async () => {
      mockGetRawOne.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 0 });
      mockGetRawMany.mockResolvedValueOnce([]);

      await service.getCosts('24h', scope);

      const sanitized = 'CASE WHEN at.cost_usd >= 0 THEN at.cost_usd ELSE NULL END';
      const costExprs = [
        ...mockSelect.mock.calls.map((c) => String(c[0])),
        ...mockAddSelect.mock.calls.map((c) => String(c[0])),
      ].filter((expr) => expr.includes('cost_usd'));
      // current total + previous total + per-model breakdown = 3 cost sums.
      expect(costExprs).toHaveLength(3);
      for (const expr of costExprs) {
        expect(expr).toContain(sanitized);
      }
    });
  });
});
