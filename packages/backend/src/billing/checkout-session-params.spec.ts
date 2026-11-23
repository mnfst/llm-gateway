import { CHECKOUT_TAX_PARAMS, getCheckoutSessionParams } from './checkout-session-params';

describe('getCheckoutSessionParams', () => {
  it('turns on Stripe Tax, VAT number collection and the billing address', () => {
    expect(getCheckoutSessionParams()).toEqual({
      params: {
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' },
      },
    });
  });

  it('returns fresh objects so a caller cannot mutate the shared constant', () => {
    const { params } = getCheckoutSessionParams();
    params.automatic_tax!.enabled = false;
    params.customer_update!.name = 'never';
    expect(CHECKOUT_TAX_PARAMS.automatic_tax.enabled).toBe(true);
    expect(CHECKOUT_TAX_PARAMS.customer_update.name).toBe('auto');
  });
});
