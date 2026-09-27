/** Dashboard origin only; API and waitlist destinations are configured separately. */
export const DEFAULT_DASHBOARD_URL = 'https://app.manifest.build';

/** Emails need absolute URLs because they are read outside the dashboard. */
export function getDashboardBaseUrl(explicit?: string | null): string {
  const explicitBase = explicit?.trim().replace(/\/+$/, '');
  const configuredBase = process.env['BETTER_AUTH_URL']?.trim().replace(/\/+$/, '');
  return explicitBase || configuredBase || DEFAULT_DASHBOARD_URL;
}

export function getEmailAssetUrl(path: string, appUrl?: string | null): string {
  return `${getDashboardBaseUrl(appUrl)}/${path.replace(/^\/+/, '')}`;
}
