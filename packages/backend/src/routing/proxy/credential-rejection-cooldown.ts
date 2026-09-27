/** How long a credential the provider rejected with a 401 is skipped. */
export const CREDENTIAL_REJECTION_COOLDOWN_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;

/** The credential a provider call used, as routing knows it. */
export interface RejectedCredentialRef {
  tenantId?: string;
  /** The `tenant_providers` row that served the call, when there is one. */
  connectionId?: string | null;
  provider: string;
  authType?: string;
  keyLabel?: string;
  /** A 401 can be model-specific, so one model's rejection never skips another. */
  model: string;
  /** The secret actually sent upstream: an API key or an OAuth access token. */
  secret: string;
}

interface Rejection {
  until: number;
  /** The exact secret the provider refused. Any other secret is tried again. */
  secret: string;
}

/**
 * Remembers credentials a provider rejected with a 401, so routing skips them
 * for a while instead of paying an upstream round-trip (and, for OAuth, a
 * refresh attempt) on every request before falling back.
 *
 * One entry per connection and model holds the secret that was refused.
 * Reconnecting an OAuth subscription or replacing an API key changes the
 * secret, so the new credential is tried at once without any invalidation hook. The secret is compared, never hashed or persisted:
 * the process already holds it for every request. The state is in-memory per
 * replica: a restart or another replica costs at most one more rejected call
 * before it learns the same thing.
 */
export class CredentialRejectionCooldown {
  private readonly rejections = new Map<string, Rejection>();

  constructor(
    private readonly ttlMs = CREDENTIAL_REJECTION_COOLDOWN_MS,
    private readonly maxEntries = MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reject(ref: RejectedCredentialRef): void {
    const key = connectionKey(ref);
    if (!key || !ref.secret) return;
    // Re-insert so insertion order stays expiry order (see evict).
    this.rejections.delete(key);
    if (this.rejections.size >= this.maxEntries) this.evict();
    this.rejections.set(key, { until: this.now() + this.ttlMs, secret: ref.secret });
  }

  /** Epoch ms until which the credential is skipped, or null when it is usable. */
  rejectedUntil(ref: RejectedCredentialRef): number | null {
    const key = connectionKey(ref);
    if (!key) return null;
    const rejection = this.rejections.get(key);
    if (!rejection) return null;
    if (rejection.until <= this.now()) {
      this.rejections.delete(key);
      return null;
    }
    return rejection.secret === ref.secret ? rejection.until : null;
  }

  /** Drop expired entries, then the oldest one if the map is still full. */
  private evict(): void {
    const now = this.now();
    for (const [key, rejection] of this.rejections) {
      if (rejection.until <= now) this.rejections.delete(key);
    }
    if (this.rejections.size < this.maxEntries) return;
    // Every entry shares one TTL, so insertion order is expiry order.
    const oldest = this.rejections.keys().next().value as string;
    this.rejections.delete(oldest);
  }
}

function connectionKey(ref: RejectedCredentialRef): string | null {
  if (!ref.tenantId) return null;
  return [
    ref.tenantId,
    ref.connectionId ?? '',
    ref.provider.toLowerCase(),
    ref.authType ?? '',
    ref.keyLabel ?? '',
    ref.model.toLowerCase(),
  ].join('\u0000');
}
