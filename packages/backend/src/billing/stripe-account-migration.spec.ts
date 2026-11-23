import {
  applyStripeAccountMigration,
  CLEAR_OTHER_SQL,
  CLEAR_USERS_SQL,
  DETACH_PAID_SQL,
  describeStripeAccountMigration,
  planStripeAccountMigration,
  type SqlRunner,
} from './stripe-account-migration';

describe('stripe-account-migration', () => {
  it('plans from the paid rows, the other rows and the users', async () => {
    const paid = [
      {
        id: 's1',
        referenceId: 'u1',
        email: 'a@example.com',
        status: 'active',
        plan: 'pro',
        periodEnd: '2026-12-15T00:00:00.000Z',
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(paid)
      .mockResolvedValueOnce([{ n: '3' }])
      .mockResolvedValueOnce([{ n: 7 }]);

    const plan = await planStripeAccountMigration({ query } as SqlRunner);

    expect(plan).toEqual({
      paidSubscriptions: paid,
      otherSubscriptionRows: 3,
      usersWithCustomerId: 7,
    });
    expect(query.mock.calls[0][0]).toContain(`s."status" IN ('active', 'trialing', 'past_due')`);
    expect(query.mock.calls[0][0]).toContain('s."stripeSubscriptionId" IS NOT NULL');
    expect(query.mock.calls[1][0]).toContain('NOT (');
    expect(query.mock.calls[2][0]).toContain('FROM "user"');
  });

  it('counts zero when a count query returns no row', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const plan = await planStripeAccountMigration({ query } as SqlRunner);
    expect(plan).toEqual({
      paidSubscriptions: [],
      otherSubscriptionRows: 0,
      usersWithCustomerId: 0,
    });
  });

  it('detaches paid rows before clearing the other ids, in one transaction', async () => {
    const txQuery = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn(async (work: (runner: SqlRunner) => Promise<void>) =>
      work({ query: txQuery } as SqlRunner),
    );

    await applyStripeAccountMigration({ query: jest.fn(), transaction } as never);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual([
      DETACH_PAID_SQL,
      CLEAR_OTHER_SQL,
      CLEAR_USERS_SQL,
    ]);
    expect(DETACH_PAID_SQL).toContain(`"status" = 'legacy_grace'`);
    expect(DETACH_PAID_SQL).toContain('"cancelAtPeriodEnd" = true');
    expect(DETACH_PAID_SQL).not.toContain('"periodEnd" =');
  });

  it('describes each paid subscription with its access end date', () => {
    const lines = describeStripeAccountMigration(
      {
        paidSubscriptions: [
          {
            id: 's1',
            referenceId: 'u1',
            email: 'a@example.com',
            status: 'active',
            plan: 'pro',
            periodEnd: new Date('2026-12-15T00:00:00Z'),
          },
          {
            id: 's2',
            referenceId: 'u2',
            email: null,
            status: 'past_due',
            plan: 'pro',
            periodEnd: '2026-11-20T00:00:00Z',
          },
          {
            id: 's3',
            referenceId: 'u3',
            email: 'c@example.com',
            status: 'active',
            plan: 'pro',
            periodEnd: null,
          },
          {
            id: 's4',
            referenceId: 'u4',
            email: 'd@example.com',
            status: 'active',
            plan: 'pro',
            periodEnd: 'not a date',
          },
        ],
        otherSubscriptionRows: 2,
        usersWithCustomerId: 9,
      },
      new Date('2026-11-30T00:00:00Z'),
    );

    expect(lines).toEqual([
      'Paid subscriptions to detach (status -> legacy_grace, Pro until period end): 4',
      '  - a@example.com (pro, active): Pro until 2026-12-15',
      '  - u2 (pro, past_due): Pro until 2026-11-20 [period already over]',
      '  - c@example.com (pro, active): Pro until no period end (loses Pro immediately)',
      '  - d@example.com (pro, active): Pro until not a date',
      'Other subscription rows with Stripe ids to clear: 2',
      'Users with a stripeCustomerId to clear: 9',
    ]);
  });

  it('uses the current time by default', () => {
    expect(
      describeStripeAccountMigration({
        paidSubscriptions: [],
        otherSubscriptionRows: 0,
        usersWithCustomerId: 0,
      })[0],
    ).toContain(': 0');
  });
});
