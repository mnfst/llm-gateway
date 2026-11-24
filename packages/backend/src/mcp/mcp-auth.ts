import { TenantCacheService } from '../common/services/tenant-cache.service';
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from '../auth/mcp-scopes';

/** The claims carried by one verified OAuth access token. */
export interface McpAccessTokenClaims {
  sub?: string;
  scope?: unknown;
}

/** The operator and capabilities carried by one verified OAuth access token. */
export interface McpOperator {
  userId: string;
  tenantId: string;
  scopes: ReadonlySet<string>;
}

/** Convert the OAuth JWT's space-separated scope claim to exact capabilities. */
export function scopesFromClaims(claims: McpAccessTokenClaims): ReadonlySet<string> {
  if (typeof claims.scope !== 'string') return new Set();
  return new Set(claims.scope.split(' ').filter(Boolean));
}

export { MCP_READ_SCOPE, MCP_WRITE_SCOPE };

/**
 * Resolve the subject of a cryptographically verified MCP access token to an
 * acting operator.
 *
 * Signature, issuer, audience, expiry, and baseline scope checks happen before
 * this function — `createMcpProtectedRequestHandler` owns them. Here we only map `sub` (a Better
 * Auth user id) to that user's tenant through the same cache the session guard
 * uses, so every tool is scoped exactly like the dashboard and CLI are.
 *
 * Returns null when the user has no tenant yet; the MCP route answers 401 so a
 * deleted or tenant-less account can never act.
 */
export async function resolveMcpOperator(
  tenantCache: TenantCacheService,
  claims: McpAccessTokenClaims,
): Promise<McpOperator | null> {
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  const tenantId = await tenantCache.resolve(claims.sub);
  if (!tenantId) return null;
  return { userId: claims.sub, tenantId, scopes: scopesFromClaims(claims) };
}
