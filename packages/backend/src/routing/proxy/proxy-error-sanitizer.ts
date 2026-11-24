import { scrubSecrets } from '../../common/utils/secret-scrub';

const KNOWN_ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request to upstream provider',
  401: 'Authentication failed with upstream provider',
  403: 'Forbidden by upstream provider',
  404: 'Model or endpoint not found',
  408: 'Upstream provider request timed out',
  422: 'Upstream provider rejected the request',
  429: 'Rate limited by upstream provider',
  500: 'Upstream provider internal error',
  502: 'Upstream provider returned bad gateway',
  503: 'Upstream provider temporarily unavailable',
  504: 'Upstream provider gateway timeout',
};

export type OpenAiCompatibleErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'server_error';

export interface ClassifiedProviderError {
  message: string;
  type: OpenAiCompatibleErrorType;
  code: 'context_length_exceeded';
  source: 'provider';
}

export interface StructuredProviderError {
  message: string;
  type: string | null;
  param: string | null;
  code: string | null;
}

const KNOWN_CONTEXT_ERROR_CODES = new Set(['context_length_exceeded']);

const KNOWN_CONTEXT_ERROR_MESSAGE_PATTERNS = [
  /\b(?:this (?:model|endpoint)'s )?maximum context length is \d+ tokens\b/i,
  /\bmaximum context length exceeded\b/i,
];

function sanitizeSensitivePatterns(msg: string): string {
  return scrubSecrets(
    msg.replace(/Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)/gi, 'Bearer [REDACTED]'),
  )
    .replace(
      /\\"(api[_-]?key|key)\\"(\s*:\s*)\\"(?:\\\\"|[^"\\]|\\(?!"))*\\"/gi,
      '\\"$1\\"$2\\"[REDACTED]\\"',
    )
    .replace(/"(api[_-]?key|key)"(\s*:\s*)"(?:\\.|[^"\\])*"/gi, '"$1"$2"[REDACTED]"')
    .replace(/'(api[_-]?key|key)'(\s*:\s*)'(?:\\.|[^'\\])*'/gi, "'$1'$2'[REDACTED]'")
    .replace(/\b(api[_-]?key)\b(\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi, '$1$2"[REDACTED]"')
    .replace(/\b(api[_-]?key)\b(\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi, "$1$2'[REDACTED]'")
    .replace(/\b(api[_-]?key)\b(\s*[:=]\s*)[^\s"',}&]+/gi, '$1$2[REDACTED]')
    .replace(/\b(key)\b(\s*=\s*)"(?:\\.|[^"\\])*"/gi, '$1$2"[REDACTED]"')
    .replace(/\b(key)\b(\s*=\s*)'(?:\\.|[^'\\])*'/gi, "$1$2'[REDACTED]'")
    .replace(/\b(key)\b(\s*=\s*)[^\s"',}&]+/gi, '$1$2[REDACTED]');
}

function normalizeErrorMessage(message: string): string {
  return sanitizeSensitivePatterns(message).replace(/\s+/g, ' ').trim().slice(0, 1000);
}

/**
 * FastAPI-style `detail`: either one string or a validation array whose entries
 * carry `msg`. ChatGPT Codex rejects an unsupported model this way, with no
 * `error` envelope at all, so ignoring it drops the only useful sentence.
 */
export function providerDetailMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail.trim().length > 0 ? detail : null;
  if (!Array.isArray(detail)) return null;
  const messages = detail.flatMap((entry) => {
    const msg =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).msg : undefined;
    return typeof msg === 'string' && msg.trim().length > 0 ? [msg] : [];
  });
  return messages.length > 0 ? messages.join('; ') : null;
}

/**
 * The human-readable message of a parsed provider error body, whatever the
 * envelope: `{error:{message}}`, `{error:"…"}`, `{message}`, or `{detail}`.
 */
function providerMessageOf(root: Record<string, unknown>): unknown {
  const nested = root.error;
  if (typeof nested === 'string') return nested;
  const error =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : root;
  return error.message ?? root.message ?? providerDetailMessage(root.detail);
}

function extractProviderMessage(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const message = providerMessageOf(parsed as Record<string, unknown>);
    return typeof message === 'string' && message.trim().length > 0 ? message : null;
  } catch {
    return null;
  }
}

function errorField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = normalizeErrorMessage(value);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Extract the allow-listed fields from a structured provider 4xx response.
 * Server errors and unstructured bodies keep the generic production message.
 */
export function parseStructuredProviderError(
  status: number,
  rawBody: string,
): StructuredProviderError | null {
  if (status < 400 || status >= 500) return null;

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const nested = root.error;
    const error =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : root;
    const message = errorField(providerMessageOf(root));
    if (!message) return null;

    return {
      message,
      type: errorField(error.type),
      param: errorField(error.param),
      code: errorField(error.code),
    };
  } catch {
    return null;
  }
}

function isHtmlErrorBody(rawBody: string): boolean {
  let offset = 0;
  while (offset < rawBody.length) {
    while (/\s/.test(rawBody.charAt(offset))) offset += 1;
    if (!rawBody.startsWith('<!--', offset)) break;

    const commentEnd = rawBody.indexOf('-->', offset + 4);
    if (commentEnd === -1) return false;
    offset = commentEnd + 3;
  }

  return /^(?:<!doctype\s+html|<html)\b/i.test(rawBody.slice(offset));
}

function htmlEndpointError(status: number | null | undefined, rawBody: string): string | null {
  if (!isHtmlErrorBody(rawBody)) return null;
  const ngrokCode = rawBody.match(/\bERR_NGROK_\d+\b/i)?.[0]?.toUpperCase();
  if (ngrokCode && /\bendpoint\b[\s\S]{0,300}\bis offline\b/i.test(rawBody)) {
    return `Tunnel endpoint is offline (${ngrokCode})`;
  }
  return status == null
    ? 'Upstream endpoint returned an HTML error page'
    : `Upstream endpoint returned HTTP ${status}`;
}

function extractProviderErrorCode(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const code = error?.code ?? parsed.code;
    return typeof code === 'string' && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

function hasKnownContextErrorCode(rawBody: string): boolean {
  const code = extractProviderErrorCode(rawBody);
  if (code && KNOWN_CONTEXT_ERROR_CODES.has(code.toLowerCase())) return true;
  return /\bcontext_length_exceeded\b/i.test(rawBody);
}

function hasKnownContextErrorMessage(rawBody: string): boolean {
  const message = extractProviderMessage(rawBody) ?? rawBody;
  return KNOWN_CONTEXT_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isContextLengthError(status: number, rawBody: string): boolean {
  if (status < 400) return false;
  return hasKnownContextErrorCode(rawBody) || hasKnownContextErrorMessage(rawBody);
}

export function openAiErrorTypeForStatus(status: number): OpenAiCompatibleErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function classifyProviderError(
  status: number,
  rawBody: string,
): ClassifiedProviderError | null {
  if (!isContextLengthError(status, rawBody)) return null;
  const message = extractProviderMessage(rawBody) ?? rawBody;
  return {
    message: normalizeErrorMessage(message),
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
    source: 'provider',
  };
}

export function sanitizeProviderError(status: number, rawBody: string, nodeEnv?: string): string {
  const generic = KNOWN_ERROR_MESSAGES[status] ?? `Upstream provider returned HTTP ${status}`;
  const endpointError = htmlEndpointError(status, rawBody);
  if (endpointError) return endpointError;
  const classified = classifyProviderError(status, rawBody);
  if (classified) return classified.message;
  const structured = parseStructuredProviderError(status, rawBody);
  if (structured) return structured.message;

  // In production, unstructured and 5xx responses stay generic to avoid leaking internals.
  if ((nodeEnv ?? 'production') === 'production') return generic;

  const message = extractProviderMessage(rawBody);
  if (message) {
    return normalizeErrorMessage(message).slice(0, 500);
  }

  return generic;
}

export function normalizeProviderErrorForStorage(
  status: number | null | undefined,
  rawBody: string,
): string {
  return htmlEndpointError(status, rawBody) ?? rawBody;
}
