'use strict';

// Run with: node --test scripts/   (Node's built-in test runner; no jest needed)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RAILWAY_GRAPHQL_ENDPOINT,
  HTTP_LOGS_QUERY,
  statusClass,
  getStatus,
  getPath,
  aggregate,
  formatReport,
  parseArgs,
  fetchHttpLogs,
} = require('./railway-http-logs');

test('statusClass buckets each status into its class', () => {
  assert.equal(statusClass(204), '2xx');
  assert.equal(statusClass(301), '3xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
  assert.equal(statusClass(100), 'other');
  assert.equal(statusClass(700), 'other');
  assert.equal(statusClass('nope'), 'other');
});

test('getStatus tolerates httpStatus / status / statusCode variants', () => {
  assert.equal(getStatus({ httpStatus: 401 }), 401);
  assert.equal(getStatus({ status: 404 }), 404);
  assert.equal(getStatus({ statusCode: 429 }), 429);
  assert.ok(Number.isNaN(getStatus({})));
});

test('getPath strips the query string and tolerates path / url variants', () => {
  assert.equal(getPath({ path: '/v1/chat/completions' }), '/v1/chat/completions');
  assert.equal(getPath({ path: '/api/v1/messages?page=2&range=30d' }), '/api/v1/messages');
  assert.equal(getPath({ url: '/assets/app.js?v=abc' }), '/assets/app.js');
  assert.equal(getPath({}), '');
});

test('aggregate counts by status, by class, and by (status, path) sorted desc', () => {
  const records = [
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 404, path: '/wp-login.php' },
    { httpStatus: 302, path: '/api/auth/sign-in/social' },
    { httpStatus: 200, path: '/api/v1/overview' },
  ];
  const agg = aggregate(records);

  assert.equal(agg.total, 6);
  assert.equal(agg.byStatus['401'], 3);
  assert.equal(agg.byClass['4xx'], 4); // three 401 + one 404
  assert.equal(agg.byClass['3xx'], 1);
  assert.equal(agg.byClass['2xx'], 1);

  // Most frequent (status, path) pair comes first.
  assert.deepEqual(agg.byStatusPath[0], {
    status: 401,
    path: '/v1/chat/completions',
    count: 3,
  });
});

test('aggregate ignores records with a non-finite status', () => {
  const agg = aggregate([{ path: '/x' }, { httpStatus: 'oops', path: '/y' }, { httpStatus: 500 }]);
  assert.equal(agg.total, 1);
  assert.equal(agg.byClass['5xx'], 1);
});

test('aggregate groups the same path with differing query strings together', () => {
  const agg = aggregate([
    { httpStatus: 404, path: '/api/v1/agents/a?x=1' },
    { httpStatus: 404, path: '/api/v1/agents/a?x=2' },
  ]);
  assert.equal(agg.byStatusPath.length, 1);
  assert.equal(agg.byStatusPath[0].count, 2);
});

test('formatReport renders totals, class lines, and a capped top table', () => {
  // Distinct counts so ordering is unambiguous: 401(3) > 404(2) > 302(1).
  const agg = aggregate([
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 401, path: '/v1/chat/completions' },
    { httpStatus: 404, path: '/wp-login.php' },
    { httpStatus: 404, path: '/wp-login.php' },
    { httpStatus: 302, path: '/api/auth/x' },
  ]);
  const report = formatReport(agg, { top: 2 });

  assert.match(report, /Total HTTP log records: 6/);
  assert.match(report, /4xx {2}5 {2}\(83\.3%\)/); // three 401 + two 404
  assert.match(report, /3xx {2}1 {2}\(16\.7%\)/);
  assert.match(report, /Top 2 \(status x path\):/);
  assert.match(report, /401 {2}\/v1\/chat\/completions/);
  // Capped at 2 rows → the lowest-count pair (302) is excluded.
  assert.ok(!report.includes('/api/auth/x'));
});

test('formatReport defaults top to 25 and handles an empty aggregate', () => {
  const report = formatReport(aggregate([]));
  assert.match(report, /Total HTTP log records: 0/);
  assert.match(report, /Top 25 \(status x path\):/);
});

test('parseArgs reads flags, applies env fallback, and sets defaults', () => {
  const cfg = parseArgs(
    ['--deployment', 'dep-1', '--filter', '@httpStatus:401', '--limit', '100', '--top', '5'],
    { RAILWAY_API_TOKEN: 'tok-env' },
  );
  assert.equal(cfg.token, 'tok-env');
  assert.equal(cfg.deploymentId, 'dep-1');
  assert.equal(cfg.filter, '@httpStatus:401');
  assert.equal(cfg.limit, 100);
  assert.equal(cfg.top, 5);

  // Defaults when flags are absent.
  const def = parseArgs([], {});
  assert.equal(def.limit, 5000);
  assert.equal(def.top, 25);
  assert.equal(def.token, undefined);

  // Explicit --token and short flags win / are honored.
  const cfg2 = parseArgs(['--token', 'tok-cli', '-d', 'dep-2', '-f', 'x', '-l', '7', '-t', '3'], {
    RAILWAY_TOKEN: 'tok-env2',
  });
  assert.equal(cfg2.token, 'tok-cli');
  assert.equal(cfg2.deploymentId, 'dep-2');
});

test('fetchHttpLogs posts the right query/variables and returns httpLogs', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { data: { httpLogs: [{ httpStatus: 404, path: '/x' }] } };
      },
    };
  };

  const records = await fetchHttpLogs(
    { token: 'tok', deploymentId: 'dep-1', start: 'S', end: 'E', filter: 'F', limit: 42 },
    fakeFetch,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RAILWAY_GRAPHQL_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.query, HTTP_LOGS_QUERY);
  assert.deepEqual(body.variables, {
    deploymentId: 'dep-1',
    startDate: 'S',
    endDate: 'E',
    filter: 'F',
    limit: 42,
  });
  assert.deepEqual(records, [{ httpStatus: 404, path: '/x' }]);
});

test('fetchHttpLogs returns [] when the API yields no logs array', async () => {
  const fakeFetch = async () => ({ ok: true, async json() { return { data: {} }; } });
  const records = await fetchHttpLogs({ token: 't', deploymentId: 'd' }, fakeFetch);
  assert.deepEqual(records, []);
});

test('fetchHttpLogs throws on missing token or deployment', async () => {
  await assert.rejects(() => fetchHttpLogs({ deploymentId: 'd' }, async () => {}), /Missing Railway API token/);
  await assert.rejects(() => fetchHttpLogs({ token: 't' }, async () => {}), /Missing deployment id/);
});

test('fetchHttpLogs surfaces HTTP and GraphQL errors', async () => {
  const httpErr = async () => ({ ok: false, status: 403, async text() { return 'forbidden'; } });
  await assert.rejects(
    () => fetchHttpLogs({ token: 't', deploymentId: 'd' }, httpErr),
    /Railway API HTTP 403: forbidden/,
  );

  const gqlErr = async () => ({
    ok: true,
    async json() {
      return { errors: [{ message: 'bad field' }] };
    },
  });
  await assert.rejects(
    () => fetchHttpLogs({ token: 't', deploymentId: 'd' }, gqlErr),
    /Railway GraphQL error/,
  );
});

test('fetchHttpLogs tolerates a text() failure on a non-ok response', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      throw new Error('stream broke');
    },
  });
  await assert.rejects(
    () => fetchHttpLogs({ token: 't', deploymentId: 'd' }, fakeFetch),
    /Railway API HTTP 500: $/,
  );
});
