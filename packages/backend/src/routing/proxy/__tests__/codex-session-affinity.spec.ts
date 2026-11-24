import { CodexSessionAffinity } from '../codex-session-affinity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function okResponseWithTurnState(token: string): Response {
  return new Response('{}', { status: 200, headers: { 'x-codex-turn-state': token } });
}

describe('CodexSessionAffinity', () => {
  let affinity: CodexSessionAffinity;

  beforeEach(() => {
    jest.useFakeTimers();
    affinity = new CodexSessionAffinity();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('prepare', () => {
    it('issues UUID-shaped session-id and thread-id headers', () => {
      const { headers } = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(headers['session-id']).toMatch(UUID_RE);
      expect(headers['thread-id']).toMatch(UUID_RE);
      expect(headers['session-id']).not.toBe(headers['thread-id']);
    });

    it('reuses the same ids for the same cache key, distinct per conversation', () => {
      const a = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      const b = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      const otherConversation = affinity.prepare('token', { prompt_cache_key: 'conv-2' });
      expect(a.headers).toEqual(b.headers);
      expect(a.storeKey).toBe(b.storeKey);
      expect(otherConversation.headers['session-id']).not.toBe(a.headers['session-id']);
      expect(otherConversation.headers['thread-id']).not.toBe(a.headers['thread-id']);
    });
    it('derives the same ids on separate instances so replicas and restarts share a shard', () => {
      const replicaA = new CodexSessionAffinity();
      const replicaB = new CodexSessionAffinity();
      const a = replicaA.prepare('token', { prompt_cache_key: 'conv-1' });
      const b = replicaB.prepare('token-rotated', { prompt_cache_key: 'conv-1' });
      expect(b.headers['session-id']).toBe(a.headers['session-id']);
      expect(b.headers['thread-id']).toBe(a.headers['thread-id']);
      // Turn-state stays per-instance: a replica that never saw a response has none to replay.
      replicaA.capture(a.storeKey, okResponseWithTurnState('turn-a'));
      expect(
        replicaA.prepare('token', { prompt_cache_key: 'conv-1' }).headers['x-codex-turn-state'],
      ).toBe('turn-a');
      expect(
        replicaB.prepare('token-rotated', { prompt_cache_key: 'conv-1' }).headers[
          'x-codex-turn-state'
        ],
      ).toBeUndefined();
    });

    it('keeps a caller-supplied prompt_cache_key untouched', () => {
      const body: Record<string, unknown> = { prompt_cache_key: 'caller-key' };

      affinity.prepare('token', body);

      expect(body.prompt_cache_key).toBe('caller-key');
    });

    it.each([[undefined], [''], [42]])(
      'injects request-local affinity when prompt_cache_key is %p',
      (callerKey) => {
        const body: Record<string, unknown> = { prompt_cache_key: callerKey };
        const bodyAgain: Record<string, unknown> = { prompt_cache_key: callerKey };

        const first = affinity.prepare('token', body);
        const second = affinity.prepare('token', bodyAgain);

        expect(body.prompt_cache_key).toMatch(UUID_RE);
        expect(bodyAgain.prompt_cache_key).toMatch(UUID_RE);
        expect(bodyAgain.prompt_cache_key).not.toBe(body.prompt_cache_key);
        expect(second.headers['session-id']).not.toBe(first.headers['session-id']);
        expect(first.storeKey).toBeUndefined();
        expect(second.storeKey).toBeUndefined();
      },
    );

    it('omits x-codex-turn-state when nothing has been captured', () => {
      const { headers } = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(headers).not.toHaveProperty('x-codex-turn-state');
    });

    it('treats an over-long prompt_cache_key as absent to cap per-key memory', () => {
      const longKey = 'x'.repeat(513);
      const body: Record<string, unknown> = { prompt_cache_key: longKey };
      const otherLongKey: Record<string, unknown> = { prompt_cache_key: 'y'.repeat(600) };

      const first = affinity.prepare('token', body);
      const second = affinity.prepare('token', otherLongKey);

      // The giant key is never echoed back to the upstream…
      expect(body.prompt_cache_key).toMatch(UUID_RE);
      expect(body.prompt_cache_key).not.toBe(longKey);
      // …and invalid keys do not create persistent token-wide sessions.
      expect(first.storeKey).toBeUndefined();
      expect(second.storeKey).toBeUndefined();
      expect(first.headers['session-id']).not.toBe(second.headers['session-id']);
    });

    it('accepts a prompt_cache_key at the length boundary', () => {
      const maxKey = 'x'.repeat(512);
      const body: Record<string, unknown> = { prompt_cache_key: maxKey };

      const { storeKey } = affinity.prepare('token', body);

      expect(body.prompt_cache_key).toBe(maxKey);
      expect(storeKey).toContain(maxKey);
    });

    it('keeps session ids stable across the TTL but drops the stale turn-state', () => {
      const before = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(before.storeKey, okResponseWithTurnState('turn-1'));
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      const after = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      expect(after.headers['session-id']).toBe(before.headers['session-id']);
      expect(after.headers['thread-id']).toBe(before.headers['thread-id']);
      expect(after.headers['x-codex-turn-state']).toBeUndefined();
    });

    it('replaces an expired session in place when no sweep has run yet', () => {
      const before = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(before.storeKey, okResponseWithTurnState('turn-1'));
      // A sweep 4m30s in leaves conv-1 alive and resets the cleanup clock…
      jest.advanceTimersByTime(4 * 60 * 1000 + 30 * 1000);
      affinity.prepare('token', { prompt_cache_key: 'conv-other' });
      // …so 40s later conv-1 is expired but still in the map, and prepare()
      // must replace it rather than replay its stale token.
      jest.advanceTimersByTime(40 * 1000);
      const after = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      expect(after.headers['session-id']).toBe(before.headers['session-id']);
      expect(after.headers['x-codex-turn-state']).toBeUndefined();
    });

    it('slides the TTL while the session stays active', () => {
      const before = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(before.storeKey, okResponseWithTurnState('turn-1'));
      jest.advanceTimersByTime(4 * 60 * 1000);
      affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      // 8 minutes after creation — the token would have expired without the refresh above.
      jest.advanceTimersByTime(4 * 60 * 1000);
      const after = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      expect(after.headers['x-codex-turn-state']).toBe('turn-1');
    });
  });

  describe('capture + replay', () => {
    it('does not replay turn-state for requests without a cache key', () => {
      const first = affinity.prepare('token', {});
      affinity.capture(first.storeKey, okResponseWithTurnState('turn-abc'));

      const second = affinity.prepare('token', {});

      expect(second.headers).not.toHaveProperty('x-codex-turn-state');
      expect(second.headers['session-id']).not.toBe(first.headers['session-id']);
    });

    it('replays the captured turn-state token on the next request for the same session', () => {
      const first = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(first.storeKey, okResponseWithTurnState('turn-abc'));

      const second = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(second.headers['x-codex-turn-state']).toBe('turn-abc');
    });

    it('scopes turn-state to the session it was captured for', () => {
      const first = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(first.storeKey, okResponseWithTurnState('turn-abc'));

      const other = affinity.prepare('token', { prompt_cache_key: 'conv-2' });

      expect(other.headers).not.toHaveProperty('x-codex-turn-state');
    });

    it('overwrites the stored token with the most recent one', () => {
      const { storeKey } = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(storeKey, okResponseWithTurnState('turn-1'));
      affinity.capture(storeKey, okResponseWithTurnState('turn-2'));

      const next = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(next.headers['x-codex-turn-state']).toBe('turn-2');
    });

    it('ignores responses without a turn-state header', () => {
      const { storeKey } = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(storeKey, new Response('{}', { status: 200 }));

      const next = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(next.headers).not.toHaveProperty('x-codex-turn-state');
    });

    it('drops the stored token but keeps the session when the upstream rejects a request', () => {
      const first = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(first.storeKey, okResponseWithTurnState('turn-abc'));
      affinity.capture(first.storeKey, new Response('{}', { status: 400 }));

      const next = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(next.headers).not.toHaveProperty('x-codex-turn-state');
      expect(next.headers['session-id']).toBe(first.headers['session-id']);
    });

    it('expires tokens after the TTL', () => {
      const { storeKey } = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(storeKey, okResponseWithTurnState('turn-abc'));

      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      const next = affinity.prepare('token', { prompt_cache_key: 'conv-1' });

      expect(next.headers).not.toHaveProperty('x-codex-turn-state');
    });

    it('is a no-op when the session has been swept before the response arrived', () => {
      const stale = affinity.prepare('token', { prompt_cache_key: 'conv-stale' });

      // The sweep during this prepare() removes the expired conv-stale session.
      jest.advanceTimersByTime(6 * 60 * 1000);
      affinity.prepare('token', { prompt_cache_key: 'conv-other' });

      affinity.capture(stale.storeKey, okResponseWithTurnState('turn-late'));
      const next = affinity.prepare('token', { prompt_cache_key: 'conv-stale' });

      expect(next.headers).not.toHaveProperty('x-codex-turn-state');
    });
  });

  describe('capture after replacement', () => {
    it('ignores a capture from a request whose entry expired and was replaced', () => {
      const stale = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      const fresh = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      expect(fresh.headers['session-id']).toBe(stale.headers['session-id']);
      // The old request completes late: its token must not land on the new entry.
      affinity.capture(stale.storeKey, okResponseWithTurnState('turn-stale'), stale.incarnation);
      expect(
        affinity.prepare('token', { prompt_cache_key: 'conv-1' }).headers['x-codex-turn-state'],
      ).toBeUndefined();
      affinity.capture(fresh.storeKey, okResponseWithTurnState('turn-fresh'), fresh.incarnation);
      expect(
        affinity.prepare('token', { prompt_cache_key: 'conv-1' }).headers['x-codex-turn-state'],
      ).toBe('turn-fresh');
    });
    it('ignores a capture from a request whose entry was evicted and recreated', () => {
      const stale = affinity.prepare('token', { prompt_cache_key: 'conv-0' });
      for (let i = 1; i <= 10_000; i++) {
        affinity.prepare('token', { prompt_cache_key: `conv-${i}` });
      }
      const fresh = affinity.prepare('token', { prompt_cache_key: 'conv-0' });
      expect(fresh.incarnation).not.toBe(stale.incarnation);
      affinity.capture(stale.storeKey, okResponseWithTurnState('turn-stale'), stale.incarnation);
      expect(
        affinity.prepare('token', { prompt_cache_key: 'conv-0' }).headers['x-codex-turn-state'],
      ).toBeUndefined();
    });
  });

  describe('capacity', () => {
    it('evicts the oldest session at capacity, preserving recently used ones', () => {
      const first = affinity.prepare('token', { prompt_cache_key: 'conv-0' });
      const second = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      affinity.capture(first.storeKey, okResponseWithTurnState('turn-0'));
      affinity.capture(second.storeKey, okResponseWithTurnState('turn-1'));
      for (let i = 2; i < 10_000; i++) {
        affinity.prepare('token', { prompt_cache_key: `conv-${i}` });
      }

      // Touching conv-0 at capacity must not evict anything, and moves it to
      // the back of the recency order…
      expect(
        affinity.prepare('token', { prompt_cache_key: 'conv-0' }).headers['x-codex-turn-state'],
      ).toBe('turn-0');

      // …so a brand-new session evicts conv-1 (now the oldest), not conv-0.
      // Ids are deterministic, so eviction shows up as the lost turn-state.
      affinity.prepare('token', { prompt_cache_key: 'conv-overflow' });

      const evicted = affinity.prepare('token', { prompt_cache_key: 'conv-1' });
      expect(evicted.headers['session-id']).toBe(second.headers['session-id']);
      expect(evicted.headers['x-codex-turn-state']).toBeUndefined();
      expect(
        affinity.prepare('token', { prompt_cache_key: 'conv-0' }).headers['x-codex-turn-state'],
      ).toBe('turn-0');
    });
  });
});
