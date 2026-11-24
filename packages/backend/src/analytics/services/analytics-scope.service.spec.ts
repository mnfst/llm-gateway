import { AnalyticsScopeService, agentScopeCacheKey } from './analytics-scope.service';

describe('analytics scope resolution', () => {
  it('distinguishes tenant-wide, tenant-less, missing, and live selections', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'live-id' }]);
    const resolver = new AnalyticsScopeService({ query } as never);
    expect(await resolver.resolve('tenant')).toBeUndefined();
    expect(await resolver.resolve(null, 'bot')).toEqual({
      tenantId: null,
      agentName: 'bot',
      agentId: null,
    });
    const missing = await resolver.resolve('tenant', 'bot');
    const live = await resolver.resolve('tenant', 'bot');
    expect(missing?.agentId).toBeNull();
    expect(live).toEqual({ tenantId: 'tenant', agentName: 'bot', agentId: 'live-id' });
    expect(
      new Set([agentScopeCacheKey(), agentScopeCacheKey(missing), agentScopeCacheKey(live)]).size,
    ).toBe(3);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('propagates a database failure instead of widening the selection', async () => {
    const query = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const resolver = new AnalyticsScopeService({ query } as never);
    await expect(resolver.resolve('tenant', 'bot')).rejects.toThrow('database unavailable');
  });
});
