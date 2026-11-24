import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AgentKeyAuthGuard } from './agent-key-auth.guard';
import { hashKey } from '../../common/utils/hash.util';

function testCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function makeContext(headers: Record<string, string | undefined>, ip = '203.0.113.1') {
  // The guard reads request.socket.remoteAddress for its loopback decision
  // (request.ip is spoofable via X-Forwarded-For when trust proxy is set).
  // Mirror the test's `ip` onto the socket so existing scenarios still hold.
  const request: Record<string, unknown> = { headers, ip, socket: { remoteAddress: ip } };
  return {
    req: request,
    ctx: {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext,
  };
}

function createMockConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    'app.nodeEnv': 'test',
    ...overrides,
  };
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('AgentKeyAuthGuard', () => {
  let guard: AgentKeyAuthGuard;
  let mockGetMany: jest.Mock;
  let mockCreateQueryBuilder: jest.Mock;
  let mockExecute: jest.Mock;
  let mockFindOne: jest.Mock;
  let mockExistsBy: jest.Mock;
  let mockConfig: ConfigService;

  function buildMockRepo() {
    mockGetMany = jest.fn().mockResolvedValue([]);
    const mockSelectQb = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getMany: mockGetMany,
      // resolveDevContext seeds-tenant lookup; default to no row so it falls
      // back to repo.findOne — preserves existing test scenarios.
      getOne: jest.fn().mockResolvedValue(null),
    };
    mockExecute = jest.fn().mockResolvedValue({});
    const mockUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockImplementation((setObj) => {
        if (setObj) {
          for (const val of Object.values(setObj)) {
            if (typeof val === 'function') (val as () => unknown)();
          }
        }
        return mockUpdateQb;
      }),
      where: jest.fn().mockReturnThis(),
      execute: mockExecute,
    };
    mockCreateQueryBuilder = jest.fn().mockImplementation((alias?: string) => {
      return alias ? mockSelectQb : mockUpdateQb;
    });
    mockFindOne = jest.fn().mockResolvedValue(null);
    mockExistsBy = jest.fn().mockResolvedValue(true);
    return {
      createQueryBuilder: mockCreateQueryBuilder,
      findOne: mockFindOne,
      existsBy: mockExistsBy,
    } as never;
  }

  function createGuard(configOverrides: Record<string, string> = {}) {
    mockConfig = createMockConfig(configOverrides);
    const repo = buildMockRepo();
    const g = new AgentKeyAuthGuard(repo, mockConfig);
    g.clearCache();
    return g;
  }

  beforeEach(() => {
    guard = createGuard();
  });

  afterEach(() => {
    guard.onModuleDestroy();
  });

  describe('onModuleInit legacy-hash audit', () => {
    const makeAuditRepo = (getCount: jest.Mock) =>
      ({
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount,
        })),
      }) as never;

    it('warns when legacy static-salt keys are still active', async () => {
      const g = new AgentKeyAuthGuard(
        makeAuditRepo(jest.fn().mockResolvedValue(3)),
        createMockConfig(),
      );
      const logger = (g as unknown as { logger: { warn: jest.Mock } }).logger;
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await g.onModuleInit();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('legacy static-salt'));
      g.onModuleDestroy();
    });

    it('swallows audit query failures with a debug log', async () => {
      const g = new AgentKeyAuthGuard(
        makeAuditRepo(jest.fn().mockRejectedValue(new Error('no table'))),
        createMockConfig(),
      );
      const logger = (g as unknown as { logger: { debug: jest.Mock } }).logger;
      const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      await g.onModuleInit();
      expect(debugSpy).toHaveBeenCalled();
      g.onModuleDestroy();
    });
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const { ctx } = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Authorization header required');
  });

  it('throws UnauthorizedException when token is empty (Bearer with no value)', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer ' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Empty token');
  });

  it('rejects token without mnfst_ prefix', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer osk_some_old_key' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    expect(mockCreateQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects mnfst_ token shorter than minimum length', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer mnfst_ab' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    expect(mockCreateQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects bare mnfst_ prefix with no suffix', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer mnfst_' });
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    expect(mockCreateQueryBuilder).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when API key is not found in DB', async () => {
    mockGetMany.mockResolvedValue([]);
    const { ctx } = makeContext({ authorization: 'Bearer mnfst_unknown-key' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');
  });

  it('returns true and attaches ingestionContext when key is valid', async () => {
    const token = 'mnfst_valid-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-1',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx, req } = makeContext({ authorization: `Bearer ${token}` });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.ingestionContext).toEqual({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentName: 'test-agent',
      userId: 'user-1',
    });
  });

  it('returns true when raw token (no Bearer prefix) matches', async () => {
    const token = 'mnfst_raw-key-test';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-2',
        tenant_id: 'tenant-2',
        agent_id: 'agent-2',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent-2' },
        tenant: { owner_user_id: 'user-2' },
      },
    ]);

    const { ctx, req } = makeContext({ authorization: token });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.ingestionContext).toEqual({
      tenantId: 'tenant-2',
      agentId: 'agent-2',
      agentName: 'test-agent-2',
      userId: 'user-2',
    });
  });

  it('throws UnauthorizedException when API key is expired', async () => {
    const token = 'mnfst_expired-key-test';
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    mockGetMany.mockResolvedValue([
      {
        id: 'key-3',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: pastDate,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('API key expired');
  });

  it('uses cached context after verifying that the key row is still active', async () => {
    const token = 'mnfst_cached-key-test';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-4',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx: ctx1 } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx1);

    expect(mockGetMany).toHaveBeenCalledTimes(1);

    mockCreateQueryBuilder.mockClear();
    mockGetMany.mockClear();
    mockCreateQueryBuilder.mockClear();

    const { ctx: ctx2 } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx2);

    expect(mockCreateQueryBuilder).not.toHaveBeenCalled();
    expect(mockExistsBy).toHaveBeenCalledWith({ id: 'key-4', is_active: true });
  });

  it('rejects a cached key deactivated by another replica', async () => {
    const token = 'mnfst_cross-replica-revocation';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-revoked',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx: first } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(first)).resolves.toBe(true);

    mockExistsBy.mockResolvedValue(false);
    const { ctx: afterRevocation } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(afterRevocation)).rejects.toThrow('Invalid API key');

    const internalCache = (AgentKeyAuthGuard as unknown as { cache: Map<string, unknown> }).cache;
    expect(internalCache.has(testCacheKey(token))).toBe(false);
  });

  it('fails closed when the cached-key activity recheck cannot reach the database', async () => {
    const token = 'mnfst_cached-key-db-error';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-db-error',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx: first } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(first)).resolves.toBe(true);

    mockExistsBy.mockRejectedValueOnce(new Error('database unavailable'));
    const { ctx: duringOutage } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(duringOutage)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(duringOutage)).resolves.toBe(true);

    expect(mockGetMany).toHaveBeenCalledTimes(1);
    expect(mockExistsBy).toHaveBeenCalledTimes(2);
  });

  it('stops authenticating from cache once the key own expiry passes within the cache TTL', async () => {
    // A key that expires (or is set to expire) while still cached must not keep
    // authenticating until the 5-min cache TTL lapses. The fast path reads the
    // key's own expires_at, not just the cache entry's TTL.
    const token = 'mnfst_soon-expiring-key';
    const keyHash = hashKey(token);
    mockGetMany.mockResolvedValue([
      {
        id: 'key-exp',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: keyHash,
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    // First call caches the key (DB lookup happens).
    const { ctx: ctx1 } = makeContext({ authorization: `Bearer ${token}` });
    expect(await guard.canActivate(ctx1)).toBe(true);
    expect(mockGetMany).toHaveBeenCalledTimes(1);

    // Simulate the key being set to expire in the past while still cached: its
    // cache entry TTL is well in the future, but keyExpiresAt is now stale.
    const internalCache = (
      AgentKeyAuthGuard as unknown as { cache: Map<string, { keyExpiresAt: number }> }
    ).cache;
    const entry = internalCache.get(testCacheKey(token))!;
    expect(entry).toBeDefined();
    entry.keyExpiresAt = Date.now() - 1000;

    // The DB now reports the key as expired — the fast path must drop the stale
    // entry and fall through to the DB re-check, which rejects.
    mockGetMany.mockResolvedValue([
      {
        id: 'key-exp',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: keyHash,
        expires_at: new Date(Date.now() - 1000).toISOString(),
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx: ctx2 } = makeContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(ctx2)).rejects.toThrow('API key expired');
    // The cache entry was discarded rather than honored, so a DB re-check ran.
    expect(internalCache.has(testCacheKey(token))).toBe(false);
  });

  it('stores the key own expires_at on the cached entry for non-expiring keys', async () => {
    const token = 'mnfst_no-expiry-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-noexp',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx);

    const internalCache = (
      AgentKeyAuthGuard as unknown as { cache: Map<string, { keyExpiresAt: number | null }> }
    ).cache;
    const entry = internalCache.get(testCacheKey(token));
    expect(entry).toBeDefined();
    // A null DB expiry stays null on the cache entry (key never expires).
    expect(entry!.keyExpiresAt).toBeNull();
  });

  it('requires auth for loopback IPs in non-development mode', async () => {
    const { ctx } = makeContext({}, '127.0.0.1');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  describe('dev loopback bypass in development mode', () => {
    beforeEach(() => {
      guard.onModuleDestroy();
      guard = createGuard({ 'app.nodeEnv': 'development' });
    });

    it('allows loopback with non-mnfst token in dev mode by resolving first active key', async () => {
      mockFindOne.mockResolvedValue({
        tenant_id: 'dev-tenant',
        agent_id: 'dev-agent',
        agent: { name: 'demo-agent' },
        tenant: { owner_user_id: 'dev-user' },
      });
      const { ctx, req } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(req.ingestionContext).toEqual({
        tenantId: 'dev-tenant',
        agentId: 'dev-agent',
        agentName: 'demo-agent',
        userId: 'dev-user',
      });
      expect(mockFindOne).toHaveBeenCalledWith({
        where: { is_active: true },
        relations: ['agent', 'tenant'],
      });
    });

    it('allows loopback without auth header in dev mode', async () => {
      mockFindOne.mockResolvedValue({
        tenant_id: 'dev-tenant',
        agent_id: 'dev-agent',
        agent: { name: 'demo-agent' },
        tenant: { owner_user_id: 'dev-user' },
      });
      const { ctx, req } = makeContext({}, '127.0.0.1');
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(req.ingestionContext).toEqual({
        tenantId: 'dev-tenant',
        agentId: 'dev-agent',
        agentName: 'demo-agent',
        userId: 'dev-user',
      });
    });

    it('rejects loopback without auth when no active keys exist in DB', async () => {
      mockFindOne.mockResolvedValue(null);
      const { ctx } = makeContext({}, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Authorization header required');
    });

    it('rejects non-mnfst token when no active keys exist in DB', async () => {
      mockFindOne.mockResolvedValue(null);
      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    });

    it('rejects non-mnfst token from non-loopback IP in dev mode', async () => {
      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '192.168.1.100');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    });

    it('rejects loopback with non-mnfst token in production mode', async () => {
      guard.onModuleDestroy();
      guard = createGuard({ 'app.nodeEnv': 'production' });
      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    });

    it('rejects loopback with non-mnfst token in test mode', async () => {
      guard.onModuleDestroy();
      guard = createGuard({ 'app.nodeEnv': 'test' });
      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key format');
    });

    it('caches dev context and reuses it on subsequent calls', async () => {
      mockFindOne.mockResolvedValue({
        tenant_id: 'dev-tenant',
        agent_id: 'dev-agent',
        agent: { name: 'demo-agent' },
        tenant: { owner_user_id: 'dev-user' },
      });

      const { ctx: ctx1 } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await guard.canActivate(ctx1);
      expect(mockFindOne).toHaveBeenCalledTimes(1);

      mockFindOne.mockClear();
      const { ctx: ctx2 } = makeContext({ authorization: 'Bearer dev-no-auth' }, '::1');
      await guard.canActivate(ctx2);
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  it('handles request.ip being undefined without crashing', async () => {
    const request: Record<string, unknown> = { headers: {}, ip: undefined, socket: {} };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('does not throw when last_used_at update fails', async () => {
    const token = 'mnfst_update-fail-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-5',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);
    mockExecute.mockRejectedValueOnce(new Error('DB write error'));

    const { ctx, req } = makeContext({ authorization: `Bearer ${token}` });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.ingestionContext).toBeDefined();
    expect(mockExecute).toHaveBeenCalled();
  });

  it('evicts the first cache entry when cache reaches MAX_CACHE_SIZE', async () => {
    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;

    const firstFillerHash = testCacheKey('mnfst_filler-0');
    for (let i = 0; i < 10_000; i++) {
      internalCache.set(testCacheKey(`mnfst_filler-${i}`), {
        tenantId: 't',
        agentId: 'a',
        agentName: 'n',
        userId: 'u',
        expiresAt: Date.now() + 999_999,
      });
    }
    expect(internalCache.size).toBe(10_000);

    const token = 'mnfst_overflow-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-max',
        tenant_id: 'tenant-max',
        agent_id: 'agent-max',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent-max' },
        tenant: { owner_user_id: 'user-max' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(internalCache.has(firstFillerHash)).toBe(false);
    expect(internalCache.has(testCacheKey(token))).toBe(true);
  });

  it('evictExpired removes entries whose expiresAt has passed', async () => {
    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;

    const expiredHash = testCacheKey('mnfst_expired-cache');
    const validHash = testCacheKey('mnfst_valid-cache');
    internalCache.set(expiredHash, {
      tenantId: 't',
      agentId: 'a',
      agentName: 'n',
      userId: 'u',
      expiresAt: Date.now() - 1000,
    });
    internalCache.set(validHash, {
      tenantId: 't2',
      agentId: 'a2',
      agentName: 'n2',
      userId: 'u2',
      expiresAt: Date.now() + 999_999,
    });

    expect(internalCache.size).toBe(2);

    const evictToken = 'mnfst_trigger-evict-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-evict',
        tenant_id: 'tenant-evict',
        agent_id: 'agent-evict',
        key_hash: hashKey(evictToken),
        expires_at: null,
        agent: { name: 'test-agent-evict' },
        tenant: { owner_user_id: 'user-evict' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${evictToken}` });
    await guard.canActivate(ctx);

    expect(internalCache.has(expiredHash)).toBe(false);
    expect(internalCache.has(validHash)).toBe(true);
    expect(internalCache.has(testCacheKey(evictToken))).toBe(true);
  });

  it('periodic timer fires evictExpired', () => {
    jest.useFakeTimers();

    const repo = buildMockRepo();
    const timedGuard = new AgentKeyAuthGuard(repo, createMockConfig());

    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;
    internalCache.set(testCacheKey('mnfst_stale'), {
      tenantId: 't',
      agentId: 'a',
      agentName: 'n',
      userId: 'u',
      expiresAt: Date.now() - 1000,
    });

    expect(internalCache.size).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(internalCache.size).toBe(0);

    timedGuard.onModuleDestroy();
    jest.useRealTimers();
  });

  it('onModuleDestroy stops the periodic cleanup timer', () => {
    jest.useFakeTimers();

    const repo = buildMockRepo();
    const timedGuard = new AgentKeyAuthGuard(repo, createMockConfig());

    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;
    timedGuard.onModuleDestroy();

    internalCache.set(testCacheKey('mnfst_leftover'), {
      tenantId: 't',
      agentId: 'a',
      agentName: 'n',
      userId: 'u',
      expiresAt: Date.now() - 1000,
    });

    jest.advanceTimersByTime(120_000);
    expect(internalCache.size).toBe(1);

    jest.useRealTimers();
  });

  it('onModuleDestroy clears the static caches so they cannot leak between contexts', () => {
    const destroyedGuard = new AgentKeyAuthGuard(buildMockRepo(), createMockConfig());
    const internalCache = (AgentKeyAuthGuard as unknown as { cache: Map<string, unknown> }).cache;
    const negativeCache = (AgentKeyAuthGuard as unknown as { negativeCache: Map<string, number> })
      .negativeCache;
    internalCache.set(testCacheKey('mnfst_survivor'), {
      tenantId: 't',
      agentId: 'a',
      agentName: 'n',
      userId: 'u',
      expiresAt: Date.now() + 60_000,
      keyExpiresAt: null,
    });
    negativeCache.set(testCacheKey('mnfst_rejected'), Date.now() + 60_000);

    destroyedGuard.onModuleDestroy();

    expect(internalCache.size).toBe(0);
    expect(negativeCache.size).toBe(0);
  });

  it('does not store plaintext tokens in cache', async () => {
    const token = 'mnfst_plaintext-check-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-pt',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx);

    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;
    expect(internalCache.has(token)).toBe(false);
    expect(internalCache.has(testCacheKey(token))).toBe(true);
  });

  it('caches entries for the configured 5 minute TTL', async () => {
    const token = 'mnfst_ttl-check-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-ttl',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const before = Date.now();
    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx);

    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, { expiresAt: number }>;
    const entry = internalCache.get(testCacheKey(token));
    expect(entry).toBeDefined();
    const ttlMs = entry!.expiresAt - before;
    expect(ttlMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(ttlMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('LRU touch on cache hit moves entry to tail of insertion order', async () => {
    const token = 'mnfst_lru-touch-key';
    mockGetMany.mockResolvedValue([
      {
        id: 'key-lru',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: hashKey(token),
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx);

    const internalCache = (AgentKeyAuthGuard as any).cache as Map<string, unknown>;
    internalCache.set(testCacheKey('mnfst_other-1'), {
      tenantId: 't',
      agentId: 'a',
      agentName: 'n',
      userId: 'u',
      expiresAt: Date.now() + 999_999,
    });

    expect(Array.from(internalCache.keys())[0]).toBe(testCacheKey(token));

    const { ctx: ctx2 } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx2);

    expect(Array.from(internalCache.keys())[1]).toBe(testCacheKey(token));
  });

  it('invalidateCache removes a specific key from cache', async () => {
    const token = 'mnfst_inv-key-test';
    const storedHash = hashKey(token);
    mockGetMany.mockResolvedValue([
      {
        id: 'key-inv',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: storedHash,
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const { ctx } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx);

    guard.invalidateCache(token);
    mockCreateQueryBuilder.mockClear();
    mockGetMany.mockClear();

    mockGetMany.mockResolvedValue([
      {
        id: 'key-inv',
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        key_hash: storedHash,
        expires_at: null,
        agent: { name: 'test-agent' },
        tenant: { owner_user_id: 'user-1' },
      },
    ]);

    const mockSelectQb2 = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: mockGetMany,
    };
    const mockUpdateQb2 = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    mockCreateQueryBuilder.mockImplementation((alias?: string) => {
      return alias ? mockSelectQb2 : mockUpdateQb2;
    });

    const { ctx: ctx2 } = makeContext({ authorization: `Bearer ${token}` });
    await guard.canActivate(ctx2);

    expect(mockGetMany).toHaveBeenCalledTimes(1);
  });

  describe('negative cache (rejected-key storm protection)', () => {
    const negativeCacheOf = (_g: AgentKeyAuthGuard) =>
      (AgentKeyAuthGuard as unknown as { negativeCache: Map<string, number> }).negativeCache;

    it('serves a repeated bad key from the negative cache without a second DB lookup or log', async () => {
      mockGetMany.mockResolvedValue([]); // unknown key — DB returns no candidates
      const logger = (guard as unknown as { logger: { warn: jest.Mock } }).logger;
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const { ctx: ctx1 } = makeContext({ authorization: 'Bearer mnfst_bad-key-storm' });
      await expect(guard.canActivate(ctx1)).rejects.toThrow('Invalid API key');
      // First miss pays the DB lookup and logs once.
      expect(mockGetMany).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      mockCreateQueryBuilder.mockClear();
      mockGetMany.mockClear();
      warnSpy.mockClear();

      const { ctx: ctx2 } = makeContext({ authorization: 'Bearer mnfst_bad-key-storm' });
      await expect(guard.canActivate(ctx2)).rejects.toThrow('Invalid API key');
      // The repeat is served from the negative cache: no DB query, no log line.
      expect(mockCreateQueryBuilder).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('records a rejected unknown key (hashed, not plaintext) for the configured TTL', async () => {
      const token = 'mnfst_record-bad-key';
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');

      const negCache = negativeCacheOf(guard);
      expect(negCache.has(testCacheKey(token))).toBe(true);
      // Stored under the hash, never the raw token.
      expect(negCache.has(token)).toBe(false);
      const ttl = negCache.get(testCacheKey(token))! - Date.now();
      expect(ttl).toBeGreaterThan(30 * 1000 - 2000);
      expect(ttl).toBeLessThanOrEqual(30 * 1000 + 100);
    });

    it('LRU-touches a negative entry on a cache hit (moves it to the tail)', async () => {
      const { ctx } = makeContext({ authorization: 'Bearer mnfst_neg-lru-key' });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');

      const negCache = negativeCacheOf(guard);
      negCache.set(testCacheKey('mnfst_neg-other'), Date.now() + 999_999);
      expect(Array.from(negCache.keys())[0]).toBe(testCacheKey('mnfst_neg-lru-key'));

      const { ctx: ctx2 } = makeContext({ authorization: 'Bearer mnfst_neg-lru-key' });
      await expect(guard.canActivate(ctx2)).rejects.toThrow('Invalid API key');
      // After the touch the rejected key sits behind the other entry.
      expect(Array.from(negCache.keys())[1]).toBe(testCacheKey('mnfst_neg-lru-key'));
    });

    it('drops a stale negative entry and re-checks the DB so a since-created key works', async () => {
      const token = 'mnfst_was-bad-now-good';
      const negCache = negativeCacheOf(guard);
      // An already-expired negative entry from an earlier rejection.
      negCache.set(testCacheKey(token), Date.now() - 1000);

      // The key now exists in the DB (created after that rejection).
      mockGetMany.mockResolvedValue([
        {
          id: 'key-revived',
          tenant_id: 'tenant-1',
          agent_id: 'agent-1',
          key_hash: hashKey(token),
          expires_at: null,
          agent: { name: 'test-agent' },
          tenant: { owner_user_id: 'user-1' },
        },
      ]);

      const { ctx, req } = makeContext({ authorization: `Bearer ${token}` });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(req.ingestionContext).toBeDefined();
      expect(negCache.has(testCacheKey(token))).toBe(false);
    });

    it('evicts the oldest negative entry when the negative cache is full', async () => {
      const negCache = negativeCacheOf(guard);
      const firstHash = testCacheKey('mnfst_neg-filler-0');
      for (let i = 0; i < 10_000; i++) {
        negCache.set(testCacheKey(`mnfst_neg-filler-${i}`), Date.now() + 999_999);
      }
      expect(negCache.size).toBe(10_000);

      const token = 'mnfst_neg-overflow-key';
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');

      expect(negCache.has(firstHash)).toBe(false);
      expect(negCache.has(testCacheKey(token))).toBe(true);
      expect(negCache.size).toBeLessThanOrEqual(10_000);
    });

    it('evictExpired also sweeps expired negative-cache entries but keeps live ones', async () => {
      const negCache = negativeCacheOf(guard);
      const expiredHash = testCacheKey('mnfst_neg-expired');
      const liveHash = testCacheKey('mnfst_neg-live');
      negCache.set(expiredHash, Date.now() - 1000);
      negCache.set(liveHash, Date.now() + 999_999);

      // A successful validation runs evictExpired() before caching, which now
      // sweeps the negative cache too.
      const token = 'mnfst_valid-triggers-evict';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-ev',
          tenant_id: 'tenant-1',
          agent_id: 'agent-1',
          key_hash: hashKey(token),
          expires_at: null,
          agent: { name: 'test-agent' },
          tenant: { owner_user_id: 'user-1' },
        },
      ]);
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await guard.canActivate(ctx);

      expect(negCache.has(expiredHash)).toBe(false);
      expect(negCache.has(liveHash)).toBe(true);
    });

    it('invalidateCache removes the negative entry so a re-created key is not stuck', async () => {
      const token = 'mnfst_inv-neg-key';
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');

      const negCache = negativeCacheOf(guard);
      expect(negCache.has(testCacheKey(token))).toBe(true);

      guard.invalidateCache(token);
      expect(negCache.has(testCacheKey(token))).toBe(false);
    });

    it('invalidation reaches every guard instance (proxy vs otlp enhancer split)', async () => {
      // Nest instantiates class-referenced @UseGuards enhancers per host
      // module, so rotate-key clears a DIFFERENT guard instance than the one
      // authenticating proxy traffic. The caches are static so a clear issued
      // through ANY instance revokes the warm entry every instance sees.
      const token = 'mnfst_cross-instance-key';
      const firstGetMany = mockGetMany;
      firstGetMany.mockResolvedValue([
        {
          id: 'key-x',
          tenant_id: 'tenant-x',
          agent_id: 'agent-x',
          key_hash: hashKey(token),
          expires_at: null,
          agent: { name: 'x' },
          tenant: { owner_user_id: 'user-x' },
        },
      ]);
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).resolves.toBe(true); // warms the shared cache

      const rotatePathInstance = new AgentKeyAuthGuard(buildMockRepo(), createMockConfig()); // a different instance, as in production
      firstGetMany.mockResolvedValue([]); // rotation deleted the row
      rotatePathInstance.invalidateCache(token); // rotate clears via the OTHER instance

      const { ctx: ctx2 } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx2)).rejects.toThrow('Invalid API key');
      rotatePathInstance.onModuleDestroy();
    });

    it('clearCache empties the negative cache', async () => {
      const token = 'mnfst_clear-neg-key';
      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid API key');

      const negCache = negativeCacheOf(guard);
      expect(negCache.size).toBe(1);

      guard.clearCache();
      expect(negCache.size).toBe(0);
    });
  });
});
