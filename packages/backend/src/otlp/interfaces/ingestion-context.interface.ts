export interface IngestionContext {
  tenantId: string;
  agentId: string;
  agentName: string;
  /**
   * The tenant's owning user, when one exists. Informational attribution
   * only (e.g. requests.user_id) — never used for scoping or auth.
   */
  userId: string | null;
}

/**
 * Attribution for a request the auth guard REJECTED but could still trace back
 * to an agent (today: an expired key, M004). Deliberately a separate property
 * from `ingestionContext` — the request is unauthenticated, and nothing
 * downstream may mistake this for a passing auth check. Only the proxy's
 * exception filter reads it, to record the rejection as a message row.
 */
export interface RequestWithManifestErrorContext {
  manifestErrorContext?: IngestionContext;
}
