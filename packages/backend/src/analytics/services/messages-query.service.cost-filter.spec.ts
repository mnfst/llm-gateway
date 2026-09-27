import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Brackets } from 'typeorm';
import { MessagesQueryService } from './messages-query.service';
import { AgentMessage } from '../../entities/agent-message.entity';
import { CustomProvider } from '../../entities/custom-provider.entity';

/**
 * Cost-filter edge cases for MessagesQueryService.
 *
 * The buildBaseMessageQuery method applies cost_min/cost_max filters to raw
 * `at.cost_usd` without sanitization (only `>=` / `<=` comparisons). If a row
 * has a negative cost (data corruption, bug, refund-style entry, etc.), the
 * filter must still apply the comparison literally rather than coerce or
 * skip the value.
 *
 * These tests pin both the SQL clause + the parameter that gets bound, so a
 * future refactor (e.g. swapping the raw column for `sqlSanitizeCost`) is
 * caught by a failing test instead of a silent behavior change.
 */
describe('MessagesQueryService — cost filter edge cases', () => {
  let service: MessagesQueryService;
  let mockGetRawOne: jest.Mock;
  let mockGetRawMany: jest.Mock;

  beforeEach(async () => {
    mockGetRawOne = jest.fn().mockResolvedValue({ total: 0 });
    mockGetRawMany = jest.fn().mockResolvedValue([]);

    const mockQb: Record<string, jest.Mock> = {
      select: jest.fn(),
      addSelect: jest.fn(),
      distinct: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orWhere: jest.fn(),
      groupBy: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      limit: jest.fn(),
      clone: jest.fn(),
      getRawOne: mockGetRawOne,
      getRawMany: mockGetRawMany,
    };

    const chainableMethods = [
      'select',
      'addSelect',
      'distinct',
      'leftJoin',
      'where',
      'andWhere',
      'orWhere',
      'groupBy',
      'orderBy',
      'addOrderBy',
      'limit',
      'clone',
    ];
    for (const method of chainableMethods) {
      mockQb[method].mockImplementation((...args: unknown[]) => {
        const arg = args[0];
        if (arg instanceof Brackets && typeof (arg as any).whereFactory === 'function') {
          (arg as any).whereFactory(mockQb);
        }
        return mockQb;
      });
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesQueryService,
        {
          provide: getRepositoryToken(AgentMessage),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(mockQb),
            query: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(CustomProvider),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get<MessagesQueryService>(MessagesQueryService);
  });

  const findCostCall = (calls: unknown[][], paramKey: 'costMin' | 'costMax') => {
    const op = paramKey === 'costMin' ? 'cost_usd >=' : 'cost_usd <=';
    return calls.find(([clause]) => typeof clause === 'string' && clause.includes(op));
  };

  it('does not serve one model filter a total cached under another', async () => {
    // The log's count request comes in with cache_total=true, so a count key
    // that ignores the model list hands the new filter the previous filter's
    // total for the whole TTL — pagination and the row list would then disagree.
    mockGetRawOne.mockResolvedValue({ total: 7 });
    mockGetRawMany.mockResolvedValue([]);

    const first = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      include_total: true,
      cache_total: true,
      models: ['gpt-4o'],
    });

    mockGetRawOne.mockResolvedValue({ total: 2 });
    const second = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      include_total: true,
      cache_total: true,
      models: ['claude-3.5-sonnet'],
    });

    expect(first.total_count).toBe(7);
    expect(second.total_count).toBe(2);
  });

  it('filters the legacy attempt-only path on the model list', async () => {
    // Installs with no `requests` rows still read straight from agent_messages,
    // where a request IS one attempt, so the model match is a plain column test.
    mockGetRawOne.mockResolvedValueOnce({ total: 1 });
    mockGetRawMany
      .mockResolvedValueOnce([
        { id: 'msg-legacy', timestamp: '2026-02-16 10:00:00', model: 'gpt-4o', cost: 0.1 },
      ])
      .mockResolvedValueOnce([{ model: 'gpt-4o' }]);

    const repo = (service as unknown as { turnRepo: { createQueryBuilder: jest.Mock } }).turnRepo;
    const qb = repo.createQueryBuilder();
    const andWhereSpy = qb.andWhere as jest.Mock;
    andWhereSpy.mockClear();

    await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      models: ['gpt-4o', 'claude-3.5-sonnet'],
    });

    const call = andWhereSpy.mock.calls.find((c) =>
      String(c[0]).includes('at.model IN (:...legacyModels)'),
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ legacyModels: ['gpt-4o', 'claude-3.5-sonnet'] });
  });

  it('passes a negative cost_min through to the cost_usd >= clause', async () => {
    mockGetRawOne.mockResolvedValueOnce({ total: 1 });
    mockGetRawMany
      .mockResolvedValueOnce([
        { id: 'msg-neg', timestamp: '2026-02-16 10:00:00', model: 'gpt-4o', cost: -0.5 },
      ])
      .mockResolvedValueOnce([{ model: 'gpt-4o' }]);

    const repo = (service as unknown as { turnRepo: { createQueryBuilder: jest.Mock } }).turnRepo;
    const qb = repo.createQueryBuilder();
    const andWhereSpy = qb.andWhere as jest.Mock;
    andWhereSpy.mockClear();

    const result = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_min: -1,
    });

    const call = findCostCall(andWhereSpy.mock.calls, 'costMin');
    // The negative bound must be forwarded literally — no coercion to 0 or
    // dropping the filter altogether (which would silently change semantics).
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ costMin: -1 });
    // The mocked row with cost=-0.5 is returned as-is (the assertion above
    // proves the filter would include it at the SQL level since -0.5 >= -1).
    expect(result.items).toHaveLength(1);
  });

  it('passes cost_min of 0 to the query so negative-cost rows are excluded', async () => {
    // Database returns no rows because cost_usd >= 0 filters them out. We
    // assert the SQL parameter (the database is the ground truth, but here
    // we lock the contract sent to it).
    mockGetRawOne.mockResolvedValueOnce({ total: 0 });
    mockGetRawMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const repo = (service as unknown as { turnRepo: { createQueryBuilder: jest.Mock } }).turnRepo;
    const qb = repo.createQueryBuilder();
    const andWhereSpy = qb.andWhere as jest.Mock;
    andWhereSpy.mockClear();

    const result = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_min: 0,
    });

    const call = findCostCall(andWhereSpy.mock.calls, 'costMin');
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ costMin: 0 });
    expect(result.items).toEqual([]);
  });

  it('passes a negative cost_max through to the cost_usd <= clause', async () => {
    mockGetRawOne.mockResolvedValueOnce({ total: 1 });
    mockGetRawMany
      .mockResolvedValueOnce([
        { id: 'msg-neg', timestamp: '2026-02-16 10:00:00', model: 'gpt-4o', cost: -0.5 },
      ])
      .mockResolvedValueOnce([{ model: 'gpt-4o' }]);

    const repo = (service as unknown as { turnRepo: { createQueryBuilder: jest.Mock } }).turnRepo;
    const qb = repo.createQueryBuilder();
    const andWhereSpy = qb.andWhere as jest.Mock;
    andWhereSpy.mockClear();

    const result = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_max: -0.1,
    });

    const call = findCostCall(andWhereSpy.mock.calls, 'costMax');
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ costMax: -0.1 });
    expect(result.items).toHaveLength(1);
  });

  it('passes both negative cost_min and cost_max for inclusive negative ranges', async () => {
    mockGetRawOne.mockResolvedValueOnce({ total: 1 });
    mockGetRawMany
      .mockResolvedValueOnce([
        { id: 'msg-neg', timestamp: '2026-02-16 10:00:00', model: 'gpt-4o', cost: -0.5 },
      ])
      .mockResolvedValueOnce([{ model: 'gpt-4o' }]);

    const repo = (service as unknown as { turnRepo: { createQueryBuilder: jest.Mock } }).turnRepo;
    const qb = repo.createQueryBuilder();
    const andWhereSpy = qb.andWhere as jest.Mock;
    andWhereSpy.mockClear();

    await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_min: -1,
      cost_max: -0.1,
    });

    const minCall = findCostCall(andWhereSpy.mock.calls, 'costMin');
    const maxCall = findCostCall(andWhereSpy.mock.calls, 'costMax');
    // Both bounds must be present and forwarded literally; without this,
    // a future "guard against negative input" change would silently widen
    // the filter window.
    expect(minCall?.[1]).toEqual({ costMin: -1 });
    expect(maxCall?.[1]).toEqual({ costMax: -0.1 });
  });

  it('uses different cache keys for opposite-sign cost bounds', async () => {
    // Negative and positive bounds with the same magnitude must NOT collide
    // in the count-cache key (else a paginated request with cost_min=-1
    // could return a cached count from a previous cost_min=1 request).
    mockGetRawOne.mockResolvedValueOnce({ total: 7 });
    mockGetRawMany
      .mockResolvedValueOnce([
        { id: 'msg-pos', timestamp: '2026-02-16 10:00:00', model: 'gpt-4o', cost: 0.5 },
      ])
      .mockResolvedValueOnce([{ model: 'gpt-4o' }]);

    await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_min: 1,
    });

    mockGetRawOne.mockResolvedValueOnce({ total: 99 });
    mockGetRawMany.mockResolvedValueOnce([
      { id: 'msg-neg', timestamp: '2026-02-16 11:00:00', model: 'gpt-4o', cost: -0.5 },
    ]);

    const result = await service.getMessages({
      range: '24h',
      tenantId: 'test-user',
      limit: 20,
      cost_min: -1,
      cursor: '2026-02-16 10:00:00|msg-pos',
    });

    // The second call uses a cursor, so a cache hit would reuse the first
    // call's total (7). We assert it ran a fresh COUNT and returned 99,
    // proving the cache key correctly distinguishes the sign of cost_min.
    expect(result.total_count).toBe(99);
    expect(mockGetRawOne).toHaveBeenCalledTimes(2);
  });
});
