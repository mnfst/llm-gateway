#!/usr/bin/env node
'use strict';

/**
 * Railway HTTP-log aggregator.
 *
 * Pulls a deployment's edge HTTP request logs from Railway's public GraphQL
 * API and prints a status×path breakdown — the "top offending routes" view the
 * Observability UI can't produce (it has no server-side GROUP BY). Use it to
 * turn the raw 2xx/3xx/4xx metric split into "which status on which route".
 *
 * Usage:
 *   RAILWAY_API_TOKEN=... RAILWAY_DEPLOYMENT_ID=... node scripts/railway-http-logs.js \
 *     --start 2026-06-24T00:00:00Z --end 2026-06-24T01:00:00Z \
 *     --filter '@httpStatus:401 OR @httpStatus:404' --top 30
 *
 * Flags (all optional except token + deployment, which may come from env):
 *   --token <t>        Railway API token        (env RAILWAY_API_TOKEN / RAILWAY_TOKEN)
 *   --deployment <id>  Deployment id            (env RAILWAY_DEPLOYMENT_ID)
 *   --start <iso>      Window start (ISO 8601)
 *   --end <iso>        Window end (ISO 8601)
 *   --filter <expr>    Railway log filter, e.g. '@httpStatus:401'
 *   --limit <n>        Max records to fetch     (default 5000)
 *   --top <n>          Rows in the status×path table (default 25)
 *
 * Note: the GraphQL field/arg names below follow Railway's public API. The API
 * evolves — if a field errors, confirm the current names via GraphQL
 * introspection and adjust HTTP_LOGS_QUERY. The aggregation tolerates a few
 * common field-name variants so a rename doesn't silently zero the counts.
 */

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';

const HTTP_LOGS_QUERY = `query HttpLogs($deploymentId: String!, $startDate: String, $endDate: String, $filter: String, $limit: Int) {
  httpLogs(deploymentId: $deploymentId, startDate: $startDate, endDate: $endDate, filter: $filter, limit: $limit) {
    timestamp
    method
    path
    host
    httpStatus
    clientUa
    srcIp
    upstreamRqDuration
  }
}`;

/** Bucket a numeric status into its class label. */
function statusClass(status) {
  const s = Number(status);
  if (!Number.isFinite(s)) return 'other';
  if (s >= 200 && s < 300) return '2xx';
  if (s >= 300 && s < 400) return '3xx';
  if (s >= 400 && s < 500) return '4xx';
  if (s >= 500 && s < 600) return '5xx';
  return 'other';
}

/** Read the status off a record, tolerant to a few Railway field-name variants. */
function getStatus(record) {
  return Number(record.httpStatus ?? record.status ?? record.statusCode);
}

/** Read the path, dropping the query string so /x?a=1 and /x?a=2 aggregate together. */
function getPath(record) {
  const raw = String(record.path ?? record.requestPath ?? record.url ?? '');
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Group records into per-status counts, per-class counts, and a (status, path)
 * table sorted by count desc. Records without a finite status are ignored.
 */
function aggregate(records) {
  const byStatus = {};
  const pairs = new Map();
  let total = 0;
  for (const r of records) {
    const status = getStatus(r);
    if (!Number.isFinite(status)) continue;
    total += 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    const path = getPath(r);
    const key = `${status} ${path}`;
    const existing = pairs.get(key);
    if (existing) existing.count += 1;
    else pairs.set(key, { status, path, count: 1 });
  }
  const byStatusPath = Array.from(pairs.values()).sort(
    (a, b) => b.count - a.count || a.status - b.status,
  );
  const byClass = {};
  for (const [status, count] of Object.entries(byStatus)) {
    const cls = statusClass(status);
    byClass[cls] = (byClass[cls] || 0) + count;
  }
  return { total, byStatus, byClass, byStatusPath };
}

/** Render an aggregate as a human-readable report. */
function formatReport(agg, options = {}) {
  const top = options.top ?? 25;
  const lines = [];
  lines.push(`Total HTTP log records: ${agg.total}`);
  lines.push('');
  lines.push('By status class:');
  for (const cls of ['2xx', '3xx', '4xx', '5xx', 'other']) {
    if (agg.byClass[cls]) {
      const pct = agg.total ? ((agg.byClass[cls] / agg.total) * 100).toFixed(1) : '0.0';
      lines.push(`  ${cls}  ${agg.byClass[cls]}  (${pct}%)`);
    }
  }
  lines.push('');
  lines.push(`Top ${top} (status x path):`);
  lines.push('  count  status  path');
  for (const row of agg.byStatusPath.slice(0, top)) {
    lines.push(
      `  ${String(row.count).padStart(5)}  ${String(row.status).padStart(6)}  ${row.path}`,
    );
  }
  return lines.join('\n');
}

/** Parse argv (process.argv.slice(2)) + env into a config object. */
function parseArgs(argv, env = {}) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--token') a.token = argv[++i];
    else if (flag === '--deployment' || flag === '-d') a.deploymentId = argv[++i];
    else if (flag === '--start') a.start = argv[++i];
    else if (flag === '--end') a.end = argv[++i];
    else if (flag === '--filter' || flag === '-f') a.filter = argv[++i];
    else if (flag === '--limit' || flag === '-l') a.limit = Number(argv[++i]);
    else if (flag === '--top' || flag === '-t') a.top = Number(argv[++i]);
  }
  return {
    token: a.token ?? env.RAILWAY_API_TOKEN ?? env.RAILWAY_TOKEN,
    deploymentId: a.deploymentId ?? env.RAILWAY_DEPLOYMENT_ID,
    start: a.start,
    end: a.end,
    filter: a.filter,
    limit: Number.isFinite(a.limit) ? a.limit : 5000,
    top: Number.isFinite(a.top) ? a.top : 25,
  };
}

/** Fetch raw HTTP-log records from Railway. fetchImpl is injectable for testing. */
async function fetchHttpLogs(config, fetchImpl = globalThis.fetch) {
  if (!config.token) {
    throw new Error('Missing Railway API token (--token or RAILWAY_API_TOKEN)');
  }
  if (!config.deploymentId) {
    throw new Error('Missing deployment id (--deployment or RAILWAY_DEPLOYMENT_ID)');
  }
  const res = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      query: HTTP_LOGS_QUERY,
      variables: {
        deploymentId: config.deploymentId,
        startDate: config.start,
        endDate: config.end,
        filter: config.filter,
        limit: config.limit,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Railway API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Railway GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  const logs = json.data && json.data.httpLogs;
  return Array.isArray(logs) ? logs : [];
}

// CLI entrypoint — thin glue over the exported, unit-tested units
// (parseArgs / fetchHttpLogs / aggregate / formatReport).
async function main() {
  const config = parseArgs(process.argv.slice(2), process.env);
  let records;
  try {
    records = await fetchHttpLogs(config);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.log(formatReport(aggregate(records), { top: config.top }));
}

// Only runs when invoked directly, not when imported by the test file.
if (require.main === module) {
  main();
}

module.exports = {
  RAILWAY_GRAPHQL_ENDPOINT,
  HTTP_LOGS_QUERY,
  statusClass,
  getStatus,
  getPath,
  aggregate,
  formatReport,
  parseArgs,
  fetchHttpLogs,
};
