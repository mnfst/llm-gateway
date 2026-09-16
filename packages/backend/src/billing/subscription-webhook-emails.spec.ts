jest.mock('./billing-email-sender', () => ({
  formatPlanName: (plan: string | null | undefined) =>
    plan === 'pro' ? 'Pro' : plan === 'free' ? 'Free' : plan,
  getBillingAppUrl: () => 'https://app.manifest.build',
  getBillingEmailFrom: () => 'noreply@manifest.build',
  sendSubscriptionPlanEmail: jest.fn().mockResolvedValue(true),
}));

import type Stripe from 'stripe';
import type { Subscription } from '@better-auth/stripe';
import {
  planFromPriceId,
  previousPlanFromEvent,
  sendPlanChangedEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionConfirmedEmail,
} from './subscription-webhook-emails';
import { sendSubscriptionPlanEmail } from './billing-email-sender';

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-row-1',
    plan: 'pro',
    referenceId: 'u1',
    status: 'active',
    stripeSubscriptionId: 'sub_123',
    periodEnd: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  } as Subscription;
}

function event(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: 'evt_123',
    data: { object: {}, previous_attributes: {} },
    ...overrides,
  } as Stripe.Event;
}

describe('subscription webhook billing emails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps previous Stripe item prices back to plan names', () => {
    const priceToPlan = new Map([['price_basic', 'free']]);
    const previous = event({
      data: {
        object: {},
        previous_attributes: { items: { data: [{ price: { id: 'price_basic' } }] } },
      },
    } as Stripe.Event);

    expect(previousPlanFromEvent(previous, priceToPlan)).toBe('free');
  });

  it('sends a deduped subscription confirmation email', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      true,
    );

    expect(query.mock.calls[0][0]).toContain('SELECT id FROM billing_email_logs');
    expect(query.mock.calls[0][1][0]).toBe('billing:subscription_confirmed:sub_123:confirm');
    expect(query.mock.calls[2][0]).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(query.mock.calls[2][1][1]).toBe('billing:subscription_confirmed:sub_123:confirm');
    expect(sendSubscriptionPlanEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ kind: 'subscription_confirmed', planName: 'Pro' }),
      'noreply@manifest.build',
    );
  });

  it('does not send when the lifecycle dedupe key already exists', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      false,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionPlanEmail).not.toHaveBeenCalled();
  });

  it('does not write the lifecycle dedupe log when sending fails', async () => {
    (sendSubscriptionPlanEmail as jest.Mock).mockResolvedValueOnce(false);
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] });

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      false,
    );

    expect(sendSubscriptionPlanEmail).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns false when lifecycle email handling throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    const query = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      false,
    );

    expect(warn).toHaveBeenCalledWith(
      '[BillingEmail] Failed to send subscription_confirmed:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('sends a plan-changed email only when the plan changed', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await expect(sendPlanChangedEmail({ query }, event(), subscription(), 'free')).resolves.toBe(
      true,
    );
    await expect(
      sendPlanChangedEmail({ query }, event({ id: 'evt_same' }), subscription(), 'pro'),
    ).resolves.toBe(false);

    expect(sendSubscriptionPlanEmail).toHaveBeenCalledTimes(1);
    expect(sendSubscriptionPlanEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        kind: 'plan_changed',
        previousPlanName: 'Free',
      }),
      'noreply@manifest.build',
    );
  });

  it('dedupes cancel and delete events by subscription id', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await expect(sendSubscriptionCanceledEmail({ query }, event(), subscription())).resolves.toBe(
      true,
    );

    expect(query.mock.calls[2][1][1]).toBe('billing:cancellation_confirmed:sub_123:cancel');
    expect(sendSubscriptionPlanEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({ kind: 'cancellation_confirmed' }),
      'noreply@manifest.build',
    );
  });

  it('returns false when no billing recipient email is found', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // dedupe check
      .mockResolvedValueOnce({ rows: [{ email: null, name: null }] }); // user lookup

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      false,
    );

    expect(sendSubscriptionPlanEmail).not.toHaveBeenCalled();
  });

  it('returns false when no billing user row exists', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // dedupe check
      .mockResolvedValueOnce({ rows: [] }); // no user found

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      false,
    );

    expect(sendSubscriptionPlanEmail).not.toHaveBeenCalled();
  });

  it('returns false for plan_changed when previousPlan is null', async () => {
    await expect(
      sendPlanChangedEmail({ query: jest.fn() }, event(), subscription(), null),
    ).resolves.toBe(false);
  });

  it('uses the stripeSubscriptionId fallback to subscription.id when stripeSubscriptionId is null', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    const sub = subscription({ stripeSubscriptionId: null as unknown as string, id: 'ba-row-id' });
    await sendSubscriptionConfirmedEmail({ query }, event(), sub);

    expect(query.mock.calls[0][1][0]).toBe('billing:subscription_confirmed:ba-row-id:confirm');
  });

  it('uses cancelAt for the period end in cancel emails when cancelAt is present', async () => {
    const cancelDate = new Date('2026-09-01T00:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await sendSubscriptionCanceledEmail({ query }, event(), subscription({ cancelAt: cancelDate }));

    expect(sendSubscriptionPlanEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        periodEnd: cancelDate.toISOString(),
      }),
      'noreply@manifest.build',
    );
  });

  it('uses endedAt for the period end when both cancelAt and periodEnd are null', async () => {
    const endedDate = new Date('2026-10-15T00:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await sendSubscriptionCanceledEmail(
      { query },
      event(),
      subscription({
        cancelAt: null as unknown as Date,
        periodEnd: null as unknown as Date,
        endedAt: endedDate,
      }),
    );

    expect(sendSubscriptionPlanEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        periodEnd: endedDate.toISOString(),
      }),
      'noreply@manifest.build',
    );
  });

  it('resolves user from an array result (not { rows } wrapper)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // dedupe check — array form
      .mockResolvedValueOnce([{ email: 'owner@example.com', name: 'Ada' }]) // user — array form
      .mockResolvedValueOnce([{ id: 'log-1' }]); // insert

    await expect(sendSubscriptionConfirmedEmail({ query }, event(), subscription())).resolves.toBe(
      true,
    );

    expect(sendSubscriptionPlanEmail).toHaveBeenCalled();
  });

  describe('planFromPriceId', () => {
    const priceToPlan = new Map([['price_pro', 'pro']]);

    it('returns the plan name for a known price', () => {
      expect(planFromPriceId('price_pro', priceToPlan)).toBe('pro');
    });

    it('returns null for an unknown price', () => {
      expect(planFromPriceId('price_unknown', priceToPlan)).toBeNull();
    });

    it('returns null for null priceId', () => {
      expect(planFromPriceId(null, priceToPlan)).toBeNull();
    });

    it('returns null for undefined priceId', () => {
      expect(planFromPriceId(undefined, priceToPlan)).toBeNull();
    });
  });

  describe('previousPlanFromEvent edge cases', () => {
    it('returns null when previous_attributes is undefined', () => {
      const priceToPlan = new Map([['price_pro', 'pro']]);
      const e = event({ data: { object: {} } } as Stripe.Event);
      expect(previousPlanFromEvent(e, priceToPlan)).toBeNull();
    });

    it('returns null when previous_attributes has no items', () => {
      const priceToPlan = new Map([['price_pro', 'pro']]);
      const e = event({
        data: { object: {}, previous_attributes: {} },
      } as Stripe.Event);
      expect(previousPlanFromEvent(e, priceToPlan)).toBeNull();
    });
  });

  it('uses eventId for the dedupe action on plan_changed kind', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ email: 'owner@example.com', name: 'Ada' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }] });

    await sendPlanChangedEmail(
      { query },
      event({ id: 'evt_plan_change_42' }),
      subscription(),
      'free',
    );

    // plan_changed uses the eventId as the dedupe action (not 'confirm' or 'cancel')
    expect(query.mock.calls[0][1][0]).toBe('billing:plan_changed:sub_123:evt_plan_change_42');
  });
});
