import { createHash } from 'crypto';

const DEFAULT_SESSION_KEY = 'default';
const SESSION_SCOPE_VERSION = 'v1';

export interface ProxySessionScope {
  /** Caller-facing session key retained for message attribution. */
  sessionKey: string;
  /** Fixed-length tenant/agent/session key used only for internal replay caches. */
  cacheKey: string;
  /** Opaque provider prompt-cache affinity key; absent without an explicit caller session. */
  providerCacheKey?: string;
  /** Routing momentum is enabled only when the caller supplied a session key. */
  momentumKey?: string;
}

export function buildProxySessionScope(
  tenantId: string,
  agentId: string,
  sessionHeader: unknown,
): ProxySessionScope {
  const explicitSessionKey =
    typeof sessionHeader === 'string' && sessionHeader.length > 0 ? sessionHeader : undefined;
  const sessionKey = explicitSessionKey ?? DEFAULT_SESSION_KEY;
  const digest = createHash('sha256')
    .update(tenantId)
    .update('\0')
    .update(agentId)
    .update('\0')
    .update(sessionKey)
    .digest('hex');
  const cacheKey = `${SESSION_SCOPE_VERSION}:${digest}`;

  return {
    sessionKey,
    cacheKey,
    ...(explicitSessionKey ? { providerCacheKey: cacheKey, momentumKey: cacheKey } : {}),
  };
}
