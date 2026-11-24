#!/usr/bin/env node
/**
 * DB footprint benchmark: run against a COPY of the Manifest database,
 * never against production.
 *
 * Runs the main HOT (proxy path) and DASH (dashboard) queries for three tenant
 * profiles (biggest, median and small by 30-day attempt volume) and the BG
 * rollup selection once, globally.
 * Each query gets 5 warm-up runs and 50 measured runs, and the script prints
 * p50/p95. It also times a batch of 1,000 request inserts plus the matching
 * attempt inserts, inside a transaction that is always rolled back.
 *
 * Run it before and after each change (reindex, index drop, retention purge,
 * memory setting) and compare the JSON outputs.
 *
 * Usage:
 *   BENCH_TARGET_IS_COPY=1 node scripts/db-footprint-bench.mjs \
 *     --url postgresql://...copy... [--runs 50] [--warmup 5] [--json out.json]
 *
 * `pg` resolves from packages/backend, so run `npm ci` first.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
const { Client } = require('pg');

function parseArgs(argv) {
  const a = { runs: 50, warmup: 5, url: process.env.BENCH_DATABASE_URL, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') a.url = argv[++i];
    else if (argv[i] === '--runs') a.runs = Number(argv[++i]);
    else if (argv[i] === '--warmup') a.warmup = Number(argv[++i]);
    else if (argv[i] === '--json') a.json = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(a.runs) || a.runs < 1) throw new Error('--runs must be an integer >= 1');
  if (!Number.isInteger(a.warmup) || a.warmup < 0)
    throw new Error('--warmup must be an integer >= 0');
  return a;
}

// Interval literals mirror the app's defaults: 30d dashboard range, current
// month for block rules, the 250-row rollup batch.
const QUERIES = [
  {
    tag: 'HOT',
    name: 'block-rule cost sum (current month, per agent)',
    // Same predicate as NotificationRulesService.getConsumption(), including
    // the legacy agent_name branch for attempts without an agent_id.
    sql: `SELECT COALESCE(SUM(at.cost_usd), 0) AS total FROM agent_messages at
          WHERE at.tenant_id = $1
            AND (
              at.agent_id = (
                SELECT id FROM agents
                WHERE tenant_id = at.tenant_id AND name = $2 AND deleted_at IS NULL
                LIMIT 1
              )
              OR (at.agent_id IS NULL AND at.agent_name = $2)
            )
            AND at.timestamp >= date_trunc('month', now())
            AND at.timestamp < date_trunc('month', now()) + interval '1 month'`,
    params: (t) => [t.tenant_id, t.agent_name],
  },
  {
    tag: 'HOT',
    name: 'plan quota counter lookup',
    sql: `SELECT request_count AS n, baseline_counted FROM tenant_request_usage
          WHERE tenant_id = $1 AND window_start = date_trunc('month', now())`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'HOT',
    name: 'attempts by request id',
    sql: `SELECT id, attempt_number, status FROM agent_messages WHERE request_id = $1 ORDER BY id`,
    params: (t) => [t.request_id],
  },
  {
    tag: 'DASH',
    name: 'overview summary (30d, covering index)',
    sql: `SELECT COUNT(*), COALESCE(SUM(at.input_tokens + at.output_tokens), 0), COALESCE(SUM(at.cost_usd), 0)
          FROM agent_messages at WHERE at.tenant_id = $1 AND at.timestamp >= now() - interval '30 days'`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'DASH',
    name: 'per-model daily timeseries (30d)',
    sql: `SELECT at.model, at.timestamp::date AS d, SUM(at.input_tokens + at.output_tokens), SUM(at.cost_usd)
          FROM agent_messages at WHERE at.tenant_id = $1 AND at.timestamp >= now() - interval '30 days'
          GROUP BY 1, 2`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'DASH',
    name: 'per-agent daily timeseries (30d)',
    sql: `SELECT at.timestamp::date AS d, COUNT(*), SUM(at.cost_usd) FROM agent_messages at
          WHERE at.tenant_id = $1 AND at.agent_id = $2 AND at.timestamp >= now() - interval '30 days'
          GROUP BY 1`,
    params: (t) => [t.tenant_id, t.agent_id],
  },
  {
    tag: 'DASH',
    name: 'requests log first page (all time)',
    sql: `SELECT r.id, r.timestamp, r.status, r.requested_model FROM requests r
          WHERE r.tenant_id = $1 ORDER BY r.timestamp DESC, r.id DESC LIMIT 50`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'DASH',
    name: 'requests log failed filter (30d)',
    sql: `SELECT r.id, r.timestamp FROM requests r WHERE r.tenant_id = $1
            AND r.timestamp >= now() - interval '30 days' AND r.status NOT IN ('ok', 'success', 'pending')
          ORDER BY r.timestamp DESC LIMIT 50`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'DASH',
    name: 'error breakdown (30d)',
    sql: `SELECT at.error_origin, COUNT(*) FROM agent_messages at WHERE at.tenant_id = $1
            AND at.timestamp >= now() - interval '30 days' AND at.error_origin IS NOT NULL GROUP BY 1`,
    params: (t) => [t.tenant_id],
  },
  {
    tag: 'BG',
    name: 'rollup batch selection (requests)',
    // Mirrors AgentUsageDailyService.processBatch(): select pending rows
    // first, check the harness only when aggregating.
    sql: `WITH selected AS MATERIALIZED (
            SELECT r.id, r.agent_id FROM requests r WHERE r.agent_usage_rolled_up_at IS NULL
              AND (r.status IS NULL OR r.status NOT IN ('pending', 'cancelled'))
              AND r.tenant_id IS NOT NULL AND r.agent_id IS NOT NULL
            ORDER BY r.timestamp DESC, r.id DESC LIMIT 250
          )
          SELECT COUNT(*) FROM selected s WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = s.agent_id)`,
    params: () => [],
    once: true,
  },
];

async function pickTenants(db) {
  const { rows } = await db.query(`
    WITH vol AS (
      SELECT tenant_id, COUNT(*) AS n FROM agent_messages
      WHERE timestamp >= now() - interval '30 days' AND tenant_id IS NOT NULL
      GROUP BY tenant_id HAVING COUNT(*) >= 50
    ), ranked AS (
      SELECT tenant_id, n, ROW_NUMBER() OVER (ORDER BY n DESC) AS rk, COUNT(*) OVER () AS total FROM vol
    )
    SELECT tenant_id, n,
      CASE WHEN rk = 1 THEN 'biggest' WHEN rk = (total + 1) / 2 THEN 'median' ELSE 'small' END AS profile
    FROM ranked WHERE rk IN (1, (total + 1) / 2, total)`);
  const tenants = [];
  for (const t of rows) {
    const sample = await db.query(
      `SELECT m.agent_id, m.request_id, a.name AS agent_name
       FROM agent_messages m JOIN agents a ON a.id = m.agent_id AND a.deleted_at IS NULL
       WHERE m.tenant_id = $1 AND m.request_id IS NOT NULL
       ORDER BY m.timestamp DESC LIMIT 1`,
      [t.tenant_id],
    );
    if (!sample.rows[0]) {
      console.warn(
        `skipping ${t.profile} tenant ${t.tenant_id}: no linked attempt with a live harness`,
      );
      continue;
    }
    tenants.push({ ...t, ...sample.rows[0] });
  }
  if (tenants.length === 0) throw new Error('No tenant with recent linked attempts to benchmark');
  return tenants;
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function timeQuery(db, q, params, warmup, runs) {
  for (let i = 0; i < warmup; i++) await db.query(q.sql, params);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await db.query(q.sql, params);
    times.push(performance.now() - t0);
  }
  return { p50: +pct(times, 0.5).toFixed(2), p95: +pct(times, 0.95).toFixed(2) };
}

async function timeInserts(db) {
  await db.query('BEGIN');
  try {
    await db.query(`CREATE TEMP TABLE bench_map ON COMMIT DROP AS
      SELECT id AS old_id, gen_random_uuid()::text AS new_id FROM requests ORDER BY timestamp DESC LIMIT 1000`);
    const cols = async (table, skip) =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name <> ALL($2) ORDER BY ordinal_position`,
          [table, skip],
        )
      ).rows.map((r) => `"${r.column_name}"`);
    const reqCols = await cols('requests', ['id']);
    const attCols = await cols('agent_messages', ['id', 'request_id']);
    let t0 = performance.now();
    const req = await db.query(`INSERT INTO requests (id, ${reqCols.join(', ')})
      SELECT m.new_id, ${reqCols.map((c) => `r.${c}`).join(', ')} FROM requests r JOIN bench_map m ON m.old_id = r.id`);
    const requestMs = performance.now() - t0;
    t0 = performance.now();
    const att = await db.query(`INSERT INTO agent_messages (id, request_id, ${attCols.join(', ')})
      SELECT gen_random_uuid()::text, m.new_id, ${attCols.map((c) => `a.${c}`).join(', ')}
      FROM agent_messages a JOIN bench_map m ON m.old_id = a.request_id`);
    const attemptMs = performance.now() - t0;
    return {
      requests: { rows: req.rowCount, ms: +requestMs.toFixed(1) },
      attempts: { rows: att.rowCount, ms: +attemptMs.toFixed(1) },
    };
  } finally {
    await db.query('ROLLBACK');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.BENCH_TARGET_IS_COPY !== '1') {
    throw new Error(
      'Refusing to run: set BENCH_TARGET_IS_COPY=1 to confirm the target is a disposable copy',
    );
  }
  if (!args.url) throw new Error('Missing --url (or BENCH_DATABASE_URL)');
  const db = new Client({ connectionString: args.url });
  await db.connect();
  const tenants = await pickTenants(db);
  const results = [];
  for (const q of QUERIES) {
    for (const t of q.once ? [tenants[0]] : tenants) {
      const r = await timeQuery(db, q, q.params(t), args.warmup, args.runs);
      results.push({ tag: q.tag, query: q.name, profile: q.once ? 'global' : t.profile, ...r });
      console.log(
        `${q.tag.padEnd(4)} ${(q.once ? 'global' : t.profile).padEnd(7)} p50=${r.p50}ms p95=${r.p95}ms  ${q.name}`,
      );
    }
  }
  // A failed insert probe must not throw away the query timings above.
  let inserts = null;
  try {
    inserts = await timeInserts(db);
    console.log('inserts (rolled back):', JSON.stringify(inserts));
  } catch (err) {
    console.error(`insert probe failed: ${err.message}`);
  }
  await db.end();
  if (args.json)
    writeFileSync(
      args.json,
      JSON.stringify({ at: new Date().toISOString(), results, inserts }, null, 2),
    );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
