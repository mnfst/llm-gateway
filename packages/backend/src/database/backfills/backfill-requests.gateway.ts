import { DataSource, QueryRunner } from 'typeorm';
import type { RequestBackfillGateway, RequestBackfillTimeouts } from './backfill-requests';

const RETRYABLE_STAGED_BATCH_ERROR = /statement timeout|lock timeout|deadlock/i;

function canResizeStagedBatch(error: unknown): boolean {
  return RETRYABLE_STAGED_BATCH_ERROR.test(error instanceof Error ? error.message : String(error));
}

export const REQUEST_BACKFILL_WINDOW_END_SQL = `
  SELECT max(id) AS end_id
  FROM (
    SELECT id
    FROM "agent_messages"
    WHERE "request_id" IS NULL AND id > $1 AND timestamp < $3
    ORDER BY id
    LIMIT $2
  ) w
`;

export const FALLBACK_PRIMARY_WINDOW_END_SQL = `
  SELECT max(id) AS end_id
  FROM (
    SELECT id
    FROM "agent_messages"
    WHERE "request_id" IS NULL
      AND id > $1
      AND timestamp < $3
      AND status = 'fallback_error'
      AND COALESCE(superseded, false)
      AND fallback_from_model IS NULL
      AND model IS NOT NULL
    ORDER BY id
    LIMIT $2
  ) w
`;

const REQUEST_LEVEL_ORIGINS = `'config', 'policy', 'request', 'internal'`;

/**
 * The requests this backfill materializes must use the canonical
 * `success` / `failed` vocabulary, same as the live recorder now writes, so the
 * `requests` table is coherent regardless of which side created a row. Historical
 * `agent_messages.status` still holds the legacy values (`ok` / `error` /
 * `rate_limited` / `fallback_error` / `auto_fixed`); this collapses a terminal
 * attempt status onto the request outcome while preserving in-flight work.
 */
const normalizeAttemptStatusSql = (expr: string): string =>
  `CASE WHEN ${expr} IN ('pending', 'cancelled') THEN ${expr} WHEN ${expr} IN ('ok', 'success') THEN 'success' ELSE 'failed' END`;

/**
 * Historical decisions written before this migration have no JSON `status`.
 * With no retry evidence those rows are necessarily no-patch or resolving, but
 * the two cannot be distinguished retrospectively; use the terminal no_patch
 * value rather than inventing an in-progress state for old traffic.
 */
const autofixStatusFromAttempt = (alias: string): string => `CASE
  WHEN ${alias}.autofix_role = 'retry' THEN
    CASE WHEN ${alias}.status IN ('ok', 'success') THEN 'retry_succeeded' ELSE 'retry_failed' END
  WHEN COALESCE(${alias}.autofix_applied, false)
    AND ${alias}.autofix_phoenix->>'healAttemptId' IS NOT NULL THEN 'retry_failed'
  WHEN ${alias}.autofix_phoenix->>'status' = 'resolving' THEN 'resolving'
  WHEN ${alias}.autofix_phoenix->>'status' = 'no_patch' THEN 'no_patch'
  WHEN ${alias}.autofix_phoenix IS NOT NULL THEN 'no_patch'
  WHEN COALESCE(${alias}.autofix_applied, false) THEN 'service_error'
  ELSE NULL
END`;

const autofixStatusFromAttempts = (alias: string): string => `CASE
  WHEN BOOL_OR(${alias}.autofix_role = 'retry' AND ${alias}.status IN ('ok', 'success'))
    THEN 'retry_succeeded'
  WHEN BOOL_OR(${alias}.autofix_role = 'retry')
    OR BOOL_OR(COALESCE(${alias}.autofix_applied, false)
      AND ${alias}.autofix_phoenix->>'healAttemptId' IS NOT NULL)
    THEN 'retry_failed'
  WHEN BOOL_OR(${alias}.autofix_phoenix->>'status' = 'resolving') THEN 'resolving'
  WHEN BOOL_OR(${alias}.autofix_phoenix->>'status' = 'no_patch') THEN 'no_patch'
  WHEN BOOL_OR(${alias}.autofix_phoenix IS NOT NULL) THEN 'no_patch'
  WHEN BOOL_OR(COALESCE(${alias}.autofix_applied, false)) THEN 'service_error'
  ELSE NULL
END`;

/**
 * The legacy recorder encoded fallback chains with exact 100 ms timestamp
 * offsets but did not stamp a shared id. Recover only chains whose primary,
 * terminal attempt, fallback indexes, and request metadata match that encoding.
 * If one attempt can belong to more than one candidate chain, leave the whole
 * chain to the generic one-attempt fallback rather than merging unrelated calls.
 */
export const CREATE_LEGACY_FALLBACK_STAGING_SQL = `
  CREATE TEMP TABLE "request_backfill_fallback_indexes" (
    fallback_index integer PRIMARY KEY
  ) ON COMMIT PRESERVE ROWS;
  CREATE TEMP TABLE "request_backfill_fallback_pairs" (
    pair_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id varchar NOT NULL,
    primary_id varchar NOT NULL,
    terminal_id varchar NOT NULL,
    primary_model varchar NOT NULL,
    primary_timestamp timestamp NOT NULL,
    terminal_index integer NOT NULL,
    outcome varchar NOT NULL,
    UNIQUE (outcome, primary_id, terminal_id)
  ) ON COMMIT PRESERVE ROWS;
  CREATE TEMP TABLE "request_backfill_fallback_members" (
    request_id varchar NOT NULL,
    attempt_id varchar NOT NULL,
    primary_id varchar NOT NULL,
    terminal_id varchar NOT NULL,
    PRIMARY KEY (request_id, attempt_id)
  ) ON COMMIT PRESERVE ROWS
`;

export const INSERT_LEGACY_FALLBACK_INDEXES_SQL = `
  INSERT INTO "request_backfill_fallback_indexes" (fallback_index)
  SELECT DISTINCT fallback_index
  FROM "agent_messages"
  WHERE "request_id" IS NULL
    AND fallback_from_model IS NOT NULL
    AND fallback_index IS NOT NULL
    AND fallback_index >= 0
    AND timestamp < $1
`;

export const INSERT_LEGACY_FALLBACK_PAIRS_SQL = `
  INSERT INTO "request_backfill_fallback_pairs" (
    request_id, primary_id, terminal_id, primary_model, primary_timestamp,
    terminal_index, outcome
  )
  WITH recovered_pairs AS (
    SELECT
      'legacy-fallback-' || md5(p.id) AS request_id,
      p.id AS primary_id,
      t.id AS terminal_id,
      p.model AS primary_model,
      p.timestamp AS primary_timestamp,
      t.fallback_index AS terminal_index,
      'recovered'::varchar AS outcome
    FROM "agent_messages" p
    JOIN "request_backfill_fallback_indexes" fi ON true
    JOIN "agent_messages" t
      ON t."request_id" IS NULL
     AND t.status IN ('ok', 'success')
     AND t.fallback_from_model = p.model
     AND t.fallback_index = fi.fallback_index
     AND t.timestamp = p.timestamp + (fi.fallback_index + 1) * INTERVAL '100 milliseconds'
     AND t.tenant_id IS NOT DISTINCT FROM p.tenant_id
     AND t.agent_id IS NOT DISTINCT FROM p.agent_id
     AND t.trace_id IS NOT DISTINCT FROM p.trace_id
     AND t.session_key IS NOT DISTINCT FROM p.session_key
     AND t.session_id IS NOT DISTINCT FROM p.session_id
     AND t.caller_attribution IS NOT DISTINCT FROM p.caller_attribution
     AND t.request_headers IS NOT DISTINCT FROM p.request_headers
     AND t.request_params IS NOT DISTINCT FROM p.request_params
     AND t.timestamp < $3
    WHERE p."request_id" IS NULL
      AND p.id > $1 AND p.id <= $2
      AND p.timestamp < $3
      AND p.status = 'fallback_error'
      AND COALESCE(p.superseded, false)
      AND p.fallback_from_model IS NULL
      AND p.model IS NOT NULL
  ), exhausted_pairs AS (
    SELECT
      'legacy-fallback-' || md5(p.id) AS request_id,
      p.id AS primary_id,
      t.id AS terminal_id,
      p.model AS primary_model,
      p.timestamp AS primary_timestamp,
      t.fallback_index AS terminal_index,
      'exhausted'::varchar AS outcome
    FROM "agent_messages" p
    JOIN "request_backfill_fallback_indexes" fi ON true
    JOIN "agent_messages" t
      ON t."request_id" IS NULL
     AND t.status NOT IN ('ok', 'fallback_error', 'auto_fixed')
     AND NOT COALESCE(t.superseded, false)
     AND t.fallback_from_model = p.model
     AND t.fallback_index = fi.fallback_index
     AND t.timestamp = p.timestamp - (fi.fallback_index + 1) * INTERVAL '100 milliseconds'
     AND t.tenant_id IS NOT DISTINCT FROM p.tenant_id
     AND t.agent_id IS NOT DISTINCT FROM p.agent_id
     AND t.trace_id IS NOT DISTINCT FROM p.trace_id
     AND t.session_key IS NOT DISTINCT FROM p.session_key
     AND t.session_id IS NOT DISTINCT FROM p.session_id
     AND t.caller_attribution IS NOT DISTINCT FROM p.caller_attribution
     AND t.request_headers IS NOT DISTINCT FROM p.request_headers
     AND t.request_params IS NOT DISTINCT FROM p.request_params
     AND t.timestamp < $3
    WHERE p."request_id" IS NULL
      AND p.id > $1 AND p.id <= $2
      AND p.timestamp < $3
      AND p.status = 'fallback_error'
      AND COALESCE(p.superseded, false)
      AND p.fallback_from_model IS NULL
      AND p.model IS NOT NULL
  )
  SELECT request_id, primary_id, terminal_id, primary_model, primary_timestamp,
         terminal_index, outcome
  FROM recovered_pairs
  UNION ALL
  SELECT request_id, primary_id, terminal_id, primary_model, primary_timestamp,
         terminal_index, outcome
  FROM exhausted_pairs
  ON CONFLICT DO NOTHING
`;

export const INDEX_LEGACY_FALLBACK_PAIRS_SQL = `
  CREATE INDEX ON "request_backfill_fallback_pairs" (request_id);
  CREATE INDEX ON "request_backfill_fallback_pairs" (terminal_id)
`;

export const INSERT_LEGACY_FALLBACK_DIRECT_MEMBERS_SQL = `
  WITH groups AS (
    SELECT *
    FROM "request_backfill_fallback_pairs"
    WHERE pair_seq > $1 AND pair_seq <= $2
  )
  INSERT INTO "request_backfill_fallback_members" (
    request_id, attempt_id, primary_id, terminal_id
  )
  SELECT g.request_id, g.primary_id, g.primary_id, g.terminal_id
  FROM groups g
  UNION ALL
  SELECT g.request_id, g.terminal_id, g.primary_id, g.terminal_id
  FROM groups g
  ON CONFLICT DO NOTHING
`;

export const INSERT_LEGACY_FALLBACK_MEMBERS_SQL = `
  WITH groups AS (
    SELECT *
    FROM "request_backfill_fallback_pairs"
    WHERE pair_seq > $1 AND pair_seq <= $2
  ), member_candidates AS (
    SELECT g.request_id, pa.id AS attempt_id, g.primary_id, g.terminal_id
    FROM groups g
    JOIN "agent_messages" primary_attempt ON primary_attempt.id = g.primary_id
    JOIN "request_backfill_fallback_indexes" fi
      ON fi.fallback_index >= 0 AND fi.fallback_index < g.terminal_index
    JOIN "agent_messages" pa
      ON pa."request_id" IS NULL
     AND g.outcome = 'recovered'
     AND pa.status = 'fallback_error'
     AND COALESCE(pa.superseded, false)
     AND pa.fallback_from_model = g.primary_model
     AND pa.fallback_index = fi.fallback_index
     AND pa.tenant_id IS NOT DISTINCT FROM primary_attempt.tenant_id
     AND pa.agent_id IS NOT DISTINCT FROM primary_attempt.agent_id
     AND pa.trace_id IS NOT DISTINCT FROM primary_attempt.trace_id
     AND pa.session_key IS NOT DISTINCT FROM primary_attempt.session_key
     AND pa.session_id IS NOT DISTINCT FROM primary_attempt.session_id
     AND pa.caller_attribution IS NOT DISTINCT FROM primary_attempt.caller_attribution
     AND pa.request_headers IS NOT DISTINCT FROM primary_attempt.request_headers
     AND pa.request_params IS NOT DISTINCT FROM primary_attempt.request_params
     AND pa.timestamp = g.primary_timestamp
       + (g.terminal_index - fi.fallback_index) * INTERVAL '100 milliseconds'
    UNION ALL
    SELECT g.request_id, pa.id, g.primary_id, g.terminal_id
    FROM groups g
    JOIN "agent_messages" primary_attempt ON primary_attempt.id = g.primary_id
    JOIN "request_backfill_fallback_indexes" fi
      ON fi.fallback_index >= 0 AND fi.fallback_index < g.terminal_index
    JOIN "agent_messages" pa
      ON pa."request_id" IS NULL
     AND g.outcome = 'exhausted'
     AND pa.status = 'fallback_error'
     AND COALESCE(pa.superseded, false)
     AND pa.fallback_from_model = g.primary_model
     AND pa.fallback_index = fi.fallback_index
     AND pa.tenant_id IS NOT DISTINCT FROM primary_attempt.tenant_id
     AND pa.agent_id IS NOT DISTINCT FROM primary_attempt.agent_id
     AND pa.trace_id IS NOT DISTINCT FROM primary_attempt.trace_id
     AND pa.session_key IS NOT DISTINCT FROM primary_attempt.session_key
     AND pa.session_id IS NOT DISTINCT FROM primary_attempt.session_id
     AND pa.caller_attribution IS NOT DISTINCT FROM primary_attempt.caller_attribution
     AND pa.request_headers IS NOT DISTINCT FROM primary_attempt.request_headers
     AND pa.request_params IS NOT DISTINCT FROM primary_attempt.request_params
     AND pa.timestamp = g.primary_timestamp
       - (fi.fallback_index + 1) * INTERVAL '100 milliseconds'
  )
  INSERT INTO "request_backfill_fallback_members" (
    request_id, attempt_id, primary_id, terminal_id
  )
  SELECT request_id, attempt_id, primary_id, terminal_id
  FROM member_candidates
  ON CONFLICT DO NOTHING
`;

export const INDEX_LEGACY_FALLBACK_MEMBERS_SQL = `
  CREATE INDEX ON "request_backfill_fallback_members" (attempt_id)
`;

export const CREATE_LEGACY_FALLBACK_GROUPS_SQL = `
  CREATE TEMP TABLE "request_backfill_fallback_groups" ON COMMIT DROP AS
  WITH groups AS (
    SELECT p.*
    FROM "request_backfill_fallback_pairs" p
    WHERE p.pair_seq > $1 AND p.pair_seq <= $2
      AND NOT EXISTS (
        SELECT 1
        FROM "request_backfill_fallback_pairs" other
        WHERE other.request_id = p.request_id AND other.pair_seq <> p.pair_seq
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "request_backfill_fallback_pairs" other
        WHERE other.terminal_id = p.terminal_id AND other.request_id <> p.request_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "request_backfill_fallback_members" member
        JOIN "request_backfill_fallback_members" other
          ON other.attempt_id = member.attempt_id
         AND other.request_id <> member.request_id
        WHERE member.request_id = p.request_id
      )
  )
  SELECT m.request_id, m.attempt_id, m.primary_id, m.terminal_id
  FROM "request_backfill_fallback_members" m
  JOIN groups g ON g.request_id = m.request_id
`;

/*
 * Pair and member candidates are staged across bounded reads before any row is
 * linked. That is what keeps ambiguity detection global even though no query
 * scans and joins the whole hot table in one transaction.
 */
export const LEGACY_FALLBACK_STAGING_INDEX_SQL = `
  ANALYZE "request_backfill_fallback_pairs";
  ANALYZE "request_backfill_fallback_members"
`;

export const INSERT_LEGACY_FALLBACK_REQUESTS_SQL = `
  WITH groups AS (
    SELECT DISTINCT request_id, primary_id, terminal_id
    FROM "request_backfill_fallback_groups"
  ), totals AS (
    SELECT g.request_id,
           min(pa.timestamp) AS started_at,
           sum(pa.duration_ms)::int AS duration_ms,
           ${autofixStatusFromAttempts('pa')} AS autofix_status
    FROM groups g
    JOIN "request_backfill_fallback_groups" member ON member.request_id = g.request_id
    JOIN "agent_messages" pa ON pa.id = member.attempt_id
    GROUP BY g.request_id
  ), ins AS (
    INSERT INTO "requests" (
      id, tenant_id, agent_id, user_id, agent_name, trace_id, session_key, session_id,
      timestamp, duration_ms, status, error_message, error_http_status, error_code,
      autofix_status, error_origin, error_class, requested_model, caller_attribution, request_headers,
      request_params, feedback_rating, feedback_tags, feedback_details
    )
    SELECT
      g.request_id, terminal.tenant_id, terminal.agent_id, terminal.user_id,
      terminal.agent_name, terminal.trace_id, terminal.session_key, terminal.session_id,
      totals.started_at, totals.duration_ms, ${normalizeAttemptStatusSql('terminal.status')}, terminal.error_message,
      terminal.error_http_status, terminal.error_code, totals.autofix_status, terminal.error_origin,
      terminal.error_class, primary_attempt.model, terminal.caller_attribution,
      terminal.request_headers, terminal.request_params, terminal.feedback_rating,
      terminal.feedback_tags, terminal.feedback_details
    FROM groups g
    JOIN totals ON totals.request_id = g.request_id
    JOIN "agent_messages" primary_attempt ON primary_attempt.id = g.primary_id
    JOIN "agent_messages" terminal ON terminal.id = g.terminal_id
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM ins
`;

export const LINK_LEGACY_FALLBACK_ATTEMPTS_SQL = `
  WITH updated AS (
    UPDATE "agent_messages" pa
    SET "request_id" = grouped.request_id,
        "attempt_number" = CASE
          WHEN pa.id = grouped.primary_id THEN 1
          WHEN pa.fallback_index IS NOT NULL THEN pa.fallback_index + 2
          ELSE NULL
        END
    FROM "request_backfill_fallback_groups" grouped
    WHERE pa.id = grouped.attempt_id AND pa."request_id" IS NULL
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM updated
`;

// These rows predate the explicit request table but never represented a
// provider call. Copy them to requests while the legacy dashboard still reads
// agent_messages; #2485 can remove the preserved row after switching readers.
export const INSERT_REJECTIONS_SQL = `
  WITH batch AS (
    SELECT * FROM "agent_messages"
    WHERE "request_id" IS NULL AND id > $1 AND id <= $2
      AND timestamp < $3
      AND status NOT IN ('ok', 'success')
      AND error_origin IN (${REQUEST_LEVEL_ORIGINS})
  ), ins AS (
    INSERT INTO "requests" (
      id, tenant_id, agent_id, user_id, agent_name, trace_id, session_key, session_id,
      timestamp, duration_ms, status, error_message, error_http_status, error_code,
      autofix_status, error_origin, error_class, requested_model, caller_attribution, request_headers,
      request_params, feedback_rating, feedback_tags, feedback_details
    )
    SELECT
      id, tenant_id, agent_id, user_id, agent_name, trace_id, session_key, session_id,
      timestamp, duration_ms, ${normalizeAttemptStatusSql('status')}, error_message, error_http_status, error_code,
      ${autofixStatusFromAttempt('batch')}, error_origin, error_class, model, caller_attribution, request_headers,
      request_params, feedback_rating, feedback_tags, feedback_details
    FROM batch
    ON CONFLICT (id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM ins
`;

// Mark the preserved legacy row as staged so subsequent tail sweeps skip it.
// attempt_number remains NULL because no provider call occurred.
export const MARK_REJECTIONS_SQL = `
  WITH marked AS (
    UPDATE "agent_messages"
    SET "request_id" = id
    WHERE "request_id" IS NULL AND id > $1 AND id <= $2
      AND timestamp < $3
      AND status NOT IN ('ok', 'success')
      AND error_origin IN (${REQUEST_LEVEL_ORIGINS})
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM marked
`;

const LEGACY_REQUEST_ID = `CASE
  WHEN autofix_group_id IS NOT NULL THEN
    'legacy-autofix-' || md5(COALESCE(tenant_id, '') || ':' || COALESCE(agent_id, '') || ':' || autofix_group_id)
  WHEN trace_id IS NOT NULL THEN
    'legacy-trace-' || md5(COALESCE(tenant_id, '') || ':' || COALESCE(agent_id, '') || ':' || trace_id)
  ELSE id
END`;

const OUTCOME_RANK = `CASE
  WHEN status IN ('ok', 'success') THEN 3
  WHEN NOT COALESCE(superseded, false)
    AND status NOT IN ('fallback_error', 'auto_fixed') THEN 2
  ELSE 1
END`;

export const INSERT_ATTEMPT_REQUESTS_SQL = `
  WITH batch AS (
    SELECT *, ${LEGACY_REQUEST_ID} AS legacy_request_id, ${OUTCOME_RANK} AS outcome_rank
    FROM "agent_messages"
    WHERE "request_id" IS NULL AND id > $1 AND id <= $2
      AND timestamp < $3
  ), terminal AS (
    SELECT DISTINCT ON (legacy_request_id) *
    FROM batch
    ORDER BY legacy_request_id, outcome_rank DESC, timestamp DESC, id DESC
  ), ins AS (
    INSERT INTO "requests" (
      id, tenant_id, agent_id, user_id, agent_name, trace_id, session_key, session_id,
      timestamp, duration_ms, status, error_message, error_http_status, error_code,
      autofix_status, error_origin, error_class, requested_model, caller_attribution, request_headers,
      request_params, feedback_rating, feedback_tags, feedback_details
    )
    SELECT
      legacy_request_id, tenant_id, agent_id, user_id, agent_name, trace_id,
      session_key, session_id, timestamp, duration_ms,
      CASE WHEN outcome_rank = 1 THEN 'pending' ELSE ${normalizeAttemptStatusSql('status')} END,
      CASE WHEN outcome_rank = 1 THEN NULL ELSE error_message END,
      CASE WHEN outcome_rank = 1 THEN NULL ELSE error_http_status END,
      CASE WHEN outcome_rank = 1 THEN NULL ELSE error_code END,
      ${autofixStatusFromAttempt('terminal')},
      CASE WHEN outcome_rank = 1 THEN NULL ELSE error_origin END,
      CASE WHEN outcome_rank = 1 THEN NULL ELSE error_class END,
      COALESCE(fallback_from_model, model), caller_attribution, request_headers,
      request_params, feedback_rating, feedback_tags, feedback_details
    FROM terminal
    ON CONFLICT (id) DO UPDATE SET
      timestamp = LEAST(requests.timestamp, EXCLUDED.timestamp),
      status = CASE
        WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status IN ('ok', 'success')
          THEN 'success'
        WHEN EXCLUDED.status = 'pending' THEN requests.status
        ELSE EXCLUDED.status
      END,
      autofix_status = COALESCE(EXCLUDED.autofix_status, requests.autofix_status),
      error_message = CASE WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status = 'pending'
        THEN requests.error_message ELSE EXCLUDED.error_message END,
      error_http_status = CASE WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status = 'pending'
        THEN requests.error_http_status ELSE EXCLUDED.error_http_status END,
      error_code = CASE WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status = 'pending'
        THEN requests.error_code ELSE EXCLUDED.error_code END,
      error_origin = CASE WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status = 'pending'
        THEN requests.error_origin ELSE EXCLUDED.error_origin END,
      error_class = CASE WHEN requests.status IN ('ok', 'success') OR EXCLUDED.status = 'pending'
        THEN requests.error_class ELSE EXCLUDED.error_class END
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted)::int AS n FROM ins
`;

export const LINK_ATTEMPTS_SQL = `
  WITH target_autofix_groups AS MATERIALIZED (
    SELECT DISTINCT
      COALESCE(tenant_id, '') AS tenant_key,
      COALESCE(agent_id, '') AS agent_key,
      autofix_group_id AS group_id
    FROM "agent_messages"
    WHERE "request_id" IS NULL AND id > $1 AND id <= $2
      AND timestamp < $3
      AND autofix_group_id IS NOT NULL
      AND autofix_role IS NULL
  ), autofix_group_stats AS MATERIALIZED (
    SELECT target.tenant_key,
           target.agent_key,
           target.group_id,
           count(*)::int AS attempt_count,
           count(*) FILTER (
             WHERE other.status = 'auto_fixed' AND COALESCE(other.superseded, false)
           )::int AS original_count
    FROM target_autofix_groups target
    JOIN "agent_messages" other
      ON COALESCE(other.tenant_id, '') = target.tenant_key
     AND COALESCE(other.agent_id, '') = target.agent_key
     AND other.autofix_group_id = target.group_id
    GROUP BY target.tenant_key, target.agent_key, target.group_id
  ), batch AS (
    SELECT pa.id,
           ${LEGACY_REQUEST_ID} AS legacy_request_id,
           CASE
             WHEN pa.autofix_group_id IS NOT NULL THEN CASE
               WHEN pa.autofix_role = 'original' THEN 1
               WHEN pa.autofix_role = 'retry' THEN 2
               WHEN stats.attempt_count = 2 AND stats.original_count = 1 THEN CASE
                 WHEN pa.status = 'auto_fixed' AND COALESCE(pa.superseded, false) THEN 1
                 ELSE 2
               END
               ELSE NULL
             END
             WHEN pa.trace_id IS NULL THEN 1
             ELSE NULL
           END AS attempt_number
    FROM "agent_messages" pa
    LEFT JOIN autofix_group_stats stats
      ON stats.tenant_key = COALESCE(pa.tenant_id, '')
     AND stats.agent_key = COALESCE(pa.agent_id, '')
     AND stats.group_id = pa.autofix_group_id
    WHERE pa."request_id" IS NULL AND pa.id > $1 AND pa.id <= $2
      AND pa.timestamp < $3
  ), updated AS (
    UPDATE "agent_messages" pa
    SET "request_id" = batch.legacy_request_id,
        "attempt_number" = batch.attempt_number
    FROM batch
    WHERE pa.id = batch.id AND pa."request_id" IS NULL
    RETURNING pa."request_id"::text AS request_id
  )
  SELECT count(*)::int AS n,
         COALESCE(array_agg(DISTINCT request_id), ARRAY[]::text[]) AS request_ids
  FROM updated
`;

// A legacy request can span UUID-ordered windows. Recompute each affected
// parent from every attempt linked so far, so the final outcome never depends
// on which window happened to contain the success or terminal failure.
export const REFRESH_ATTEMPT_REQUESTS_SQL = `
  WITH affected AS MATERIALIZED (
    SELECT unnest($1::text[]) AS request_id
  ), totals AS (
    SELECT pa.request_id,
           min(pa.timestamp) AS started_at,
           sum(pa.duration_ms)::int AS duration_ms
    FROM "agent_messages" pa
    JOIN affected a ON a.request_id = pa.request_id
    GROUP BY pa.request_id
  ), terminal AS (
    SELECT DISTINCT ON (pa.request_id) pa.*
    FROM "agent_messages" pa
    JOIN affected a ON a.request_id = pa.request_id
    ORDER BY pa.request_id,
      pa.attempt_number DESC NULLS LAST,
      CASE
        WHEN pa.status IN ('ok', 'success') THEN 3
        WHEN NOT COALESCE(pa.superseded, false)
          AND pa.status NOT IN ('fallback_error', 'auto_fixed') THEN 2
        ELSE 1
      END DESC,
      pa.timestamp DESC,
      pa.id DESC
  ), autofix AS (
    SELECT pa.request_id, ${autofixStatusFromAttempts('pa')} AS autofix_status
    FROM "agent_messages" pa
    JOIN affected a ON a.request_id = pa.request_id
    GROUP BY pa.request_id
  )
  UPDATE "requests" r
  SET timestamp = totals.started_at,
      duration_ms = totals.duration_ms,
      status = ${normalizeAttemptStatusSql('terminal.status')},
      autofix_status = autofix.autofix_status,
      error_message = terminal.error_message,
      error_http_status = terminal.error_http_status,
      error_code = terminal.error_code,
      error_origin = terminal.error_origin,
      error_class = terminal.error_class
  FROM totals
  JOIN terminal ON terminal.request_id = totals.request_id
  JOIN autofix ON autofix.request_id = totals.request_id
  WHERE r.id = totals.request_id
`;

export const FINALIZE_PENDING_REQUESTS_SQL = `
  WITH pending AS (
    SELECT r.id
    FROM "requests" r
    WHERE r.status = 'pending'
      AND (
        r.id LIKE 'legacy-autofix-%'
        OR r.id LIKE 'legacy-trace-%'
        OR EXISTS (
          SELECT 1 FROM "agent_messages" pa
          WHERE pa.request_id = r.id AND pa.id = r.id
        )
      )
  ), last_attempt AS (
    SELECT DISTINCT ON (pa.request_id) pa.*
    FROM "agent_messages" pa
    JOIN pending p ON p.id = pa.request_id
    ORDER BY pa.request_id, pa.attempt_number DESC NULLS LAST, pa.timestamp DESC, pa.id DESC
  )
  UPDATE "requests" r
  SET status = COALESCE(${normalizeAttemptStatusSql('last_attempt.status')}, 'failed'),
      error_message = last_attempt.error_message,
      error_http_status = last_attempt.error_http_status,
      error_code = last_attempt.error_code,
      error_origin = last_attempt.error_origin,
      error_class = last_attempt.error_class
  FROM last_attempt
  WHERE r.id = last_attempt.request_id
`;

export const DELETE_STAGED_REJECTIONS_SQL = `
  WITH batch AS (
    SELECT pa.id
    FROM "agent_messages" pa
    JOIN "requests" r ON r.id = pa.request_id
    WHERE pa.request_id = pa.id
      AND pa.attempt_number IS NULL
      AND pa.status NOT IN ('ok', 'success')
      AND pa.error_origin IN (${REQUEST_LEVEL_ORIGINS})
    ORDER BY pa.id
    LIMIT $1
    FOR UPDATE OF pa SKIP LOCKED
  ), deleted AS (
    DELETE FROM "agent_messages" pa
    USING batch
    WHERE pa.id = batch.id
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM deleted
`;

export class TypeOrmRequestBackfillGateway implements RequestBackfillGateway {
  constructor(private readonly dataSource: DataSource) {}

  async analyze(): Promise<void> {
    await this.dataSource.query('ANALYZE "agent_messages"');
  }

  async nextWindowEnd(afterId: string, batchSize: number, before: string): Promise<string | null> {
    const rows = (await this.dataSource.query(REQUEST_BACKFILL_WINDOW_END_SQL, [
      afterId,
      batchSize,
      before,
    ])) as { end_id: string | null }[];
    return rows[0]?.end_id ?? null;
  }

  async backfillFallbackGroups(
    batchSize: number,
    before: string,
    timeouts: RequestBackfillTimeouts,
    pause: () => Promise<void>,
    reportProgress?: (message: string) => void,
  ): Promise<{ requests: number; attempts: number }> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let requests = 0;
    let attempts = 0;
    try {
      await runner.query(`SET lock_timeout = '${timeouts.lockTimeoutMs}ms'`);
      await runner.query(`SET statement_timeout = '${timeouts.statementTimeoutMs}ms'`);
      // Parallel hashes were the source of the production /dev/shm failure.
      // The staged tables trade a little elapsed time for bounded memory.
      await runner.query(`SET max_parallel_workers_per_gather = 0`);
      await runner.query(`SET max_parallel_maintenance_workers = 0`);
      await runner.query(CREATE_LEGACY_FALLBACK_STAGING_SQL);
      await runner.query(INSERT_LEGACY_FALLBACK_INDEXES_SQL, [before]);
      await runner.query('ANALYZE "request_backfill_fallback_indexes"');

      let afterId = '';
      let primaryWindows = 0;
      for (;;) {
        const [{ end_id: endId = null } = { end_id: null }] = (await runner.query(
          FALLBACK_PRIMARY_WINDOW_END_SQL,
          [afterId, batchSize, before],
        )) as { end_id: string | null }[];
        if (endId === null) break;
        await runner.query(INSERT_LEGACY_FALLBACK_PAIRS_SQL, [afterId, endId, before]);
        afterId = endId;
        primaryWindows += 1;
        if (primaryWindows % 25 === 0) {
          reportProgress?.(`scanned ${primaryWindows} fallback-primary window(s)`);
        }
        await pause();
      }

      const [{ max_seq: maxPairSeq = 0 } = { max_seq: 0 }] = (await runner.query(
        `SELECT COALESCE(max(pair_seq), 0)::int AS max_seq
         FROM "request_backfill_fallback_pairs"`,
      )) as { max_seq: number }[];

      reportProgress?.(`staged ${maxPairSeq} fallback candidate chain(s)`);

      let memberWindows = 0;
      for (let afterSeq = 0; afterSeq < maxPairSeq; afterSeq += batchSize) {
        const params = [afterSeq, Math.min(afterSeq + batchSize, maxPairSeq)];
        await runner.query(INSERT_LEGACY_FALLBACK_DIRECT_MEMBERS_SQL, params);
        await runner.query(INSERT_LEGACY_FALLBACK_MEMBERS_SQL, params);
        memberWindows += 1;
        if (memberWindows % 25 === 0 || params[1] === maxPairSeq) {
          reportProgress?.(
            `staged members for ${params[1]}/${maxPairSeq} fallback candidate chain(s)`,
          );
        }
        await pause();
      }

      // These operations touch session-local data only. Let them finish rather
      // than restarting a large local index build because of the hot-table
      // statement timeout used for every bounded source read.
      await runner.query(`SET statement_timeout = '0'`);
      await runner.query(INDEX_LEGACY_FALLBACK_PAIRS_SQL);
      await runner.query(INDEX_LEGACY_FALLBACK_MEMBERS_SQL);
      await runner.query(LEGACY_FALLBACK_STAGING_INDEX_SQL);
      await runner.query(`SET statement_timeout = '${timeouts.statementTimeoutMs}ms'`);

      let afterSeq = 0;
      let linkBatchSize = batchSize;
      let linkWindows = 0;
      while (afterSeq < maxPairSeq) {
        const endSeq = Math.min(afterSeq + linkBatchSize, maxPairSeq);
        try {
          const grouped = await this.inRunnerTransaction(runner, timeouts, async () => {
            await runner.query(CREATE_LEGACY_FALLBACK_GROUPS_SQL, [afterSeq, endSeq]);
            const [{ n: requestCount }] = (await runner.query(
              INSERT_LEGACY_FALLBACK_REQUESTS_SQL,
            )) as { n: number }[];
            const [{ n: attemptCount }] = (await runner.query(
              LINK_LEGACY_FALLBACK_ATTEMPTS_SQL,
            )) as { n: number }[];
            return { requests: requestCount, attempts: attemptCount };
          });
          requests += grouped.requests;
          attempts += grouped.attempts;
          afterSeq = endSeq;
          linkWindows += 1;
          if (linkWindows % 25 === 0 || afterSeq === maxPairSeq) {
            reportProgress?.(
              `linked ${afterSeq}/${maxPairSeq} fallback candidate chain(s) ` +
                `into ${requests} request(s) and ${attempts} attempt(s)`,
            );
          }
          await pause();
        } catch (error) {
          if (!canResizeStagedBatch(error) || linkBatchSize === 1) throw error;
          const smallerBatchSize = Math.max(1, Math.floor(linkBatchSize / 2));
          const reason = error instanceof Error ? error.message : String(error);
          reportProgress?.(
            `fallback batch after ${afterSeq} failed (${reason}); ` +
              `reducing batch size from ${linkBatchSize} to ${smallerBatchSize}`,
          );
          linkBatchSize = smallerBatchSize;
          await pause();
        }
      }
      return { requests, attempts };
    } finally {
      await runner
        .query(
          `DROP TABLE IF EXISTS "request_backfill_fallback_groups",
            "request_backfill_fallback_members", "request_backfill_fallback_pairs",
            "request_backfill_fallback_indexes"`,
        )
        .catch(() => undefined);
      await runner.query('RESET ALL').catch(() => undefined);
      await runner.release();
    }
  }

  async backfillWindow(
    afterId: string,
    endId: string,
    before: string,
    timeouts: RequestBackfillTimeouts,
  ): Promise<{ requests: number; attempts: number; rejections: number }> {
    return this.inTransaction(timeouts, async (runner) => {
      const params = [afterId, endId, before];
      const [{ n: requests }] = (await runner.query(INSERT_REJECTIONS_SQL, params)) as {
        n: number;
      }[];
      const [{ n: rejections }] = (await runner.query(MARK_REJECTIONS_SQL, params)) as {
        n: number;
      }[];
      const [{ n: attemptRequests }] = (await runner.query(
        INSERT_ATTEMPT_REQUESTS_SQL,
        params,
      )) as { n: number }[];
      const [{ n: attempts, request_ids: requestIds }] = (await runner.query(
        LINK_ATTEMPTS_SQL,
        params,
      )) as { n: number; request_ids: string[] }[];
      await runner.query(REFRESH_ATTEMPT_REQUESTS_SQL, [requestIds]);
      return { requests: requests + attemptRequests, attempts, rejections };
    });
  }

  async finalize(timeouts: RequestBackfillTimeouts): Promise<void> {
    await this.inTransaction(timeouts, async (runner) => {
      await runner.query(FINALIZE_PENDING_REQUESTS_SQL);
    });
  }

  async finalizeTransition(
    batchSize: number,
    timeouts: RequestBackfillTimeouts,
    reportProgress?: (deleted: number) => void,
  ): Promise<number> {
    let deleted = 0;
    for (;;) {
      const batch = await this.inTransaction(timeouts, async (runner) => {
        const [{ n = 0 } = { n: 0 }] = (await runner.query(DELETE_STAGED_REJECTIONS_SQL, [
          batchSize,
        ])) as { n: number }[];
        return n;
      });
      if (batch === 0) break;
      deleted += batch;
      reportProgress?.(deleted);
    }

    await this.inTransaction(timeouts, async (runner) => {
      await runner.query(`SET LOCAL statement_timeout = '0'`);
      await runner.query(
        'ALTER TABLE "agent_messages" VALIDATE CONSTRAINT "FK_agent_messages_request"',
      );
      await runner.query(
        'ALTER TABLE "agent_messages" VALIDATE CONSTRAINT "CHK_agent_messages_attempt_number_positive"',
      );
    });
    return deleted;
  }

  private async inTransaction<T>(
    timeouts: RequestBackfillTimeouts,
    fn: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SET LOCAL lock_timeout = '${timeouts.lockTimeoutMs}ms'`);
      await runner.query(`SET LOCAL statement_timeout = '${timeouts.statementTimeoutMs}ms'`);
      const result = await fn(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async inRunnerTransaction<T>(
    runner: QueryRunner,
    timeouts: RequestBackfillTimeouts,
    fn: () => Promise<T>,
  ): Promise<T> {
    await runner.startTransaction();
    try {
      await runner.query(`SET LOCAL lock_timeout = '${timeouts.lockTimeoutMs}ms'`);
      await runner.query(`SET LOCAL statement_timeout = '${timeouts.statementTimeoutMs}ms'`);
      const result = await fn();
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  }
}
