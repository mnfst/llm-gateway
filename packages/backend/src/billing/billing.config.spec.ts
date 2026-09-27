import { isBillingEnabled } from './billing.config';

describe('isBillingEnabled', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function setCloudWithKeys() {
    process.env['MANIFEST_MODE'] = 'cloud';
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
    process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';
  }

  it('is enabled in cloud mode with all Stripe env vars set', () => {
    setCloudWithKeys();
    expect(isBillingEnabled()).toBe(true);
  });

  it('is disabled when self-hosted even with keys', () => {
    setCloudWithKeys();
    process.env['MANIFEST_MODE'] = 'selfhosted';
    expect(isBillingEnabled()).toBe(false);
  });

  it.each(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRO_PRICE_ID'])(
    'is disabled when %s is missing',
    (key) => {
      setCloudWithKeys();
      delete process.env[key];
      expect(isBillingEnabled()).toBe(false);
    },
  );
});

describe('getStripeClient', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.resetModules();
    jest.unmock('stripe');
  });

  it('lazily creates a singleton Stripe client', () => {
    const constructorCalls: string[] = [];
    jest.resetModules();
    jest.mock('stripe', () => ({
      __esModule: true,
      default: class MockStripe {
        constructor(key: string) {
          constructorCalls.push(key);
        }
      },
    }));
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_singleton';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getStripeClient } = require('./billing.config');

    const first = getStripeClient();
    const second = getStripeClient();

    expect(first).toBe(second);
    expect(constructorCalls).toEqual(['sk_test_singleton']);
  });
});
