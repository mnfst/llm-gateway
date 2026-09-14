import { Injectable } from '@nestjs/common';
import { parseOAuthTokenBlob } from '../oauth/core';

/**
 * Process-local health state for provider credentials that an upstream rejected
 * with an authentication error (401). A 401 is an auth failure, not a transient
 * one: without this, every request selects the dead connection first, burns an
 * upstream call, and only then falls back — exactly the latency and quota waste
 * reported for dead OpenAI subscription tokens (issue #2883).
 *
 * Entries are keyed by `tenant_providers.id` and carry a fingerprint of the
 * credential value that failed. Re-authenticating replaces the refresh token /
 * API key, so the fingerprint changes and the entry is ignored automatically —
 * this is what lets routing resume without an explicit "clear" on re-auth.
 *
 * In-memory on purpose: routing already resolves selection per request, and a
 * restart simply re-learns the failure on the next attempted call.
 */

const MAX_TRACKED_CREDENTIALS = 5_000;

export type CredentialAuthFailureReason = 'subscription_token_rejected' | 'api_key_rejected';

export interface CredentialAuthFailure {
  /** Upstream status that rejected the credential (401/403). */
  statusCode: number;
  reason: CredentialAuthFailureReason;
  /** Connection label at the time of failure, for logs and the dashboard. */
  keyLabel?: string;
  /** Provider the credential belongs to, for the dashboard. */
  provider?: string;
  /** Epoch ms of the most recent rejection. */
  at: number;
}

export interface CredentialHealthSnapshot {
  requires_reauth: boolean;
  last_auth_failure: CredentialAuthFailure | null;
}

interface RejectedEntry {
  fingerprint: string;
  failure: CredentialAuthFailure;
}

/**
 * Stable identity for a credential value. For an OAuth blob the refresh token
 * is the stable part (access tokens rotate on every refresh); for an API key the
 * key itself is. Anything else falls back to the raw value.
 */
export function credentialFingerprint(rawValue: string): string {
  const blob = parseOAuthTokenBlob(rawValue);
  const material = blob ? blob.r || blob.t : rawValue;
  // An in-memory equality tag for a credential that failed upstream, not
  // password storage: the tag is never persisted and never verifies a secret.
  // Four FNV-1a-style 32-bit mixes make a 128-bit tag cheap enough for the
  // routing hot path without routing secret material through a KDF.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  let h3 = 0x85ebca77;
  let h4 = 0xc2b2ae3d;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
    h3 = Math.imul(h3 + c, 0x27d4eb2f);
    h4 = Math.imul(h4 ^ (c << 3), 0x165667b1);
  }
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

@Injectable()
export class CredentialHealthService {
  private readonly rejected = new Map<string, RejectedEntry>();

  /**
   * Record that the credential behind `tenantProviderId` was rejected upstream.
   * Calling again refreshes the failure (new status/label/timestamp) but keeps
   * the same fingerprint unless the credential itself changed.
   */
  markRejected(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
    failure: Omit<CredentialAuthFailure, 'at'> & { at?: number },
  ): void {
    if (!tenantProviderId || !rawValue) return;
    if (this.rejected.size >= MAX_TRACKED_CREDENTIALS && !this.rejected.has(tenantProviderId)) {
      // Evict the oldest entry. The map is non-empty here (size >= max), so the
      // loop always deletes exactly one key on its first iteration.
      for (const oldest of this.rejected.keys()) {
        this.rejected.delete(oldest);
        break;
      }
    }
    this.rejected.set(tenantProviderId, {
      fingerprint: credentialFingerprint(rawValue),
      failure: { ...failure, at: failure.at ?? Date.now() },
    });
  }

  /**
   * Mark a credential healthy again after a successful upstream call. Only
   * clears the entry when the value still matches the one that failed, so a
   * stale success from a replaced credential cannot erase a fresh failure.
   */
  markHealthy(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
  ): void {
    if (!tenantProviderId || !rawValue) return;
    const entry = this.rejected.get(tenantProviderId);
    if (!entry) return;
    if (entry.fingerprint === credentialFingerprint(rawValue)) {
      this.rejected.delete(tenantProviderId);
    }
  }

  /**
   * Whether this exact credential is still the rejected one. A re-authenticated
   * credential (different refresh token / API key) reports healthy and drops the
   * stale entry.
   */
  isRejected(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
  ): boolean {
    if (!tenantProviderId || !rawValue) return false;
    const entry = this.rejected.get(tenantProviderId);
    if (!entry) return false;
    if (entry.fingerprint !== credentialFingerprint(rawValue)) {
      this.rejected.delete(tenantProviderId);
      return false;
    }
    return true;
  }

  getFailure(tenantProviderId: string | null | undefined): CredentialAuthFailure | null {
    if (!tenantProviderId) return null;
    return this.rejected.get(tenantProviderId)?.failure ?? null;
  }

  /**
   * Health for the providers API. The failure stays until the credential
   * itself is replaced or a later upstream call succeeds, matching what
   * routing does: a metadata edit (rename, reorder) must never hide a skip.
   */
  getSnapshot(tenantProviderId: string | null | undefined): CredentialHealthSnapshot {
    const failure = this.getFailure(tenantProviderId);
    return failure
      ? { requires_reauth: true, last_auth_failure: failure }
      : { requires_reauth: false, last_auth_failure: null };
  }

  /** Test hook: drop all tracked failures. */
  clear(): void {
    this.rejected.clear();
  }

  /** Drop the tracked failure for one connection, e.g. after it is reconnected. */
  clearConnection(tenantProviderId: string | null | undefined): void {
    if (tenantProviderId) this.rejected.delete(tenantProviderId);
  }
}
