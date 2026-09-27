import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';

export type BillingEmailLogQueryable = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
};

export interface BillingEmailLogParams {
  dedupeKey: string;
  kind: string;
  tenantId?: string | null;
  userId?: string | null;
  stripeSubscriptionId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  metadata?: Record<string, unknown> | null;
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function queryRows<T>(
  db: BillingEmailLogQueryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return rowsFrom<T>(await db.query(sql, params));
}

export async function hasBillingEmailLog(
  db: BillingEmailLogQueryable,
  dedupeKey: string,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    db,
    `SELECT id FROM billing_email_logs WHERE dedupe_key = $1 LIMIT 1`,
    [dedupeKey],
  );
  return rows.length > 0;
}

export async function tryInsertBillingEmailLog(
  db: BillingEmailLogQueryable,
  params: BillingEmailLogParams,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(
    db,
    `INSERT INTO billing_email_logs
       (id, dedupe_key, kind, tenant_id, user_id, stripe_subscription_id, period_start, period_end, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      uuid(),
      params.dedupeKey,
      params.kind,
      params.tenantId ?? null,
      params.userId ?? null,
      params.stripeSubscriptionId ?? null,
      params.periodStart ?? null,
      params.periodEnd ?? null,
      params.metadata ?? null,
    ],
  );
  return rows.length > 0;
}

@Injectable()
export class BillingEmailLogService {
  constructor(private readonly dataSource: DataSource) {}

  async hasDedupeKey(dedupeKey: string): Promise<boolean> {
    return hasBillingEmailLog(this.dataSource, dedupeKey);
  }

  async tryInsert(params: BillingEmailLogParams): Promise<boolean> {
    return tryInsertBillingEmailLog(this.dataSource, params);
  }
}
