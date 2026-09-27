import {
  computeTrend,
  downsample,
  formatTimestamp,
  addTenantFilter,
  selectMessageRowColumns,
  excludePlaygroundAgents,
  EXCLUDE_PLAYGROUND_AGENTS_PREDICATE,
  excludeDirectAttempts,
  EXCLUDE_DIRECT_ATTEMPTS_PREDICATE,
  sqlExcludeDirectRequests,
  CUSTOM_PROVIDER_JOIN_CONDITION,
  PROVIDER_SERIES_KEY_EXPR,
  filterByKeyLabel,
  filterByTenantProviderId,
  scopeToConnection,
  filterByLiveAgentName,
  MESSAGE_ROW_SELECT_ALIASES,
  sqlCountMessages,
  ERROR_MESSAGE_STATUSES,
  MANIFEST_ORIGIN_PREDICATE,
} from './query-helpers';
import { MANIFEST_ERROR_ORIGINS } from 'manifest-shared';
import { SelectQueryBuilder } from 'typeorm';
import { CustomProvider } from '../../entities/custom-provider.entity';

describe('computeTrend', () => {
  it('returns positive trend when current exceeds previous', () => {
    expect(computeTrend(150, 100)).toBe(50);
  });

  it('returns negative trend when current is less than previous', () => {
    expect(computeTrend(80, 100)).toBe(-20);
  });

  it('returns zero when both current and previous are equal', () => {
    expect(computeTrend(100, 100)).toBe(0);
  });

  it('returns zero when previous is zero (avoid division by zero)', () => {
    expect(computeTrend(100, 0)).toBe(0);
    expect(computeTrend(0, 0)).toBe(0);
  });

  it('returns zero when previous is near-zero (floating-point edge case)', () => {
    expect(computeTrend(0, 1e-9)).toBe(0);
    expect(computeTrend(0.001, 1e-9)).toBe(0);
    expect(computeTrend(1e-9, 1e-9)).toBe(0);
  });

  it('returns zero when both values are near-zero', () => {
    expect(computeTrend(1e-8, 1e-7)).toBe(0);
    expect(computeTrend(0, 0.0000001)).toBe(0);
  });

  it('clamps extreme positive trends to 999', () => {
    expect(computeTrend(10000, 1)).toBe(999);
  });

  it('clamps extreme negative trends to -999', () => {
    expect(computeTrend(0, 100)).toBe(-100);
  });

  it('rounds the result', () => {
    expect(computeTrend(200, 300)).toBe(-33);
  });

  it('handles 100% increase', () => {
    expect(computeTrend(200, 100)).toBe(100);
  });

  it('handles 100% decrease', () => {
    expect(computeTrend(0, 100)).toBe(-100);
  });
});

describe('downsample', () => {
  it('returns input unchanged when length <= target', () => {
    const data = [10, 20, 30];
    expect(downsample(data, 5)).toEqual([10, 20, 30]);
    expect(downsample(data, 3)).toEqual([10, 20, 30]);
  });

  it('reduces data to target length by summing buckets', () => {
    const data = [1, 2, 3, 4, 5, 6];
    const result = downsample(data, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual([3, 7, 11]);
  });

  it('handles single target bucket', () => {
    const data = [1, 2, 3, 4];
    const result = downsample(data, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(10);
  });

  it('handles empty input', () => {
    expect(downsample([], 5)).toEqual([]);
  });

  it('handles uneven bucket sizes', () => {
    const data = [1, 2, 3, 4, 5];
    const result = downsample(data, 2);
    expect(result).toHaveLength(2);
    const sum = result[0]! + result[1]!;
    expect(sum).toBe(15);
  });
});

describe('formatTimestamp', () => {
  it('formats a Date as a PG-compatible timestamp string', () => {
    const d = new Date(2026, 1, 16, 10, 5, 3, 42);
    const result = formatTimestamp(d);
    expect(result).toBe('2026-02-16T10:05:03.042');
  });

  it('zero-pads single-digit months, days, hours, minutes, seconds', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 7);
    const result = formatTimestamp(d);
    expect(result).toBe('2026-01-02T03:04:05.007');
  });

  it('handles midnight (all-zero time components)', () => {
    const d = new Date(2026, 5, 15, 0, 0, 0, 0);
    const result = formatTimestamp(d);
    expect(result).toBe('2026-06-15T00:00:00.000');
  });

  it('handles end-of-day timestamp', () => {
    const d = new Date(2026, 11, 31, 23, 59, 59, 999);
    const result = formatTimestamp(d);
    expect(result).toBe('2026-12-31T23:59:59.999');
  });
});

describe('addTenantFilter', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const qb = {
      andWhere: mockAndWhere.mockImplementation(() => qb),
      where: jest.fn().mockImplementation(() => qb),
      orWhere: jest.fn().mockImplementation(() => qb),
    };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere };
  }

  it('matches nothing (1 = 0) when tenantId is null', () => {
    const { qb, mockAndWhere } = makeMockQb();
    addTenantFilter(qb, null);

    expect(mockAndWhere).toHaveBeenCalledTimes(1);
    expect(mockAndWhere).toHaveBeenCalledWith('1 = 0');
  });

  it('filters by tenant_id when tenantId is provided', () => {
    const { qb, mockAndWhere } = makeMockQb();
    addTenantFilter(qb, 'tenant-456');

    expect(mockAndWhere).toHaveBeenCalledTimes(1);
    expect(mockAndWhere).toHaveBeenCalledWith('at.tenant_id = :tenantId', {
      tenantId: 'tenant-456',
    });
  });

  it('resolves agentName to the live agent_id via subquery so soft-deleted agents do not leak', () => {
    const { qb, mockAndWhere } = makeMockQb();
    addTenantFilter(qb, 'tenant-456', 'my-agent');

    expect(mockAndWhere).toHaveBeenCalledTimes(2);
    const secondCall = mockAndWhere.mock.calls[1];
    expect(secondCall[0]).toContain('at.agent_id = (');
    expect(secondCall[0]).toContain('FROM agents');
    expect(secondCall[0]).toContain('deleted_at IS NULL');
    // The agent lookup is scoped via the tenant id, never `at.tenant_id`.
    expect(secondCall[0]).toContain('a.tenant_id = :liveTenantId');
    expect(secondCall[0]).not.toContain('at.tenant_id');
    expect(secondCall[1]).toEqual({ liveAgentName: 'my-agent', liveTenantId: 'tenant-456' });
  });

  it('does not add agent_name filter when agentName is undefined', () => {
    const { qb, mockAndWhere } = makeMockQb();
    addTenantFilter(qb, 'tenant-456');

    expect(mockAndWhere).toHaveBeenCalledTimes(1);
  });

  it('filterByLiveAgentName scopes by the tenant id', () => {
    const { qb, mockAndWhere } = makeMockQb();
    const result = filterByLiveAgentName(qb, 'my-agent', 'tenant-456');

    expect(result).toBe(qb);
    expect(mockAndWhere).toHaveBeenCalledTimes(1);
    const call = mockAndWhere.mock.calls[0];
    expect(call[0]).toContain('at.agent_id = (');
    expect(call[0]).toContain('FROM agents');
    expect(call[0]).toContain('deleted_at IS NULL');
    expect(call[0]).toContain('a.tenant_id = :liveTenantId');
    // Must never key the lookup off the (possibly NULL) message tenant_id.
    expect(call[0]).not.toContain('at.tenant_id');
    expect(call[1]).toEqual({ liveAgentName: 'my-agent', liveTenantId: 'tenant-456' });
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    const result = addTenantFilter(qb, 'tenant-456');
    expect(result).toBe(qb);
  });

  it('accepts both agentName and tenantId together', () => {
    const { qb, mockAndWhere } = makeMockQb();
    addTenantFilter(qb, 'tenant-456', 'my-agent');

    expect(mockAndWhere).toHaveBeenCalledTimes(2);
  });
});

describe('excludePlaygroundAgents', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const mockLeftJoin = jest.fn();
    const qb = {
      leftJoin: mockLeftJoin.mockImplementation(() => qb),
      andWhere: mockAndWhere.mockImplementation(() => qb),
    };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere, mockLeftJoin };
  }

  it('excludes playground agents via a NOT EXISTS semi-join (no join added)', () => {
    const { qb, mockAndWhere, mockLeftJoin } = makeMockQb();
    excludePlaygroundAgents(qb);

    // Semi-join only: never adds a LEFT JOIN of its own.
    expect(mockLeftJoin).not.toHaveBeenCalled();
    expect(mockAndWhere).toHaveBeenCalledWith(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE);
  });

  it('matches the playground agent by id OR name, without correlating on agents', () => {
    // Still a pure existence test that cannot duplicate fact rows, and still
    // matches on either agent_id OR agent_name (so a Playground row carrying
    // only agent_name, NULL agent_id, is excluded too).
    //
    // Both subqueries must stay UNCORRELATED. Postgres evaluates an
    // uncorrelated `IN (subquery)` once, as a hashed SubPlan; the previous
    // correlated NOT EXISTS was re-scanned per row whenever the planner
    // declined to materialize it, costing 24.7s on the Overview.
    expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).toContain('is_playground = true');
    expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).toContain('at.agent_id IN (SELECT plg.id');
    expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).toContain(
      '(at.tenant_id, at.agent_name) IN (SELECT plg.tenant_id, plg.name',
    );
    // No reference to the outer alias inside either subquery.
    const subqueries = EXCLUDE_PLAYGROUND_AGENTS_PREDICATE.match(/\(SELECT plg[^)]*\)/g) ?? [];
    expect(subqueries).toHaveLength(2);
    for (const sub of subqueries) expect(sub).not.toContain('at.');
    // The name arm compares the (tenant_id, name) PAIR. Agent names are unique
    // only per tenant, so a bare name match would drop other tenants' traffic.
    expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE).not.toMatch(/[^,]agent_name IN \(SELECT plg\.name/);
    // COALESCE is required: `x IN (subquery)` is NULL, not false, when x is
    // NULL and nothing matches, and NOT NULL is NULL — the row would vanish.
    expect(EXCLUDE_PLAYGROUND_AGENTS_PREDICATE.match(/COALESCE\(/g)).toHaveLength(2);
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    expect(excludePlaygroundAgents(qb)).toBe(qb);
  });
});

describe('excludeDirectAttempts', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const qb = { andWhere: mockAndWhere.mockImplementation(() => qb) };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere };
  }

  it('drops rows the caller pinned a model on', () => {
    const { qb, mockAndWhere } = makeMockQb();
    excludeDirectAttempts(qb);
    expect(mockAndWhere).toHaveBeenCalledWith(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE);
  });

  it('uses IS DISTINCT FROM so NULL-reason rows survive', () => {
    // A pending/cancelled row is stamped before a route is chosen, so its
    // routing_reason is NULL. Under `!= 'direct'` NULL compares to NULL and the
    // row would silently vanish from the harness Overview.
    expect(EXCLUDE_DIRECT_ATTEMPTS_PREDICATE).toBe("at.routing_reason IS DISTINCT FROM 'direct'");
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    expect(excludeDirectAttempts(qb)).toBe(qb);
  });
});

describe('sqlExcludeDirectRequests', () => {
  it('tests the parent request through its attempts, where routing_reason lives', () => {
    // `requests` carries no routing_reason column, so a request-level aggregate
    // has to reach into agent_messages by request_id.
    const sql = sqlExcludeDirectRequests('r');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM agent_messages direct_attempt');
    expect(sql).toContain('direct_attempt.request_id = r.id');
    expect(sql).toContain("direct_attempt.routing_reason = 'direct'");
  });

  it('honours the caller alias', () => {
    expect(sqlExcludeDirectRequests('req')).toContain('direct_attempt.request_id = req.id');
  });

  it('keeps a request that has no attempts at all', () => {
    // NOT EXISTS over an empty attempt set is true: a request recorded before any
    // provider was contacted has nothing claiming `direct`, so it survives —
    // matching how the attempt-level predicate keeps NULL routing_reason rows.
    expect(sqlExcludeDirectRequests('r').startsWith('NOT EXISTS')).toBe(true);
  });
});

describe('filterByKeyLabel', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const qb = { andWhere: mockAndWhere.mockImplementation(() => qb) };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere };
  }

  it('matches the label case-insensitively', () => {
    const { qb, mockAndWhere } = makeMockQb();
    filterByKeyLabel(qb, 'Work');
    expect(mockAndWhere).toHaveBeenCalledWith(
      "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)",
      { keyLabel: 'Work' },
    );
  });

  it('collapses a null label to Default', () => {
    const { qb, mockAndWhere } = makeMockQb();
    filterByKeyLabel(qb, null);
    expect(mockAndWhere.mock.calls[0][1]).toEqual({ keyLabel: 'Default' });
  });

  it('collapses an empty-string label to Default', () => {
    const { qb, mockAndWhere } = makeMockQb();
    filterByKeyLabel(qb, '');
    expect(mockAndWhere.mock.calls[0][1]).toEqual({ keyLabel: 'Default' });
  });

  it('collapses an undefined label to Default', () => {
    const { qb, mockAndWhere } = makeMockQb();
    filterByKeyLabel(qb, undefined);
    expect(mockAndWhere.mock.calls[0][1]).toEqual({ keyLabel: 'Default' });
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    expect(filterByKeyLabel(qb, 'x')).toBe(qb);
  });
});

describe('filterByTenantProviderId', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const qb = { andWhere: mockAndWhere.mockImplementation(() => qb) };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere };
  }

  it('filters by the tenant_provider_id column', () => {
    const { qb, mockAndWhere } = makeMockQb();
    filterByTenantProviderId(qb, 'tp-123');
    expect(mockAndWhere).toHaveBeenCalledWith('at.tenant_provider_id = :tenantProviderId', {
      tenantProviderId: 'tp-123',
    });
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    expect(filterByTenantProviderId(qb, 'tp-123')).toBe(qb);
  });
});

describe('scopeToConnection', () => {
  function makeMockQb() {
    const mockAndWhere = jest.fn();
    const qb = { andWhere: mockAndWhere.mockImplementation(() => qb) };
    return { qb: qb as unknown as SelectQueryBuilder<never>, mockAndWhere };
  }

  it('uses filterByTenantProviderId when tenantProviderId is provided', () => {
    const { qb, mockAndWhere } = makeMockQb();
    scopeToConnection(qb, 'tp-123', 'Work');
    expect(mockAndWhere).toHaveBeenCalledWith('at.tenant_provider_id = :tenantProviderId', {
      tenantProviderId: 'tp-123',
    });
  });

  it('uses filterByKeyLabel when only label is provided', () => {
    const { qb, mockAndWhere } = makeMockQb();
    scopeToConnection(qb, undefined, 'Work');
    expect(mockAndWhere).toHaveBeenCalledWith(
      "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)",
      { keyLabel: 'Work' },
    );
  });

  it('is a no-op when neither tenantProviderId nor label is supplied', () => {
    const { qb, mockAndWhere } = makeMockQb();
    const result = scopeToConnection(qb, undefined, undefined);
    expect(mockAndWhere).not.toHaveBeenCalled();
    expect(result).toBe(qb);
  });

  it('uses filterByKeyLabel when label is null', () => {
    const { qb, mockAndWhere } = makeMockQb();
    scopeToConnection(qb, undefined, null);
    expect(mockAndWhere).toHaveBeenCalledWith(
      "LOWER(COALESCE(at.provider_key_label, 'Default')) = LOWER(:keyLabel)",
      { keyLabel: 'Default' },
    );
  });
});

describe('selectMessageRowColumns', () => {
  function makeMockQb() {
    const selectCalls: Array<[string, string]> = [];
    const addSelectCalls: Array<[string, string]> = [];
    const leftJoinCalls: Array<[unknown, string, string]> = [];
    const qb = {
      select: jest.fn().mockImplementation((expr: string, alias: string) => {
        selectCalls.push([expr, alias]);
        return qb;
      }),
      addSelect: jest.fn().mockImplementation((expr: string, alias: string) => {
        addSelectCalls.push([expr, alias]);
        return qb;
      }),
      leftJoin: jest
        .fn()
        .mockImplementation((entity: unknown, alias: string, condition: string) => {
          leftJoinCalls.push([entity, alias, condition]);
          return qb;
        }),
    };
    return {
      qb: qb as unknown as SelectQueryBuilder<never>,
      selectCalls,
      addSelectCalls,
      leftJoinCalls,
    };
  }

  it('projects exactly the columns declared in MESSAGE_ROW_SELECT_ALIASES', () => {
    const { qb, selectCalls, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'CAST(at.cost_usd AS FLOAT)');

    expect(selectCalls).toHaveLength(1);
    expect(addSelectCalls).toHaveLength(MESSAGE_ROW_SELECT_ALIASES.length - 1);

    const emittedAliases = [selectCalls[0]![1], ...addSelectCalls.map(([, alias]) => alias)];
    expect(emittedAliases).toEqual([...MESSAGE_ROW_SELECT_ALIASES]);
  });

  it('uses the caller-supplied cost expression verbatim', () => {
    const { qb, addSelectCalls } = makeMockQb();
    const costExpr = 'CAST(CASE WHEN at.cost_usd >= 0 THEN at.cost_usd ELSE NULL END AS FLOAT)';
    selectMessageRowColumns(qb, costExpr);

    const costCall = addSelectCalls.find(([, alias]) => alias === 'cost');
    expect(costCall).toEqual([costExpr, 'cost']);
  });

  it('computes total_tokens from input_tokens + output_tokens', () => {
    const { qb, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    const totalCall = addSelectCalls.find(([, alias]) => alias === 'total_tokens');
    expect(totalCall).toEqual(['at.input_tokens + at.output_tokens', 'total_tokens']);
  });

  it('aliases display_name from at.model', () => {
    const { qb, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    const displayNameCall = addSelectCalls.find(([, alias]) => alias === 'display_name');
    expect(displayNameCall).toEqual(['at.model', 'display_name']);
  });

  it('projects specificity_category so the frontend badge can render it', () => {
    const { qb, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    const specCall = addSelectCalls.find(([, alias]) => alias === 'specificity_category');
    expect(specCall).toEqual(['at.specificity_category', 'specificity_category']);
  });

  it('projects error_origin, error_class, and error_http_status so the frontend can render the taxonomy', () => {
    const { qb, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    expect(addSelectCalls.find(([, a]) => a === 'error_origin')).toEqual([
      'at.error_origin',
      'error_origin',
    ]);
    expect(addSelectCalls.find(([, a]) => a === 'error_class')).toEqual([
      'at.error_class',
      'error_class',
    ]);
    expect(addSelectCalls.find(([, a]) => a === 'error_http_status')).toEqual([
      'at.error_http_status',
      'error_http_status',
    ]);
    expect(MESSAGE_ROW_SELECT_ALIASES).toContain('error_origin');
    expect(MESSAGE_ROW_SELECT_ALIASES).toContain('error_class');
    expect(MESSAGE_ROW_SELECT_ALIASES).toContain('error_http_status');
  });

  it('returns the query builder for chaining', () => {
    const { qb } = makeMockQb();
    const result = selectMessageRowColumns(qb, 'cost');
    expect(result).toBe(qb);
  });

  it('left-joins custom_providers and projects custom_provider_name', () => {
    const { qb, addSelectCalls, leftJoinCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    expect(leftJoinCalls).toHaveLength(1);
    const [entity, alias, condition] = leftJoinCalls[0]!;
    expect(entity).toBe(CustomProvider);
    expect(alias).toBe('cp');
    expect(condition).toBe(CUSTOM_PROVIDER_JOIN_CONDITION);

    const nameCall = addSelectCalls.find(([, a]) => a === 'custom_provider_name');
    expect(nameCall).toEqual(['cp.name', 'custom_provider_name']);
  });

  it('projects autofix_applied and autofix_role for Autofix rendering', () => {
    const { qb, addSelectCalls } = makeMockQb();
    selectMessageRowColumns(qb, 'cost');

    expect(addSelectCalls.find(([, a]) => a === 'autofix_applied')).toEqual([
      'at.autofix_applied',
      'autofix_applied',
    ]);
    expect(addSelectCalls.find(([, a]) => a === 'autofix_role')).toEqual([
      'at.autofix_role',
      'autofix_role',
    ]);
    expect(MESSAGE_ROW_SELECT_ALIASES).toContain('autofix_applied');
    expect(MESSAGE_ROW_SELECT_ALIASES).toContain('autofix_role');
  });

  it('keys the join on the custom:-prefixed provider id', () => {
    expect(CUSTOM_PROVIDER_JOIN_CONDITION).toBe("at.provider = 'custom:' || cp.id");
  });

  it('resolves custom series keys to the provider name with a deleted-provider fallback', () => {
    expect(PROVIDER_SERIES_KEY_EXPR).toBe(
      "CASE WHEN at.provider LIKE 'custom:%' THEN COALESCE(cp.name, 'Deleted provider') ELSE at.provider END",
    );
  });
});

describe('sqlCountMessages', () => {
  it('counts logical requests rather than provider hops', () => {
    expect(sqlCountMessages()).toContain('COUNT(DISTINCT COALESCE(at.request_id, at.id))');
    expect(sqlCountMessages()).toContain("at.status NOT IN ('error', 'fallback_error'");
  });

  it('honours a custom table alias', () => {
    expect(sqlCountMessages('m')).toContain('COUNT(DISTINCT COALESCE(m.request_id, m.id))');
    expect(sqlCountMessages('m')).toContain('m.status IS NULL');
  });

  it('keeps the shared error-status set for request log filters', () => {
    expect(ERROR_MESSAGE_STATUSES).toEqual([
      'error',
      'fallback_error',
      'rate_limited',
      'auto_fixed',
      'failed',
    ]);
  });
});

describe('origin predicates', () => {
  it('MANIFEST_ORIGIN_PREDICATE matches every Manifest origin, request included', () => {
    expect(MANIFEST_ERROR_ORIGINS).toEqual(['config', 'policy', 'internal', 'request']);
    expect(MANIFEST_ORIGIN_PREDICATE).toBe(
      "at.error_origin IN ('config', 'policy', 'internal', 'request')",
    );
  });
});
