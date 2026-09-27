import type Stripe from 'stripe';
import type { Subscription } from '@better-auth/stripe';
import {
  formatPlanName,
  getBillingAppUrl,
  getBillingEmailFrom,
  sendSubscriptionPlanEmail,
} from './billing-email-sender';
import {
  BillingEmailLogQueryable,
  hasBillingEmailLog,
  tryInsertBillingEmailLog,
} from './billing-email-log.service';

interface BillingUserRecipient {
  email: string | null;
  name: string | null;
}

async function resolveBillingUser(
  db: BillingEmailLogQueryable,
  userId: string,
): Promise<BillingUserRecipient | null> {
  const result = await db.query(
    `SELECT email, NULLIF(name, '') AS name FROM "user" WHERE id = $1`,
    [userId],
  );
  const rows = Array.isArray(result)
    ? (result as BillingUserRecipient[])
    : ((result as { rows?: BillingUserRecipient[] }).rows ?? []);
  return rows[0] ?? null;
}

async function sendLifecycleEmail(
  db: BillingEmailLogQueryable,
  params: {
    kind: 'subscription_confirmed' | 'plan_changed' | 'cancellation_confirmed';
    eventId: string;
    subscription: Subscription;
    previousPlanName?: string | null;
    periodEnd?: string | null;
  },
): Promise<boolean> {
  try {
    const userId = params.subscription.referenceId;
    const subscriptionId = params.subscription.stripeSubscriptionId ?? params.subscription.id;
    const dedupeAction =
      params.kind === 'subscription_confirmed'
        ? 'confirm'
        : params.kind === 'cancellation_confirmed'
          ? 'cancel'
          : params.eventId;
    const dedupeKey = `billing:${params.kind}:${subscriptionId}:${dedupeAction}`;
    if (await hasBillingEmailLog(db, dedupeKey)) return false;

    const recipient = await resolveBillingUser(db, userId);
    if (!recipient?.email) return false;

    const appUrl = getBillingAppUrl();
    const sent = await sendSubscriptionPlanEmail(
      recipient.email,
      {
        kind: params.kind,
        userName: recipient.name,
        planName: formatPlanName(params.subscription.plan),
        previousPlanName: params.previousPlanName,
        periodEnd: params.periodEnd ?? null,
        appUrl,
        manageBillingUrl: `${appUrl}/account`,
      },
      getBillingEmailFrom(),
    );
    if (!sent) return false;

    await tryInsertBillingEmailLog(db, {
      dedupeKey,
      kind: params.kind,
      userId,
      stripeSubscriptionId: subscriptionId,
      periodEnd: params.periodEnd ?? null,
      metadata: {
        eventId: params.eventId,
        plan: params.subscription.plan,
        previousPlan: params.previousPlanName ?? null,
      },
    });
    return true;
  } catch (err) {
    console.warn(`[BillingEmail] Failed to send ${params.kind}:`, err);
    return false;
  }
}

export function planFromPriceId(
  priceId: string | null | undefined,
  priceToPlan: ReadonlyMap<string, string>,
): string | null {
  if (!priceId) return null;
  return priceToPlan.get(priceId) ?? null;
}

export function previousPlanFromEvent(
  event: Stripe.Event,
  priceToPlan: ReadonlyMap<string, string>,
): string | null {
  const previous = event.data.previous_attributes as
    | { items?: { data?: Array<{ price?: { id?: string } }> } }
    | undefined;
  const previousPrice = previous?.items?.data?.find((item) => item.price?.id)?.price?.id;
  return planFromPriceId(previousPrice, priceToPlan);
}

export async function sendSubscriptionConfirmedEmail(
  db: BillingEmailLogQueryable,
  event: Stripe.Event,
  subscription: Subscription,
): Promise<boolean> {
  return sendLifecycleEmail(db, {
    kind: 'subscription_confirmed',
    eventId: event.id,
    subscription,
    periodEnd: subscription.periodEnd?.toISOString(),
  });
}

export async function sendPlanChangedEmail(
  db: BillingEmailLogQueryable,
  event: Stripe.Event,
  subscription: Subscription,
  previousPlan: string | null,
): Promise<boolean> {
  if (!previousPlan || previousPlan === subscription.plan) return false;
  return sendLifecycleEmail(db, {
    kind: 'plan_changed',
    eventId: event.id,
    subscription,
    previousPlanName: formatPlanName(previousPlan),
    periodEnd: subscription.periodEnd?.toISOString(),
  });
}

export async function sendSubscriptionCanceledEmail(
  db: BillingEmailLogQueryable,
  event: Stripe.Event,
  subscription: Subscription,
): Promise<boolean> {
  return sendLifecycleEmail(db, {
    kind: 'cancellation_confirmed',
    eventId: event.id,
    subscription,
    periodEnd:
      subscription.cancelAt?.toISOString() ??
      subscription.periodEnd?.toISOString() ??
      subscription.endedAt?.toISOString(),
  });
}
