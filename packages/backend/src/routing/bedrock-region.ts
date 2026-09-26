import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import { normalizeProviderBaseUrl } from './provider-base-url';

export const DEFAULT_BEDROCK_REGION = 'us-east-1';

export const BEDROCK_ENDPOINT_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'eu-south-1',
  'eu-north-1',
  'ap-south-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-northeast-1',
  'sa-east-1',
] as const;

const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const BEDROCK_PROVIDER_ID = 'bedrock';
const BEDROCK_PROVIDER = PROVIDER_BY_ID_OR_ALIAS.get(BEDROCK_PROVIDER_ID);
if (!BEDROCK_PROVIDER) {
  throw new Error('AWS Bedrock provider is missing from the shared provider registry');
}
const LEGACY_BEDROCK_API_KEY_PREFIX = 'bedrock-api-key-';
const AWS_BEARER_TOKEN_PREFIX = 'ABSK';

export function isBedrockProvider(provider: string): boolean {
  return PROVIDER_BY_ID_OR_ALIAS.get(provider.toLowerCase().trim())?.id === BEDROCK_PROVIDER_ID;
}

export function isBedrockRegion(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    AWS_REGION_RE.test(value) &&
    BEDROCK_ENDPOINT_REGIONS.includes(value as (typeof BEDROCK_ENDPOINT_REGIONS)[number])
  );
}

export function getBedrockMantleBaseUrl(region?: string | null): string {
  const resolved = isBedrockRegion(region) ? region : DEFAULT_BEDROCK_REGION;
  return `https://bedrock-mantle.${resolved}.api.aws`;
}

/**
 * Cross-Region inference profiles served by Bedrock Runtime. The model family
 * is intentionally unrestricted: ListInferenceProfiles is the authority for
 * discovery, while this syntax check also supports explicit profile IDs.
 *
 * Geographic profile scopes documented by Bedrock are Global, US, EU and
 * APAC. API compatibility is optimistic: the caller's API mode is preserved
 * and Bedrock returns the authoritative unsupported-API error when necessary.
 */
const BEDROCK_RUNTIME_CRIS_RE = /^(?:global|us|eu|apac)\.(?<baseModelId>[a-z0-9][a-z0-9:._-]*)$/i;

function bareBedrockModelId(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(slash + 1) : model;
}

/** Return the underlying Bedrock model ID for a geographic inference profile. */
export function getBedrockInferenceProfileBaseModelId(model: string): string | null {
  const match = BEDROCK_RUNTIME_CRIS_RE.exec(bareBedrockModelId(model));
  return match?.groups?.['baseModelId'] ?? null;
}

/** True when the model is a CRIS profile that must be sent to Bedrock Runtime. */
export function isBedrockRuntimeModel(model: string): boolean {
  return getBedrockInferenceProfileBaseModelId(model) !== null;
}

/**
 * Bedrock Runtime host. Cross-Region inference (CRIS) profiles such as
 * `global.moonshotai.kimi-k3` are only served here — Mantle answers 404 for
 * them. The OpenAI-compatible surface lives under `/openai/v1` on this host.
 */
export function getBedrockRuntimeBaseUrl(region?: string | null): string {
  const resolved = isBedrockRegion(region) ? region : DEFAULT_BEDROCK_REGION;
  return `https://bedrock-runtime.${resolved}.amazonaws.com`;
}

/** Bedrock control-plane host (`ListInferenceProfiles`), authenticated with the same API key. */
export function getBedrockControlPlaneBaseUrl(region?: string | null): string {
  const resolved = isBedrockRegion(region) ? region : DEFAULT_BEDROCK_REGION;
  return `https://bedrock.${resolved}.amazonaws.com`;
}

/** Extract the region from a Mantle base URL (`https://bedrock-mantle.<region>.api.aws`). */
export function bedrockRegionFromMantleBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const match = /bedrock-mantle\.([a-z0-9-]+)\.api\.aws/i.exec(baseUrl);
  const region = match?.[1]?.toLowerCase();
  return isBedrockRegion(region) ? region : null;
}

export function normalizeBedrockMantleBaseUrl(baseUrl: string): string | null {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    const match = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(url.hostname);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    if (!match || !isBedrockRegion(match[1])) return null;
    return normalized.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function detectBedrockRegionFromApiKey(apiKey: string | undefined): string | null {
  const compact = apiKey?.replace(/\s/g, '') ?? '';
  if (compact.startsWith(AWS_BEARER_TOKEN_PREFIX)) return null;
  if (!compact.startsWith(LEGACY_BEDROCK_API_KEY_PREFIX)) return null;

  try {
    const encoded = compact.slice(LEGACY_BEDROCK_API_KEY_PREFIX.length);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const query = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded;
    const credential = new URLSearchParams(query).get('X-Amz-Credential');
    const region = credential?.split('/')[2];
    return isBedrockRegion(region) ? region : null;
  } catch {
    return null;
  }
}
