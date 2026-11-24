import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentKeyAuthGuard } from './agent-key-auth.guard';
import { hashKey } from '../../common/utils/hash.util';

// Edge-case coverage for AgentKeyAuthGuard that does not fit into the main
// spec file (which is already at the per-file size cap from CLAUDE.md). The
// primary spec is `agent-key-auth.guard.spec.ts`. These tests document
// behavior at the boundary of missing relations and DB failures during the
// dev-loopback seed-tenant lookup.

function makeContext(headers: Record<string, string | undefined>, ip = '203.0.113.1') {
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

describe('AgentKeyAuthGuard edge cases', () => {
  let guard: AgentKeyAuthGuard;
  let mockGetMany: jest.Mock;
  let mockGetOne: jest.Mock;
  let mockCreateQueryBuilder: jest.Mock;
  let mockExecute: jest.Mock;
  let mockFindOne: jest.Mock;
  let mockConfig: ConfigService;

  function buildMockRepo() {
    mockGetMany = jest.fn().mockResolvedValue([]);
    mockGetOne = jest.fn().mockResolvedValue(null);
    const mockSelectQb = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getMany: mockGetMany,
      getOne: mockGetOne,
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
    return {
      createQueryBuilder: mockCreateQueryBuilder,
      findOne: mockFindOne,
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

  describe('validateMnfstToken with broken relations', () => {
    // The candidate query left-joins agent + tenant. If either relation fails
    // to hydrate (race during a delete, foreign-key drift, missing JOIN
    // result), the guard now rejects with a clean UnauthorizedException (401)
    // instead of dereferencing null and surfacing a TypeError as a 500. These
    // tests pin that hardened behavior.
    it('rejects with 401 when keyRecord.agent is null', async () => {
      const token = 'mnfst_missing-agent-key';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-no-agent',
          tenant_id: 'tenant-1',
          agent_id: 'agent-orphan',
          key_hash: hashKey(token),
          expires_at: null,
          agent: null,
          tenant: { owner_user_id: 'user-1' },
        },
      ]);

      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects with 401 when keyRecord.tenant is null', async () => {
      const token = 'mnfst_missing-tenant-key';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-no-tenant',
          tenant_id: 'tenant-orphan',
          agent_id: 'agent-1',
          key_hash: hashKey(token),
          expires_at: null,
          agent: { name: 'orphan-agent' },
          tenant: null,
        },
      ]);

      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects with 401 when both keyRecord.agent and keyRecord.tenant are null', async () => {
      const token = 'mnfst_both-null-key';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-both-null',
          tenant_id: 'tenant-orphan',
          agent_id: 'agent-orphan',
          key_hash: hashKey(token),
          expires_at: null,
          agent: null,
          tenant: null,
        },
      ]);

      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('remembers the rejection so an identical retry is served from the negative cache', async () => {
      const token = 'mnfst_orphan-retry-key';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-orphan-retry',
          tenant_id: 'tenant-1',
          agent_id: 'agent-orphan',
          key_hash: hashKey(token),
          expires_at: null,
          agent: null,
          tenant: { owner_user_id: 'user-1' },
        },
      ]);

      const first = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(first.ctx)).rejects.toThrow(UnauthorizedException);
      const second = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(second.ctx)).rejects.toThrow(UnauthorizedException);

      // The unhydrated-relation path calls rememberInvalid(), so the second
      // attempt short-circuits on the negative cache without a second DB hit.
      expect(mockGetMany).toHaveBeenCalledTimes(1);
    });

    it('does not cache a positive entry when agent is null (rejects before cache.set)', async () => {
      const token = 'mnfst_no-cache-on-fail-key';
      mockGetMany.mockResolvedValue([
        {
          id: 'key-uncached',
          tenant_id: 'tenant-1',
          agent_id: 'agent-1',
          key_hash: hashKey(token),
          expires_at: null,
          agent: null,
          tenant: { owner_user_id: 'user-1' },
        },
      ]);

      const { ctx } = makeContext({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      // The guard rejects on the null relation before reaching cache.set, so
      // no positive entry lands in the cache — a poisoned entry can never be
      // served on a later request.
      const internalCache = (AgentKeyAuthGuard as unknown as { cache: Map<string, unknown> }).cache;
      expect(internalCache.size).toBe(0);
    });
  });

  describe('dev loopback seed-tenant lookup failure', () => {
    beforeEach(() => {
      guard.onModuleDestroy();
      guard = createGuard({ 'app.nodeEnv': 'development' });
    });

    // The seed-tenant lookup at lines 229-235 of the source has no try/catch.
    // If the DB connection drops or the query rejects, the rejection
    // propagates up through resolveDevContext -> handleDevLoopback ->
    // canActivate. The current fallback (`seedKey ?? findOne(...)`) only
    // covers the case where getOne() resolves to null — it does NOT cover
    // a rejected promise. This test pins that propagation so a future fix
    // (e.g. wrapping getOne in try/catch and falling back to findOne) has a
    // failing assertion to flip.
    it('propagates the error when seed-tenant getOne() rejects (no fallback today)', async () => {
      const dbError = new Error('Connection lost');
      mockGetOne.mockRejectedValue(dbError);
      mockFindOne.mockResolvedValue({
        tenant_id: 'dev-tenant',
        agent_id: 'dev-agent',
        agent: { name: 'demo-agent' },
        tenant: { owner_user_id: 'dev-user' },
      });

      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Connection lost');

      // The findOne fallback is never reached because getOne rejected first.
      // If a future patch adds try/catch around getOne and falls through to
      // findOne, this assertion will fail loudly and force the test author
      // to update both this expectation and the one above.
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('does not poison the devContext cache when seed-tenant getOne() rejects', async () => {
      mockGetOne.mockRejectedValue(new Error('Connection lost'));

      const { ctx } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      await expect(guard.canActivate(ctx)).rejects.toThrow('Connection lost');

      // devContext must remain unset so a subsequent successful call resolves
      // fresh. A poisoned cache would short-circuit future requests.
      const devContext = (
        guard as unknown as { devContext: { context: unknown; expiresAt: number } | null }
      ).devContext;
      expect(devContext).toBeNull();
    });

    it('falls back to findOne when seed-tenant getOne() resolves to null', async () => {
      // This covers the documented happy path of the `seedKey ?? findOne(...)`
      // fallback at line 237-242 — getOne returns null (seed tenant doesn't
      // exist in this DB), so the guard uses the first active key from
      // findOne. Pinned here because the rejection test above is the
      // pathological sibling — both branches need explicit assertions.
      mockGetOne.mockResolvedValue(null);
      mockFindOne.mockResolvedValue({
        tenant_id: 'first-tenant',
        agent_id: 'first-agent',
        agent: { name: 'first-agent-name' },
        tenant: { owner_user_id: 'first-user' },
      });

      const { ctx, req } = makeContext({ authorization: 'Bearer dev-no-auth' }, '127.0.0.1');
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(req.ingestionContext).toEqual({
        tenantId: 'first-tenant',
        agentId: 'first-agent',
        agentName: 'first-agent-name',
        userId: 'first-user',
      });
      expect(mockGetOne).toHaveBeenCalledTimes(1);
      expect(mockFindOne).toHaveBeenCalledTimes(1);
    });
  });
});
