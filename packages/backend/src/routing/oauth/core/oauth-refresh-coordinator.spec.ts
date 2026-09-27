import { Logger } from '@nestjs/common';
import {
  coordinateOAuthRefresh,
  oauthRefreshKey,
  __resetOAuthRefreshCoordinator,
  PERSIST_MAX_ATTEMPTS,
  REFRESH_EXPIRY_SKEW_MS,
  REJECTED_TOKEN_EXPIRY,
  type CoordinatedRefreshParams,
  type CredentialLockOps,
} from './oauth-refresh-coordinator';

interface TestBlob {
  t: string;
  e: number;
  r: string;
}

function fakeLogger(): Logger {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as unknown as Logger;
}

const expired = (): TestBlob => ({ t: 'old', e: Date.now() - 1_000, r: 'refresh-old' });
const valid = (t = 'fresh'): TestBlob => ({ t, e: Date.now() + 5 * 60_000, r: 'refresh-new' });

function makeParams(
  overrides: Partial<CoordinatedRefreshParams<TestBlob>> & {
    persist?: jest.Mock;
    readFreshRaw?: jest.Mock;
  } = {},
): {
  params: CoordinatedRefreshParams<TestBlob>;
  refresh: jest.Mock;
  persist: jest.Mock;
  readFreshRaw: jest.Mock;
  logger: Logger;
} {
  const logger = overrides.logger ?? fakeLogger();
  const refresh = (overrides.refresh as jest.Mock) ?? jest.fn().mockResolvedValue(valid());
  const persist = overrides.persist ?? jest.fn().mockResolvedValue(undefined);
  const readFreshRaw = overrides.readFreshRaw ?? jest.fn().mockResolvedValue(null);
  // Default withLock just runs the critical section with the mock ops — same
  // as a single-process test without a real DB lock.
  const withLock =
    overrides.withLock ??
    (<R>(fn: (ops: CredentialLockOps<TestBlob>) => Promise<R>) => fn({ readFreshRaw, persist }));
  const params: CoordinatedRefreshParams<TestBlob> = {
    key: overrides.key ?? 'openai:user-1:agent-1:Default',
    logger,
    callerBlob: overrides.callerBlob ?? expired(),
    parse: overrides.parse ?? ((raw: string) => JSON.parse(raw) as TestBlob),
    refresh,
    withLock,
  };
  return { params, refresh, persist, readFreshRaw, logger };
}

describe('oauthRefreshKey', () => {
  it('namespaces by provider/user and defaults the label', () => {
    expect(oauthRefreshKey('openai', 'u')).toBe('openai:u:Default');
  });

  it('uses an explicit label when provided', () => {
    expect(oauthRefreshKey('openai', 'u', 'Work')).toBe('openai:u:Work');
  });
});

describe('coordinateOAuthRefresh', () => {
  afterEach(() => __resetOAuthRefreshCoordinator());

  it('refreshes and persists when the credential is expired and no fresher copy exists', async () => {
    const refreshed = valid('brand-new');
    const { params, refresh, persist, readFreshRaw } = makeParams({
      refresh: jest.fn().mockResolvedValue(refreshed),
    });

    const result = await coordinateOAuthRefresh(params);

    expect(result).toBe(refreshed);
    expect(readFreshRaw).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(params.callerBlob);
    expect(persist).toHaveBeenCalledWith(refreshed);
  });

  it('returns the fresher DB copy without refreshing when it is already valid', async () => {
    const dbBlob = valid('already-refreshed');
    const { params, refresh, persist } = makeParams({
      readFreshRaw: jest.fn().mockResolvedValue(JSON.stringify(dbBlob)),
    });

    const result = await coordinateOAuthRefresh(params);

    expect(result).toEqual(dbBlob);
    expect(refresh).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('refreshes a token the provider rejected even though the DB copy has not expired yet', async () => {
    // A 401 marks the caller's token as rejected, while the DB still holds
    // that same token with a future expiry.
    const dbBlob = valid('rejected');
    const refreshed = valid('brand-new');
    const { params, refresh, persist } = makeParams({
      callerBlob: { ...dbBlob, e: REJECTED_TOKEN_EXPIRY },
      readFreshRaw: jest.fn().mockResolvedValue(JSON.stringify(dbBlob)),
      refresh: jest.fn().mockResolvedValue(refreshed),
    });

    const result = await coordinateOAuthRefresh(params);

    expect(result).toBe(refreshed);
    expect(refresh).toHaveBeenCalledWith(dbBlob);
    expect(persist).toHaveBeenCalledWith(refreshed);
  });

  it('reuses a valid DB copy that kept the same token when the caller only saw it expire', async () => {
    // Some providers reissue the same access token with a new expiry; a caller
    // holding the old expiry must not trigger a second refresh.
    const dbBlob = valid('reissued');
    const { params, refresh } = makeParams({
      callerBlob: { ...dbBlob, e: Date.now() - 1_000 },
      readFreshRaw: jest.fn().mockResolvedValue(JSON.stringify(dbBlob)),
    });

    await expect(coordinateOAuthRefresh(params)).resolves.toEqual(dbBlob);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes using the fresher DB refresh token when the DB copy is also expired', async () => {
    const dbBlob: TestBlob = { t: 'db', e: Date.now() - 500, r: 'refresh-from-db' };
    const refreshed = valid('rotated');
    const refresh = jest.fn().mockResolvedValue(refreshed);
    const { params } = makeParams({
      readFreshRaw: jest.fn().mockResolvedValue(JSON.stringify(dbBlob)),
      refresh,
    });

    const result = await coordinateOAuthRefresh(params);

    expect(result).toBe(refreshed);
    expect(refresh).toHaveBeenCalledWith(dbBlob);
  });

  it('falls back to the caller blob when the fresh DB value cannot be parsed', async () => {
    const refresh = jest.fn().mockResolvedValue(valid('rotated'));
    const { params } = makeParams({
      readFreshRaw: jest.fn().mockResolvedValue('not-json'),
      parse: () => null,
      refresh,
    });

    await coordinateOAuthRefresh(params);

    expect(refresh).toHaveBeenCalledWith(params.callerBlob);
  });

  it('coalesces concurrent refreshes for the same key into a single round-trip', async () => {
    let resolveRefresh!: (b: TestBlob) => void;
    const refreshed = valid('shared');
    const refresh = jest.fn().mockReturnValue(
      new Promise<TestBlob>((res) => {
        resolveRefresh = res;
      }),
    );
    const { params, persist, readFreshRaw } = makeParams({ refresh });

    const p1 = coordinateOAuthRefresh(params);
    const p2 = coordinateOAuthRefresh(params);
    resolveRefresh(refreshed);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(refreshed);
    expect(r2).toBe(refreshed);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(readFreshRaw).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('runs a new refresh once the previous in-flight one has settled', async () => {
    const { params, refresh } = makeParams();
    await coordinateOAuthRefresh(params);
    await coordinateOAuthRefresh(params);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('retries persistence and succeeds after transient failures', async () => {
    const persist = jest
      .fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(undefined);
    const refreshed = valid('rotated');
    const { params, logger } = makeParams({
      refresh: jest.fn().mockResolvedValue(refreshed),
      persist,
    });

    const result = await coordinateOAuthRefresh(params);

    expect(result).toBe(refreshed);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting persistence retries', async () => {
    const err = new Error('db down');
    const persist = jest.fn().mockRejectedValue(err);
    const { params, logger } = makeParams({ persist });

    await expect(coordinateOAuthRefresh(params)).rejects.toBe(err);
    expect(persist).toHaveBeenCalledTimes(PERSIST_MAX_ATTEMPTS);
    expect(logger.warn).toHaveBeenCalledTimes(PERSIST_MAX_ATTEMPTS);
  });

  it('refreshes a credential whose expiry is inside the early-refresh skew window', async () => {
    const nearExpiry: TestBlob = {
      t: 'soon',
      e: Date.now() + REFRESH_EXPIRY_SKEW_MS - 1_000,
      r: 'r',
    };
    const refresh = jest.fn().mockResolvedValue(valid('rotated'));
    const { params } = makeParams({ callerBlob: nearExpiry, refresh });

    await coordinateOAuthRefresh(params);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('runs the critical section inside withLock', async () => {
    const order: string[] = [];
    const withLock: CoordinatedRefreshParams<TestBlob>['withLock'] = async (fn) => {
      order.push('lock');
      const result = await fn({
        readFreshRaw: async () => {
          order.push('read');
          return null;
        },
        persist: async () => {
          order.push('persist');
        },
      });
      order.push('unlock');
      return result;
    };
    const refresh = jest.fn(async () => {
      order.push('refresh');
      return valid('x');
    });
    const { params } = makeParams({ withLock, refresh });

    await coordinateOAuthRefresh(params);

    expect(order).toEqual(['lock', 'read', 'refresh', 'persist', 'unlock']);
  });
});
