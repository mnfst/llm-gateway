import { QueryRunner } from 'typeorm';
import { AddBillingEmailLogs1798200000000 } from './1798200000000-AddBillingEmailLogs';

describe('AddBillingEmailLogs1798200000000', () => {
  let migration: AddBillingEmailLogs1798200000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddBillingEmailLogs1798200000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  it('creates the billing email log table and dedupe indexes', async () => {
    await migration.up(queryRunner as unknown as QueryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "billing_email_logs"');
    expect(sql).toContain('"dedupe_key" varchar NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "IDX_billing_email_logs_dedupe_key"');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_billing_email_logs_tenant_period" ON "billing_email_logs" ("tenant_id", "period_start") WHERE "tenant_id" IS NOT NULL',
    );
  });

  it('drops indexes before dropping the table', async () => {
    await migration.down(queryRunner as unknown as QueryRunner);

    expect(queryRunner.query.mock.calls.map(([statement]) => String(statement))).toEqual([
      'DROP INDEX IF EXISTS "IDX_billing_email_logs_tenant_period"',
      'DROP INDEX IF EXISTS "IDX_billing_email_logs_dedupe_key"',
      'DROP TABLE IF EXISTS "billing_email_logs"',
    ]);
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddBillingEmailLogs1798200000000');
  });
});
