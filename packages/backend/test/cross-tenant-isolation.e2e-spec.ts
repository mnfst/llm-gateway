import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_AGENT_ID, TEST_API_KEY, TEST_TENANT_ID } from './helpers';

const TENANT_B = 'tenant-b';
const USER_B = 'user-b';

/**
 * Cross-tenant isolation guard.
 *
 * The management surface must scope every read and write to the caller's
 * tenant. This suite drives the per-request tenant context the dashboard and
 * the CLI consent flow use (impersonated through the test session header) and
 * asserts a second tenant cannot see, mutate, or learn about the first
 * tenant's harnesses through any agent-scoped route, nor read its request log.
 *
 * Credential -> tenant binding itself (the tenant coming off the `api_keys`
 * row) is covered by `api-key.guard.spec.ts`; this suite covers everything
 * downstream of that resolution.
 */
describe('cross-tenant isolation (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    await ds.query(
      `INSERT INTO tenants (id, name, owner_user_id, organization_name, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,true,$5,$6)`,
      [TENANT_B, 'Tenant B', USER_B, 'Org B', now, now],
    );
    // One real request-log row for tenant A: the list reads `requests`, with
    // the attempt linked via request_id, so the isolation check is not vacuous.
    await ds.query(
      `INSERT INTO requests (id, tenant_id, agent_id, agent_name, status, timestamp) VALUES ($1,$2,$3,$4,$5,$6)`,
      ['req-a', TEST_TENANT_ID, TEST_AGENT_ID, 'test-agent', 'success', now],
    );
    await ds.query(
      `INSERT INTO agent_messages (id, request_id, tenant_id, agent_id, agent_name, status, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['msg-a', 'req-a', TEST_TENANT_ID, TEST_AGENT_ID, 'test-agent', 'success', now],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** The seeded tenant A agent (`test-agent`) is the target. */
  const asA = (req: request.Test) => req.set('x-api-key', TEST_API_KEY);
  const asB = (req: request.Test) =>
    req.set('x-api-key', TEST_API_KEY).set('x-test-user-id', USER_B);

  it('the owning tenant can read its harness', async () => {
    const res = await asA(request(app.getHttpServer()).get('/api/v1/agents/test-agent')).expect(200);
    expect(res.body.agent?.agent_name ?? res.body.agent?.name).toBe('test-agent');
  });

  it('a foreign tenant sees none of the owning tenant harnesses', async () => {
    const list = await asB(request(app.getHttpServer()).get('/api/v1/agents')).expect(200);
    expect(list.body.agents).toEqual([]);
  });

  it('a foreign tenant reads null, not another tenant harness', async () => {
    // GET /agents/:name is 200 `{ agent: null }` for a miss by contract (the CLI
    // normalizes it to not-found); what matters is that no agent is returned.
    const res = await asB(request(app.getHttpServer()).get('/api/v1/agents/test-agent')).expect(
      200,
    );
    expect(res.body.agent).toBeNull();
  });

  it.each([
    ['GET', '/api/v1/agents/test-agent/key'],
    ['GET', '/api/v1/routing/test-agent/tiers'],
    ['GET', '/api/v1/routing/test-agent/autofix'],
    ['GET', '/api/v1/routing/test-agent/recording'],
  ])('a foreign tenant cannot GET %s (%s)', async (_label, path) => {
    // Tenant-first resolution throws NotFound for a foreign harness.
    await asB(request(app.getHttpServer()).get(path as string)).expect(404);
  });

  it('a foreign tenant cannot mutate the harness', async () => {
    await asB(
      request(app.getHttpServer())
        .patch('/api/v1/agents/test-agent')
        .send({ agent_category: 'personal' }),
    ).expect(404);

    await asB(
      request(app.getHttpServer())
        .post('/api/v1/agents/test-agent/rotate-key')
        .send({}),
    ).expect(404);

    await asB(request(app.getHttpServer()).delete('/api/v1/agents/test-agent')).expect(404);
  });

  it('the owning tenant sees its request-log row', async () => {
    const res = await asA(
      request(app.getHttpServer()).get('/api/v1/messages?agent_name=test-agent'),
    ).expect(200);
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    // Pin to the seeded row: a length check alone would pass on any row.
    expect(items.map((i: { id?: string }) => i.id)).toContain('req-a');
  });

  it('a foreign tenant request log is empty for the other harness', async () => {
    const res = await asB(
      request(app.getHttpServer()).get('/api/v1/messages?agent_name=test-agent'),
    ).expect(200);
    const items = Array.isArray(res.body.items) ? res.body.items : [];
    expect(items).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('test-agent');
  });

  it('the owning agent still exists after the foreign attempts', async () => {
    const row = await ds.query(`SELECT tenant_id, deleted_at FROM agents WHERE name = 'test-agent'`);
    expect(row).toHaveLength(1);
    expect(row[0].tenant_id).toBe(TEST_TENANT_ID);
    expect(row[0].deleted_at).toBeNull();
  });
});
