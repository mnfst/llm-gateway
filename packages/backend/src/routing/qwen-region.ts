import { normalizeProviderBaseUrl } from './provider-base-url';

const QWEN_REGION_BASE_URLS = {
  singapore: 'https://dashscope-intl.aliyuncs.com/compatible-mode',
  us: 'https://dashscope-us.aliyuncs.com/compatible-mode',
  beijing: 'https://dashscope.aliyuncs.com/compatible-mode',
} as const;

const QWEN_ALLOWED_BASE_URLS: ReadonlySet<string> = new Set(Object.values(QWEN_REGION_BASE_URLS));
const QWEN_WORKSPACE_REGION_CODES: ReadonlySet<string> = new Set([
  'cn-beijing',
  'ap-southeast-1',
  'ap-northeast-1',
  'cn-hongkong',
  'eu-central-1',
]);
const QWEN_REGION_DETECTION_ORDER = ['singapore', 'us', 'beijing'] as const;
const QWEN_DETECTION_TIMEOUT_MS = 3000;
const QWEN_WORKSPACE_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const QWEN_REGION_VALIDATION_MESSAGE =
  'Qwen region must be one of: auto, singapore, us, beijing, or a valid Alibaba Cloud Model Studio compatible-mode base URL';

export type QwenResolvedRegion = keyof typeof QWEN_REGION_BASE_URLS;
export type QwenRegion = string;

function buildModelsUrl(region: QwenResolvedRegion): string {
  return `${QWEN_REGION_BASE_URLS[region]}/v1/models`;
}

export function isQwenResolvedRegion(
  value: string | null | undefined,
): value is QwenResolvedRegion {
  return value === 'singapore' || value === 'us' || value === 'beijing';
}

export function isQwenRegion(value: string | null | undefined): value is QwenRegion {
  return value === 'auto' || isQwenResolvedRegion(value) || !!normalizeQwenCompatibleBaseUrl(value);
}

export function getQwenCompatibleBaseUrl(region?: string | null): string {
  const endpoint = normalizeQwenCompatibleBaseUrl(region);
  if (endpoint) return endpoint;
  if (isQwenResolvedRegion(region)) return QWEN_REGION_BASE_URLS[region];
  return QWEN_REGION_BASE_URLS.beijing;
}

export function normalizeQwenCompatibleBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    const normalized = normalizeProviderBaseUrl(`${url.origin}${url.pathname}`);
    if (QWEN_ALLOWED_BASE_URLS.has(normalized)) return normalized;

    const normalizedUrl = new URL(normalized);
    if (normalizedUrl.pathname !== '/compatible-mode') return null;

    const parts = normalizedUrl.hostname.split('.');
    if (parts.length !== 5) return null;

    const [workspaceId, regionCode, service, domain, tld] = parts;
    if (
      !workspaceId ||
      !regionCode ||
      service !== 'maas' ||
      domain !== 'aliyuncs' ||
      tld !== 'com'
    ) {
      return null;
    }
    if (!QWEN_WORKSPACE_HOST_RE.test(workspaceId)) return null;
    if (!QWEN_WORKSPACE_REGION_CODES.has(regionCode)) return null;

    return normalized;
  } catch {
    return null;
  }
}

export function isQwenResolvedEndpoint(value: string | null | undefined): value is string {
  return isQwenResolvedRegion(value) || !!normalizeQwenCompatibleBaseUrl(value);
}

export async function detectQwenRegion(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QwenResolvedRegion | null> {
  const headers = { Authorization: `Bearer ${apiKey}` };

  for (const region of QWEN_REGION_DETECTION_ORDER) {
    try {
      const response = await fetchImpl(buildModelsUrl(region), {
        headers,
        signal: AbortSignal.timeout(QWEN_DETECTION_TIMEOUT_MS),
      });
      if (response.ok) return region;
    } catch {
      // Try the next official region before giving up.
    }
  }

  return null;
}
