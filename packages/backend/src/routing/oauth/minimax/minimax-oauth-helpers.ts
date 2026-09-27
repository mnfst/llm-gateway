import { OAuthTokenBlob } from '../core';
import { toPollIntervalMs as toDeviceFlowPollIntervalMs } from '../core/device-flow';
import { normalizeMinimaxSubscriptionBaseUrl } from '../../provider-base-url';

export { ABSOLUTE_TIME_THRESHOLD_MS, toAbsoluteExpiryTimestamp } from '../core/device-flow';

export const MINIMAX_BASE_URLS = {
  global: 'https://api.minimax.io',
  cn: 'https://api.minimaxi.com',
} as const;

export type MinimaxRegion = keyof typeof MINIMAX_BASE_URLS;

export const DEFAULT_REGION: MinimaxRegion = 'global';
export const DEFAULT_BASE_URL = MINIMAX_BASE_URLS[DEFAULT_REGION];
export const DEFAULT_RESOURCE_URL = `${DEFAULT_BASE_URL}/anthropic/v1`;
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export const MINIMAX_API_KEY_REGION_VALIDATION_MESSAGE =
  'MiniMax API-key region must be one of: global, cn';

export function isMinimaxRegion(value: string | undefined): value is MinimaxRegion {
  return value === 'global' || value === 'cn';
}

export function getMinimaxBaseUrl(region: MinimaxRegion = DEFAULT_REGION): string {
  return MINIMAX_BASE_URLS[region];
}

export function buildMinimaxCodeUrl(baseUrl: string): string {
  return `${baseUrl}/oauth/code`;
}

export function buildMinimaxTokenUrl(baseUrl: string): string {
  return `${baseUrl}/oauth/token`;
}

export function buildMinimaxResourceUrl(baseUrl: string): string {
  return `${baseUrl}/anthropic/v1`;
}

const VERIFICATION_HOST_REWRITES: Record<string, string> = {
  'www.minimax.io': 'platform.minimax.io',
  'www.minimaxi.com': 'platform.minimaxi.com',
};

// Upstream MiniMax /oauth/code returns verification_uri pointing at
// www.minimax.io/oauth-authorize, which 307-redirects to the homepage. The
// real authorize page lives on platform.{minimax.io,minimaxi.com}. Rewrite
// only that exact host+path pair so any future upstream fix keeps working.
export function normalizeMinimaxVerificationUri(verificationUri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    return verificationUri;
  }
  if (parsed.pathname !== '/oauth-authorize') return verificationUri;
  const replacement = VERIFICATION_HOST_REWRITES[parsed.hostname];
  if (!replacement) return verificationUri;
  parsed.hostname = replacement;
  return parsed.toString();
}

export function getMinimaxResourceUrl(resourceUrl?: string): string | null {
  if (!resourceUrl) return null;
  return normalizeMinimaxSubscriptionBaseUrl(resourceUrl);
}

export function getMinimaxOauthBaseUrl(resourceUrl?: string): string {
  const normalized = getMinimaxResourceUrl(resourceUrl);
  if (!normalized) return DEFAULT_BASE_URL;
  return new URL(normalized).origin;
}

export function toPollIntervalMs(interval?: number): number {
  return toDeviceFlowPollIntervalMs(interval, DEFAULT_POLL_INTERVAL_MS);
}

export function isOAuthTokenBlob(value: unknown): value is OAuthTokenBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return (
    typeof blob.t === 'string' &&
    typeof blob.r === 'string' &&
    typeof blob.e === 'number' &&
    Number.isFinite(blob.e) &&
    (blob.u === undefined || typeof blob.u === 'string')
  );
}
