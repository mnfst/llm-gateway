/**
 * Two backend instances on one database, as Cloud Run runs them. A routing
 * write served by one instance must be visible on the other: immediately for
 * the dashboard (read-your-writes) and within the feed's poll interval for the
 * proxy, instead of after the two-minute in-memory TTL.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_API_KEY } from './helpers';
import { HeaderTierService } from '../src/routing/header-tiers/header-tier.service';
import { SYNC_POLL_INTERVAL_MS } from '../src/routing/routing-core/routing-cache-sync.service';

let instanceA: INestApplication;
let instanceB: INestApplication;

const auth = (r: request.Test) => r.set('x-api-key', TEST_API_KEY);
const headerTiersPath = '/api/v1/routing/test-agent/header-tiers';

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
  instanceA = await createTestApp();
  instanceB = await createTestApp({ dropSchema: false, seed: false });
}, 60_000);

afterAll(async () => {
  await instanceB?.close();
  await instanceA?.close();
});

describe('routing cache sync across instances', () => {
  it('a dashboard read on instance B sees a write made on instance A right away', async () => {
    // Warm instance B's header-tier cache with the empty list.
    const before = await auth(request(instanceB.getHttpServer()).get(headerTiersPath)).expect(200);
    expect(before.body).toEqual([]);

    await auth(request(instanceA.getHttpServer()).post(headerTiersPath))
      .send({
        name: 'Premium',
        header_key: 'x-tier',
        header_value: 'premium',
        badge_color: 'indigo',
      })
      .expect(201);

    const after = await auth(request(instanceB.getHttpServer()).get(headerTiersPath)).expect(200);
    expect(after.body.map((t: { name: string }) => t.name)).toEqual(['Premium']);
  });

  it('the proxy-side cache on instance B picks up a write from instance A within a poll', async () => {
    // Read the way the proxy does: straight from the cached service, no
    // management catch-up in front of it.
    const headerTiersOnB = instanceB.get(HeaderTierService);
    const initial = await headerTiersOnB.list(TEST_AGENT_ID);

    await auth(request(instanceA.getHttpServer()).post(headerTiersPath))
      .send({ name: 'Batch', header_key: 'x-tier', header_value: 'batch', badge_color: 'emerald' })
      .expect(201);

    const elapsed = await waitUntil(
      async () => (await headerTiersOnB.list(TEST_AGENT_ID)).length === initial.length + 1,
      SYNC_POLL_INTERVAL_MS * 5,
    );
    expect(elapsed).toBeLessThan(SYNC_POLL_INTERVAL_MS * 5);
  });
});
