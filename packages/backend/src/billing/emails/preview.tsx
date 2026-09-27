/**
 * Quick email preview script.
 * Usage: npx tsx src/billing/emails/preview.tsx [kind]
 * Kinds: requests_warning, requests_limit_reached, subscription_confirmed, plan_changed, cancellation_confirmed
 * Opens the rendered email in the default browser.
 */
import { render } from '@react-email/render';
import * as React from 'react';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { PlanUsageEmail, SubscriptionPlanEmail } from './billing-plan-email';

const kind = (process.argv[2] ?? 'requests_warning') as string;
const outPath = '/tmp/manifest-email-preview.html';

async function main() {
  let html: string;

  if (kind === 'requests_warning' || kind === 'requests_limit_reached') {
    html = await render(
      React.createElement(PlanUsageEmail, {
        kind: kind as 'requests_warning' | 'requests_limit_reached',
        userName: 'Sébastien',
        used: kind === 'requests_limit_reached' ? 10000 : 8200,
        limit: 10000,
        periodEnd: '2026-08-01T00:00:00.000Z',
        appUrl: 'http://localhost:37475',
      }),
    );
  } else {
    html = await render(
      React.createElement(SubscriptionPlanEmail, {
        kind: kind as 'subscription_confirmed' | 'plan_changed' | 'cancellation_confirmed',
        userName: 'Sébastien',
        planName: 'Pro',
        previousPlanName: kind === 'plan_changed' ? 'Free' : undefined,
        periodEnd: kind === 'cancellation_confirmed' ? '2026-08-06T00:00:00.000Z' : undefined,
        appUrl: 'http://localhost:37475',
        manageBillingUrl: 'http://localhost:37475/account',
      }),
    );
  }

  writeFileSync(outPath, html);
  console.log(`Preview written to ${outPath}`);
  execSync(`open ${outPath}`);
}

main();
