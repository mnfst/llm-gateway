import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { hashKey } from '../utils/hash.util';

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        ip: '127.0.0.1',
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let mockFind: jest.Mock;
  let mockExecute: jest.Mock;
  let mockSet: jest.Mock;
  let configGet: jest.Mock;
  let reflector: Reflector;

  beforeEach(() => {
    mockFind = jest.fn().mockResolvedValue([]);
    mockExecute = jest.fn().mockResolvedValue({});
    mockSet = jest.fn().mockImplementation((setObj) => {
      // Invoke raw expression functions for coverage (e.g. () => 'CURRENT_TIMESTAMP')
      if (setObj) {
        for (const val of Object.values(setObj)) {
          if (typeof val === 'function') (val as () => unknown)();
        }
      }
      return mockUpdateQb;
    });
    const mockUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: mockSet,
      where: jest.fn().mockReturnThis(),
      execute: mockExecute,
    };
    configGet = jest
      .fn()
      .mockImplementation((key: string) => (key === 'app.cliTokenTtlDays' ? 30 : ''));
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const configService = { get: configGet } as unknown as ConfigService;
    const mockRepo = {
      find: mockFind,
      createQueryBuilder: jest.fn().mockReturnValue(mockUpdateQb),
    } as never;
    guard = new ApiKeyGuard(reflector, configService, mockRepo);
  });

  it('throws UnauthorizedException when X-API-Key header is missing', async () => {
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('X-API-Key header required');
  });

  it('throws UnauthorizedException when X-API-Key is not a string', async () => {
    const ctx = makeContext({ 'x-api-key': undefined });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('returns true when API key hash is found in database', async () => {
    const rawKey = 'valid-db-key';
    const storedHash = hashKey(rawKey);
    mockFind.mockResolvedValueOnce([
      {
        id: 'key-1',
        tenant_id: 'tenant-123',
        created_by_user_id: 'user-123',
        key_hash: storedHash,
        key_prefix: rawKey.substring(0, 12),
      },
    ]);
    const ctx = makeContext({ 'x-api-key': rawKey });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('sets tenantContext (and user attribution) on request when DB key matches', async () => {
    const rawKey = 'db-key';
    const storedHash = hashKey(rawKey);
    mockFind.mockResolvedValueOnce([
      {
        id: 'key-1',
        tenant_id: 'tenant-456',
        created_by_user_id: 'user-456',
        key_hash: storedHash,
        key_prefix: rawKey.substring(0, 12),
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as {
      headers: Record<string, string>;
      ip: string;
      tenantContext?: { tenantId: string; userId: string | null };
      user?: { id: string };
      authMethod?: string;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    // The tenant comes straight off the key row — no key→user→tenant indirection.
    expect(request.tenantContext).toEqual({ tenantId: 'tenant-456', userId: 'user-456' });
    // Creating user is kept as attribution so @CurrentUser controllers see a user.
    expect(request.user).toEqual({ id: 'user-456' });
    expect(request.authMethod).toBe('api_key');
  });

  it('sets tenantContext but does not synthesize request.user when created_by_user_id is null', async () => {
    const rawKey = 'orphan-key';
    const storedHash = hashKey(rawKey);
    mockFind.mockResolvedValueOnce([
      {
        id: 'key-2',
        tenant_id: 'tenant-789',
        created_by_user_id: null,
        key_hash: storedHash,
        key_prefix: rawKey.substring(0, 12),
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as {
      headers: Record<string, string>;
      ip: string;
      tenantContext?: { tenantId: string; userId: string | null };
      user?: { id: string };
      authMethod?: string;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(request.tenantContext).toEqual({ tenantId: 'tenant-789', userId: null });
    // No owning user → no synthesized request.user (env-key-style attribution).
    expect(request.user).toBeUndefined();
    expect(request.authMethod).toBe('api_key');
  });

  it('falls back to env-based API key when DB lookup returns empty', async () => {
    mockFind.mockResolvedValueOnce([]);
    configGet.mockReturnValue('env-api-key');
    const request = {
      headers: { 'x-api-key': 'env-api-key' },
      ip: '127.0.0.1',
    } as {
      headers: Record<string, string>;
      ip: string;
      tenantContext?: unknown;
      user?: unknown;
      authMethod?: string;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    // Env key is a shared operator credential — no tenant context, no user.
    expect(request.authMethod).toBe('env_api_key');
    expect(request.tenantContext).toBeUndefined();
    expect(request.user).toBeUndefined();
  });

  it('throws when neither DB nor env key matches', async () => {
    mockFind.mockResolvedValueOnce([]);
    configGet.mockReturnValue('correct-key');
    const ctx = makeContext({ 'x-api-key': 'wrong-key' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');
  });

  it('throws when env key is empty and DB lookup fails', async () => {
    mockFind.mockResolvedValueOnce([]);
    configGet.mockReturnValue('');
    const ctx = makeContext({ 'x-api-key': 'any-key' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects keys of different length from env key', async () => {
    mockFind.mockResolvedValueOnce([]);
    configGet.mockReturnValue('short');
    const ctx = makeContext({ 'x-api-key': 'much-longer-key-value' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('does not throw when last_used_at update fails', async () => {
    const rawKey = 'key-that-triggers-update-fail';
    const storedHash = hashKey(rawKey);
    mockFind.mockResolvedValueOnce([
      {
        id: 'key-1',
        tenant_id: 'tenant-789',
        created_by_user_id: 'user-789',
        key_hash: storedHash,
        key_prefix: rawKey.substring(0, 12),
      },
    ]);
    mockExecute.mockRejectedValueOnce(new Error('DB write error'));
    const ctx = makeContext({ 'x-api-key': rawKey });

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('returns true immediately when route is marked @Public()', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValueOnce(true);
    const ctx = makeContext({});

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('skips API key validation when authMethod is session', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          ip: '127.0.0.1',
          authMethod: 'session',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('does not skip API key validation when user is set but authMethod is missing', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          ip: '127.0.0.1',
          user: { id: 'session-user' },
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects x-api-key header when provided as an array', async () => {
    // Express returns an array when multiple values are supplied for the
    // same header (e.g. duplicate `X-API-Key: ...` lines). `typeof` an
    // array is 'object', so the guard's `typeof apiKey !== 'string'` check
    // must reject this case rather than coerce / pick a value silently.
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-api-key': ['key1', 'key2'] },
          ip: '127.0.0.1',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('X-API-Key header required');
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects x-api-key header when provided as a single-element array', async () => {
    // Even when only one value is present, an array shape must not pass —
    // otherwise downstream `apiKey.substring(...)` / hash lookups would
    // explode at runtime on `array.substring is not a function`.
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-api-key': ['only-key'] },
          ip: '127.0.0.1',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('X-API-Key header required');
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects x-api-key header when provided as an empty array', async () => {
    // Falsy short-circuit (`!apiKey`) handles `[]` because empty arrays
    // are truthy in JS — the explicit type guard is what catches this.
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-api-key': [] as string[] },
          ip: '127.0.0.1',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects an expired key with 401', async () => {
    const rawKey = 'mnfst_pat_expired';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k1',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as {
      headers: Record<string, string>;
      ip: string;
      tenantContext?: unknown;
      user?: unknown;
      authMethod?: string;
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    // The expiry check runs BEFORE any credential is attached — an expired key
    // must never leave a usable tenant/user on the request for a later guard
    // or filter to pick up, and must not slide its own expiry forward.
    expect(request.tenantContext).toBeUndefined();
    expect(request.user).toBeUndefined();
    expect(request.authMethod).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('surfaces the re-login hint when the key is expired', async () => {
    const rawKey = 'mnfst_pat_expired2';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k1b',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const ctx = makeContext({ 'x-api-key': rawKey });

    await expect(guard.canActivate(ctx)).rejects.toThrow('API key expired — run mnfst login');
  });

  it('slides expires_at forward on successful auth for expiring keys', async () => {
    const rawKey = 'mnfst_pat_live';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k2',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ]);
    const ctx = makeContext({ 'x-api-key': rawKey });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // the update .set() payload must include BOTH last_used_at and expires_at.
    // expires_at is a Node-computed naive local timestamp, not a DB expression:
    // CliAuthService mints with the same clock, so the slide must read it too.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        last_used_at: expect.any(Function),
        expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      }),
    );
    const setArg = mockSet.mock.calls[0][0] as { expires_at: string };
    const slid = new Date(setArg.expires_at).getTime();
    expect(slid).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(slid).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 1000);
  });

  it('rejects a key past its absolute ceiling even when the sliding window is live', async () => {
    const rawKey = 'mnfst_pat_at-ceiling';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k-ceiling',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        // Sliding window still has a day left, but the hard ceiling passed.
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        absolute_expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as { headers: Record<string, string>; ip: string; tenantContext?: unknown };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow('API key expired — run mnfst login');
    // No credential attached, no renewal written.
    expect(request.tenantContext).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('caps the sliding renewal at the absolute ceiling', async () => {
    const rawKey = 'mnfst_pat_capped';
    const ceiling = Date.now() + 2 * 86_400_000;
    mockFind.mockResolvedValueOnce([
      {
        id: 'k-cap',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        absolute_expires_at: new Date(ceiling).toISOString(),
      },
    ]);
    const ctx = makeContext({ 'x-api-key': rawKey });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const setArg = mockSet.mock.calls[0][0] as { expires_at: string };
    const renewed = new Date(setArg.expires_at).getTime();
    // 30 days of slide would overshoot; the ceiling wins.
    expect(renewed).toBeLessThanOrEqual(ceiling);
    expect(renewed).toBeGreaterThan(ceiling - 2000);
  });

  it('does not touch expires_at for non-expiring keys', async () => {
    const rawKey = 'test-api-key-001';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k3',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: null,
      },
    ]);
    const ctx = makeContext({ 'x-api-key': rawKey });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockSet).toHaveBeenCalledWith({ last_used_at: expect.any(Function) });
  });

  it('attaches the refreshed apiKeyExpiresAt to the request', async () => {
    const rawKey = 'mnfst_pat_live2';
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    mockFind.mockResolvedValueOnce([
      {
        id: 'k4',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: expiresAt,
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as { headers: Record<string, string>; ip: string; apiKeyExpiresAt?: string | null };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    // /me must report the slid deadline (ISO UTC), not the pre-refresh one.
    expect(request.apiKeyExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(request.apiKeyExpiresAt!).getTime()).toBeGreaterThan(
      new Date(expiresAt).getTime(),
    );
  });

  it('attaches a null apiKeyExpiresAt for non-expiring keys', async () => {
    const rawKey = 'never-expires-key';
    mockFind.mockResolvedValueOnce([
      {
        id: 'k5',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.substring(0, 12),
        tenant_id: 't1',
        created_by_user_id: 'u1',
        expires_at: null,
      },
    ]);
    const request = {
      headers: { 'x-api-key': rawKey },
      ip: '127.0.0.1',
    } as { headers: Record<string, string>; ip: string; apiKeyExpiresAt?: string | null };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(request.apiKeyExpiresAt).toBeNull();
  });
});
