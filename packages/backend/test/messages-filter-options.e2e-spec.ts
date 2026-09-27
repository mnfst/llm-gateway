import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID, TEST_AGENT_ID } from './helpers';

// The Requests log is tenant-wide: it shows every harness's requests unless one
// is picked in the Harness filter. Its Tier filter must follow — custom (header)
// tiers used to come from a per-harness endpoint, so with no harness selected
// the filter listed none of them and a custom tier could not be filtered on at
// all from the page it belongs to.

let app: INestApplication;
let ds: DataSource;

const SECOND_AGENT_ID = 'second-agent-001';
const OTHER_TENANT_ID = 'other-tenant-002';
const OTHER_USER_ID = 'other-user-002';
const OTHER_AGENT_ID = 'other-agent-002';

const ALPHA_PREMIUM = 'ht-alpha-premium';
const BETA_PREMIUM = 'ht-beta-premium';
const BETA_BATCH = 'ht-beta-batch';
const OTHER_TIER = 'ht-other-secret';

const ALPHA_MESSAGE = 'msg-alpha-premium';
const BETA_MESSAGE = 'msg-beta-premium';
const UNTIERED_MESSAGE = 'msg-untiered';

interface TierOption {
  name: string;
  ids: string[];
}

async function insertHeaderTier(
  id: string,
  tenantId: string,
  agentId: string,
  name: string,
  now: string,
): Promise<void> {
  await ds.query(
    `INSERT INTO header_tiers
       (id, tenant_id, agent_id, name, header_key, header_value, badge_color,
        sort_order, enabled, output_modality, response_mode, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'x-tier',$4,'blue',0,true,'text','buffered',$5,$5)`,
    [id, tenantId, agentId, name, now],
  );
}

async function insertMessage(
  id: string,
  agentId: string,
  agentName: string,
  headerTierId: string | null,
  now: string,
): Promise<void> {
  await ds.query(
    `INSERT INTO agent_messages
       (id, tenant_id, agent_id, timestamp, status, model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        description, service_type, agent_name, user_id, header_tier_id)
     VALUES ($1,$2,$3,$4,'ok','gpt-4o',10,5,0,0,'Routed','agent',$5,'test-user-001',$6)`,
    [id, TEST_TENANT_ID, agentId, now, agentName, headerTierId],
  );
}

beforeAll(async () => {
  app = await createTestApp();
  ds = app.get(DataSource);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  // A second harness in the caller's own tenant, plus a harness owned by
  // someone else — the tenant-wide listing must span the first and not the second.
  await ds.query(
    `INSERT INTO agents (id, name, display_name, description, is_active,
       complexity_routing_enabled, tenant_id, created_at, updated_at)
     VALUES ($1,$2,$3,$3,true,true,$4,$5,$5)`,
    [SECOND_AGENT_ID, 'second-agent', 'Second Agent', TEST_TENANT_ID, now],
  );
  await ds.query(
    `INSERT INTO tenants (id, name, owner_user_id, organization_name, is_active, created_at, updated_at)
     VALUES ($1,$2,$2,'Other Org',true,$3,$3)`,
    [OTHER_TENANT_ID, OTHER_USER_ID, now],
  );
  await ds.query(
    `INSERT INTO agents (id, name, display_name, description, is_active,
       complexity_routing_enabled, tenant_id, created_at, updated_at)
     VALUES ($1,$2,$3,$3,true,true,$4,$5,$5)`,
    [OTHER_AGENT_ID, 'other-agent', 'Other Agent', OTHER_TENANT_ID, now],
  );

  // Both of the caller's harnesses define a "Premium" tier; only the second
  // defines "Batch". The other tenant's tier must never surface.
  await insertHeaderTier(ALPHA_PREMIUM, TEST_TENANT_ID, TEST_AGENT_ID, 'Premium', now);
  await insertHeaderTier(BETA_PREMIUM, TEST_TENANT_ID, SECOND_AGENT_ID, 'Premium', now);
  await insertHeaderTier(BETA_BATCH, TEST_TENANT_ID, SECOND_AGENT_ID, 'Batch', now);
  await insertHeaderTier(OTHER_TIER, OTHER_TENANT_ID, OTHER_AGENT_ID, 'Secret', now);

  await insertMessage(ALPHA_MESSAGE, TEST_AGENT_ID, 'test-agent', ALPHA_PREMIUM, now);
  await insertMessage(BETA_MESSAGE, SECOND_AGENT_ID, 'second-agent', BETA_PREMIUM, now);
  await insertMessage(UNTIERED_MESSAGE, TEST_AGENT_ID, 'test-agent', null, now);
});

afterAll(async () => {
  await app?.close();
});

describe('GET /api/v1/messages/filter-options — custom tiers', () => {
  it('offers every harness custom tier when no harness is selected', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages/filter-options?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const tiers: TierOption[] = res.body.header_tiers;
    const premium = tiers.find((t) => t.name === 'Premium');
    // One option per name, carrying both harnesses' ids: on the tenant-wide
    // log "Premium" can only mean "any harness's Premium tier".
    expect(premium?.ids.sort()).toEqual([ALPHA_PREMIUM, BETA_PREMIUM].sort());
    expect(tiers.map((t) => t.name).sort()).toEqual(['Batch', 'Premium']);
  });

  it('offers only the selected harness custom tiers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages/filter-options?range=24h&agent_name=second-agent')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const tiers: TierOption[] = res.body.header_tiers;
    expect(tiers.map((t) => t.name).sort()).toEqual(['Batch', 'Premium']);
    expect(tiers.find((t) => t.name === 'Premium')?.ids).toEqual([BETA_PREMIUM]);
  });

  it('never offers another tenant custom tiers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/messages/filter-options?range=24h')
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const tiers: TierOption[] = res.body.header_tiers;
    expect(tiers.map((t) => t.name)).not.toContain('Secret');
    expect(tiers.flatMap((t) => t.ids)).not.toContain(OTHER_TIER);
  });
});

describe('GET /api/v1/messages — custom tier filter', () => {
  it('matches every harness behind one tier option', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages?range=24h&limit=50&header_tier_id=${ALPHA_PREMIUM},${BETA_PREMIUM}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const ids: string[] = res.body.items.map((it: { id: string }) => it.id);
    expect(ids).toEqual(expect.arrayContaining([ALPHA_MESSAGE, BETA_MESSAGE]));
    expect(ids).not.toContain(UNTIERED_MESSAGE);
  });

  it('still accepts a single tier id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages?range=24h&limit=50&header_tier_id=${ALPHA_PREMIUM}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);

    const ids: string[] = res.body.items.map((it: { id: string }) => it.id);
    expect(ids).toContain(ALPHA_MESSAGE);
    expect(ids).not.toContain(BETA_MESSAGE);
  });
});
