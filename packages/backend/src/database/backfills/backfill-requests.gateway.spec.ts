import { DataSource } from 'typeorm';

import {
  CREATE_LEGACY_FALLBACK_STAGING_SQL,
  CREATE_LEGACY_FALLBACK_GROUPS_SQL,
  DELETE_STAGED_REJECTIONS_SQL,
  FALLBACK_PRIMARY_WINDOW_END_SQL,
  FINALIZE_PENDING_REQUESTS_SQL,
  INSERT_LEGACY_FALLBACK_DIRECT_MEMBERS_SQL,
  INSERT_LEGACY_FALLBACK_INDEXES_SQL,
  INSERT_LEGACY_FALLBACK_MEMBERS_SQL,
  INSERT_LEGACY_FALLBACK_PAIRS_SQL,
  INSERT_LEGACY_FALLBACK_REQUESTS_SQL,
  INSERT_ATTEMPT_REQUESTS_SQL,
  INSERT_REJECTIONS_SQL,
  LINK_ATTEMPTS_SQL,
  LINK_LEGACY_FALLBACK_ATTEMPTS_SQL,
  MARK_REJECTIONS_SQL,
  REFRESH_ATTEMPT_REQUESTS_SQL,
  TypeOrmRequestBackfillGateway,
  REQUEST_BACKFILL_WINDOW_END_SQL,
} from './backfill-requests.gateway';

function mockQueryRunner() {
  return {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(),
  };
}

const timeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 60_000 };
const before = '2026-01-01 00:00:00';

describe('TypeOrmRequestBackfillGateway', () => {
  it('derives every request-level Autofix status during historical backfill', () => {
    const sql = `${INSERT_ATTEMPT_REQUESTS_SQL}\n${REFRESH_ATTEMPT_REQUESTS_SQL}`;
    for (const status of [
      'no_patch',
      'resolving',
      'retry_succeeded',
      'retry_failed',
      'service_error',
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain("autofix_phoenix->>'status'");
    expect(sql).toContain("autofix_phoenix->>'healAttemptId'");
  });

  it('preserves non-outcome attempts when deriving request status', () => {
    const sql = `${INSERT_ATTEMPT_REQUESTS_SQL}\n${REFRESH_ATTEMPT_REQUESTS_SQL}`;
    expect(sql).toContain("WHEN terminal.status IN ('pending', 'cancelled') THEN terminal.status");
    expect(sql).toContain("WHEN status IN ('pending', 'cancelled') THEN status");
  });

  it('precomputes legacy Autofix group sizes once per window', () => {
    expect(LINK_ATTEMPTS_SQL).toContain('target_autofix_groups AS MATERIALIZED');
    expect(LINK_ATTEMPTS_SQL).toContain('autofix_group_stats AS MATERIALIZED');
    expect(LINK_ATTEMPTS_SQL).toContain('LEFT JOIN autofix_group_stats stats');
    expect(LINK_ATTEMPTS_SQL).not.toMatch(/WHEN \(\s*SELECT count\(\*\)/);
  });

  it('scopes request refreshes to parents linked by the current window', () => {
    expect(LINK_ATTEMPTS_SQL).toContain('array_agg(DISTINCT request_id)');
    expect(REFRESH_ATTEMPT_REQUESTS_SQL).toContain('unnest($1::text[])');
    expect(REFRESH_ATTEMPT_REQUESTS_SQL).not.toContain('id > $1');
  });

  it('analyzes attempts and finds keyset window ends', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ end_id: 'attempt-9' }])
      .mockResolvedValueOnce([]);
    const gateway = new TypeOrmRequestBackfillGateway({ query } as unknown as DataSource);

    await gateway.analyze();
    await expect(gateway.nextWindowEnd('attempt-0', 100, before)).resolves.toBe('attempt-9');
    await expect(gateway.nextWindowEnd('attempt-9', 100, before)).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith('ANALYZE "agent_messages"');
    expect(query).toHaveBeenCalledWith(REQUEST_BACKFILL_WINDOW_END_SQL, ['attempt-0', 100, before]);
  });

  it('backfills a window in one timeout-guarded transaction', async () => {
    const runner = mockQueryRunner();
    runner.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ n: 2 }])
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([{ n: 3 }])
      .mockResolvedValueOnce([{ n: 4, request_ids: ['request-1', 'request-2'] }])
      .mockResolvedValueOnce(undefined);
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    await expect(gateway.backfillWindow('a', 'b', before, timeouts)).resolves.toEqual({
      requests: 5,
      attempts: 4,
      rejections: 1,
    });
    expect(runner.query).toHaveBeenNthCalledWith(1, "SET LOCAL lock_timeout = '5000ms'");
    expect(runner.query).toHaveBeenNthCalledWith(2, "SET LOCAL statement_timeout = '60000ms'");
    expect(runner.query).toHaveBeenNthCalledWith(3, INSERT_REJECTIONS_SQL, ['a', 'b', before]);
    expect(runner.query).toHaveBeenNthCalledWith(4, MARK_REJECTIONS_SQL, ['a', 'b', before]);
    expect(runner.query).toHaveBeenNthCalledWith(7, REFRESH_ATTEMPT_REQUESTS_SQL, [
      ['request-1', 'request-2'],
    ]);
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('reconstructs unambiguous legacy fallback chains transactionally', async () => {
    const runner = mockQueryRunner();
    let primaryWindow = 0;
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === FALLBACK_PRIMARY_WINDOW_END_SQL) {
        primaryWindow += 1;
        return [{ end_id: primaryWindow === 1 ? 'primary-z' : null }];
      }
      if (sql.includes('max(pair_seq)')) return [{ max_seq: 1 }];
      if (sql === INSERT_LEGACY_FALLBACK_REQUESTS_SQL) return [{ n: 2 }];
      if (sql === LINK_LEGACY_FALLBACK_ATTEMPTS_SQL) return [{ n: 5 }];
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    const pause = jest.fn().mockResolvedValue(undefined);
    await expect(gateway.backfillFallbackGroups(100, before, timeouts, pause)).resolves.toEqual({
      requests: 2,
      attempts: 5,
    });
    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_STAGING_SQL);
    expect(runner.query).toHaveBeenCalledWith(INSERT_LEGACY_FALLBACK_INDEXES_SQL, [before]);
    expect(runner.query).toHaveBeenCalledWith(INSERT_LEGACY_FALLBACK_PAIRS_SQL, [
      '',
      'primary-z',
      before,
    ]);
    expect(runner.query).toHaveBeenCalledWith(INSERT_LEGACY_FALLBACK_MEMBERS_SQL, [0, 1]);
    expect(runner.query).toHaveBeenCalledWith(INSERT_LEGACY_FALLBACK_DIRECT_MEMBERS_SQL, [0, 1]);
    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_GROUPS_SQL, [0, 1]);
    expect(runner.query).toHaveBeenCalledWith(INSERT_LEGACY_FALLBACK_REQUESTS_SQL);
    expect(runner.query).toHaveBeenCalledWith(LINK_LEGACY_FALLBACK_ATTEMPTS_SQL);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(runner.commitTransaction).toHaveBeenCalled();
  });

  it('reports progress while scanning large fallback histories', async () => {
    const runner = mockQueryRunner();
    let primaryWindow = 0;
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === FALLBACK_PRIMARY_WINDOW_END_SQL) {
        primaryWindow += 1;
        return [{ end_id: primaryWindow <= 25 ? `primary-${primaryWindow}` : null }];
      }
      if (sql.includes('max(pair_seq)')) return [{ max_seq: 0 }];
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);
    const progress = jest.fn();

    await expect(
      gateway.backfillFallbackGroups(100, before, timeouts, jest.fn(), progress),
    ).resolves.toEqual({ requests: 0, attempts: 0 });

    expect(progress).toHaveBeenCalledWith('scanned 25 fallback-primary window(s)');
  });

  it('shrinks a timed-out fallback link batch without rebuilding staged candidates', async () => {
    const runner = mockQueryRunner();
    let primaryWindow = 0;
    let linkAttempt = 0;
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === FALLBACK_PRIMARY_WINDOW_END_SQL) {
        primaryWindow += 1;
        return [{ end_id: primaryWindow === 1 ? 'primary-z' : null }];
      }
      if (sql.includes('max(pair_seq)')) return [{ max_seq: 100 }];
      if (sql === INSERT_LEGACY_FALLBACK_REQUESTS_SQL) return [{ n: 1 }];
      if (sql === LINK_LEGACY_FALLBACK_ATTEMPTS_SQL) {
        linkAttempt += 1;
        if (linkAttempt === 1) {
          throw new Error('canceling statement due to statement timeout');
        }
        return [{ n: 2 }];
      }
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);
    const progress = jest.fn();

    await expect(
      gateway.backfillFallbackGroups(100, before, timeouts, jest.fn(), progress),
    ).resolves.toEqual({ requests: 2, attempts: 4 });

    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_STAGING_SQL);
    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_GROUPS_SQL, [0, 100]);
    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_GROUPS_SQL, [0, 50]);
    expect(runner.query).toHaveBeenCalledWith(CREATE_LEGACY_FALLBACK_GROUPS_SQL, [50, 100]);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('reducing batch size from 100 to 50'),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('linked 100/100 fallback candidate chain(s)'),
    );
  });

  it('handles empty fallback staging results and cleanup failures', async () => {
    const runner = mockQueryRunner();
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === FALLBACK_PRIMARY_WINDOW_END_SQL || sql.includes('max(pair_seq)')) return [];
      if (sql.startsWith('DROP TABLE')) throw new Error('cleanup failed');
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    await expect(gateway.backfillFallbackGroups(100, before, timeouts, jest.fn())).resolves.toEqual(
      { requests: 0, attempts: 0 },
    );
    expect(runner.release).toHaveBeenCalled();
  });

  it('rolls back a fallback group transaction when grouping fails', async () => {
    const runner = mockQueryRunner();
    const failure = new Error('grouping failed');
    let primaryWindow = 0;
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === FALLBACK_PRIMARY_WINDOW_END_SQL) {
        primaryWindow += 1;
        return [{ end_id: primaryWindow === 1 ? 'primary-z' : null }];
      }
      if (sql.includes('max(pair_seq)')) return [{ max_seq: 1 }];
      if (sql === CREATE_LEGACY_FALLBACK_GROUPS_SQL) throw failure;
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    await expect(gateway.backfillFallbackGroups(100, before, timeouts, jest.fn())).rejects.toBe(
      failure,
    );
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('finalizes pending requests without validating the foreign key', async () => {
    const runner = mockQueryRunner();
    runner.query.mockResolvedValue(undefined);
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    await gateway.finalize(timeouts);

    expect(runner.query).toHaveBeenCalledWith(FINALIZE_PENDING_REQUESTS_SQL);
    expect(runner.query).not.toHaveBeenCalledWith(expect.stringContaining('VALIDATE CONSTRAINT'));
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('removes staged rejections in batches before validating deferred constraints', async () => {
    const runner = mockQueryRunner();
    let cleanupBatch = 0;
    runner.query.mockImplementation(async (sql: string) => {
      if (sql === DELETE_STAGED_REJECTIONS_SQL) {
        cleanupBatch += 1;
        if (cleanupBatch === 1) return [{ n: 2 }];
        if (cleanupBatch === 2) return [{ n: 1 }];
        return [];
      }
      return undefined;
    });
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);
    const progress = jest.fn();

    await expect(gateway.finalizeTransition(100, timeouts, progress)).resolves.toBe(3);

    expect(DELETE_STAGED_REJECTIONS_SQL).toContain('pa.request_id = pa.id');
    expect(DELETE_STAGED_REJECTIONS_SQL).toContain('pa.attempt_number IS NULL');
    expect(runner.query.mock.calls.filter(([sql]) => sql === DELETE_STAGED_REJECTIONS_SQL)).toEqual(
      [
        [DELETE_STAGED_REJECTIONS_SQL, [100]],
        [DELETE_STAGED_REJECTIONS_SQL, [100]],
        [DELETE_STAGED_REJECTIONS_SQL, [100]],
      ],
    );
    expect(progress).toHaveBeenNthCalledWith(1, 2);
    expect(progress).toHaveBeenNthCalledWith(2, 3);
    expect(runner.query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '0'");
    expect(runner.query).toHaveBeenCalledWith(
      'ALTER TABLE "agent_messages" VALIDATE CONSTRAINT "FK_agent_messages_request"',
    );
    expect(runner.query).toHaveBeenCalledWith(
      'ALTER TABLE "agent_messages" VALIDATE CONSTRAINT "CHK_agent_messages_attempt_number_positive"',
    );
    expect(runner.commitTransaction).toHaveBeenCalledTimes(4);
    expect(runner.release).toHaveBeenCalledTimes(4);
  });

  it('rolls back and releases when a window fails', async () => {
    const runner = mockQueryRunner();
    const error = new Error('deadlock');
    runner.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error);
    const gateway = new TypeOrmRequestBackfillGateway({
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource);

    await expect(gateway.backfillWindow('a', 'b', before, timeouts)).rejects.toBe(error);
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });
});
