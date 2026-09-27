import { DataSource } from 'typeorm';
import { runRequestBackfill } from '../src/database/backfills/backfill-requests';
import { TypeOrmRequestBackfillGateway } from '../src/database/backfills/backfill-requests.gateway';
import { AddRequestsAndProviderAttempts1801000000000 } from '../src/database/migrations/1801000000000-AddRequestsAndProviderAttempts';
import { AddProviderAttemptOrdering1801100000000 } from '../src/database/migrations/1801100000000-AddProviderAttemptOrdering';

interface LegacyAttempt {
  id: string;
  timestamp: string;
  status: string;
  model: string;
  fallbackFrom?: string;
  fallbackIndex?: number;
  superseded?: boolean;
  autofixGroup?: string;
  autofixApplied?: boolean;
  autofixRole?: string;
  autofixDecision?: object;
  errorOrigin?: string;
  requestParams?: object;
  traceId?: string;
  sessionKey?: string;
  sessionId?: string;
}

describe('request backfill legacy fallback reconstruction (e2e)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DROP SCHEMA public CASCADE');
    await dataSource.query('CREATE SCHEMA public');
    await dataSource.query(`
      CREATE TABLE agent_messages (
        id varchar PRIMARY KEY,
        tenant_id varchar,
        agent_id varchar,
        user_id varchar,
        agent_name varchar,
        trace_id varchar,
        session_key varchar,
        session_id varchar,
        timestamp timestamp NOT NULL,
        duration_ms integer,
        status varchar NOT NULL,
        error_message varchar,
        error_http_status integer,
        error_code varchar(8),
        error_origin varchar,
        error_class varchar,
        model varchar,
        caller_attribution text,
        request_headers text,
        request_params jsonb,
        feedback_rating varchar,
        feedback_tags varchar,
        feedback_details text,
        autofix_group_id varchar,
        autofix_applied boolean DEFAULT false,
        autofix_role varchar,
        autofix_phoenix jsonb,
        superseded boolean DEFAULT false,
        fallback_from_model varchar,
        fallback_index integer
      )
    `);
    const runner = dataSource.createQueryRunner();
    try {
      await new AddRequestsAndProviderAttempts1801000000000().up(runner);
      await new AddProviderAttemptOrdering1801100000000().up(runner);
    } finally {
      await runner.release();
    }
  });

  async function insertAttempt(attempt: LegacyAttempt): Promise<void> {
    await dataSource.query(
      `INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, duration_ms, status,
        model, fallback_from_model, fallback_index, superseded,
        autofix_group_id, autofix_applied, autofix_role, autofix_phoenix,
        error_origin, caller_attribution, request_headers,
        request_params, trace_id, session_key, session_id
      ) VALUES (
        $1, 'tenant-1', 'agent-1', 'Agent', $2, 100, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, '{"agent":"openai-sdk"}',
        '{"content-type":"application/json"}', $13, $14, $15, $16
      )`,
      [
        attempt.id,
        attempt.timestamp,
        attempt.status,
        attempt.model,
        attempt.fallbackFrom ?? null,
        attempt.fallbackIndex ?? null,
        attempt.superseded ?? false,
        attempt.autofixGroup ?? null,
        attempt.autofixApplied ?? false,
        attempt.autofixRole ?? null,
        attempt.autofixDecision ?? null,
        attempt.errorOrigin ?? null,
        attempt.requestParams ?? { model: 'openai/gpt-4o' },
        attempt.traceId ?? null,
        attempt.sessionKey ?? null,
        attempt.sessionId ?? null,
      ],
    );
  }

  async function backfill(
    options: {
      batchSize?: number;
      before?: string;
      fallbackBefore?: string;
      finalize?: boolean;
    } = {},
  ): Promise<void> {
    await runRequestBackfill(new TypeOrmRequestBackfillGateway(dataSource), {
      batchSize: options.batchSize ?? 2,
      throttleMs: 0,
      before: options.before,
      fallbackBefore: options.fallbackBefore,
      finalize: options.finalize,
    });
  }

  it('stages Manifest rejections without deleting their legacy rows', async () => {
    const expected = [
      { id: 'manifest-config', error_code: 'M100', error_origin: 'config' },
      { id: 'manifest-internal', error_code: 'M500', error_origin: 'internal' },
      { id: 'manifest-policy', error_code: 'M201', error_origin: 'policy' },
      { id: 'manifest-request', error_code: 'M300', error_origin: 'request' },
    ];
    await dataSource.query(`
      INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, duration_ms, status,
        error_code, error_origin, error_class, model
      ) VALUES
        ('manifest-config', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:00.000', 0, 'error', 'M100', 'config', 'no_provider_key', 'auto'),
        ('manifest-policy', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:01.000', 0, 'rate_limited', 'M201', 'policy', 'rate_limit', 'auto'),
        ('manifest-request', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:02.000', 0, 'error', 'M300', 'request', 'invalid_request', 'auto'),
        ('manifest-internal', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:03.000', 0, 'error', 'M500', 'internal', 'internal_error', 'auto')
    `);

    await backfill({ batchSize: 1 });
    const legacyRows = await dataSource.query(`
      SELECT id, request_id, attempt_number, error_code, error_origin
      FROM agent_messages
      ORDER BY id
    `);
    const requestRows = await dataSource.query(`
      SELECT id, status, error_code, error_origin
      FROM requests
      ORDER BY id
    `);

    expect(legacyRows).toEqual(
      expected.map((row) => ({ ...row, request_id: row.id, attempt_number: null })),
    );
    expect(requestRows).toEqual(expected.map((row) => ({ ...row, status: 'failed' })));
  });

  it('removes staged Manifest rejections and validates constraints at transition completion', async () => {
    await dataSource.query(`
      INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, duration_ms, status,
        error_code, error_origin, error_class, model
      ) VALUES
        ('manifest-config', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:00.000', 0, 'error', 'M100', 'config', 'no_provider_key', 'auto'),
        ('provider-error', 'tenant-1', 'agent-1', 'Agent',
         '2026-01-01 00:00:01.000', 100, 'error', NULL, 'provider', 'server_error', 'gpt-4o')
    `);
    await backfill({ batchSize: 1 });

    const gateway = new TypeOrmRequestBackfillGateway(dataSource);
    await expect(
      gateway.finalizeTransition(1, {
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      }),
    ).resolves.toBe(1);

    const attempts = await dataSource.query(`
      SELECT id, request_id, attempt_number
      FROM agent_messages
      ORDER BY id
    `);
    const [{ requests }] = await dataSource.query(`SELECT count(*)::int AS requests FROM requests`);
    const constraints = await dataSource.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname IN (
        'FK_agent_messages_request',
        'CHK_agent_messages_attempt_number_positive'
      )
      ORDER BY conname
    `);

    expect(attempts).toEqual([
      { id: 'provider-error', request_id: 'provider-error', attempt_number: 1 },
    ]);
    expect(requests).toBe(2);
    expect(constraints).toEqual([
      { conname: 'CHK_agent_messages_attempt_number_positive', convalidated: true },
      { conname: 'FK_agent_messages_request', convalidated: true },
    ]);
  });

  it('refreshes only requests linked by the current sparse window', async () => {
    await insertAttempt({
      id: 'a-linked',
      timestamp: '2026-01-01 00:00:00.000',
      status: 'ok',
      model: 'openai/gpt-4o',
    });
    await backfill({ batchSize: 1 });
    await dataSource.query(`UPDATE requests SET duration_ms = 999 WHERE id = 'a-linked'`);

    await insertAttempt({
      id: 'z-delta',
      timestamp: '2026-01-01 00:00:01.000',
      status: 'ok',
      model: 'openai/gpt-4o',
    });
    await backfill({ batchSize: 1 });

    const requests = await dataSource.query(`SELECT id, duration_ms FROM requests ORDER BY id`);
    expect(requests).toEqual([
      { id: 'a-linked', duration_ms: 999 },
      { id: 'z-delta', duration_ms: 100 },
    ]);
  });

  it('groups a recovered fallback chain without traceparent', async () => {
    await insertAttempt({
      id: 'recovered-primary',
      timestamp: '2026-01-01 00:00:00.000',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'recovered-fallback-0',
      timestamp: '2026-01-01 00:00:00.200',
      status: 'fallback_error',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'recovered-fallback-1',
      timestamp: '2026-01-01 00:00:00.100',
      status: 'fallback_error',
      model: 'google/gemini-flash',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 1,
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'recovered-terminal',
      timestamp: '2026-01-01 00:00:00.300',
      status: 'ok',
      model: 'google/gemini-pro',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 2,
    });

    await backfill({ batchSize: 1 });

    const [request] = await dataSource.query(
      `SELECT status, requested_model, duration_ms FROM requests`,
    );
    const [{ parents, attempts }] = await dataSource.query(
      `SELECT count(DISTINCT request_id)::int parents, count(*)::int attempts
       FROM agent_messages`,
    );
    expect({ ...request, parents, attempts }).toEqual({
      status: 'success',
      requested_model: 'openai/gpt-4o',
      duration_ms: 400,
      parents: 1,
      attempts: 4,
    });
  });

  it('groups an exhausted fallback chain around its legacy primary anchor', async () => {
    await insertAttempt({
      id: 'exhausted-fallback-0',
      timestamp: '2026-01-01 00:01:00.200',
      status: 'fallback_error',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'exhausted-terminal',
      timestamp: '2026-01-01 00:01:00.100',
      status: 'error',
      model: 'google/gemini-pro',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 1,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'exhausted-primary',
      timestamp: '2026-01-01 00:01:00.300',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
    });

    await backfill();

    const [request] = await dataSource.query(`SELECT status, requested_model FROM requests`);
    const [{ parents }] = await dataSource.query(
      `SELECT count(DISTINCT request_id)::int parents FROM agent_messages`,
    );
    expect({ ...request, parents }).toEqual({
      status: 'failed',
      requested_model: 'openai/gpt-4o',
      parents: 1,
    });
  });

  it('leaves ambiguous fallback signatures as separate synthetic requests', async () => {
    for (const id of ['ambiguous-primary-a', 'ambiguous-primary-b']) {
      await insertAttempt({
        id,
        timestamp: '2026-01-01 00:02:00.000',
        status: 'fallback_error',
        model: 'openai/gpt-4o',
        superseded: true,
        errorOrigin: 'provider',
      });
    }
    await insertAttempt({
      id: 'ambiguous-terminal',
      timestamp: '2026-01-01 00:02:00.100',
      status: 'ok',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
    });

    await backfill();

    const [{ requests, parents }] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM requests) requests,
              (SELECT count(DISTINCT request_id)::int FROM agent_messages) parents`,
    );
    expect({ requests, parents }).toEqual({ requests: 3, parents: 3 });
  });

  it('does not reconstruct a fallback chain across trace or session identity', async () => {
    await insertAttempt({
      id: 'identity-primary',
      timestamp: '2026-01-01 00:02:30.000',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
      traceId: 'trace-a',
      sessionKey: 'session-key-a',
      sessionId: 'session-a',
    });
    await insertAttempt({
      id: 'identity-terminal',
      timestamp: '2026-01-01 00:02:30.100',
      status: 'ok',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
      traceId: 'trace-b',
      sessionKey: 'session-key-b',
      sessionId: 'session-b',
    });

    await backfill();

    const [{ requests, parents, fallbackRequests }] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM requests) requests,
              (SELECT count(DISTINCT request_id)::int FROM agent_messages) parents,
              (SELECT count(*)::int FROM requests
               WHERE id LIKE 'legacy-fallback-%') AS "fallbackRequests"`,
    );
    expect({ requests, parents, fallbackRequests }).toEqual({
      requests: 2,
      parents: 2,
      fallbackRequests: 0,
    });
  });

  it('does not attach a fallback member from another trace or session', async () => {
    const identity = {
      traceId: 'trace-a',
      sessionKey: 'session-key-a',
      sessionId: 'session-a',
    };
    await insertAttempt({
      id: 'member-primary',
      timestamp: '2026-01-01 00:02:40.000',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
      ...identity,
    });
    await insertAttempt({
      id: 'foreign-member',
      timestamp: '2026-01-01 00:02:40.200',
      status: 'fallback_error',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
      superseded: true,
      errorOrigin: 'provider',
      traceId: 'trace-b',
      sessionKey: 'session-key-b',
      sessionId: 'session-b',
    });
    await insertAttempt({
      id: 'member-terminal',
      timestamp: '2026-01-01 00:02:40.300',
      status: 'ok',
      model: 'google/gemini-pro',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 2,
      ...identity,
    });

    await backfill();

    const rows = (await dataSource.query(
      `SELECT r.id, count(pa.id)::int AS attempts
       FROM requests r
       JOIN agent_messages pa ON pa.request_id = r.id
       GROUP BY r.id
       ORDER BY attempts DESC`,
    )) as { id: string; attempts: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: expect.stringMatching(/^legacy-fallback-/), attempts: 2 });
    expect(rows[1]).toEqual({ id: expect.not.stringMatching(/^legacy-fallback-/), attempts: 1 });
  });

  it('rejects member ambiguity that spans separate source batches', async () => {
    await insertAttempt({
      id: 'cross-batch-primary-a',
      timestamp: '2026-01-01 00:04:00.000',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'cross-batch-primary-b',
      timestamp: '2026-01-01 00:04:00.100',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'cross-batch-shared-member',
      timestamp: '2026-01-01 00:04:00.200',
      status: 'fallback_error',
      model: 'anthropic/claude-sonnet',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 0,
      superseded: true,
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'cross-batch-terminal-a',
      timestamp: '2026-01-01 00:04:00.300',
      status: 'ok',
      model: 'google/gemini-pro',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 2,
    });
    await insertAttempt({
      id: 'cross-batch-terminal-b',
      timestamp: '2026-01-01 00:04:00.300',
      status: 'ok',
      model: 'mistral/large',
      fallbackFrom: 'openai/gpt-4o',
      fallbackIndex: 1,
    });

    await backfill({ batchSize: 1 });

    const [{ requests, parents }] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM requests) requests,
              (SELECT count(DISTINCT request_id)::int FROM agent_messages) parents`,
    );
    expect({ requests, parents }).toEqual({ requests: 5, parents: 5 });
  });

  it('waits for a late old-replica terminal before linking its primary', async () => {
    await dataSource.query(`
      INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, duration_ms, status,
        model, superseded, error_origin, caller_attribution, request_headers, request_params
      ) VALUES (
        'late-primary', 'tenant-1', 'agent-1', 'Agent',
        '2026-01-01 00:05:00.000', 100, 'fallback_error', 'openai/gpt-4o', true,
        'provider', '{"agent":"openai-sdk"}', '{"content-type":"application/json"}',
        '{"model":"openai/gpt-4o"}'::jsonb
      )
    `);
    await dataSource.query(`
      INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, duration_ms, status,
        model, fallback_from_model, fallback_index, superseded,
        caller_attribution, request_headers, request_params
      ) VALUES (
        'late-terminal', 'tenant-1', 'agent-1', 'Agent',
        '2026-01-01 00:05:00.100', 100, 'ok', 'anthropic/claude-sonnet',
        'openai/gpt-4o', 0, false, '{"agent":"openai-sdk"}',
        '{"content-type":"application/json"}', '{"model":"openai/gpt-4o"}'::jsonb
      )
    `);

    await backfill({
      batchSize: 1,
      fallbackBefore: '2026-01-01 00:05:00.050',
      before: '2025-12-31 23:55:00.000',
    });
    const [{ unlinkedAfterFirstSweep }] = await dataSource.query(
      `SELECT count(*)::int AS "unlinkedAfterFirstSweep"
       FROM agent_messages WHERE request_id IS NULL`,
    );
    expect(unlinkedAfterFirstSweep).toBe(2);

    await backfill({
      batchSize: 1,
      fallbackBefore: '2026-01-01 00:06:00.000',
      before: '2026-01-01 00:05:30.000',
    });
    const [{ requests, parents, unlinked }] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM requests) requests,
              (SELECT count(DISTINCT request_id)::int FROM agent_messages) parents,
              (SELECT count(*)::int FROM agent_messages WHERE request_id IS NULL) unlinked`,
    );
    expect({ requests, parents, unlinked }).toEqual({ requests: 1, parents: 1, unlinked: 0 });
  });

  it('keeps the legacy table and column shape writable after the additive migrations', async () => {
    const [relation] = await dataSource.query(`
      SELECT c.relkind,
             to_regclass('public.provider_attempts')::text AS renamed_relation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'agent_messages'
    `);
    expect(relation).toEqual({ relkind: 'r', renamed_relation: null });

    await dataSource.query(`
      INSERT INTO agent_messages (
        id, tenant_id, agent_id, agent_name, timestamp, status, model, autofix_phoenix
      ) VALUES (
        'old-replica', 'tenant-1', 'agent-1', 'Agent',
        '2026-01-01 00:05:00.000', 'error', 'openai/gpt-4o',
        '{"status":"no_patch","issueId":"issue-1"}'::jsonb
      )
    `);
    await dataSource.query(`
      UPDATE agent_messages
      SET status = 'ok', autofix_phoenix = '{"status":"no_patch","issueId":"issue-2"}'::jsonb
      WHERE id = 'old-replica'
    `);

    const [attempt] = await dataSource.query(
      `SELECT status, autofix_phoenix, request_id, attempt_number
       FROM agent_messages WHERE id = 'old-replica'`,
    );
    expect(attempt).toEqual({
      status: 'ok',
      autofix_phoenix: { status: 'no_patch', issueId: 'issue-2' },
      request_id: null,
      attempt_number: null,
    });
  });

  it('finalizes an incomplete fallback chain during a tail sweep', async () => {
    await insertAttempt({
      id: 'incomplete-primary',
      timestamp: '2026-01-01 00:06:00.000',
      status: 'fallback_error',
      model: 'openai/gpt-4o',
      superseded: true,
      errorOrigin: 'provider',
    });

    await backfill({
      before: '2026-01-01 00:07:00.000',
      fallbackBefore: '2026-01-01 00:07:00.000',
      finalize: true,
    });

    const [request] = await dataSource.query(`SELECT status FROM requests`);
    expect(request).toEqual({ status: 'failed' });
  });

  it('preserves ordinary and Autofix grouping behavior', async () => {
    await insertAttempt({
      id: 'plain',
      timestamp: '2026-01-01 00:03:00.000',
      status: 'ok',
      model: 'openai/gpt-4o',
    });
    await insertAttempt({
      id: 'autofix-original',
      timestamp: '2026-01-01 00:03:01.000',
      status: 'auto_fixed',
      model: 'openai/gpt-4o',
      superseded: true,
      autofixGroup: 'heal-1',
      errorOrigin: 'provider',
    });
    await insertAttempt({
      id: 'autofix-retry',
      timestamp: '2026-01-01 00:03:01.100',
      status: 'ok',
      model: 'openai/gpt-4o',
      autofixGroup: 'heal-1',
    });

    await backfill();

    const [{ requests, parents, ordered }] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM requests) requests,
              (SELECT count(DISTINCT request_id)::int FROM agent_messages) parents,
              (SELECT array_agg(attempt_number ORDER BY attempt_number)
               FROM agent_messages
               WHERE autofix_group_id = 'heal-1') ordered`,
    );
    expect({ requests, parents, ordered }).toEqual({
      requests: 2,
      parents: 2,
      ordered: [1, 2],
    });
  });

  it('backfills each recorded Autofix outcome onto its request', async () => {
    const base = {
      timestamp: '2026-01-01 00:03:00.000',
      status: 'error',
      model: 'openai/gpt-4o',
      errorOrigin: 'provider',
      autofixApplied: true,
    };
    await insertAttempt({
      ...base,
      id: 'no-patch',
      autofixDecision: { status: 'no_patch', issueId: 'issue-no-patch' },
    });
    await insertAttempt({
      ...base,
      id: 'resolving',
      autofixDecision: { status: 'resolving', issueId: 'issue-resolving' },
    });
    await insertAttempt({ ...base, id: 'service-error' });
    await insertAttempt({
      ...base,
      id: 'legacy-no-patch',
      autofixDecision: { issueId: 'legacy-issue' },
    });
    await insertAttempt({
      ...base,
      id: 'retry-success-original',
      status: 'auto_fixed',
      superseded: true,
      autofixGroup: 'success-group',
      autofixRole: 'original',
      autofixDecision: { status: 'patched', healAttemptId: 'heal-success' },
    });
    await insertAttempt({
      ...base,
      id: 'retry-success',
      timestamp: '2026-01-01 00:03:00.100',
      status: 'ok',
      autofixGroup: 'success-group',
      autofixRole: 'retry',
    });
    await insertAttempt({
      ...base,
      id: 'retry-failed',
      autofixGroup: 'failed-group',
      autofixRole: 'retry',
      autofixDecision: { status: 'patched', healAttemptId: 'heal-failed' },
    });

    await backfill({ batchSize: 1 });

    const rows = await dataSource.query(`
      SELECT pa.id, r.autofix_status
      FROM agent_messages pa
      JOIN requests r ON r.id = pa.request_id
      WHERE pa.id IN (
        'no-patch', 'resolving', 'service-error', 'legacy-no-patch',
        'retry-success', 'retry-failed'
      )
      ORDER BY pa.id
    `);
    expect(rows).toEqual([
      { id: 'legacy-no-patch', autofix_status: 'no_patch' },
      { id: 'no-patch', autofix_status: 'no_patch' },
      { id: 'resolving', autofix_status: 'resolving' },
      { id: 'retry-failed', autofix_status: 'retry_failed' },
      { id: 'retry-success', autofix_status: 'retry_succeeded' },
      { id: 'service-error', autofix_status: 'service_error' },
    ]);
  });
});
