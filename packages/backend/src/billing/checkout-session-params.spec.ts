import {
  CHECKOUT_TAX_PARAMS,
  getCheckoutSessionParams,
  MIN_TRIAL_END_MS,
  type CheckoutContext,
} from './checkout-session-params';

const NOW = Date.parse('2026-11-30T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function ctxWith(rows: Array<{ status: string; periodEnd?: Date | string | null }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { ctx: { context: { adapter: { findMany } } } as CheckoutContext, findMany };
}

const TAX_PARAMS = {
  automatic_tax: { enabled: true },
  tax_id_collection: { enabled: true },
  billing_address_collection: 'required',
  customer_update: { address: 'auto', name: 'auto' },
};

describe('getCheckoutSessionParams', () => {
  it('turns on Stripe Tax, VAT number collection and the billing address', async () => {
    expect(await getCheckoutSessionParams()).toEqual({ params: TAX_PARAMS });
  });

  it('returns fresh objects so a caller cannot mutate the shared constant', async () => {
    const { params } = await getCheckoutSessionParams();
    params.automatic_tax!.enabled = false;
    params.customer_update!.name = 'never';
    expect(CHECKOUT_TAX_PARAMS.automatic_tax.enabled).toBe(true);
    expect(CHECKOUT_TAX_PARAMS.customer_update.name).toBe('auto');
  });

  it('starts a trial until the end of the period paid on the former account', async () => {
    const end = new Date(NOW + 15 * DAY);
    const { ctx, findMany } = ctxWith([
      { status: 'canceled', periodEnd: new Date(NOW + 40 * DAY) },
      { status: 'legacy_grace', periodEnd: end },
      { status: 'legacy_grace', periodEnd: null },
    ]);

    const { params } = await getCheckoutSessionParams({ user: { id: 'u1' } }, undefined, ctx, NOW);

    expect(findMany).toHaveBeenCalledWith({
      model: 'subscription',
      where: [{ field: 'referenceId', value: 'u1' }],
    });
    expect(params).toEqual({
      ...TAX_PARAMS,
      subscription_data: { trial_end: Math.floor(end.getTime() / 1000) },
    });
  });

  it('starts at once when the paid period ends in less than 48 hours', async () => {
    const { ctx } = ctxWith([
      { status: 'legacy_grace', periodEnd: new Date(NOW + MIN_TRIAL_END_MS - 1).toISOString() },
    ]);
    const { params } = await getCheckoutSessionParams({ user: { id: 'u1' } }, undefined, ctx, NOW);
    expect(params.subscription_data).toBeUndefined();
  });

  it('starts at once for a user who never had a subscription on the former account', async () => {
    const { ctx } = ctxWith([]);
    const { params } = await getCheckoutSessionParams({ user: { id: 'u1' } }, undefined, ctx);
    expect(params).toEqual(TAX_PARAMS);
  });

  it('starts at once without an endpoint context', async () => {
    const { params } = await getCheckoutSessionParams({ user: { id: 'u1' } });
    expect(params).toEqual(TAX_PARAMS);
  });
});
