#!/usr/bin/env bash
# Rebuild the bloated agent_messages / requests indexes, one at a time.
#
# Ops runbook, not a migration: self-hosted installs don't need it. Uses
# REINDEX INDEX CONCURRENTLY (SHARE UPDATE EXCLUSIVE), so inserts and updates
# keep flowing; only DDL and VACUUM on the same table wait. Peak extra disk is
# the size of the index being rebuilt.
#
# Not lock-free in practice for latency: each build reads the whole table, and
# on the 8 GB Railway prod instance that I/O alone pushed the proxy's request
# INSERT from ~1 ms to 150-400 ms, even with no parallel workers (2026-10-09).
# The guard below cancels the build when that happens.
#
# Usage:
#   DATABASE_URL=postgresql://...direct, not PgBouncer... scripts/db-reindex-bloated.sh [index ...]
#   PSQL="docker run --rm -i --network host postgres:17 psql" DATABASE_URL=... scripts/db-reindex-bloated.sh
#
# With no arguments it rebuilds the default list below, smallest first. It
# stops at the first failure after dropping the "<name>_ccnew" leftover, and
# refuses to start while a transaction older than MAX_XACT_AGE is open,
# because REINDEX CONCURRENTLY would wait for it.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a direct (non-PgBouncer) connection}"
PSQL=${PSQL:-psql}
MAX_XACT_AGE=${MAX_XACT_AGE:-5 minutes}
MAINTENANCE_WORK_MEM=${MAINTENANCE_WORK_MEM:-256MB}
# Parallel build workers saturate disk I/O: on prod (2026-10-09) three workers
# pushed the proxy's awaited request INSERT from ~5 ms to 140-420 ms. Build
# with the leader only.
PARALLEL_WORKERS=${PARALLEL_WORKERS:-0}
# Latency guard: cancel the running build when the mean of the request INSERT
# (on the proxy path) over the last GUARD_INTERVAL seconds exceeds this.
# Windows with fewer than GUARD_MIN_CALLS inserts are too small to judge and
# are skipped, so on near-idle traffic only MAX_BUILD_SECONDS protects you.
# The guard fails closed: if it cannot read pg_stat_statements it cancels.
MAX_INSERT_MS=${MAX_INSERT_MS:-40}
GUARD_INTERVAL=${GUARD_INTERVAL:-30}
GUARD_MIN_CALLS=${GUARD_MIN_CALLS:-5}
# A concurrent build waits for every transaction that starts while it runs, so
# a fresh long transaction can stall it indefinitely. Cancel past this age.
MAX_BUILD_SECONDS=${MAX_BUILD_SECONDS:-1800}

# On 2026-10-09 the first 14 were rebuilt on prod. The last 6 were left
# alone on purpose: each build slowed proxy requests (see header).
DEFAULT_INDEXES=(
  IDX_requests_pending
  IDX_agent_messages_direct_usage
  IDX_agent_messages_recording
  IDX_agent_messages_unlinked_fallback
  IDX_requests_agent_usage_pending
  IDX_agent_messages_agent_usage_pending
  IDX_agent_messages_errors_timestamp
  IDX_agent_messages_error_origin
  PK_requests
  IDX_agent_messages_fallback_window
  PK_8c7cdeda30e81dba421925df4fe
  UQ_agent_messages_request_attempt_number
  IDX_requests_tenant_status_timestamp
  IDX_agent_messages_tenant_timestamp
  IDX_agent_messages_request_id
  IDX_agent_messages_tenant_provider
  IDX_b920481d4d296ccce0647d6a8a
  IDX_requests_tenant_timestamp
  IDX_requests_tenant_agent_timestamp
  IDX_agent_messages_provider_usage
)
if [ "$#" -gt 0 ]; then INDEXES=("$@"); else INDEXES=("${DEFAULT_INDEXES[@]}"); fi

q() { $PSQL "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }

# Prints "<calls> <total_ms>" for the proxy's request INSERTs.
insert_stats() {
  q "SELECT COALESCE(SUM(calls), 0) || ' ' || COALESCE(SUM(total_exec_time), 0)::bigint
     FROM pg_stat_statements WHERE query LIKE 'INSERT INTO \"requests\"%'"
}

# Cancels the build of index $1 and waits until its backend is really gone:
# cancel first, terminate after 5 tries. Logs loudly if it still can't confirm,
# so an operator knows the build may still be running.
cancel_build() {
  local match="query = 'REINDEX INDEX CONCURRENTLY \"$1\"' AND pid <> pg_backend_pid()"
  local fn=pg_cancel_backend left i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ "$i" -gt 5 ] && fn=pg_terminate_backend
    q "SELECT $fn(pid) FROM pg_stat_activity WHERE $match" >/dev/null
    sleep 2
    left=$(q "SELECT count(*) FROM pg_stat_activity WHERE $match")
    if [ "$left" = "0" ]; then
      log "GUARD: build of $1 stopped"
      return 0
    fi
  done
  log "GUARD: COULD NOT CONFIRM the build of $1 stopped; check pg_stat_activity by hand"
  return 1
}

# Runs in the background while an index builds; cancels that build (and only
# that one) when the insert mean over a window goes above MAX_INSERT_MS, when
# the build runs past MAX_BUILD_SECONDS, or when the stats can't be read.
guard() {
  set +e
  local idx=$1 started prev cur c0 t0 c1 t1 n
  started=$(date +%s)
  prev=$(insert_stats)
  while sleep "$GUARD_INTERVAL"; do
    cur=$(insert_stats)
    if [ -z "$prev" ] || [ -z "$cur" ]; then
      log "GUARD: cannot read pg_stat_statements; cancelling $idx"
      cancel_build "$idx"
      return
    fi
    if [ $(($(date +%s) - started)) -gt "$MAX_BUILD_SECONDS" ]; then
      log "GUARD: $idx still building after $MAX_BUILD_SECONDS s; cancelling"
      cancel_build "$idx"
      return
    fi
    read -r c0 t0 <<<"$prev"
    read -r c1 t1 <<<"$cur"
    n=$((c1 - c0))
    if [ "$n" -ge "$GUARD_MIN_CALLS" ] && [ $(((t1 - t0) / n)) -gt "$MAX_INSERT_MS" ]; then
      log "GUARD: request INSERT mean $(((t1 - t0) / n)) ms > $MAX_INSERT_MS ms; cancelling $idx"
      cancel_build "$idx"
      return
    fi
    prev=$cur
  done
}
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

invalid=$(q "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid")
if [ -n "$invalid" ]; then
  log "ABORT: invalid indexes already present: $invalid"
  exit 1
fi

guard_pid=
trap '[ -n "$guard_pid" ] && kill "$guard_pid" 2>/dev/null' EXIT INT TERM

total_before=0
total_after=0
for idx in "${INDEXES[@]}"; do
  old=$(q "SELECT xact_start::text || ' ' || usename FROM pg_stat_activity
           WHERE xact_start < now() - interval '$MAX_XACT_AGE' AND pid <> pg_backend_pid()
           ORDER BY xact_start LIMIT 1")
  if [ -n "$old" ]; then
    log "ABORT before $idx: transaction open since $old (older than $MAX_XACT_AGE)"
    exit 1
  fi
  before=$(q "SELECT pg_relation_size('\"$idx\"'::regclass)")
  start=$(date +%s)
  log "REINDEX $idx ($((before / 1048576)) MB)"
  guard "$idx" &
  guard_pid=$!
  # Separate -c flags: a multi-statement -c string runs as one implicit
  # transaction, which REINDEX CONCURRENTLY refuses.
  if ! $PSQL "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -c "SET maintenance_work_mem = '$MAINTENANCE_WORK_MEM'" -c "SET statement_timeout = 0" \
    -c "SET max_parallel_maintenance_workers = $PARALLEL_WORKERS" \
    -c "REINDEX INDEX CONCURRENTLY \"$idx\""; then
    # Let a cancelling guard finish confirming the backend is gone (bounded).
    (sleep 25 && kill "$guard_pid" 2>/dev/null) &
    wait "$guard_pid" 2>/dev/null || true
    log "FAILED $idx; dropping leftover ${idx}_ccnew if any"
    q "DROP INDEX CONCURRENTLY IF EXISTS \"${idx}_ccnew\"" || true
    exit 1
  fi
  kill "$guard_pid" 2>/dev/null || true
  after=$(q "SELECT pg_relation_size('\"$idx\"'::regclass)")
  total_before=$((total_before + before))
  total_after=$((total_after + after))
  log "done  $idx: $((before / 1048576)) -> $((after / 1048576)) MB in $(($(date +%s) - start))s"
done

log "TOTAL: $((total_before / 1048576)) -> $((total_after / 1048576)) MB"
invalid=$(q "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid")
[ -z "$invalid" ] || { log "WARNING: invalid indexes remain: $invalid"; exit 1; }
