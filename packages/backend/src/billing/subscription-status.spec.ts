import {
  PAID_SUBSCRIPTION_STATUSES,
  PAID_SUBSCRIPTION_STATUS_SQL_LIST,
} from './subscription-status';

describe('subscription-status', () => {
  it('keeps past_due subscriptions on the paid plan', () => {
    expect(PAID_SUBSCRIPTION_STATUSES).toEqual(['active', 'trialing', 'past_due']);
  });

  it('renders the statuses as a SQL IN list', () => {
    expect(PAID_SUBSCRIPTION_STATUS_SQL_LIST).toBe("'active', 'trialing', 'past_due'");
  });
});
