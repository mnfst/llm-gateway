import { DataSource } from 'typeorm';
import { AgentUsageDailyService } from '../src/analytics/services/agent-usage-daily.service';
import { toLocalSqlTimestamp } from '../src/common/utils/postgres-sql';

const TENANT = 'rollup-tenant';
const AGENT = 'rollup-agent';
// agent_messages.agent_id has no foreign key, so rows outlive a hard-deleted
// harness. This id deliberately has no "agents" row.
const GONE_AGENT = 'rollup-agent-deleted';
const TIMESTAMP = toLocalSqlTimestamp(new Date(Date.now() - 60 * 60 * 1000));

async function insertRequest(ds: DataSource, id: string, agentId: string): Promise<void> {
  await ds.query(
    `INSERT INTO "requests" ("id", "tenant_id", "agent_id", "timestamp", "status")
     VALUES ($1, $2, $3, $4, 'success')`,
    [id, TENANT, agentId, TIMESTAMP],
  );
}

async function insertAttempt(
  ds: DataSource,
  id: string,
  requestId: string | null,
  agentId: string,
): Promise<void> {
  await ds.query(
    `INSERT INTO "agent_messages" (
       "id", "request_id", "tenant_id", "agent_id", "agent_name", "timestamp",
       "status", "input_tokens", "output_tokens", "cache_read_tokens",
       "cache_creation_tokens", "cost_usd"
     )
     VALUES ($1, $2, $3, $4, $4, $5, 'success', 10, 5, 0, 0, 0.5)`,
    [id, requestId, TENANT, agentId, TIMESTAMP],
  );
}

async function pendingCount(ds: DataSource, table: 'requests' | 'agent_messages'): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*) AS n FROM "${table}" WHERE "agent_usage_rolled_up_at" IS NULL`,
  );
  return Number(rows[0].n);
}

describe('AgentUsageDailyService rollup of rows whose harness is gone (e2e)', () => {
  let ds: DataSource;
  let service: AgentUsageDailyService;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
      entities: ['src/entities/!(*.spec).ts'],
      migrations: ['src/database/migrations/!(*.spec).ts'],
      synchronize: false,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    await ds.query(`INSERT INTO "tenants" ("id", "name", "is_active") VALUES ($1, $1, true)`, [
      TENANT,
    ]);
    await ds.query(
      `INSERT INTO "agents" ("id", "tenant_id", "name", "display_name", "is_playground")
       VALUES ($1, $2, $1, $1, false)`,
      [AGENT, TENANT],
    );
    // Start every row as pending, whatever the column default is.
    await insertRequest(ds, 'live-request', AGENT);
    await insertAttempt(ds, 'live-attempt', 'live-request', AGENT);
    await insertRequest(ds, 'orphan-request', GONE_AGENT);
    await insertAttempt(ds, 'orphan-attempt', 'orphan-request', GONE_AGENT);
    await insertAttempt(ds, 'orphan-unlinked-attempt', null, GONE_AGENT);
    await ds.query(`UPDATE "requests" SET "agent_usage_rolled_up_at" = NULL`);
    await ds.query(`UPDATE "agent_messages" SET "agent_usage_rolled_up_at" = NULL`);

    service = new AgentUsageDailyService(ds);
  }, 60_000);

  afterAll(async () => {
    await ds?.destroy();
  });

  it('marks orphaned rows as rolled up without counting them', async () => {
    const result = await service.processBatch(250);

    expect(result.acquired).toBe(true);
    // 2 requests + 3 attempts, orphans included.
    expect(result.processed).toBe(5);
    expect(await pendingCount(ds, 'requests')).toBe(0);
    expect(await pendingCount(ds, 'agent_messages')).toBe(0);

    const daily: Array<{ agent_id: string; request_count: string; cost_usd: string }> =
      await ds.query(`SELECT "agent_id", "request_count", "cost_usd" FROM "agent_usage_daily"`);
    expect(daily).toHaveLength(1);
    expect(daily[0].agent_id).toBe(AGENT);
    expect(Number(daily[0].request_count)).toBe(1);
    expect(Number(daily[0].cost_usd)).toBe(0.5);
  });

  it('finds nothing left to process on the next batch', async () => {
    await expect(service.processBatch(250)).resolves.toEqual({
      acquired: true,
      processed: 0,
      rollups: 0,
    });
  });
});
