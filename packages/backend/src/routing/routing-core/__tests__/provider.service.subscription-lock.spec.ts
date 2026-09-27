// withSubscriptionCredentialLock holds a SELECT … FOR UPDATE on the subscription
// row while the provider OAuth refresh runs, then persists the rotated blob.
// These tests pin the invariants that keep that safe: the critical section is
// bounded (SET LOCAL), the label is trimmed+lowercased so it matches the stored
// row, the write goes through a SAVEPOINT (so a transient failure can be
// retried under the still-held lock), and the routing cache is invalidated only
// AFTER commit.
import { ProviderService } from '../provider.service';
import { TenantProvider } from '../../../entities/tenant-provider.entity';
import { TierAssignment } from '../../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import { Agent } from '../../../entities/agent.entity';
import { HeaderTier } from '../../../entities/header-tier.entity';
import { AgentEnabledProvider } from '../../../entities/agent-enabled-provider.entity';
import type { Repository } from 'typeorm';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { decrypt, encrypt, getEncryptionSecret } from '../../../common/utils/crypto.util';

interface LockRow {
  id: string;
  api_key_encrypted: string | null;
  key_prefix?: string;
  updated_at?: string;
}

function makeHarness(row: LockRow | null) {
  const andWhereCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lockQb: any = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string, params?: Record<string, unknown>) => {
      andWhereCalls.push([clause, params]);
      return lockQb;
    }),
    getOne: jest.fn().mockResolvedValue(row),
  };
  const lockRepo = { createQueryBuilder: jest.fn().mockReturnValue(lockQb) };

  const subUpdate = jest.fn().mockResolvedValue(undefined);
  const subManager = { getRepository: jest.fn().mockReturnValue({ update: subUpdate }) };

  const outerManager = {
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue(lockRepo),
    // The SAVEPOINT: writeRaw wraps its update in manager.transaction(...).
    transaction: jest.fn((cb: (m: typeof subManager) => Promise<unknown>) => cb(subManager)),
  };

  const providerRepo = {
    manager: {
      transaction: jest.fn((cb: (m: typeof outerManager) => Promise<unknown>) => cb(outerManager)),
    },
  };

  const routingCache = {
    getProviders: jest.fn().mockReturnValue(null),
    setProviders: jest.fn(),
    invalidateAgent: jest.fn(),
    invalidateTenant: jest.fn(),
  };

  const makeRepo = () => ({ find: jest.fn(), findOne: jest.fn() });
  const svc = new ProviderService(
    providerRepo as unknown as Repository<TenantProvider>,
    makeRepo() as unknown as Repository<TierAssignment>,
    makeRepo() as unknown as Repository<SpecificityAssignment>,
    makeRepo() as unknown as Repository<Agent>,
    makeRepo() as unknown as Repository<HeaderTier>,
    { getByModel: jest.fn() } as unknown as ModelPricingCacheService,
    routingCache as unknown as RoutingCacheService,
    makeRepo() as unknown as Repository<AgentEnabledProvider>,
  );

  return { svc, outerManager, subUpdate, andWhereCalls, routingCache };
}

describe('ProviderService.withSubscriptionCredentialLock', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it('bounds the section and locks the trimmed, lowercased label', async () => {
    const { svc, outerManager, andWhereCalls } = makeHarness({
      id: 'tp-1',
      api_key_encrypted: null,
    });

    await svc.withSubscriptionCredentialLock(
      'tenant-1',
      'anthropic',
      '  Work  ',
      async () => 'done',
    );

    const statements = outerManager.query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /SET LOCAL lock_timeout/.test(s))).toBe(true);
    expect(statements.some((s) => /SET LOCAL idle_in_transaction_session_timeout/.test(s))).toBe(
      true,
    );
    const labelClause = andWhereCalls.find(([clause]) => clause.includes('LOWER(tp.label)'));
    expect(labelClause?.[1]).toEqual({ label: 'work' });
  });

  it('defaults a missing label to the lowercased default', async () => {
    const { svc, andWhereCalls } = makeHarness({ id: 'tp-1', api_key_encrypted: null });
    await svc.withSubscriptionCredentialLock('tenant-1', 'kiro', undefined, async () => null);
    const labelClause = andWhereCalls.find(([clause]) => clause.includes('LOWER(tp.label)'));
    expect(labelClause?.[1]).toEqual({ label: 'default' });
  });

  it('readFreshRaw decrypts the locked row (and returns null when undecryptable)', async () => {
    const stored = encrypt('stored-refresh-blob', getEncryptionSecret());
    const { svc } = makeHarness({ id: 'tp-1', api_key_encrypted: stored });
    const fresh = await svc.withSubscriptionCredentialLock('t', 'anthropic', 'Default', (ops) =>
      ops.readFreshRaw(),
    );
    expect(fresh).toBe('stored-refresh-blob');

    const { svc: svc2 } = makeHarness({ id: 'tp-1', api_key_encrypted: 'not-a-valid-ciphertext' });
    const bad = await svc2.withSubscriptionCredentialLock('t', 'anthropic', 'Default', (ops) =>
      ops.readFreshRaw(),
    );
    expect(bad).toBeNull();
  });

  it('writeRaw persists via a savepoint and invalidates the cache only after commit', async () => {
    const { svc, outerManager, subUpdate, routingCache } = makeHarness({
      id: 'tp-1',
      api_key_encrypted: null,
    });

    await svc.withSubscriptionCredentialLock('tenant-1', 'anthropic', 'Default', async (ops) => {
      await ops.writeRaw('brand-new-blob');
    });

    // The write went through the nested transaction (SAVEPOINT), not a bare save.
    expect(outerManager.transaction).toHaveBeenCalledTimes(1);
    expect(subUpdate).toHaveBeenCalledTimes(1);
    const [where, patch] = subUpdate.mock.calls[0] as [
      { id: string },
      { api_key_encrypted: string; key_prefix: string },
    ];
    expect(where).toEqual({ id: 'tp-1' });
    expect(decrypt(patch.api_key_encrypted, getEncryptionSecret())).toBe('brand-new-blob');
    expect(patch.key_prefix).toBe('brand-ne');

    // Cache invalidation happens, and strictly AFTER the write (post-commit).
    expect(routingCache.invalidateTenant).toHaveBeenCalledWith('tenant-1');
    expect(subUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      routingCache.invalidateTenant.mock.invocationCallOrder[0],
    );
  });

  it('does not invalidate the cache when nothing was written', async () => {
    const { svc, routingCache } = makeHarness({ id: 'tp-1', api_key_encrypted: null });
    await svc.withSubscriptionCredentialLock(
      'tenant-1',
      'anthropic',
      'Default',
      async () => 'noop',
    );
    expect(routingCache.invalidateTenant).not.toHaveBeenCalled();
  });

  it('writeRaw throws when no subscription row was locked', async () => {
    const { svc, routingCache } = makeHarness(null);
    await expect(
      svc.withSubscriptionCredentialLock('tenant-1', 'anthropic', 'Default', async (ops) => {
        await ops.writeRaw('rotated');
      }),
    ).rejects.toThrow(/No subscription credential row/);
    expect(routingCache.invalidateTenant).not.toHaveBeenCalled();
  });
});
