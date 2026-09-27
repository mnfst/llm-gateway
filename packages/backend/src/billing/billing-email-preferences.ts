import type { BillingEmailPreferences } from 'manifest-shared';

export const DEFAULT_BILLING_EMAIL_PREFERENCES: BillingEmailPreferences = {
  usageAlerts: true,
};

export function normalizeBillingEmailPreferences(raw: unknown): BillingEmailPreferences {
  const value = raw as Partial<BillingEmailPreferences> | null | undefined;
  return {
    usageAlerts:
      typeof value?.usageAlerts === 'boolean'
        ? value.usageAlerts
        : DEFAULT_BILLING_EMAIL_PREFERENCES.usageAlerts,
  };
}
