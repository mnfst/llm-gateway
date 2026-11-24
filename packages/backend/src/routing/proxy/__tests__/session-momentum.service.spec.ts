import {
  SESSION_MOMENTUM_MAX_KEY_LENGTH,
  SESSION_MOMENTUM_MAX_SESSIONS,
  SessionMomentumService,
} from '../session-momentum.service';

describe('SessionMomentumService', () => {
  let service: SessionMomentumService;

  beforeEach(() => {
    service = new SessionMomentumService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('returns undefined for unknown session', () => {
    expect(service.getRecentTiers('unknown')).toBeUndefined();
  });

  it('records and retrieves a tier', () => {
    service.recordTier('sess-1', 'complex');
    expect(service.getRecentTiers('sess-1')).toEqual(['complex']);
  });

  it('prepends new tiers (most recent first)', () => {
    service.recordTier('sess-1', 'simple');
    service.recordTier('sess-1', 'complex');
    service.recordTier('sess-1', 'reasoning');
    expect(service.getRecentTiers('sess-1')).toEqual(['reasoning', 'complex', 'simple']);
  });

  it('caps at 5 entries', () => {
    for (const tier of [
      'simple',
      'standard',
      'complex',
      'reasoning',
      'simple',
      'complex',
    ] as const) {
      service.recordTier('sess-1', tier);
    }
    const tiers = service.getRecentTiers('sess-1')!;
    expect(tiers).toHaveLength(5);
    expect(tiers[0]).toBe('complex');
  });

  it('returns undefined for expired sessions', () => {
    service.recordTier('sess-1', 'simple');

    // Manually expire by reaching into the internals
    const sessions = (service as unknown as { sessions: Map<string, { lastUpdated: number }> })
      .sessions;
    const entry = sessions.get('sess-1')!;
    entry.lastUpdated = Date.now() - 31 * 60 * 1000; // 31 minutes ago

    expect(service.getRecentTiers('sess-1')).toBeUndefined();
  });

  it('evicts stale sessions during cleanup', () => {
    service.recordTier('fresh', 'simple');
    service.recordTier('stale', 'complex');

    // Manually expire the 'stale' session
    const sessions = (
      service as unknown as {
        sessions: Map<string, { tiers: string[]; lastUpdated: number }>;
      }
    ).sessions;
    const staleEntry = sessions.get('stale')!;
    staleEntry.lastUpdated = Date.now() - 31 * 60 * 1000; // 31 minutes ago

    // Trigger eviction manually
    (service as unknown as { evictStale: () => void }).evictStale();

    // Stale session should be removed, fresh session should remain
    expect(service.getRecentTiers('stale')).toBeUndefined();
    expect(service.getRecentTiers('fresh')).toEqual(['simple']);
  });

  it('eviction keeps non-stale sessions', () => {
    service.recordTier('a', 'simple');
    service.recordTier('b', 'complex');

    (service as unknown as { evictStale: () => void }).evictStale();

    // Both should survive since they are fresh
    expect(service.getRecentTiers('a')).toEqual(['simple']);
    expect(service.getRecentTiers('b')).toEqual(['complex']);
  });

  it('fires the cleanup interval callback to evict stale sessions', () => {
    jest.useFakeTimers();

    const timedService = new SessionMomentumService();
    timedService.recordTier('stale-session', 'simple');

    // Manually expire the session
    const sessions = (
      timedService as unknown as {
        sessions: Map<string, { tiers: string[]; lastUpdated: number }>;
      }
    ).sessions;
    sessions.get('stale-session')!.lastUpdated = Date.now() - 31 * 60 * 1000;

    timedService.recordTier('fresh-session', 'complex');

    // Advance past the cleanup interval (5 minutes)
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);

    // The interval callback should have triggered evictStale
    expect(timedService.getRecentTiers('stale-session')).toBeUndefined();
    expect(timedService.getRecentTiers('fresh-session')).toEqual(['complex']);

    timedService.onModuleDestroy();
    jest.useRealTimers();
  });

  it('isolates different session keys', () => {
    service.recordTier('a', 'simple');
    service.recordTier('b', 'complex');
    expect(service.getRecentTiers('a')).toEqual(['simple']);
    expect(service.getRecentTiers('b')).toEqual(['complex']);
  });

  it('caps the total session count and evicts the least recently used entry', () => {
    service.recordTier('oldest', 'simple');
    service.recordTier('recent', 'complex');
    service.getRecentTiers('oldest');

    for (let i = 2; i < SESSION_MOMENTUM_MAX_SESSIONS; i++) {
      service.recordTier(`session-${i}`, 'standard');
    }
    service.recordTier('overflow', 'reasoning');

    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.size).toBe(SESSION_MOMENTUM_MAX_SESSIONS);
    expect(service.getRecentTiers('recent')).toBeUndefined();
    expect(service.getRecentTiers('oldest')).toEqual(['simple']);
    expect(service.getRecentTiers('overflow')).toEqual(['reasoning']);
  });

  it('does not retain oversized session keys', () => {
    const oversizedKey = 'x'.repeat(SESSION_MOMENTUM_MAX_KEY_LENGTH + 1);

    service.recordTier(oversizedKey, 'simple');
    service.recordCategory(oversizedKey, 'coding');

    expect(service.getRecentTiers(oversizedKey)).toBeUndefined();
    expect(service.getRecentCategories(oversizedKey)).toBeUndefined();
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.size).toBe(0);
  });

  describe('specificity categories', () => {
    it('returns undefined when no categories have been recorded', () => {
      expect(service.getRecentCategories('unknown')).toBeUndefined();
    });

    it('creates a new entry when recordCategory is called first', () => {
      service.recordCategory('sess-1', 'coding');
      expect(service.getRecentCategories('sess-1')).toEqual(['coding']);
    });

    it('prepends new categories on an existing entry', () => {
      service.recordCategory('sess-1', 'coding');
      service.recordCategory('sess-1', 'web_browsing');
      expect(service.getRecentCategories('sess-1')).toEqual(['web_browsing', 'coding']);
    });

    it('caps categories at 5 entries', () => {
      for (const c of [
        'coding',
        'web_browsing',
        'coding',
        'coding',
        'coding',
        'web_browsing',
      ] as const) {
        service.recordCategory('sess-1', c);
      }
      const cats = service.getRecentCategories('sess-1')!;
      expect(cats).toHaveLength(5);
      expect(cats[0]).toBe('web_browsing');
    });

    it('returns undefined when the entry exists but has no categories', () => {
      // recordTier creates an entry whose categories[] is empty — the guard
      // in getRecentCategories must not surface the empty array as a result.
      service.recordTier('sess-1', 'simple');
      expect(service.getRecentCategories('sess-1')).toBeUndefined();
    });

    it('returns undefined for expired sessions even when categories were recorded', () => {
      service.recordCategory('sess-1', 'coding');
      const sessions = (service as unknown as { sessions: Map<string, { lastUpdated: number }> })
        .sessions;
      sessions.get('sess-1')!.lastUpdated = Date.now() - 31 * 60 * 1000;
      expect(service.getRecentCategories('sess-1')).toBeUndefined();
    });

    it('keeps tier history intact when recordCategory appends to an existing entry', () => {
      service.recordTier('sess-1', 'complex');
      service.recordCategory('sess-1', 'coding');
      expect(service.getRecentTiers('sess-1')).toEqual(['complex']);
      expect(service.getRecentCategories('sess-1')).toEqual(['coding']);
    });
  });
});
