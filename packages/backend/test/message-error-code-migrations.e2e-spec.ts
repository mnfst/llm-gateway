/**
 * Real-data e2e for AddMessageErrorCode: reverts the migration, seeds rows the
 * way the old proxy wrote them, then replays it and asserts both backfills —
 * the `error_code` derivation from `routing_reason`, and the removal of the
 * placeholder model/provider/tier the canned-stub path used to stamp.
 */
import { DataSource } from 'typeorm';
import { AddMessageErrorCode1800200000000 } from '../src/database/migrations/1800200000000-AddMessageErrorCode';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';

const TENANT = 'errcode-tenant-1';
const AGENT = 'errcode-agent-1';

interface SeedRow {
  id: string;
  status: string;
  routing_reason: string | null;
  error_origin: string | null;
  error_http_status: number | null;
  provider: string | null;
  model: string | null;
  routing_tier: string | null;
}

async function runUp(ds: DataSource): Promise<void> {
  const qr = ds.createQueryRunner();
  try {
    await new AddMessageErrorCode1800200000000().up(qr);
  } finally {
    await qr.release();
  }
}

async function runDown(ds: DataSource): Promise<void> {
  const qr = ds.createQueryRunner();
  try {
    await new AddMessageErrorCode1800200000000().down(qr);
  } finally {
    await qr.release();
  }
}

async function insertRow(ds: DataSource, row: SeedRow): Promise<void> {
  await ds.query(
    `INSERT INTO agent_messages
       (id, tenant_id, agent_id, agent_name, timestamp, status, routing_reason,
        error_origin, error_http_status, provider, model, routing_tier,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES ($1,$2,$3,$4, now(), $5,$6,$7,$8,$9,$10,$11, 0,0,0,0)`,
    [
      row.id,
      TENANT,
      AGENT,
      AGENT,
      row.status,
      row.routing_reason,
      row.error_origin,
      row.error_http_status,
      row.provider,
      row.model,
      row.routing_tier,
    ],
  );
}

async function fetchRow(
  ds: DataSource,
  id: string,
): Promise<{
  error_code: string | null;
  provider: string | null;
  model: string | null;
  routing_tier: string | null;
}> {
  const rows = await ds.query(
    `SELECT error_code, provider, model, routing_tier FROM agent_messages WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function columnNames(ds: DataSource, table: string): Promise<string[]> {
  const cols: { column_name: string }[] = await ds.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return cols.map((c) => c.column_name);
}

describe('AddMessageErrorCode migration — data backfill (e2e)', () => {
  let ds: DataSource;

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

    const schemaQr = ds.createQueryRunner();
    await new AddRequestsAndProviderAttempts1801000000000().down(schemaQr);
    await schemaQr.release();

    // Back to the pre-migration schema, then seed rows exactly as the old proxy
    // wrote them: canned stubs carrying provider='manifest' / tier='simple'.
    await runDown(ds);

    await ds.query(`INSERT INTO tenants (id, name, is_active) VALUES ($1,$1,true)`, [TENANT]);
    await ds.query(`INSERT INTO agents (id, name, display_name, tenant_id) VALUES ($1,$1,$1,$2)`, [
      AGENT,
      TENANT,
    ]);

    const stub = (
      id: string,
      routing_reason: string | null,
      error_origin: string | null,
      error_http_status: number | null = null,
    ): SeedRow => ({
      id,
      status: 'error',
      routing_reason,
      error_origin,
      error_http_status,
      provider: 'manifest',
      model: 'manifest',
      routing_tier: 'simple',
    });

    await insertRow(ds, stub('m-no-provider', 'no_provider', 'config'));
    await insertRow(ds, stub('m-no-key', 'no_provider_key', 'config'));
    await insertRow(ds, stub('m-limit', 'limit_exceeded', 'policy'));
    await insertRow(ds, stub('m-plan-402', 'limit_exceeded', 'policy', 402));
    await insertRow(ds, stub('m-plan', 'plan_request_limit_exceeded', 'policy', 402));
    await insertRow(ds, stub('m-internal', 'friendly_error', 'internal'));
    await insertRow(ds, stub('m-ratelimit', 'manifest_rate_limited', 'policy', 429));

    // A failed stub written before the taxonomy backfill: still NULL origin.
    // Prod has a handful of these; keying the cleanup on error_origin missed them.
    await insertRow(ds, { ...stub('m-null-origin', 'no_provider_key', null), status: 'error' });

    // A much older stub, recorded as a success before the canned-status change.
    // It still counts as a message, so its placeholder model must survive.
    await insertRow(ds, { ...stub('m-legacy-ok', 'no_provider', null), status: 'ok' });

    // A real provider failure must be left completely untouched.
    await insertRow(ds, {
      id: 'm-provider',
      status: 'error',
      routing_reason: 'scored',
      error_origin: 'provider',
      error_http_status: 500,
      provider: 'openai',
      model: 'gpt-4o',
      routing_tier: 'standard',
    });

    await runUp(ds);
  }, 60_000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('adds the error_code column', async () => {
    expect(await columnNames(ds, 'agent_messages')).toContain('error_code');
  });

  it.each([
    ['m-no-provider', 'M101'],
    ['m-no-key', 'M100'],
    ['m-limit', 'M200'],
    ['m-plan', 'M204'],
    ['m-internal', 'M500'],
  ])('backfills %s to %s', async (id, expected) => {
    expect((await fetchRow(ds, id)).error_code).toBe(expected);
  });

  it('resolves a 402 limit_exceeded row to the plan-limit code, not the usage-limit code', async () => {
    expect((await fetchRow(ds, 'm-plan-402')).error_code).toBe('M204');
  });

  it('leaves the collapsed rate-limit reason unresolved rather than guessing', async () => {
    // manifest_rate_limited covered M201/M202/M203 — which one fired is not
    // recoverable from the row, so NULL is the honest answer.
    expect((await fetchRow(ds, 'm-ratelimit')).error_code).toBeNull();
  });

  it('clears the placeholder model/provider/tier from Manifest-authored rows', async () => {
    const row = await fetchRow(ds, 'm-no-key');
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
    expect(row.routing_tier).toBeNull();
  });

  it('clears the placeholders on a failed stub whose error_origin was never backfilled', async () => {
    const row = await fetchRow(ds, 'm-null-origin');
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
    expect(row.routing_tier).toBeNull();
    // The code backfill keys on routing_reason, so it reaches this row too.
    expect(row.error_code).toBe('M100');
  });

  it('leaves a legacy stub that was recorded as a success alone', async () => {
    // status='ok' rows still count as messages; nulling the model would move
    // them under "unknown model" in the cost breakdown.
    const row = await fetchRow(ds, 'm-legacy-ok');
    expect(row.provider).toBe('manifest');
    expect(row.model).toBe('manifest');
    expect(row.routing_tier).toBe('simple');
  });

  it('never touches a real provider failure', async () => {
    const row = await fetchRow(ds, 'm-provider');
    expect(row.error_code).toBeNull();
    expect(row.provider).toBe('openai');
    expect(row.model).toBe('gpt-4o');
    expect(row.routing_tier).toBe('standard');
  });

  it('drops the column on down()', async () => {
    await runDown(ds);
    expect(await columnNames(ds, 'agent_messages')).not.toContain('error_code');
    await runUp(ds);
  });
});
