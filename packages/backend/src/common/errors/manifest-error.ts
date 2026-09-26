import { HttpException } from '@nestjs/common';
import { formatManifestError, MANIFEST_ERRORS, type ManifestErrorCode } from './error-codes';

/**
 * `routing_reason` values the proxy stamps on a Manifest-originated row. Each
 * one classifies to an `{ error_origin, error_class }` pair via
 * `classifyMessageError` in `manifest-shared` — the two lists are kept in
 * lock-step by `__tests__/manifest-error.spec.ts`.
 */
export const MANIFEST_BLOCKED_REQUEST_REASONS = [
  'no_provider',
  'no_provider_key',
  'subscription_credentials_unusable',
  'key_expired',
  'limit_exceeded',
  'plan_request_limit_exceeded',
  'manifest_rate_limited',
  'manifest_ip_rate_limited',
  'manifest_concurrency_limited',
  'manifest_invalid_request',
  'local_provider_unavailable',
  'model_not_available',
  'manifest_internal_error',
] as const;
export type ManifestBlockedRequestReason = (typeof MANIFEST_BLOCKED_REQUEST_REASONS)[number];

/**
 * Error codes that can never become an `agent_messages` row: they are raised by
 * `AgentKeyAuthGuard` before a key resolves to a tenant, so there is no agent to
 * attribute the row to. Recording them anyway would let anyone holding the
 * endpoint URL write rows into someone else's dashboard by guessing keys.
 *
 * `M004` (expired key) is deliberately NOT here — that key does resolve to an
 * agent, so its rejection is recordable.
 */
export const UNRECORDABLE_MANIFEST_CODES = ['M001', 'M002', 'M003', 'M005'] as const;
export type UnrecordableManifestCode = (typeof UNRECORDABLE_MANIFEST_CODES)[number];

/** A documented Manifest error that can be attributed to an agent, and so recorded. */
export type RecordableManifestCode = Exclude<ManifestErrorCode, UnrecordableManifestCode>;

/**
 * The one mapping from a documented error code to the reason persisted on its
 * message row. Adding a code to `MANIFEST_ERRORS` without adding it here (or to
 * `UNRECORDABLE_MANIFEST_CODES`) fails the guardrail spec.
 */
export const MANIFEST_CODE_TO_REASON: Record<RecordableManifestCode, ManifestBlockedRequestReason> =
  {
    M004: 'key_expired',
    M100: 'no_provider_key',
    M101: 'no_provider',
    M102: 'subscription_credentials_unusable',
    M200: 'limit_exceeded',
    M201: 'manifest_rate_limited',
    M202: 'manifest_ip_rate_limited',
    M203: 'manifest_concurrency_limited',
    M204: 'plan_request_limit_exceeded',
    M300: 'manifest_invalid_request',
    M302: 'model_not_available',
    M303: 'local_provider_unavailable',
    M304: 'manifest_invalid_request',
    M500: 'manifest_internal_error',
  };

export function isRecordableManifestCode(code: ManifestErrorCode): code is RecordableManifestCode {
  return !(UNRECORDABLE_MANIFEST_CODES as readonly string[]).includes(code);
}

/**
 * An error Manifest itself raised, carrying the documented code that identifies
 * it. Throwing this instead of a bare `HttpException` is what lets the proxy
 * tell "Manifest rejected the request" from "the provider returned a 4xx" —
 * before this existed, a `BadRequestException` for a malformed body was recorded
 * as a provider error and counted against provider reliability.
 */
export class ManifestError extends HttpException {
  constructor(
    readonly code: ManifestErrorCode,
    status: number,
    vars: Record<string, string | number> = {},
  ) {
    super(formatManifestError(code, vars), status);
  }

  /** Human title from the catalogue, e.g. "Missing messages array". */
  get title(): string {
    return MANIFEST_ERRORS[this.code].title;
  }
}
