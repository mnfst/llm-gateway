import { INestApplication } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { createTestApp } from './helpers';
import {
  applyStripeAccountMigration,
  planStripeAccountMigration,
  type SqlRunner,
  type TransactionalSqlRunner,
} from '../src/billing/stripe-account-migration';
import { DetachFormerStripeAccount1803200000000 } from '../src/database/migrations/1803200000000-DetachFormerStripeAccount';

/**
 * Runs the one-time Stripe account migration against real PostgreSQL, inside a
 * transaction that is rolled back, so the global UPDATEs never touch the rows
 * other suites rely on.
 */

let app: INestApplication;
let ds: DataSource;
let qr: QueryRunner;

function runner(): TransactionalSqlRunner {
  const query = <T>(sql: string, params?: unknown[]) => qr.query(sql, params) as Promise<T>;
  return {
    query,
    transaction: <T>(work: (tx: SqlRunner) => Promise<T>) => work({ query }),
  };
}

beforeAll(async () => {
  app = await createTestApp();
  ds = app.get(DataSource);
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  qr = ds.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  await qr.query(`CREATE TABLE IF NOT EXISTS "subscription" (
    "id" text PRIMARY KEY,
    "plan" text NOT NULL,
    "referenceId" text NOT NULL,
    "stripeCustomerId" text,
    "stripeSubscriptionId" text,
    "status" text NOT NULL,
    "periodStart" timestamptz,
    "periodEnd" timestamptz,
    "cancelAtPeriodEnd" boolean DEFAULT false
  )`);
  await qr.query(`ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "stripeScheduleId" text`);
  await qr.query(`CREATE TABLE IF NOT EXISTS "user" ("id" text PRIMARY KEY, "email" text)`);
  await qr.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stripeCustomerId" text`);
  await qr.query(`DELETE FROM "subscription"`);
  await qr.query(`UPDATE "user" SET "stripeCustomerId" = NULL`);
  await qr.query(
    `INSERT INTO "user" ("id", "email", "stripeCustomerId") VALUES
       ('mig-u1', 'paid@example.com', 'cus_old1'),
       ('mig-u2', 'free@example.com', 'cus_old2')
     ON CONFLICT ("id") DO UPDATE SET "stripeCustomerId" = EXCLUDED."stripeCustomerId"`,
  );
  await qr.query(
    `INSERT INTO "subscription"
       ("id", "plan", "referenceId", "stripeCustomerId", "stripeSubscriptionId", "status", "periodEnd", "cancelAtPeriodEnd", "stripeScheduleId")
     VALUES
       ('mig-s1', 'pro', 'mig-u1', 'cus_old1', 'sub_old1', 'active', '2099-01-15T00:00:00Z', false, 'sub_sched_1'),
       ('mig-s2', 'pro', 'mig-u2', 'cus_old2', 'sub_old2', 'canceled', '2026-10-01T00:00:00Z', false, NULL),
       ('mig-s3', 'pro', 'mig-u2', 'cus_old2', NULL, 'incomplete', NULL, false, NULL)`,
  );
});

afterEach(async () => {
  await qr.rollbackTransaction();
  await qr.release();
});

describe('Stripe account migration (PostgreSQL)', () => {
  it('plans the paid row, the other rows and the users', async () => {
    const plan = await planStripeAccountMigration(runner());
    expect(plan.paidSubscriptions.map((row) => [row.id, row.email])).toEqual([
      ['mig-s1', 'paid@example.com'],
    ]);
    expect(plan.otherSubscriptionRows).toBe(2);
    expect(plan.usersWithCustomerId).toBeGreaterThanOrEqual(2);
  });

  it('detaches paid rows, clears every Stripe id and is idempotent', async () => {
    await applyStripeAccountMigration(runner());

    const rows = await qr.query(
      `SELECT "id", "status", "stripeCustomerId", "stripeSubscriptionId", "stripeScheduleId",
              "cancelAtPeriodEnd", "periodEnd"
         FROM "subscription" ORDER BY "id"`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'mig-s1',
        status: 'legacy_grace',
        cancelAtPeriodEnd: true,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeScheduleId: null,
        periodEnd: new Date('2099-01-15T00:00:00Z'),
      }),
      expect.objectContaining({
        id: 'mig-s2',
        status: 'canceled',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }),
      expect.objectContaining({ id: 'mig-s3', status: 'incomplete', stripeCustomerId: null }),
    ]);

    const after = await planStripeAccountMigration(runner());
    expect(after).toEqual({
      paidSubscriptions: [],
      otherSubscriptionRows: 0,
      usersWithCustomerId: 0,
    });

    await applyStripeAccountMigration(runner());
    const again = await qr.query(`SELECT "status" FROM "subscription" WHERE "id" = 'mig-s1'`);
    expect(again[0].status).toBe('legacy_grace');
  });

  it('the TypeORM migration writes the same result as the CLI', async () => {
    const prev = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = 'cloud';
    try {
      await new DetachFormerStripeAccount1803200000000().up(qr);
    } finally {
      if (prev === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = prev;
    }

    const rows = await qr.query(
      `SELECT "id", "status", "cancelAtPeriodEnd", "stripeCustomerId", "stripeSubscriptionId", "periodEnd"
         FROM "subscription" ORDER BY "id"`,
    );
    expect(rows.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ['mig-s1', 'legacy_grace'],
      ['mig-s2', 'canceled'],
      ['mig-s3', 'incomplete'],
    ]);
    expect(rows[0].periodEnd).toEqual(new Date('2099-01-15T00:00:00Z'));
    expect(rows[0].cancelAtPeriodEnd).toBe(true);
    expect(rows.every((r: { stripeCustomerId: unknown }) => r.stripeCustomerId === null)).toBe(
      true,
    );
    expect(await planStripeAccountMigration(runner())).toEqual({
      paidSubscriptions: [],
      otherSubscriptionRows: 0,
      usersWithCustomerId: 0,
    });
  });
});
