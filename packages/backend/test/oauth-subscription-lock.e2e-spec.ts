/**
 * Real-Postgres e2e for ProviderService.withSubscriptionCredentialLock.
 *
 * The unit spec drives this method against mocked TypeORM objects, which can
 * assert that the right calls happen but NOT that they mean anything: a mocked
 * `SELECT … FOR UPDATE` does not block, a mocked nested transaction is not a
 * SAVEPOINT, and a mocked commit does not persist. Every invariant this file
 * pins is one that only a real database can prove.
 *
 * Covers:
 *  - the row lock actually SERIALIZES two concurrent refreshes (the whole point
 *    of the lock: two replicas must not rotate the same refresh token at once)
 *  - `SET LOCAL lock_timeout` bounds the wait instead of blocking forever
 *  - the write survives COMMIT and is readable/decryptable afterwards
 *  - a transient write failure rolls back to the SAVEPOINT and a RETRY under the
 *    same held lock still succeeds — the bug that would otherwise abort the
 *    transaction and silently discard an already-rotated token
 *  - a whitespace-padded label still finds its stored row
 */
import { DataSource } from 'typeorm';
import { ProviderService } from '../src/routing/routing-core/provider.service';
import { TenantProvider } from '../src/entities/tenant-provider.entity';
import { TierAssignment } from '../src/entities/tier-assignment.entity';
import { SpecificityAssignment } from '../src/entities/specificity-assignment.entity';
import { Agent } from '../src/entities/agent.entity';
import { HeaderTier } from '../src/entities/header-tier.entity';
import { AgentEnabledProvider } from '../src/entities/agent-enabled-provider.entity';
import type { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';
import type { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { encrypt, decrypt, getEncryptionSecret } from '../src/common/utils/crypto.util';

const TENANT = 'oauthlock-tenant-1';
const AGENT = 'oauthlock-agent-1';
const PROVIDER = 'anthropic';

/** Wall-clock sleep — used to hold the lock long enough to observe blocking. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withSubscriptionCredentialLock — real Postgres (e2e)', () => {
  let ds: DataSource;
  let svc: ProviderService;
  let invalidateTenant: jest.Mock;
  let originalSecret: string | undefined;

  const makeService = (dataSource: DataSource): ProviderService => {
    invalidateTenant = jest.fn();
    const routingCache = {
      getProviders: jest.fn().mockReturnValue(null),
      setProviders: jest.fn(),
      invalidateAgent: jest.fn(),
      invalidateTenant,
    } as unknown as RoutingCacheService;

    return new ProviderService(
      dataSource.getRepository(TenantProvider),
      dataSource.getRepository(TierAssignment),
      dataSource.getRepository(SpecificityAssignment),
      dataSource.getRepository(Agent),
      dataSource.getRepository(HeaderTier),
      { getByModel: jest.fn() } as unknown as ModelPricingCacheService,
      routingCache,
      dataSource.getRepository(AgentEnabledProvider),
    );
  };

  /** Reset the credential row to a known encrypted blob before each test. */
  const seedCredential = async (label: string, raw: string): Promise<string> => {
    await ds.query(`DELETE FROM tenant_providers WHERE tenant_id = $1`, [TENANT]);
    const rows = await ds.query(
      `INSERT INTO tenant_providers
         (id, tenant_id, provider, auth_type, label, api_key_encrypted, key_prefix)
       VALUES (gen_random_uuid(), $1, $2, 'subscription', $3, $4, $5)
       RETURNING id`,
      [TENANT, PROVIDER, label, encrypt(raw, getEncryptionSecret()), raw.substring(0, 8)],
    );
    return rows[0].id;
  };

  const readStoredRaw = async (id: string): Promise<string | null> => {
    const rows = await ds.query(`SELECT api_key_encrypted FROM tenant_providers WHERE id = $1`, [
      id,
    ]);
    const enc = rows[0]?.api_key_encrypted;
    return enc ? decrypt(enc, getEncryptionSecret()) : null;
  };

  beforeAll(async () => {
    originalSecret = process.env['BETTER_AUTH_SECRET'];
    process.env['BETTER_AUTH_SECRET'] = 'a'.repeat(48);

    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
      // Two concurrent lock holders + the outer assertions need >1 connection.
      extra: { max: 10 },
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    await ds.query(`INSERT INTO tenants (id, name, is_active) VALUES ($1,$1,true)`, [TENANT]);
    await ds.query(`INSERT INTO agents (id, name, display_name, tenant_id) VALUES ($1,$1,$1,$2)`, [
      AGENT,
      TENANT,
    ]);

    svc = makeService(ds);
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (originalSecret === undefined) delete process.env['BETTER_AUTH_SECRET'];
    else process.env['BETTER_AUTH_SECRET'] = originalSecret;
  });

  it('persists the rotated blob through COMMIT and busts the cache after', async () => {
    const id = await seedCredential('Default', 'old-refresh-blob');

    const seenInside = await svc.withSubscriptionCredentialLock(
      TENANT,
      PROVIDER,
      'Default',
      async (ops) => {
        const fresh = await ops.readFreshRaw();
        await ops.writeRaw('rotated-refresh-blob');
        return fresh;
      },
    );

    // readFreshRaw saw the pre-rotation value...
    expect(seenInside).toBe('old-refresh-blob');
    // ...and the new one is durable after commit.
    expect(await readStoredRaw(id)).toBe('rotated-refresh-blob');
    expect(invalidateTenant).toHaveBeenCalledWith(TENANT);
  });

  it('SERIALIZES two concurrent refreshes on the same credential row', async () => {
    const id = await seedCredential('Default', 'gen-0');
    const order: string[] = [];

    // A holds the lock for 400ms before writing. B must not interleave.
    const a = svc.withSubscriptionCredentialLock(TENANT, PROVIDER, 'Default', async (ops) => {
      order.push('A:enter');
      await sleep(400);
      await ops.writeRaw('gen-A');
      order.push('A:exit');
    });

    // Give A time to take the lock first.
    await sleep(75);

    const b = svc.withSubscriptionCredentialLock(TENANT, PROVIDER, 'Default', async (ops) => {
      order.push('B:enter');
      // B re-reads UNDER the lock — it must observe A's committed write, which is
      // exactly how the coordinator avoids rotating an already-rotated token.
      const fresh = await ops.readFreshRaw();
      order.push(`B:sees=${fresh}`);
      await ops.writeRaw('gen-B');
      order.push('B:exit');
    });

    await Promise.all([a, b]);

    // The critical sections must not overlap.
    expect(order).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:sees=gen-A', 'B:exit']);
    expect(await readStoredRaw(id)).toBe('gen-B');
  }, 30_000);

  it('retries a failed write under the same held lock (SAVEPOINT rollback)', async () => {
    // This is the regression the savepoint exists for: without it the first
    // failure aborts the surrounding transaction and every retry dies with
    // "current transaction is aborted" (25P02), discarding the rotated token.
    //
    // The failure must happen INSIDE Postgres to abort the transaction — a JS
    // throw before the query never reaches the server and would make this test
    // pass with or without the savepoint. A trigger rejecting a sentinel prefix
    // gives us a genuine server-side error on the UPDATE itself.
    const id = await seedCredential('Default', 'pre-retry');
    await ds.query(`
      CREATE OR REPLACE FUNCTION oauthlock_reject_sentinel() RETURNS trigger AS $$
      BEGIN
        IF NEW.key_prefix = 'FAILFAIL' THEN
          RAISE EXCEPTION 'simulated transient write failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `);
    await ds.query(`
      CREATE TRIGGER oauthlock_reject_sentinel_trg
      BEFORE UPDATE ON tenant_providers
      FOR EACH ROW EXECUTE FUNCTION oauthlock_reject_sentinel();
    `);

    try {
      let failed = false;
      await svc.withSubscriptionCredentialLock(TENANT, PROVIDER, 'Default', async (ops) => {
        // Attempt 1: the UPDATE reaches Postgres and raises.
        try {
          await ops.writeRaw('FAILFAILrotated');
        } catch {
          failed = true; // swallowed — mirrors the coordinator's retry loop
        }
        // Attempt 2 must still succeed on the SAME transaction and lock.
        await ops.writeRaw('post-retry-blob');
      });

      expect(failed).toBe(true);
      expect(await readStoredRaw(id)).toBe('post-retry-blob');
    } finally {
      await ds.query(`DROP TRIGGER IF EXISTS oauthlock_reject_sentinel_trg ON tenant_providers`);
      await ds.query(`DROP FUNCTION IF EXISTS oauthlock_reject_sentinel()`);
    }
  }, 30_000);

  it('matches a stored row through a whitespace-padded label', async () => {
    const id = await seedCredential('Work', 'label-blob');

    await svc.withSubscriptionCredentialLock(TENANT, PROVIDER, '  Work  ', async (ops) => {
      await ops.writeRaw('trimmed-label-write');
    });

    // Untrimmed, the LOWER(label) match would miss and writeRaw would throw
    // "No subscription credential row to persist".
    expect(await readStoredRaw(id)).toBe('trimmed-label-write');
  });

  it('bounds the wait with lock_timeout instead of blocking forever', async () => {
    await seedCredential('Default', 'timeout-blob');

    // Hold the row lock outside the service, longer than lock_timeout (5s).
    const blocker = ds.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query(
      `SELECT id FROM tenant_providers WHERE tenant_id = $1 AND provider = $2 FOR UPDATE`,
      [TENANT, PROVIDER],
    );

    try {
      const started = Date.now();
      await expect(
        svc.withSubscriptionCredentialLock(TENANT, PROVIDER, 'Default', async (ops) => {
          await ops.writeRaw('should-never-land');
        }),
      ).rejects.toThrow(/lock timeout|canceling statement/i);
      // Bounded by lock_timeout rather than hanging until the blocker releases.
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
  }, 40_000);
});
