import { renderToStaticMarkup } from 'react-dom/server';
import { VerifyEmailEmail } from './verify-email';
import { ResetPasswordEmail } from './reset-password';
import { TestEmail } from './test-email';
import { ThresholdAlertEmail } from './threshold-alert';
import { DoctorReleaseEmail } from './doctor-release';
import { PlanUsageEmail, SubscriptionPlanEmail } from '../../billing/emails/billing-plan-email';

const dashboard = 'https://dashboard.example';
const renderers = {
  verification: () => VerifyEmailEmail({ userName: 'Ada', verificationUrl: `${dashboard}/verify` }),
  password: () => ResetPasswordEmail({ userName: 'Ada', resetUrl: `${dashboard}/reset` }),
  test: () => TestEmail({}),
  threshold: () =>
    ThresholdAlertEmail({
      agentName: 'demo',
      metricType: 'cost',
      threshold: 10,
      actualValue: 12,
      period: 'day',
      timestamp: '2026-09-11 12:00',
      agentUrl: `${dashboard}/harnesses/demo`,
    }),
  announcement: () => DoctorReleaseEmail({ appUrl: dashboard }),
  subscription: () =>
    SubscriptionPlanEmail({
      kind: 'subscription_confirmed',
      planName: 'Pro',
      appUrl: dashboard,
      manageBillingUrl: `${dashboard}/account`,
    }),
  usage: () =>
    PlanUsageEmail({
      kind: 'requests_warning',
      used: 8000,
      limit: 10000,
      periodEnd: '2026-10-01',
      appUrl: dashboard,
    }),
};

describe('email image deployment URLs', () => {
  const originalUrl = process.env['BETTER_AUTH_URL'];
  beforeEach(() => {
    process.env['BETTER_AUTH_URL'] = `${dashboard}/`;
  });
  afterEach(() => {
    if (originalUrl === undefined) delete process.env['BETTER_AUTH_URL'];
    else process.env['BETTER_AUTH_URL'] = originalUrl;
  });

  it.each(Object.entries(renderers))(
    '%s renders images from the configured dashboard',
    (_, render) => {
      const html = renderToStaticMarkup(render());
      expect(html).toContain(`src="${dashboard}/manifest-logo.png"`);
      expect(html).not.toContain('app.manifest.build');
    },
  );

  it('honors explicit image hosting overrides', () => {
    const html = renderToStaticMarkup(
      DoctorReleaseEmail({
        appUrl: dashboard,
        logoUrl: 'https://cdn.example/logo.png',
        autofixIconUrl: 'https://cdn.example/autofix.png',
      }),
    );
    expect(html).toContain('src="https://cdn.example/logo.png"');
    expect(html).toContain('src="https://cdn.example/autofix.png"');
  });

  it('uses the email dashboard for images even when the server has another default', () => {
    process.env['BETTER_AUTH_URL'] = 'https://server.example';
    const html = renderToStaticMarkup(DoctorReleaseEmail({ appUrl: dashboard }));
    expect(html).toContain(`src="${dashboard}/manifest-logo.png"`);
    expect(html).toContain(`src="${dashboard}/autofix-icon-email.png"`);
    expect(html).not.toContain('server.example');
  });
});
