import type { ProviderWireFormat, ProxyApiMode } from '../proxy/proxy-types';
import type { AuthType } from 'manifest-shared';

/**
 * Wire contract for the Phoenix healing service (mnfst/phoenix). Mirrors
 * Phoenix's `phoenix-openapi.yaml` (the source of truth): POST /api/heal returns
 * a discriminated heal decision, and PATCH /api/heal-attempts/{healAttemptId}
 * reports the post-retry outcome. Keep these shapes in lockstep with Phoenix —
 * the HttpHealingClient maps 1:1.
 */

/** Normalised provider error — the four fields Phoenix fingerprints on. */
export interface PhoenixProviderError {
  message: string;
  type?: string | null;
  param?: string | null;
  code?: string | null;
}

export interface PhoenixProviderResponse {
  statusCode: number;
  error: PhoenixProviderError;
}

/** Final provider-side exchange, separate from the request shape Phoenix patches. */
export interface PhoenixProviderExchange {
  format: ProviderWireFormat;
  url?: string;
  request: {
    body: Record<string, unknown>;
    redactedFields?: string[];
  };
  response: {
    statusCode: number;
    body: unknown;
  };
}

/** POST /api/heal request body. Route identity scopes Phoenix's fingerprint. */
export interface HealRequest {
  /**
   * Correlates every heal within one logical request's retry chain — Phoenix's
   * `traceId` (Manifest reuses the message-link group id). REQUIRED: Phoenix
   * rejects a heal request without it (`400`).
   */
  traceId: string;
  /**
   * The Manifest tenant this request belongs to (`Tenant.id`). Attributes the
   * failure to a customer so Phoenix can report affected tenants per issue and
   * browse a tenant's failures. Always available on the proxy heal path (the
   * agent key resolves a tenant), so we always send it; Phoenix treats it as an
   * optional, opaque label.
   */
  tenantId: string;
  provider: string;
  /** Logical model identity; native transports may encode it in the URL. */
  model?: string;
  authType: AuthType;
  /**
   * Provider-facing wire protocol. `request` uses this shape, and Phoenix must
   * return `healedBody` in the same shape so Manifest can resend it verbatim.
   */
  api: ProxyApiMode;
  url?: string;
  request: Record<string, unknown>;
  response: PhoenixProviderResponse;
  providerExchange?: PhoenixProviderExchange;
  responseTimeMs?: number;
  responseSizeBytes?: number;
}

/**
 * Heal decision from `POST /api/heal`. Both `patched` (the issue is already
 * verified) and `unverified` (a freshly served patch, not yet confirmed) carry a
 * `healedBody` + `healAttemptId` to resend — the client keys off their presence,
 * not an allow-list, so a future patch-bearing status still applies. `resolving`
 * means Phoenix is still authoring a fix (nothing to resend); `no_patch` is terminal.
 *
 * Declared as a runtime array so `phoenix-contract.spec.ts` can assert it stays
 * in lockstep with the OpenAPI `HealResult.status` enum.
 */
export const HEAL_STATUSES = ['patched', 'unverified', 'resolving', 'no_patch'] as const;
export type PhoenixHealStatus = (typeof HEAL_STATUSES)[number];

/** One deterministic edit from the Phoenix catalog (MVP #1: rename_param). */
export interface PhoenixOperation {
  type: string;
  from?: string;
  to?: string;
}

/**
 * Phoenix's own human-readable "why" for a served heal — render this instead of
 * re-deriving prose from the raw operations (which we did before, incompletely).
 * `operations[].detail` is a plain sentence per edit (built from the real args);
 * `summary` is the one-line story; `source` says whether the text was composed
 * deterministically, written by the investigator agent, or by an operator.
 */
export interface PhoenixExplanation {
  summary: string;
  operations: Array<{ type: string; detail: string }>;
  source: 'deterministic' | 'agent' | 'operator';
}

/** POST /api/heal response — discriminated on `status`. */
export interface HealResponse {
  status: PhoenixHealStatus;
  issueId: string;
  patchId?: string | null;
  /** Present when a patch was handed out; report its outcome via PATCH /api/heal-attempts/{healAttemptId}. */
  healAttemptId?: string | null;
  operations?: PhoenixOperation[] | null;
  /** Human-readable "why" for the fix, present when a patch was handed out. */
  explanation?: PhoenixExplanation | null;
  healedBody?: Record<string, unknown> | null;
  retryAfterMs?: number | null;
}

/**
 * PATCH /api/heal-attempts/{healAttemptId} request body — what happened after we
 * applied the patch and retried. Phoenix (not us) decides succeeded/failed from
 * this. `error` is REQUIRED when `retryStatusCode >= 400`, omitted on 2xx.
 */
export interface HealOutcome {
  retryStatusCode: number;
  error?: PhoenixProviderError;
}

/** Issue lifecycle states — kept in lockstep with the OpenAPI `IssueView.status` enum. */
export const ISSUE_STATUSES = [
  'resolving',
  'unverified',
  'verified',
  'ineffective',
  'no_fix_found',
] as const;
export type PhoenixIssueStatus = (typeof ISSUE_STATUSES)[number];

/** Adjudicated attempt outcome — kept in lockstep with the OpenAPI `OutcomeResult.status` enum. */
export const OUTCOME_STATUSES = ['succeeded', 'failed', 'expired'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** PATCH /api/heal-attempts/{healAttemptId} response body. */
export interface ConfirmResponse {
  healAttemptId: string;
  /** `expired` when the attempt was swept (no outcome reported in time) before this call. */
  status: OutcomeStatus;
  /**
   * The issue's status after this outcome. Typed as a plain string to match the
   * vendored OpenAPI (`OutcomeResult.issueStatus: { type: string }`) rather than
   * narrowing to {@link PhoenixIssueStatus} — Phoenix does not guarantee the enum
   * on this field, so callers must not assume exhaustiveness. Reporting is
   * fire-and-forget, so this value is not consumed today.
   */
  issueStatus: string;
}
