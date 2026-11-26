import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoutingCacheService } from './routing-cache.service';
import { RoutingCacheSyncService, SYNC_POLL_INTERVAL_MS } from './routing-cache-sync.service';

type Row = { next_since: string; scope: string | null; target_id: string | null };

const NOW = '2026-11-26 10:00:00.123456';

function setup() {
  const query = jest.fn();
  const dataSource = { query } as unknown as DataSource;
  const cache = new RoutingCacheService();
  const sync = new RoutingCacheSyncService(dataSource, cache);
  const inserts = () => query.mock.calls.filter(([sql]) => String(sql).includes('INSERT'));
  const polls = () => query.mock.calls.filter(([sql]) => String(sql).includes('WITH clock'));
  return { query, cache, sync, inserts, polls };
}

function feed(...rows: [string, string][]): Row[] {
  if (rows.length === 0) return [{ next_since: NOW, scope: null, target_id: null }];
  return rows.map(([scope, target_id]) => ({ next_since: NOW, scope, target_id }));
}

const tick = () => new Promise((r) => setImmediate(r));

describe('RoutingCacheSyncService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  describe('publishing', () => {
    it('publishes local agent and tenant invalidations in one batched insert', async () => {
      const { query, cache, inserts } = setup();
      query.mockResolvedValue([]);

      cache.invalidateAgent('agent-1');
      cache.invalidateAgent('agent-2');
      cache.invalidateAgent('agent-1'); // duplicate within the batch
      cache.invalidateTenant('tenant-1');
      await tick();

      expect(inserts()).toHaveLength(1);
      const [, params] = inserts()[0];
      expect(params).toEqual([
        ['agent', 'agent', 'tenant'],
        ['agent-1', 'agent-2', 'tenant-1'],
      ]);
    });

    it('flushPending resolves only after the insert completed', async () => {
      const { query, cache, sync } = setup();
      let release!: () => void;
      query.mockReturnValue(new Promise<void>((r) => (release = () => r())));

      cache.invalidateAgent('agent-1');
      let done = false;
      const flushed = sync.flushPending().then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      release();
      await flushed;
      expect(done).toBe(true);
    });

    it('flushPending waits for an insert already started by the scheduled flush', async () => {
      const { query, cache, sync, inserts } = setup();
      let release!: () => void;
      query.mockReturnValue(new Promise<void>((r) => (release = () => r())));

      cache.invalidateAgent('agent-1');
      await tick(); // the scheduled flush has started the insert
      expect(inserts()).toHaveLength(1);

      let done = false;
      const flushed = sync.flushPending().then(() => (done = true));
      await tick();
      expect(done).toBe(false);
      release();
      await flushed;
      expect(inserts()).toHaveLength(1);
    });

    it('flushPending resolves immediately when nothing was invalidated', async () => {
      const { query, sync } = setup();
      await sync.flushPending();
      expect(query).not.toHaveBeenCalled();
    });

    it('logs a failed insert and retries the batch on the next flush', async () => {
      const { query, cache, sync, inserts } = setup();
      query.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
      cache.invalidateAgent('agent-1');
      await expect(sync.flushPending()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));

      cache.invalidateAgent('agent-2');
      cache.invalidateAgent('agent-1'); // already queued again: not duplicated
      await sync.flushPending();
      expect(inserts()).toHaveLength(2);
      expect(inserts()[1][1]).toEqual([
        ['agent', 'agent'],
        ['agent-1', 'agent-2'],
      ]);
    });

    it('the poll timer retries a batch a failed insert put back', async () => {
      jest.useFakeTimers();
      const { query, cache, sync, inserts } = setup();
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT') && inserts().length === 1) throw new Error('db down');
        return feed();
      });
      cache.invalidateAgent('agent-1');
      await sync.flushPending();
      expect(inserts()).toHaveLength(1);

      sync.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);
      expect(inserts()).toHaveLength(2);
      expect(inserts()[1][1]).toEqual([['agent'], ['agent-1']]);
      await sync.onModuleDestroy();
    });
  });

  describe('applying the feed', () => {
    it('invalidates the local caches for every published row', async () => {
      const { query, cache, sync } = setup();
      cache.setTiers('agent-1', []);
      cache.setProviders('tenant-1', []);
      cache.setTiers('agent-other', []);
      query.mockResolvedValueOnce(feed(['agent', 'agent-1'], ['tenant', 'tenant-1']));

      await sync.catchUp();

      expect(cache.getTiers('agent-1')).toBeNull();
      expect(cache.getProviders('tenant-1')).toBeNull();
      expect(cache.getTiers('agent-other')).toEqual([]);
    });

    it('fires the cache listeners so dependent caches are dropped too', async () => {
      const { query, cache, sync } = setup();
      const agentListener = jest.fn();
      const tenantListener = jest.fn();
      cache.addInvalidationListener(agentListener);
      cache.addTenantInvalidationListener(tenantListener);
      query.mockResolvedValueOnce(feed(['agent', 'agent-1'], ['tenant', 'tenant-1']));

      await sync.catchUp();

      expect(agentListener).toHaveBeenCalledWith('agent-1');
      expect(tenantListener).toHaveBeenCalledWith('tenant-1');
    });

    it('does not re-publish invalidations it applied from the feed', async () => {
      const { query, sync, inserts } = setup();
      query.mockResolvedValueOnce(feed(['agent', 'agent-1'], ['tenant', 'tenant-1']));
      await sync.catchUp();
      await tick();
      expect(inserts()).toHaveLength(0);
    });

    it('applies a row repeated in one poll once', async () => {
      const { query, cache, sync } = setup();
      const listener = jest.fn();
      cache.addInvalidationListener(listener);
      query.mockResolvedValueOnce(feed(['agent', 'agent-1'], ['agent', 'agent-1']));
      await sync.catchUp();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown scopes', async () => {
      const { query, cache, sync } = setup();
      cache.setTiers('agent-1', []);
      query.mockResolvedValueOnce(feed(['bogus', 'agent-1']));
      await sync.catchUp();
      expect(cache.getTiers('agent-1')).toEqual([]);
    });

    it('starts from the DB clock, then polls from the returned lower bound', async () => {
      const { query, sync, polls } = setup();
      query.mockResolvedValueOnce(feed()).mockResolvedValueOnce(feed());

      await sync.catchUp();
      await sync.catchUp();

      expect(polls()[0][1]).toEqual([null]);
      expect(polls()[1][1]).toEqual([NOW]);
    });

    it('keeps the previous lower bound when the poll returns no row', async () => {
      const { query, sync, polls } = setup();
      query.mockResolvedValueOnce(feed()).mockResolvedValueOnce([]).mockResolvedValueOnce(feed());
      await sync.catchUp();
      await sync.catchUp();
      await sync.catchUp();
      expect(polls()[2][1]).toEqual([NOW]);
    });

    it('logs and swallows a failed poll', async () => {
      const { query, sync } = setup();
      query.mockRejectedValueOnce('boom');
      await expect(sync.catchUp()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
  });

  describe('lifecycle', () => {
    it('polls on an interval after bootstrap and stops on destroy', async () => {
      jest.useFakeTimers();
      const { query, sync, polls } = setup();
      query.mockResolvedValue(feed());

      sync.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);
      expect(polls()).toHaveLength(3);

      await sync.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);
      expect(polls()).toHaveLength(3);
    });

    it('skips a tick while the previous timer poll is still running', async () => {
      jest.useFakeTimers();
      const { query, sync, polls } = setup();
      let release!: () => void;
      query.mockReturnValueOnce(new Promise((r) => (release = () => r(feed()))));
      query.mockResolvedValue(feed());

      sync.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);
      expect(polls()).toHaveLength(1);
      release();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);
      expect(polls()).toHaveLength(2);
      await sync.onModuleDestroy();
    });

    it('prunes old rows periodically and tolerates a failed prune', async () => {
      jest.useFakeTimers();
      const { query, sync } = setup();
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('DELETE')) throw new Error('prune failed');
        return feed();
      });

      sync.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 60);
      const deletes = query.mock.calls.filter(([sql]) => String(sql).includes('DELETE'));
      expect(deletes).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('prune failed'));
      await sync.onModuleDestroy();
    });

    it('flushes queued invalidations on destroy', async () => {
      const { query, cache, sync, inserts } = setup();
      query.mockResolvedValue([]);
      cache.invalidateAgent('agent-1');
      await sync.onModuleDestroy();
      expect(inserts()).toHaveLength(1);
    });
  });
});
