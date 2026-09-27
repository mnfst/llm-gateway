import { Repository } from 'typeorm';
import { ErrorBreakdownService } from './error-breakdown.service';
import { AgentMessage } from '../../entities/agent-message.entity';

interface GroupRow {
  origin: string;
  error_class: string | null;
  count: string;
}

function makeQb(groups: GroupRow[], successful: number, autoFixed: number) {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(groups),
    // querySuccessful resolves first, queryAutoFixed second (Promise.all order).
    getRawOne: jest
      .fn()
      .mockResolvedValueOnce({ count: String(successful) })
      .mockResolvedValue({ count: String(autoFixed) }),
  };
}

function makeService(groups: GroupRow[], successful: number, autoFixed = 0) {
  const qb = makeQb(groups, successful, autoFixed);
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<AgentMessage>;
  return { service: new ErrorBreakdownService(repo), qb };
}

describe('ErrorBreakdownService', () => {
  const GROUPS: GroupRow[] = [
    { origin: 'provider', error_class: 'rate_limit', count: '10' },
    { origin: 'provider', error_class: 'server_error', count: '5' },
    { origin: 'config', error_class: 'no_provider_key', count: '4' },
    { origin: 'transport', error_class: 'timeout', count: '2' },
  ];

  it('separates provider failures from Manifest-origin and transport errors', async () => {
    const { service } = makeService(GROUPS, 81);
    const result = await service.getBreakdown({ tenantId: 't1', range: '30d' });

    expect(result.provider_errors).toBe(15);
    expect(result.transport_errors).toBe(2);
    expect(result.manifest_errors).toBe(4);
    expect(result.total_errors).toBe(21);
    expect(result.successful).toBe(81);
  });

  it('aggregates by_origin (seeded with every origin) and by_class', async () => {
    const { service } = makeService(GROUPS, 81);
    const result = await service.getBreakdown({ tenantId: 't1' });

    expect(result.by_origin).toEqual({
      provider: 15,
      transport: 2,
      config: 4,
      policy: 0,
      internal: 0,
      request: 0,
    });
    expect(result.by_class).toEqual({
      rate_limit: 10,
      server_error: 5,
      no_provider_key: 4,
      timeout: 2,
    });
  });

  it('computes provider_error_rate as provider / (provider + successful)', async () => {
    const { service } = makeService(GROUPS, 81);
    const result = await service.getBreakdown({ tenantId: 't1' });
    expect(result.provider_error_rate).toBeCloseTo(15 / 96, 10);
  });

  it('counts a malformed caller request as a Manifest error, never a provider fault', async () => {
    const { service } = makeService(
      [
        { origin: 'provider', error_class: 'server_error', count: '3' },
        { origin: 'request', error_class: 'invalid_request', count: '9' },
        { origin: 'internal', error_class: 'internal', count: '1' },
      ],
      7,
    );
    const result = await service.getBreakdown({ tenantId: 't1' });

    expect(result.provider_errors).toBe(3);
    expect(result.manifest_errors).toBe(10);
    // Before the `request` origin existed these 9 rows were recorded as provider
    // 400s and dragged the reliability number down with them.
    expect(result.provider_error_rate).toBeCloseTo(3 / 10, 10);
  });

  it('counts requests whose Autofix retry succeeded, independent of the error groups', async () => {
    const { service, qb } = makeService(GROUPS, 81, 7);
    const result = await service.getBreakdown({ tenantId: 't1', range: '7d' });

    expect(result.auto_fixed).toBe(7);
    // The heal count must not inflate the error totals — it is a view over rows
    // already inside total_errors, not a new bucket.
    expect(result.total_errors).toBe(21);
    const filtersAutoFixed = (qb.andWhere as jest.Mock).mock.calls
      .flat()
      .filter((clause): clause is string => typeof clause === 'string')
      .join(' ');
    expect(filtersAutoFixed).toContain("r.autofix_status = 'retry_succeeded'");
    expect(filtersAutoFixed).toContain("retry.status IN ('ok', 'success')");
  });

  it('reports auto_fixed as 0 when nothing was healed', async () => {
    const { service } = makeService(GROUPS, 81);
    const result = await service.getBreakdown({ tenantId: 't1' });
    expect(result.auto_fixed).toBe(0);
  });

  it('defaults the range to 30d when none is supplied', async () => {
    const { service } = makeService([], 0);
    const result = await service.getBreakdown({ tenantId: 't1' });
    expect(result.range).toBe('30d');
  });

  it('returns zeros and a 0 rate when there are no errors and no successes', async () => {
    const { service } = makeService([], 0);
    const result = await service.getBreakdown({ tenantId: 't1', range: '7d' });

    expect(result.total_errors).toBe(0);
    expect(result.provider_errors).toBe(0);
    expect(result.manifest_errors).toBe(0);
    expect(result.provider_error_rate).toBe(0);
    expect(result.by_class).toEqual({});
    expect(result.by_origin).toEqual({
      provider: 0,
      transport: 0,
      config: 0,
      policy: 0,
      internal: 0,
      request: 0,
    });
  });

  it('scopes to the agent when agentName is provided', async () => {
    const { service, qb } = makeService(GROUPS, 5);
    await service.getBreakdown({ tenantId: 't1', agentName: 'my-agent' });
    // addTenantFilter appends the live-agent subquery via andWhere.
    const agentScoped = (qb.andWhere as jest.Mock).mock.calls.some(
      ([clause]) => typeof clause === 'string' && clause.includes('FROM agents'),
    );
    expect(agentScoped).toBe(true);
  });

  it('handles a null tenant (no rows) without throwing', async () => {
    const { service } = makeService([], 0);
    const result = await service.getBreakdown({ tenantId: null });
    expect(result.total_errors).toBe(0);
    expect(result.successful).toBe(0);
  });
});
