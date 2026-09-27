jest.mock('@react-email/render', () => ({
  render: jest
    .fn()
    .mockImplementation((_el: unknown, opts?: { plainText?: boolean }) =>
      Promise.resolve(opts?.plainText ? 'plain text' : '<html>rendered</html>'),
    ),
}));
jest.mock('./emails/billing-plan-email', () => ({
  SubscriptionPlanEmail: jest.fn().mockReturnValue('sub-element'),
  PlanUsageEmail: jest.fn().mockReturnValue('usage-element'),
}));
jest.mock('../notifications/services/email-providers/send-email', () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
}));

import {
  formatPlanName,
  getBillingEmailFrom,
  getBillingAppUrl,
  subscriptionEmailSubject,
  usageEmailSubject,
  sendSubscriptionPlanEmail,
  sendPlanUsageEmail,
} from './billing-email-sender';
import { sendEmail } from '../notifications/services/email-providers/send-email';
import { SubscriptionPlanEmail, PlanUsageEmail } from './emails/billing-plan-email';

describe('billing-email-sender', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...saved };
    delete process.env['EMAIL_FROM'];
    delete process.env['NOTIFICATION_FROM_EMAIL'];
    delete process.env['BETTER_AUTH_URL'];
  });

  afterAll(() => {
    process.env = { ...saved };
  });

  describe('formatPlanName', () => {
    it('capitalizes "pro"', () => expect(formatPlanName('pro')).toBe('Pro'));
    it('capitalizes "Pro"', () => expect(formatPlanName('Pro')).toBe('Pro'));
    it('capitalizes "free"', () => expect(formatPlanName('free')).toBe('Free'));
    it('returns Manifest for null', () => expect(formatPlanName(null)).toBe('Manifest'));
    it('returns Manifest for undefined', () => expect(formatPlanName(undefined)).toBe('Manifest'));
    it('returns Manifest for empty string', () => expect(formatPlanName('')).toBe('Manifest'));
    it('returns Manifest for whitespace', () => expect(formatPlanName('  ')).toBe('Manifest'));
    it('capitalizes first letter of unknown plans', () =>
      expect(formatPlanName('starter')).toBe('Starter'));
  });

  describe('getBillingEmailFrom', () => {
    it('returns the explicit value when given', () => {
      expect(getBillingEmailFrom('custom@example.com')).toBe('custom@example.com');
    });

    it('falls back to EMAIL_FROM', () => {
      process.env['EMAIL_FROM'] = 'from@env.com';
      expect(getBillingEmailFrom()).toBe('from@env.com');
    });

    it('falls back to NOTIFICATION_FROM_EMAIL', () => {
      process.env['NOTIFICATION_FROM_EMAIL'] = 'notify@env.com';
      expect(getBillingEmailFrom()).toBe('notify@env.com');
    });

    it('falls back to the default address', () => {
      expect(getBillingEmailFrom()).toBe('noreply@manifest.build');
    });

    it('falls back when explicit is null', () => {
      expect(getBillingEmailFrom(null)).toBe('noreply@manifest.build');
    });
  });

  describe('getBillingAppUrl', () => {
    it('returns the explicit value, stripping trailing slashes', () => {
      expect(getBillingAppUrl('https://my.app/')).toBe('https://my.app');
    });

    it('falls back to BETTER_AUTH_URL', () => {
      process.env['BETTER_AUTH_URL'] = 'https://auth.example.com';
      expect(getBillingAppUrl()).toBe('https://auth.example.com');
    });

    it('falls back to the default app URL', () => {
      expect(getBillingAppUrl()).toBe('https://app.manifest.build');
    });

    it('falls back when explicit is null', () => {
      expect(getBillingAppUrl(null)).toBe('https://app.manifest.build');
    });

    it('returns the default when stripping slashes yields empty', () => {
      expect(getBillingAppUrl('///')).toBe('https://app.manifest.build');
    });
  });

  describe('subscriptionEmailSubject', () => {
    it('returns a plan_changed subject', () => {
      expect(subscriptionEmailSubject('plan_changed', 'Pro')).toBe(
        'Your Manifest plan changed to Pro',
      );
    });

    it('returns a cancellation_confirmed subject', () => {
      expect(subscriptionEmailSubject('cancellation_confirmed', 'Pro')).toBe(
        'Your Manifest Pro cancellation is scheduled',
      );
    });

    it('returns a subscription_confirmed subject', () => {
      expect(subscriptionEmailSubject('subscription_confirmed', 'Pro')).toBe(
        'Your Manifest Pro plan is active',
      );
    });
  });

  describe('usageEmailSubject', () => {
    it('returns the limit-reached subject', () => {
      expect(usageEmailSubject('requests_limit_reached')).toBe(
        'Your Manifest monthly request limit has been reached',
      );
    });

    it('returns the warning subject', () => {
      expect(usageEmailSubject('requests_warning')).toBe(
        'Your Manifest workspace has used 80% of monthly requests',
      );
    });
  });

  describe('sendSubscriptionPlanEmail', () => {
    it('renders, sends, and returns the result', async () => {
      const props = {
        kind: 'subscription_confirmed' as const,
        userName: 'Ada',
        planName: 'Pro',
        previousPlanName: null,
        periodEnd: null,
        appUrl: 'https://app.manifest.build',
        manageBillingUrl: 'https://app.manifest.build/account',
      };
      const result = await sendSubscriptionPlanEmail('ada@example.com', props);

      expect(result).toBe(true);
      expect(SubscriptionPlanEmail).toHaveBeenCalledWith(props);
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'ada@example.com',
        subject: 'Your Manifest Pro plan is active',
        html: '<html>rendered</html>',
        text: 'plain text',
        from: 'Manifest <noreply@manifest.build>',
      });
    });

    it('uses a custom from email when provided', async () => {
      const props = {
        kind: 'plan_changed' as const,
        userName: null,
        planName: 'Free',
        previousPlanName: 'Pro',
        periodEnd: null,
        appUrl: 'https://app.manifest.build',
        manageBillingUrl: 'https://app.manifest.build/account',
      };
      await sendSubscriptionPlanEmail('ada@example.com', props, 'custom@manifest.build');

      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Manifest <custom@manifest.build>',
        }),
      );
    });
  });

  describe('sendPlanUsageEmail', () => {
    it('renders, sends, and returns the result', async () => {
      const props = {
        kind: 'requests_limit_reached' as const,
        userName: 'Ada',
        used: 10000,
        limit: 10000,
        periodEnd: '2026-08-01T00:00:00.000Z',
        appUrl: 'https://app.manifest.build',
      };
      const result = await sendPlanUsageEmail('ada@example.com', props);

      expect(result).toBe(true);
      expect(PlanUsageEmail).toHaveBeenCalledWith(props);
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'ada@example.com',
        subject: 'Your Manifest monthly request limit has been reached',
        html: '<html>rendered</html>',
        text: 'plain text',
        from: 'Manifest <noreply@manifest.build>',
      });
    });

    it('uses a custom from email when provided', async () => {
      const props = {
        kind: 'requests_warning' as const,
        userName: null,
        used: 8000,
        limit: 10000,
        periodEnd: '2026-08-01T00:00:00.000Z',
        appUrl: 'https://app.manifest.build',
      };
      await sendPlanUsageEmail('ada@example.com', props, 'custom@manifest.build');

      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Manifest <custom@manifest.build>',
          subject: 'Your Manifest workspace has used 80% of monthly requests',
        }),
      );
    });
  });
});
