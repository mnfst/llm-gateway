export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

const MINIMAX_SUBSCRIPTION_BASE_URLS = new Map([
  ['https://api.minimax.io/anthropic', 'https://api.minimax.io/anthropic/v1'],
  ['https://api.minimax.io/anthropic/v1', 'https://api.minimax.io/anthropic/v1'],
  ['https://api.minimaxi.com/anthropic', 'https://api.minimaxi.com/anthropic/v1'],
  ['https://api.minimaxi.com/anthropic/v1', 'https://api.minimaxi.com/anthropic/v1'],
]);

export function normalizeMinimaxSubscriptionBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return null;
    }

    const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    return MINIMAX_SUBSCRIPTION_BASE_URLS.get(normalized) ?? null;
  } catch {
    return null;
  }
}
