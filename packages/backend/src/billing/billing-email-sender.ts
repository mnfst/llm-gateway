import { getDashboardBaseUrl } from '../common/utils/dashboard-url';
import { render } from '@react-email/render';
import {
  PlanUsageEmail,
  PlanUsageEmailProps,
  SubscriptionPlanEmail,
  SubscriptionPlanEmailProps,
} from './emails/billing-plan-email';
import { sendEmail } from '../notifications/services/email-providers/send-email';

export function formatPlanName(plan: string | null | undefined): string {
  const normalized = (plan ?? '').trim().toLowerCase();
  if (normalized === 'pro') return 'Pro';
  if (normalized === 'free') return 'Free';
  if (!normalized) return 'Manifest';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function getBillingEmailFrom(explicit?: string | null): string {
  return (
    explicit ||
    process.env['EMAIL_FROM'] ||
    process.env['NOTIFICATION_FROM_EMAIL'] ||
    'noreply@manifest.build'
  );
}

export function getBillingAppUrl(explicit?: string | null): string {
  return getDashboardBaseUrl(explicit);
}

export function subscriptionEmailSubject(kind: SubscriptionPlanEmailProps['kind'], plan: string) {
  if (kind === 'plan_changed') return `Your Manifest plan changed to ${plan}`;
  if (kind === 'cancellation_confirmed') return `Your Manifest ${plan} cancellation is scheduled`;
  return `Your Manifest ${plan} plan is active`;
}

export function usageEmailSubject(kind: PlanUsageEmailProps['kind']) {
  return kind === 'requests_limit_reached'
    ? 'Your Manifest monthly request limit has been reached'
    : 'Your Manifest workspace has used 80% of monthly requests';
}

export async function sendSubscriptionPlanEmail(
  to: string,
  props: SubscriptionPlanEmailProps,
  fromEmail?: string | null,
): Promise<boolean> {
  const element = SubscriptionPlanEmail(props);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return sendEmail({
    to,
    subject: subscriptionEmailSubject(props.kind, props.planName),
    html,
    text,
    from: `Manifest <${getBillingEmailFrom(fromEmail)}>`,
  });
}

export async function sendPlanUsageEmail(
  to: string,
  props: PlanUsageEmailProps,
  fromEmail?: string | null,
): Promise<boolean> {
  const element = PlanUsageEmail(props);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return sendEmail({
    to,
    subject: usageEmailSubject(props.kind),
    html,
    text,
    from: `Manifest <${getBillingEmailFrom(fromEmail)}>`,
  });
}
