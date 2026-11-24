import { isAnthropicExtraUsageError } from 'manifest-shared';
import { scrubSecrets } from '../../common/utils/secret-scrub';
import { redactInlineImageDataUrls } from '../proxy/inline-image-redaction';
import type { ProviderWireFormat, ProxyApiMode } from '../proxy/proxy-types';
import type { AuthType } from 'manifest-shared';
import { normalizeProviderError } from './provider-error-normalizer';
import type { HealRequest } from './phoenix.types';

/**
 * 4xx codes that are never a defect in the request body: the caller is
 * unauthenticated, out of credit, forbidden, or throttled. Rewriting the request
 * cannot fix any of them, so reporting them to Phoenix would only pad its issue
 * base with noise. Mirrors the exclusion list Peacock's historical scrape uses
 * (`phoenix-ingestion-sql.ts`), so the live feed and the scrape agree on scope.
 */
const NON_REQUEST_SIDE = new Set([401, 402, 403, 429]);

/**
 * Cap on the serialized observation body. Phoenix stores request bodies
 * uncapped, and a single agent can forward a multi-megabyte prompt; an
 * observation is diagnostic evidence, not an archive, so oversized ones are
 * dropped rather than truncated (a half-body would fingerprint the same but
 * heal wrong).
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** Whether a failed forward is a request-side 4xx worth reporting. */
export function isReportableStatus(status: number): boolean {
  return status >= 400 && status < 500 && !NON_REQUEST_SIDE.has(status);
}

/**
 * Keys whose value is a credential whatever its shape. {@link scrubSecrets} only
 * matches text, so a non-string value (a number, an object) under one of these
 * would survive it. Compared after {@link normalizeKey}, so every separator and
 * casing variant a caller might send — `api_key`, `apiKey`, `X-API-Key` — folds
 * onto one entry.
 */
const CREDENTIAL_KEYS = new Set([
  'xapikey',
  'authorization',
  'apikey',
  'apisecret',
  'refreshtoken',
  'clientsecret',
  'accesstoken',
  'devicecode',
]);

/**
 * Fold a JSON key to its separator- and case-insensitive form. Every
 * non-alphanumeric character goes, not just `-`/`_`, so `client.secret` and
 * `access token` fold onto the same entry as `clientSecret` and `access_token`.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep the resolved endpoint while removing credentials from query parameters. */
export function scrubProviderUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|signature|credential/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return scrubSecrets(raw);
  }
}

/**
 * Recursively scrub credentials out of a body.
 *
 * Walk the values rather than the serialized JSON. Scrubbing the serialized form
 * would miss a secret nested inside message content — `{"authorization":"Basic …"}`
 * quoted inside a prompt serializes to `{\"authorization\":\"Basic …\"}`, whose
 * escaped quotes defeat the header pattern — and a replacement landing outside a
 * string literal would leave invalid JSON. Walking sidesteps both: every string
 * reaches {@link scrubSecrets} unescaped, and the structure is never touched.
 *
 * Property names are caller-controlled too, so they are scrubbed like any other
 * string — a key that IS a secret would otherwise ride along untouched.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const scrubbed = CREDENTIAL_KEYS.has(normalizeKey(key)) ? '[REDACTED]' : scrubValue(nested);
    out[scrubSecrets(key)] = scrubbed;
  }
  return out;
}

/**
 * Strip credentials and inline base64 images from a request body before it
 * leaves this process, or return null when the body is too large to ship. The
 * body is the caller's, not ours, and it can carry a key a user pasted into a
 * prompt or a tool definition.
 */
export function scrubBody(body: Record<string, unknown>): Record<string, unknown> | null {
  // Inline base64 images go first: an observation is evidence about the shape of
  // a request, and no Phoenix operation reads image bytes. Dropping them before
  // the size check also keeps a request that only failed the cap because of a
  // screenshot reportable.
  const withoutImages = redactInlineImageDataUrls(body);
  if (Buffer.byteLength(JSON.stringify(withoutImages), 'utf8') > MAX_BODY_BYTES) return null;
  return scrubValue(withoutImages) as Record<string, unknown>;
}

export interface ObservationInput {
  /**
   * The `traceparent` trace id when the caller sent one. Phoenix keys its ledger
   * on `(issue, traceId)`, and Peacock's scrape reports the same
   * `agent_messages.trace_id`, so passing it through is what lets a live
   * observation and a later scrape of the same failure collapse into one row.
   */
  traceId: string;
  tenantId: string;
  /**
   * The agent the request routed through. Used ONLY to resolve the Autofix
   * consent gate (`isActiveFor`) — never part of the observation, since Phoenix
   * attributes failures to a tenant, not to an agent.
   */
  agentId: string;
  provider: string;
  /** Logical model identity when the provider encodes it in the URL. */
  model: string;
  authType: AuthType;
  apiMode: ProxyApiMode;
  /**
   * The provider-facing body. Inline base64 images are redacted below because an
   * observation is evidence only and no Phoenix operation needs the image bytes.
   */
  requestBody: Record<string, unknown>;
  providerWire?: {
    format: ProviderWireFormat;
    url?: string;
    body: Record<string, unknown>;
  };
  status: number;
  /** Raw text of the provider's error response. */
  errorBody: string;
  responseTimeMs?: number;
}

/**
 * Build the `/api/heal/observe` payload for one failed forward, or null when the
 * failure isn't request-side or the body can't be safely shipped.
 */
export function toObservation(input: ObservationInput): HealRequest | null {
  if (!isReportableStatus(input.status)) return null;
  if (
    isAnthropicExtraUsageError({
      provider: input.provider,
      httpStatus: input.status,
      errorBody: input.errorBody,
    })
  ) {
    return null;
  }
  const scrubbed = scrubBody(input.requestBody);
  if (!scrubbed) return null;
  const scrubbedProviderBody = input.providerWire ? scrubBody(input.providerWire.body) : null;
  if (input.providerWire && !scrubbedProviderBody) return null;

  const safeErrorBody = scrubSecrets(input.errorBody);
  let providerResponseBody: unknown = safeErrorBody;
  try {
    providerResponseBody = JSON.parse(safeErrorBody) as unknown;
  } catch {
    // Plain-text provider responses remain plain text.
  }

  return {
    traceId: input.traceId,
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    authType: input.authType,
    api: input.apiMode,
    request: scrubbed,
    response: { statusCode: input.status, error: normalizeProviderError(input.errorBody) },
    ...(input.providerWire
      ? {
          providerExchange: {
            format: input.providerWire.format,
            ...(input.providerWire.url ? { url: scrubProviderUrl(input.providerWire.url) } : {}),
            request: { body: scrubbedProviderBody!, redactedFields: [] },
            response: { statusCode: input.status, body: providerResponseBody },
          },
        }
      : {}),
    ...(input.responseTimeMs != null ? { responseTimeMs: input.responseTimeMs } : {}),
  };
}
