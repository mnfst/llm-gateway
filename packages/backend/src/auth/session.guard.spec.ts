jest.mock('better-auth/node', () => ({
  fromNodeHeaders: jest.fn((headers: Record<string, string>) => headers),
}));

jest.mock('./auth.instance', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}));

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionGuard } from './session.guard';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { auth } = require('./auth.instance');

function createMockContext(overrides: { ip?: string; headers?: Record<string, string> }): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  // The guard no longer looks at the peer address at all. `ip` is kept so the
  // tests can still describe whether a request came from loopback or not.
  const peerIp = overrides.ip ?? '127.0.0.1';
  const request: Record<string, unknown> = {
    ip: peerIp,
    socket: { remoteAddress: peerIp },
    headers: overrides.headers ?? {},
  };

  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('SessionGuard', () => {
  let guard: SessionGuard;
  let reflector: Reflector;
  let tenantCache: { resolve: jest.Mock; ensureForUser: jest.Mock; invalidate: jest.Mock };

  beforeEach(() => {
    reflector = new Reflector();
    tenantCache = {
      resolve: jest.fn().mockResolvedValue('tenant-1'),
      ensureForUser: jest.fn(),
      invalidate: jest.fn(),
    };
    guard = new SessionGuard(reflector, tenantCache as never);
    jest.clearAllMocks();
    tenantCache.resolve.mockResolvedValue('tenant-1');
  });

  afterEach(() => {
    guard.onModuleDestroy();
  });

  it('allows public routes', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const { context } = createMockContext({});

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('passes through when X-API-Key header is present', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const { context } = createMockContext({
      headers: { 'x-api-key': 'some-key' },
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('attaches user when session is valid', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const mockSession = {
      user: { id: 'user-1', name: 'Test', email: 'test@test.com' },
      session: { id: 'session-1' },
    };
    (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);
    const { context, request } = createMockContext({});

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request['user']).toEqual(mockSession.user);
    expect(request['session']).toEqual(mockSession.session);
    expect(request['authMethod']).toBe('session');
  });

  it('attaches tenantContext { tenantId, userId } from the resolved session user', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (auth.api.getSession as jest.Mock).mockResolvedValue({
      user: { id: 'user-1', name: 'Test', email: 'test@test.com' },
      session: { id: 'session-1' },
    });
    tenantCache.resolve.mockResolvedValue('tenant-42');
    const { context, request } = createMockContext({});

    await guard.canActivate(context);

    expect(tenantCache.resolve).toHaveBeenCalledWith('user-1');
    expect(request['tenantContext']).toEqual({ tenantId: 'tenant-42', userId: 'user-1' });
  });

  it('attaches tenantContext with a null tenantId for a fresh user without a tenant', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (auth.api.getSession as jest.Mock).mockResolvedValue({
      user: { id: 'fresh-user', name: 'Fresh', email: 'fresh@test.com' },
      session: { id: 'session-2' },
    });
    tenantCache.resolve.mockResolvedValue(null);
    const { context, request } = createMockContext({});

    await guard.canActivate(context);

    expect(request['tenantContext']).toEqual({ tenantId: null, userId: 'fresh-user' });
  });

  it('fails soft with a null tenantId when tenant resolution throws (no request crash)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (auth.api.getSession as jest.Mock).mockResolvedValue({
      user: { id: 'user-1', name: 'Test', email: 'test@test.com' },
      session: { id: 'session-1' },
    });
    tenantCache.resolve.mockRejectedValue(new Error('connection terminated'));
    const { context, request } = createMockContext({});

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request['tenantContext']).toEqual({ tenantId: null, userId: 'user-1' });
  });

  it('returns true even when no session found (anonymous passthrough)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (auth.api.getSession as jest.Mock).mockResolvedValue(null);
    const { context, request } = createMockContext({ ip: '203.0.113.1' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request['user']).toBeUndefined();
    expect(request['authMethod']).toBeUndefined();
  });

  it('returns true and leaves user undefined when getSession throws (cloud mode)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (auth.api.getSession as jest.Mock).mockRejectedValue(new Error('DB connection lost'));
    const { context, request } = createMockContext({ ip: '203.0.113.1' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request['user']).toBeUndefined();
    expect(request['authMethod']).toBeUndefined();
  });

  describe('cloud mode (default) — no loopback fallback', () => {
    const originalEnv = process.env['MANIFEST_MODE'];

    beforeEach(() => {
      delete process.env['MANIFEST_MODE'];
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = originalEnv;
    });

    it('does NOT inject synthetic user for loopback IP without session', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockResolvedValue(null);
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      await guard.canActivate(context);

      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
    });

    it('does NOT inject synthetic user for loopback IP when getSession throws', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockRejectedValue(new Error('DB error'));
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      await guard.canActivate(context);

      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
    });

    it('attaches real user when Better Auth session is valid (loopback IP)', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'cloud-user-1', name: 'Cloud User', email: 'cloud@example.com' },
        session: { id: 'session-cloud' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      await guard.canActivate(context);

      expect(request['user']).toEqual(mockSession.user);
      expect(request['authMethod']).toBe('session');
    });

    it('does NOT inject synthetic user when MANIFEST_MODE is "cloud"', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockResolvedValue(null);
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      await guard.canActivate(context);

      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
    });
  });

  describe('self-hosted mode — no loopback auto-login', () => {
    const originalEnv = process.env['MANIFEST_MODE'];

    beforeEach(() => {
      process.env['MANIFEST_MODE'] = 'selfhosted';
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = originalEnv;
    });

    it('uses real session when Better Auth session exists (preserves per-user isolation)', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'real-user-1', name: 'Real User', email: 'real@test.com' },
        session: { id: 'session-1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      await guard.canActivate(context);

      expect(request['user']).toEqual(mockSession.user);
      expect(request['authMethod']).toBe('session');
    });

    it('leaves a loopback request without a session unauthenticated', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockResolvedValue(null);
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      // Still returns true so ApiKeyGuard gets to reject the request.
      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
      expect(request['tenantContext']).toBeUndefined();
      expect(tenantCache.resolve).not.toHaveBeenCalled();
    });

    it('leaves a loopback request unauthenticated when getSession throws', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockRejectedValue(new Error('DB error'));
      const { context, request } = createMockContext({ ip: '127.0.0.1' });

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
      expect(tenantCache.resolve).not.toHaveBeenCalled();
    });

    it('leaves a non-loopback request unauthenticated', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockResolvedValue(null);
      const { context, request } = createMockContext({ ip: '203.0.113.1' });

      await guard.canActivate(context);

      expect(request['user']).toBeUndefined();
      expect(request['authMethod']).toBeUndefined();
    });
  });

  describe('session cache', () => {
    it('reuses cached session for same cookie within TTL', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'u1', name: 'A', email: 'a@b.c' },
        session: { id: 's1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);
      const headers = { cookie: 'session=abc; theme=dark' };

      const first = createMockContext({ headers });
      await guard.canActivate(first.context);
      expect(auth.api.getSession).toHaveBeenCalledTimes(1);

      const second = createMockContext({ headers });
      const result = await guard.canActivate(second.context);

      expect(result).toBe(true);
      expect(auth.api.getSession).toHaveBeenCalledTimes(1);
      expect(second.request['user']).toEqual(mockSession.user);
      expect(second.request['session']).toEqual(mockSession.session);
      expect(second.request['authMethod']).toBe('session');
    });

    it('does not cache anonymous responses', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockResolvedValue(null);
      const headers = { cookie: 'session=abc' };

      await guard.canActivate(createMockContext({ headers }).context);
      await guard.canActivate(createMockContext({ headers }).context);

      expect(auth.api.getSession).toHaveBeenCalledTimes(2);
    });

    it('skips cache when no cookie header is present', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'u1', name: 'A', email: 'a@b.c' },
        session: { id: 's1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);

      await guard.canActivate(createMockContext({}).context);
      await guard.canActivate(createMockContext({}).context);

      expect(auth.api.getSession).toHaveBeenCalledTimes(2);
    });

    it('uses different cache entries for different cookies', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      (auth.api.getSession as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          user: { id: 'u1', name: 'A', email: 'a@b.c' },
          session: { id: 's1' },
        }),
      );

      await guard.canActivate(createMockContext({ headers: { cookie: 'session=alpha' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'session=beta' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'session=alpha' } }).context);

      expect(auth.api.getSession).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache clears entries for a cookie', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'u1', name: 'A', email: 'a@b.c' },
        session: { id: 's1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);
      const headers = { cookie: 'session=abc' };

      await guard.canActivate(createMockContext({ headers }).context);
      guard.invalidateCache('session=abc');
      await guard.canActivate(createMockContext({ headers }).context);

      expect(auth.api.getSession).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache without arg clears the entire cache', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'u1', name: 'A', email: 'a@b.c' },
        session: { id: 's1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);

      await guard.canActivate(createMockContext({ headers: { cookie: 'session=a' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'session=b' } }).context);
      guard.invalidateCache();
      await guard.canActivate(createMockContext({ headers: { cookie: 'session=a' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'session=b' } }).context);

      expect(auth.api.getSession).toHaveBeenCalledTimes(4);
    });

    it('expires cache entries past the TTL', async () => {
      jest.useFakeTimers();
      try {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
        (auth.api.getSession as jest.Mock).mockResolvedValue({
          user: { id: 'u1', name: 'A', email: 'a@b.c' },
          session: { id: 's1' },
        });
        const headers = { cookie: 'session=abc' };

        await guard.canActivate(createMockContext({ headers }).context);
        jest.advanceTimersByTime(61_000);
        await guard.canActivate(createMockContext({ headers }).context);

        expect(auth.api.getSession).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('evicts oldest entry when cache exceeds max size', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const mockSession = {
        user: { id: 'u1', name: 'A', email: 'a@b.c' },
        session: { id: 's1' },
      };
      (auth.api.getSession as jest.Mock).mockResolvedValue(mockSession);

      // Resize the cache cap for the test by exposing private state via cast
      type WritableMax = { MAX_CACHE_SIZE: number };
      (guard as unknown as WritableMax).MAX_CACHE_SIZE = 2;

      await guard.canActivate(createMockContext({ headers: { cookie: 'a' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'b' } }).context);
      await guard.canActivate(createMockContext({ headers: { cookie: 'c' } }).context);

      // 'a' should have been evicted
      await guard.canActivate(createMockContext({ headers: { cookie: 'a' } }).context);
      expect(auth.api.getSession).toHaveBeenCalledTimes(4);

      // 'c' is still cached
      await guard.canActivate(createMockContext({ headers: { cookie: 'c' } }).context);
      expect(auth.api.getSession).toHaveBeenCalledTimes(4);
    });
  });
});
