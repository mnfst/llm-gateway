import { Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { AgentListCacheService } from './agent-list-cache.service';
import { AGENT_LIST_CACHE_TTL_MS } from '../constants/cache.constants';

describe('AgentListCacheService', () => {
  let service: AgentListCacheService;
  let cache: { del: jest.Mock };

  beforeEach(() => {
    cache = { del: jest.fn().mockResolvedValue(true) };
    service = new AgentListCacheService(cache as unknown as Cache);
  });

  it('starts every tenant on generation 0', () => {
    expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g0');
    expect(service.key('t1', true)).toBe('t1:/api/v1/agents:playground=true:g0');
  });

  it('deletes both retired variants and moves the tenant to the next generation', async () => {
    await service.invalidate('t1');

    expect(cache.del).toHaveBeenCalledTimes(2);
    expect(cache.del).toHaveBeenCalledWith('t1:/api/v1/agents:playground=false:g0');
    expect(cache.del).toHaveBeenCalledWith('t1:/api/v1/agents:playground=true:g0');
    expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');
  });

  it('leaves a tenant that was never invalidated on generation 0', async () => {
    await service.invalidate('t1');

    expect(service.key('t2', false)).toBe('t2:/api/v1/agents:playground=false:g0');
  });

  it('draws generations from one counter, so no two tenants share one', async () => {
    await service.invalidate('t1');
    await service.invalidate('t2');

    expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');
    expect(service.key('t2', false)).toBe('t2:/api/v1/agents:playground=false:g2');
  });

  it('still retires the generation when the delete fails, and never rejects', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    cache.del.mockRejectedValue(new Error('cache unavailable'));

    await expect(service.invalidate('t1')).resolves.toBeUndefined();

    expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');
    expect(warn).toHaveBeenCalledWith(
      'Could not delete the retired agent-list cache entry t1:/api/v1/agents:playground=false:g0; it expires on its own',
      expect.any(String),
    );
    warn.mockRestore();
  });

  it('logs a non-Error rejection without losing the generation bump', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    cache.del.mockRejectedValue('boom');

    await service.invalidate('t1');

    expect(warn).toHaveBeenCalledWith(expect.any(String), 'boom');
    expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');
    warn.mockRestore();
  });

  it('forgets a tenant only once every entry written under its generation has expired', async () => {
    jest.useFakeTimers();
    try {
      await service.invalidate('t1');
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');

      // One TTL in, a g0 entry written by a request that was still in flight
      // could survive, so the generation must still be remembered.
      jest.advanceTimersByTime(AGENT_LIST_CACHE_TTL_MS + 1);
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');

      jest.advanceTimersByTime(AGENT_LIST_CACHE_TTL_MS);
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g0');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never puts a forgotten tenant back on a generation it already ran on', async () => {
    jest.useFakeTimers();
    try {
      await service.invalidate('t1');
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g1');

      // Forgotten: reads fall back to generation 0, whose entries have expired.
      jest.advanceTimersByTime(AGENT_LIST_CACHE_TTL_MS * 2);
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g0');

      // The next invalidation must not land back on g1, where an entry warmed
      // during the first run could still be sitting.
      await service.invalidate('t1');
      expect(service.key('t1', false)).toBe('t1:/api/v1/agents:playground=false:g2');
    } finally {
      jest.useRealTimers();
    }
  });
});
