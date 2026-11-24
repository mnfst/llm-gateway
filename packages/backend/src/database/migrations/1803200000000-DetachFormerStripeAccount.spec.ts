import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { DetachFormerStripeAccount1803200000000 } from './1803200000000-DetachFormerStripeAccount';

jest.mock('../../common/utils/detect-self-hosted', () => ({ isSelfHosted: jest.fn() }));

const ALL_COLUMNS = [
  { table_name: 'subscription', column_name: 'status' },
  { table_name: 'subscription', column_name: 'stripeCustomerId' },
  { table_name: 'subscription', column_name: 'stripeSubscriptionId' },
  { table_name: 'subscription', column_name: 'stripeScheduleId' },
  { table_name: 'user', column_name: 'stripeCustomerId' },
];

async function run(columns: Array<{ table_name: string; column_name: string }>): Promise<string[]> {
  const query = jest.fn(async (sql: string) =>
    sql.includes('information_schema.columns') ? columns : [],
  );
  await new DetachFormerStripeAccount1803200000000().up({ query } as never);
  return query.mock.calls
    .map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    .filter((sql) => !sql.includes('information_schema'));
}

describe('DetachFormerStripeAccount1803200000000', () => {
  beforeEach(() => jest.mocked(isSelfHosted).mockReturnValue(false));

  it('detaches paid rows, then clears the other ids, then the users', async () => {
    const statements = await run(ALL_COLUMNS);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(`SET "status" = 'legacy_grace', "cancelAtPeriodEnd" = true`);
    expect(statements[0]).toContain(
      `"stripeScheduleId" = NULL WHERE "status" IN ('active', 'trialing', 'past_due') AND "stripeSubscriptionId" IS NOT NULL`,
    );
    expect(statements[0]).not.toContain('"periodEnd"');
    expect(statements[1]).toContain(
      'WHERE "stripeCustomerId" IS NOT NULL OR "stripeSubscriptionId" IS NOT NULL',
    );
    expect(statements[2]).toBe(
      'UPDATE "user" SET "stripeCustomerId" = NULL WHERE "stripeCustomerId" IS NOT NULL',
    );
  });

  it('leaves stripeScheduleId alone on a schema that predates it', async () => {
    const statements = await run(ALL_COLUMNS.filter((c) => c.column_name !== 'stripeScheduleId'));
    expect(statements).toHaveLength(3);
    expect(statements.join(' ')).not.toContain('stripeScheduleId');
  });

  it('skips a database where billing was never enabled', async () => {
    expect(await run([])).toEqual([]);
  });

  it('does nothing on a self-hosted install', async () => {
    jest.mocked(isSelfHosted).mockReturnValue(true);
    const query = jest.fn();
    await new DetachFormerStripeAccount1803200000000().up({ query } as never);
    expect(query).not.toHaveBeenCalled();
  });

  it('cannot be reverted', async () => {
    await expect(new DetachFormerStripeAccount1803200000000().down()).resolves.toBeUndefined();
  });
});
