import { scrubSecrets } from '../../common/utils/secret-scrub';
import { providerDetailMessage } from '../proxy/proxy-error-sanitizer';
import type { PhoenixProviderError } from './phoenix.types';

const MAX_MESSAGE_LENGTH = 2000;

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Like {@link coerceString} but scrubs secrets from the result. Every string
 * lifted off the upstream error body (`type`/`param`/`code`, not just `message`)
 * is shipped to Phoenix, so a provider that echoes a key in any of them must not
 * leak it.
 */
function coerceScrubbed(value: unknown): string | null {
  const raw = coerceString(value);
  return raw === null ? null : scrubSecrets(raw);
}

/**
 * Turn a raw upstream error body (the text of a 4xx provider response) into the
 * normalised `{ message, type, param, code }` shape Phoenix fingerprints on.
 *
 * Handles the OpenAI-compatible envelope (`{ error: { message, type, param,
 * code } }`), a flat `{ message, ... }` body, a bare `{ error: "…" }` string, a
 * FastAPI-style `{ detail }`, and non-JSON bodies (the raw text becomes the
 * message). Secrets are scrubbed and the message is length-capped so
 * we never ship a key or an unbounded blob to the healing service.
 */
export function normalizeProviderError(rawBody: string): PhoenixProviderError {
  let parsed: Record<string, unknown> | null = null;
  try {
    const json = JSON.parse(rawBody) as unknown;
    if (json && typeof json === 'object') parsed = json as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  const errorObj =
    parsed && typeof parsed.error === 'object' && parsed.error !== null
      ? (parsed.error as Record<string, unknown>)
      : parsed;

  const rawMessage =
    coerceString(errorObj?.message) ??
    coerceString(parsed?.message) ??
    coerceString(parsed?.error) ??
    providerDetailMessage(parsed?.detail) ??
    rawBody;
  const message = scrubSecrets(rawMessage).slice(0, MAX_MESSAGE_LENGTH);

  return {
    message,
    type: coerceScrubbed(errorObj?.type),
    param: coerceScrubbed(errorObj?.param),
    code: coerceScrubbed(errorObj?.code),
  };
}

/** Cap on the dimension fields, mirroring the bound Phoenix's wire schema enforces. */
const MAX_FIELD_LENGTH = 1024;

/** The same error stripped of its dimensions — the fallback when they don't fit. */
function bare(message: string): PhoenixProviderError {
  return { message, type: null, param: null, code: null };
}

/** Build the envelope, omitting the dimensions the provider didn't give us. */
function envelopeOf(error: PhoenixProviderError, message: string): string {
  return JSON.stringify({
    error: {
      message,
      ...(error.type ? { type: error.type } : {}),
      ...(error.param ? { param: error.param } : {}),
      ...(error.code ? { code: error.code } : {}),
    },
  });
}

/**
 * Re-serialize a normalised error into the OpenAI-compatible `{"error":{…}}` envelope —
 * the inverse of {@link normalizeProviderError}, and the shape every other
 * `agent_messages.error_message` already holds.
 *
 * Autofix rows used to persist `error.message` alone, silently dropping `type`, `param`
 * and `code`. Those are exactly the dimensions Phoenix fingerprints on, so a downstream
 * re-ingest of such a row (Peacock's historical scrape) landed on a *different* issue than
 * the live `/heal` that had already reported the same failure — one error, two issues,
 * split occurrence counts.
 *
 * Every field is scrubbed and bounded here rather than at the call site: this is a storage
 * boundary, and it must not assume its input already went through
 * {@link normalizeProviderError}. The result never exceeds {@link MAX_MESSAGE_LENGTH} and
 * always parses — only field *contents* are trimmed, never the JSON.
 */
export function serializeProviderError(error: PhoenixProviderError): string {
  const clip = (v: string | null | undefined) =>
    v ? scrubSecrets(v).slice(0, MAX_FIELD_LENGTH) : null;
  const safe: PhoenixProviderError = {
    message: scrubSecrets(error.message),
    type: clip(error.type),
    param: clip(error.param),
    code: clip(error.code),
  };

  // The dimensions identify the error, so they are kept and the message absorbs the trim.
  // Unless they exhaust the budget on their own — a provider padding them with characters
  // JSON escapes to six bytes each. Then drop them and keep the message, which is all this
  // row stored before anyway. Either way an empty message now fits, so the trim below can
  // always close the gap.
  const target = envelopeOf(safe, '').length <= MAX_MESSAGE_LENGTH ? safe : bare(safe.message);

  let message = target.message;
  let out = envelopeOf(target, message);
  while (out.length > MAX_MESSAGE_LENGTH && message.length > 0) {
    message = dropTail(message, Math.max(out.length - MAX_MESSAGE_LENGTH, 1));
    out = envelopeOf(target, message);
  }
  return out;
}

/**
 * Drop `count` UTF-16 code units off the end of `s`, never leaving a lone high surrogate.
 *
 * Trimming a message usually shrinks its JSON by as much as it removes. Cutting an astral
 * character in half does the opposite: `JSON.stringify` renders the orphaned half as the
 * six-character escape `\ud83d`, so a one-unit cut can grow the envelope by four. Dropping
 * the orphan restores the "shrinks by at least `count`" property the caller's loop needs to
 * make progress.
 */
function dropTail(s: string, count: number): string {
  const cut = s.slice(0, Math.max(0, s.length - count));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
