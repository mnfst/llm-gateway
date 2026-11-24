import { buildProxySessionScope } from '../proxy-session-scope';

describe('buildProxySessionScope', () => {
  it('builds a deterministic fixed-length key for the same scope', () => {
    const first = buildProxySessionScope('tenant-1', 'agent-1', 'session-1');
    const second = buildProxySessionScope('tenant-1', 'agent-1', 'session-1');

    expect(first).toEqual(second);
    expect(first.cacheKey).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(first.providerCacheKey).toBe(first.cacheKey);
    expect(first.momentumKey).toBe(first.cacheKey);
    expect(first.cacheKey).not.toContain('session-1');
  });

  it.each([
    ['tenant-2', 'agent-1', 'session-1'],
    ['tenant-1', 'agent-2', 'session-1'],
    ['tenant-1', 'agent-1', 'session-2'],
  ])('isolates a different tenant, agent, or session', (tenantId, agentId, sessionKey) => {
    const baseline = buildProxySessionScope('tenant-1', 'agent-1', 'session-1');
    const scoped = buildProxySessionScope(tenantId, agentId, sessionKey);

    expect(scoped.cacheKey).not.toBe(baseline.cacheKey);
    expect(scoped.providerCacheKey).not.toBe(baseline.providerCacheKey);
  });

  it.each([undefined, '', ['session-1']])(
    'uses a cache-only default scope when no explicit string header is present',
    (header) => {
      const scope = buildProxySessionScope('tenant-1', 'agent-1', header);

      expect(scope.sessionKey).toBe('default');
      expect(scope.cacheKey).toMatch(/^v1:[a-f0-9]{64}$/);
      expect(scope.providerCacheKey).toBeUndefined();
      expect(scope.momentumKey).toBeUndefined();
    },
  );
});
