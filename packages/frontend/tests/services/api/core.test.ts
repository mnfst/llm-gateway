import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchJson,
  fetchMutate,
  parseErrorMessage,
  routingPath,
} from '../../../src/services/api/core';
import { invalidateAll } from '../../../src/services/api/cache';

const mockToastError = vi.fn();
vi.mock('../../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    statusText: 'STATUS',
    json: async () => opts.body ?? {},
    text: async () => opts.text ?? (opts.body !== undefined ? JSON.stringify(opts.body) : ''),
  } as Response;
}

describe('core api helpers', () => {
  let location: { origin: string; pathname: string; href?: string };

  beforeEach(() => {
    location = { origin: 'http://localhost', pathname: '/dashboard', href: '' };
    vi.stubGlobal('window', { location });
    mockToastError.mockReset();
    // Start each test with an empty SWR cache so cached payloads from a prior
    // test don't satisfy a later GET before its fetch mock is asserted.
    invalidateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('routingPath', () => {
    it('encodes the agent name', () => {
      expect(routingPath('my agent')).toBe('/routing/my%20agent');
    });

    it('appends the suffix with a leading slash already present', () => {
      expect(routingPath('demo', '/tiers/simple')).toBe('/routing/demo/tiers/simple');
    });

    it("inserts a slash when the suffix doesn't start with one", () => {
      expect(routingPath('demo', 'tiers/simple')).toBe('/routing/demo/tiers/simple');
    });

    it('returns just the agent path with no suffix', () => {
      expect(routingPath('demo')).toBe('/routing/demo');
    });
  });

  describe('fetchJson', () => {
    it('returns parsed JSON on a 2xx', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { rows: [1, 2] } }));
      vi.stubGlobal('fetch', fetchMock);

      const out = await fetchJson<{ rows: number[] }>('/something');
      expect(out).toEqual({ rows: [1, 2] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/v1/something');
      expect((init as RequestInit).credentials).toBe('include');
      expect((init as RequestInit & { cache?: string }).cache).toBe('default');
    });

    it('appends provided params, skipping undefined values', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: {} }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchJson('/messages', { range: '7d', cursor: undefined, limit: '50' });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('range=7d');
      expect(url).toContain('limit=50');
      expect(url).not.toContain('cursor=');
    });

    it('redirects to /login on a session-expiry 401 (empty body)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 401, text: '' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('Session expired');
      expect(location.href).toBe('/login');
    });

    it('rejects without the login redirect on a session-expiry 401 when loginRedirect is false', async () => {
      // A probe that may legitimately run signed-out (the plan prefetch in
      // AuthGuard) must not hard-navigate the browser to /login, or the guard
      // never gets to preserve the requested path in the redirect.
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 401, text: '' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything', undefined, { loginRedirect: false })).rejects.toThrow(
        'Session expired',
      );
      expect(location.href).toBe('');
    });

    it('does not redirect when already on /login', async () => {
      location.pathname = '/login';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 401, text: '' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('Session expired');
      expect(location.href).toBe('');
    });

    it('treats a 401 body matching the session regex as session expiry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 401, text: 'session expired' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('Session expired');
      expect(location.href).toBe('/login');
    });

    it('throws Unauthorized without redirect on a 401 with non-session body', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 401, text: 'forbidden resource' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('forbidden resource');
      expect(location.href).toBe('');
    });

    it('throws on non-2xx with the body when present', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 500, text: 'boom' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('boom');
    });

    it('throws a generic message when body is empty', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow(/API error: 503/);
    });

    it('re-throws when fetch() throws a network error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('Network error');
    });

    it('re-throws when fetch() throws DOMException (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchJson('/anything')).rejects.toThrow('The operation was aborted');
    });

    it('serves a cacheable GET from the SWR cache on the second call', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { v: 1 } }));
      vi.stubGlobal('fetch', fetchMock);

      const first = await fetchJson<{ v: number }>('/overview', { range: '7d' });
      const second = await fetchJson<{ v: number }>('/overview', { range: '7d' });
      expect(first).toEqual({ v: 1 });
      expect(second).toEqual({ v: 1 });
      // Second identical GET is a cache hit — only one network call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keys the cache by full URL incl. query params', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { v: 1 } }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchJson('/overview', { range: '7d' });
      await fetchJson('/overview', { range: '30d' });
      // Different params → different keys → two network calls.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache when called with { cache: false }', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { v: 1 } }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchJson('/overview', undefined, { cache: false });
      await fetchJson('/overview', undefined, { cache: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never caches a deny-listed sensitive URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { key: 'secret' } }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchJson('/agents/demo/key');
      await fetchJson('/agents/demo/key');
      // Deny-listed → every call hits the network, never a stale secret.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('still passes cache: default to the underlying fetch', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: {} }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchJson('/overview');
      const init = fetchMock.mock.calls[0][1] as RequestInit & { cache?: string };
      expect(init.cache).toBe('default');
    });
  });

  describe('parseErrorMessage', () => {
    it('returns body.message when it is a string', async () => {
      const res = makeResponse({ body: { message: 'no good' } });
      expect(await parseErrorMessage(res)).toBe('no good');
    });

    it('joins body.message when it is an array', async () => {
      const res = makeResponse({ body: { message: ['a', 'b'] } });
      expect(await parseErrorMessage(res)).toBe('a, b');
    });

    it('falls back to status code when body is not JSON', async () => {
      const res = {
        status: 422,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response;
      expect(await parseErrorMessage(res)).toBe('Request failed (422)');
    });

    it('falls back to status code when message field is absent', async () => {
      const res = makeResponse({ status: 400, body: { other: 'field' } });
      expect(await parseErrorMessage(res)).toBe('Request failed (400)');
    });
  });

  describe('fetchMutate', () => {
    it('returns parsed JSON on success', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { ok: true } }));
      vi.stubGlobal('fetch', fetchMock);

      const out = await fetchMutate<{ ok: boolean }>('/something', { method: 'POST' });
      expect(out).toEqual({ ok: true });
    });

    it('returns undefined on success with empty body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: undefined, text: '' }));
      vi.stubGlobal('fetch', fetchMock);

      const out = await fetchMutate('/something', { method: 'DELETE' });
      expect(out).toBeUndefined();
    });

    it('invalidates the GET cache on a successful mutation', async () => {
      // Prime the cache with a GET, then mutate, then GET again.
      const getRes = vi.fn().mockResolvedValue(makeResponse({ body: { v: 1 } }));
      vi.stubGlobal('fetch', getRes);
      await fetchJson('/overview');
      expect(getRes).toHaveBeenCalledTimes(1);

      const mutateRes = vi.fn().mockResolvedValue(makeResponse({ body: undefined, text: '' }));
      vi.stubGlobal('fetch', mutateRes);
      await fetchMutate('/agents/demo', { method: 'PATCH' });

      // After the mutation, the previously-cached GET must refetch.
      const getRes2 = vi.fn().mockResolvedValue(makeResponse({ body: { v: 2 } }));
      vi.stubGlobal('fetch', getRes2);
      const out = await fetchJson<{ v: number }>('/overview');
      expect(out).toEqual({ v: 2 });
      expect(getRes2).toHaveBeenCalledTimes(1);
    });

    it('does NOT invalidate the cache on a failed mutation', async () => {
      const getRes = vi.fn().mockResolvedValue(makeResponse({ body: { v: 1 } }));
      vi.stubGlobal('fetch', getRes);
      await fetchJson('/overview');

      const failRes = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 400, body: { message: 'bad' } }));
      vi.stubGlobal('fetch', failRes);
      await expect(fetchMutate('/agents/demo', { method: 'PATCH' })).rejects.toThrow('bad');

      // The cached GET survives a failed mutation — still served from cache.
      const getRes2 = vi.fn().mockResolvedValue(makeResponse({ body: { v: 2 } }));
      vi.stubGlobal('fetch', getRes2);
      const out = await fetchJson<{ v: number }>('/overview');
      expect(out).toEqual({ v: 1 });
      expect(getRes2).not.toHaveBeenCalled();
    });

    it('throws and toasts the parsed message on failure', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(makeResponse({ ok: false, status: 400, body: { message: 'bad' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchMutate('/something', { method: 'POST' })).rejects.toThrow('bad');
      expect(mockToastError).toHaveBeenCalledWith('bad');
    });

    it('re-throws when fetch() throws a network error', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchMutate('/something', { method: 'POST' })).rejects.toThrow('Network error');
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it('re-throws when fetch() throws DOMException (AbortError)', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      const fetchMock = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchMutate('/something', { method: 'POST' })).rejects.toThrow(
        'The operation was aborted',
      );
      expect(mockToastError).not.toHaveBeenCalled();
    });
  });
});
