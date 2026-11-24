/**
 * Shape of the payload POSTed once per 24h from a self-hosted install to the
 * ingest endpoint. All fields are derived aggregates — no per-request events,
 * no identifiers beyond the random `install_id` and the Manifest version.
 * Additive changes keep `schema_version: 1`; breaking changes bump it.
 *
 * Optional fields are flagged as such because installs running older Manifest
 * versions emit a strict subset. Receivers should feature-detect on presence,
 * not on `schema_version`.
 */
export interface TelemetryPayloadV1 {
  schema_version: 1;
  install_id: string;
  manifest_version: string;

  // Activity
  messages_total: number;
  messages_by_provider: Record<string, number>;
  messages_by_tier: Record<string, number>;
  messages_by_auth_type: Record<string, number>;

  // Volume
  tokens_input_total: number;
  tokens_output_total: number;

  /**
   * Total dollar value flowing through the install over the 24h window,
   * summed from the same `cost_usd` Manifest computes at routing time.
   * Rounded to cents to avoid leaking precision. Always present on installs
   * that ship this field — `0` when nothing chargeable was routed (e.g.
   * Ollama-only fleets). Optional in the DTO because older installs predate
   * the field; absence means "fall back to estimating from token counts".
   */
  cost_usd_total?: number;

  /**
   * Per-provider breakdown of `cost_usd_total`, keyed by the same canonical
   * provider buckets as `messages_by_provider` (registry ID for known
   * providers, `"custom"` for user-defined ones, `"unknown"` for legacy
   * NULLs). Values rounded to cents. Empty `{}` when no chargeable rows.
   */
  cost_usd_by_provider?: Record<string, number>;

  /**
   * Caller requests over the 24h window (request-first model: one row per
   * caller call; provider retries/fallbacks are attempts under it and are
   * NOT counted here). Optional because older installs predate the field.
   */
  requests_total?: number;

  /**
   * Requests that ended `failed` over the same window. Together with
   * `errors_by_class` this gives the receiver error visibility for installs
   * whose failures never reach the Phoenix heal path.
   */
  errors_total?: number;

  /**
   * Per-`error_class` split of `errors_total`, using the shared taxonomy
   * (`rate_limit`, `auth`, `invalid_request`, ...). Unknown values collapse
   * to `"other"` and unclassified NULLs to `"unknown"` — same
   * defense-in-depth as the tier map.
   */
  errors_by_class?: Record<string, number>;

  // Configuration
  agents_total: number;
  agents_by_platform: Record<string, number>;

  // Management surfaces (CLI + remote MCP). All derived from existing tables at
  // send time; nothing is counted per call. Optional because older installs
  // predate the fields.

  /** PATs minted by `mnfst login` (rows of `api_keys` named `cli`). */
  cli_keys_total?: number;
  /** Of those, keys that authenticated at least once in the last 7 days. */
  cli_keys_active_7d?: number;

  /** OAuth clients registered against the remote MCP server (not disabled). */
  mcp_clients_total?: number;
  /** Consent grants users gave to those clients. */
  mcp_consents_total?: number;
  /**
   * Access tokens minted in the 24h window. Tokens live 15 minutes, so an
   * actively used MCP session mints ~4/hour — this is the activity proxy
   * that stands in for a per-tool-call counter.
   */
  mcp_tokens_issued_24h?: number;
  /** Distinct clients that minted at least one access token in the window. */
  mcp_clients_active_24h?: number;
  /**
   * Registered clients keyed by their declared name, whitelisted to known MCP
   * hosts (`claude-code`, `cursor`, …). Anything else collapses to `"other"`
   * and a missing name to `"unknown"`, so a free-form client name never
   * leaves the install.
   */
  mcp_clients_by_name?: Record<string, number>;

  // Runtime
  platform: string;
  arch: string;
}
