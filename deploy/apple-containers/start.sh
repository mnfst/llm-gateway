#!/usr/bin/env bash
# Run the Manifest docker-compose stack with Apple Containers (`container` CLI).
#
# Mirrors docker/docker-compose.yml as closely as Apple Containers allows:
#   - postgres:16-alpine with a persistent data directory
#   - manifest app wired to postgres, with health-wait before starting
#   - host LLM access (Ollama / LM Studio) via the container gateway IP
#     (Apple Containers has no host.docker.internal)
#   - dashboard published on host loopback for a stable, VPN-safe URL
#
# Not replicated:
#   - cap_drop / no-new-privileges: each Apple container runs in its own
#     lightweight VM, so isolation is stronger by default
#   - log rotation options and pids_limit: unsupported by the `container` CLI
#   - split frontend/internal networks: Apple Containers has no service-name
#     DNS, so the app connects to PostgreSQL's discovered private IP
#   - healthchecks / depends_on: replaced by explicit readiness polls
#
# Usage:
#   ./deploy/apple-containers/start.sh up      # start the stack (default)
#   ./deploy/apple-containers/start.sh down    # stop and remove containers (data kept)
#   ./deploy/apple-containers/start.sh status  # show container state and URLs
#
# Configuration comes from docker/.env (the same file as Docker Compose).
# Override its path with MANIFEST_ENV_FILE. BETTER_AUTH_SECRET is required:
#   openssl rand -hex 32

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_CONTAINER="mnfst-postgres"
APP_CONTAINER="mnfst-manifest"

if [[ -n "${MANIFEST_ENV_FILE:-}" ]]; then
  ENV_FILE="$MANIFEST_ENV_FILE"
elif [[ -f "$SCRIPT_DIR/.env" ]]; then
  # Backward compatibility with early versions of this script.
  ENV_FILE="$SCRIPT_DIR/.env"
else
  ENV_FILE="$SCRIPT_DIR/../../docker/.env"
fi
load_env_file() {
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "error: invalid entry in $ENV_FILE: $line" >&2
      exit 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"

    # Match Docker Compose dotenv semantics for the forms used by the bundled
    # config: comments are literal inside quotes, and start after whitespace in
    # unquoted values. A caller-exported value takes precedence over .env.
    if [[ "$value" =~ ^[[:space:]]*\"(.*)\"[[:space:]]*(#.*)?$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^[[:space:]]*\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
      value="${BASH_REMATCH[1]}"
    else
      if [[ "$value" =~ ^(.*)[[:space:]]+#.*$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
    fi

    if ! printenv "$key" >/dev/null 2>&1; then
      printf -v "$key" '%s' "$value"
      export "$key"
    fi
  done < "$ENV_FILE"
}

if [[ -f "$ENV_FILE" ]]; then
  # Parse dotenv assignments as data; never execute the configuration file.
  load_env_file
fi

PORT="${PORT:-2099}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-manifest}"
PG_VOLUME="${MANIFEST_PG_VOLUME:-mnfst-postgres-data}"
RECORDINGS_VOLUME="${MANIFEST_RECORDINGS_VOLUME:-mnfst-request-recordings}"
POSTGRES_IMAGE="postgres:16-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416"

if [[ "$POSTGRES_PASSWORD" != "manifest" && -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL must be set when POSTGRES_PASSWORD is customized." >&2
  echo "Percent-encode special characters in its password; see docker/.env.example." >&2
  exit 1
fi

validate_positive_integer() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $name must be a positive integer, got '$value'." >&2
    exit 1
  fi
}

PROVIDER_TIMEOUT_MS="${PROVIDER_TIMEOUT_MS:-180000}"
STREAM_WARMUP_MS="${STREAM_WARMUP_MS:-15000}"
CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS="${CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS:-60000}"
validate_positive_integer PORT "$PORT"
if ((PORT > 65535)); then
  echo "error: PORT must be at most 65535, got '$PORT'." >&2
  exit 1
fi
validate_positive_integer PROVIDER_TIMEOUT_MS "$PROVIDER_TIMEOUT_MS"
validate_positive_integer STREAM_WARMUP_MS "$STREAM_WARMUP_MS"
validate_positive_integer CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS "$CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS"

component_version() {
  local component="$1"
  if [[ "$component" == "container" ]]; then
    container system version 2>/dev/null \
      | sed -n 's/^container[[:space:]]*\([^[:space:]]*\).*/\1/p' \
      | head -n1
  else
    container system version 2>/dev/null \
      | sed -n 's/^container-apiserver.* version \([^[:space:]]*\).*/\1/p' \
      | head -n1
  fi
}

require_cli() {
  if ! command -v container >/dev/null 2>&1; then
    echo "error: Apple 'container' CLI not found." >&2
    echo "Install it from https://github.com/apple/container/releases (macOS 15+, Apple silicon)." >&2
    exit 1
  fi
  # Idempotent: starts the API server / VM services if not already running.
  if ! container system start --enable-kernel-install >/dev/null 2>&1; then
    # A healthy, already-running service may make `system start` non-zero.
    container list >/dev/null 2>&1 || {
      echo "error: Apple Containers service could not be started." >&2
      exit 1
    }
  fi

  local cli_version server_version
  cli_version="$(component_version container)"
  server_version="$(component_version container-apiserver)"
  if [[ -n "$cli_version" && -n "$server_version" && "$cli_version" != "$server_version" ]]; then
    echo "error: Apple Containers CLI ($cli_version) and services ($server_version) do not match." >&2
    echo "After upgrading Apple Containers, restart its services:" >&2
    echo "  container system stop" >&2
    echo "  container system start --enable-kernel-install" >&2
    exit 1
  fi

  if ! container network inspect default >/dev/null 2>&1; then
    echo "error: Apple Containers builtin network is not present." >&2
    echo "Restart the services to recreate it:" >&2
    echo "  container system stop" >&2
    echo "  container system start --enable-kernel-install" >&2
    exit 1
  fi
}

container_ip() {
  # The CLI JSON-escapes the CIDR slash as `\/`, so stop parsing after the
  # numeric address rather than matching the slash. Older releases used
  # `address` instead of `ipv4Address`.
  container inspect "$1" 2>/dev/null \
    | sed -n \
      -e 's/.*"ipv4Address"[[:space:]]*:[[:space:]]*"\([0-9.]*\).*/\1/p' \
      -e 's/.*"address"[[:space:]]*:[[:space:]]*"\([0-9.]*\).*/\1/p' \
    | head -n1
}

gateway_ip() {
  container inspect "$1" 2>/dev/null \
    | sed -n \
      -e 's/.*"ipv4Gateway"[[:space:]]*:[[:space:]]*"\([0-9.]*\).*/\1/p' \
      -e 's/.*"gateway"[[:space:]]*:[[:space:]]*"\([0-9.]*\).*/\1/p' \
    | head -n1
}

is_running() {
  # 1.x nests lifecycle state under status.state; older releases exposed a
  # top-level status string.
  container inspect "$1" 2>/dev/null \
    | grep -Eq '"(state|status)"[[:space:]]*:[[:space:]]*"running"'
}

cmd_up() {
  require_cli

  if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
    echo "error: BETTER_AUTH_SECRET must be set (in $ENV_FILE or the environment)." >&2
    echo "Generate one with: openssl rand -hex 32" >&2
    exit 1
  fi

  # A host bind mount cannot be chown/chmod'ed by PostgreSQL under Apple
  # Containers, so the image exits before starting. A named volume is managed
  # inside the container VM and supports the ownership changes the image needs.
  if ! container volume inspect "$PG_VOLUME" >/dev/null 2>&1; then
    container volume create "$PG_VOLUME" >/dev/null
  fi
  if ! container volume inspect "$RECORDINGS_VOLUME" >/dev/null 2>&1; then
    container volume create "$RECORDINGS_VOLUME" >/dev/null
  fi
  # The Manifest image runs as distroless nonroot (uid/gid 65532), while a new
  # Apple Containers volume is root-owned. Initialize ownership before mounting
  # it over the writable recording directory.
  container run --rm \
    --entrypoint chown \
    --volume "$RECORDINGS_VOLUME:/data/request-recordings" \
    "$POSTGRES_IMAGE" \
    65532:65532 /data/request-recordings >/dev/null

  if is_running "$PG_CONTAINER"; then
    echo "postgres already running."
  else
    container delete "$PG_CONTAINER" >/dev/null 2>&1 || true
    echo "starting postgres..."
    container run --detach --name "$PG_CONTAINER" \
      --env POSTGRES_USER=manifest \
      --env POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
      --env POSTGRES_DB=manifest \
      --env PGDATA=/var/lib/postgresql/data/pgdata \
      --volume "$PG_VOLUME:/var/lib/postgresql/data" \
      "$POSTGRES_IMAGE"
  fi

  echo "waiting for postgres to accept connections..."
  local attempt=0
  until container exec "$PG_CONTAINER" pg_isready -U manifest -d manifest >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if ! is_running "$PG_CONTAINER"; then
      echo "error: postgres stopped before becoming ready." >&2
      echo "Container logs:" >&2
      container logs "$PG_CONTAINER" >&2 || true
      exit 1
    fi
    if [[ $attempt -ge 30 ]]; then
      echo "error: postgres did not become ready within 60s." >&2
      echo "Container logs:" >&2
      container logs "$PG_CONTAINER" >&2 || true
      exit 1
    fi
    sleep 2
  done
  if ! container exec --env PGPASSWORD="$POSTGRES_PASSWORD" "$PG_CONTAINER" \
    psql -h 127.0.0.1 -U manifest -d manifest -c 'SELECT 1' >/dev/null 2>&1; then
    echo "error: postgres rejected POSTGRES_PASSWORD." >&2
    echo "POSTGRES_PASSWORD only initializes a new volume; changing it later does not rotate the database password." >&2
    echo "Restore the original password or explicitly rotate the manifest role in PostgreSQL." >&2
    exit 1
  fi
  echo "postgres is ready."

  local pg_ip gateway
  pg_ip="$(container_ip "$PG_CONTAINER")"
  gateway="$(gateway_ip "$PG_CONTAINER")"
  if [[ -z "$pg_ip" || -z "$gateway" ]]; then
    echo "error: could not determine postgres network addresses." >&2
    container inspect "$PG_CONTAINER" >&2 || true
    exit 1
  fi

  # The compose file uses the service name `postgres` as the DB host; Apple
  # Containers has no inter-container DNS by default, so use the IP. Translate
  # the bundled compose URL when present; custom URLs are left untouched.
  local database_url
  database_url="${DATABASE_URL:-postgresql://manifest:manifest@${pg_ip}:5432/manifest}"
  database_url="${database_url/@postgres:5432/@${pg_ip}:5432}"

  # The gateway reaches host services bound beyond loopback. Ollama and LM
  # Studio may need to be configured to listen on the host gateway interface.
  local ollama_host
  ollama_host="${OLLAMA_HOST:-http://${gateway}:11434}"

  if is_running "$APP_CONTAINER"; then
    echo "manifest already running, recreating to pick up postgres address..."
    container stop --time 15 "$APP_CONTAINER" >/dev/null
  fi
  container delete "$APP_CONTAINER" >/dev/null 2>&1 || true

  echo "starting manifest..."
  container run --detach --name "$APP_CONTAINER" \
    --memory 1g \
    --publish "127.0.0.1:${PORT}:${PORT}" \
    --volume "$RECORDINGS_VOLUME:/data/request-recordings" \
    --env PORT="$PORT" \
    --env BIND_ADDRESS=0.0.0.0 \
    --env DATABASE_URL="$database_url" \
    --env BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
    --env MANIFEST_ENCRYPTION_KEY="${MANIFEST_ENCRYPTION_KEY:-}" \
    --env BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:${PORT}}" \
    --env OLLAMA_HOST="$ollama_host" \
    --env PROVIDER_TIMEOUT_MS="$PROVIDER_TIMEOUT_MS" \
    --env STREAM_WARMUP_MS="$STREAM_WARMUP_MS" \
    --env CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS="$CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS" \
    --env SEED_DATA=false \
    --env NODE_ENV=production \
    --env MANIFEST_MODE="${MANIFEST_MODE:-selfhosted}" \
    --env EMAIL_PROVIDER="${EMAIL_PROVIDER:-}" \
    --env EMAIL_API_KEY="${EMAIL_API_KEY:-}" \
    --env EMAIL_DOMAIN="${EMAIL_DOMAIN:-}" \
    --env EMAIL_FROM="${EMAIL_FROM:-}" \
    --env GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}" \
    --env GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}" \
    --env GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-}" \
    --env GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-}" \
    --env DISCORD_CLIENT_ID="${DISCORD_CLIENT_ID:-}" \
    --env DISCORD_CLIENT_SECRET="${DISCORD_CLIENT_SECRET:-}" \
    --env REQUEST_RECORDING_STORAGE="${REQUEST_RECORDING_STORAGE:-auto}" \
    --env REQUEST_RECORDING_FILESYSTEM_PATH=/data/request-recordings \
    --env REQUEST_RECORDING_RETENTION_DAYS="${REQUEST_RECORDING_RETENTION_DAYS:-}" \
    --env REQUEST_RECORDING_S3_BUCKET="${REQUEST_RECORDING_S3_BUCKET:-}" \
    --env REQUEST_RECORDING_S3_ENDPOINT="${REQUEST_RECORDING_S3_ENDPOINT:-}" \
    --env REQUEST_RECORDING_S3_REGION="${REQUEST_RECORDING_S3_REGION:-}" \
    --env REQUEST_RECORDING_S3_ACCESS_KEY_ID="${REQUEST_RECORDING_S3_ACCESS_KEY_ID:-}" \
    --env REQUEST_RECORDING_S3_SECRET_ACCESS_KEY="${REQUEST_RECORDING_S3_SECRET_ACCESS_KEY:-}" \
    --env REQUEST_RECORDING_S3_FORCE_PATH_STYLE="${REQUEST_RECORDING_S3_FORCE_PATH_STYLE:-false}" \
    --env MANIFEST_TELEMETRY_DISABLED="${MANIFEST_TELEMETRY_DISABLED:-0}" \
    manifestdotbuild/manifest:latest

  echo "waiting for manifest to become healthy..."
  attempt=0
  # Mirrors the compose healthcheck: 90s start grace + retries.
  until curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if ! is_running "$APP_CONTAINER"; then
      echo "error: manifest stopped before becoming healthy." >&2
      echo "Container logs:" >&2
      container logs "$APP_CONTAINER" >&2 || true
      exit 1
    fi
    if [[ $attempt -ge 40 ]]; then
      echo "error: manifest did not become healthy within 120s." >&2
      echo "Container logs:" >&2
      container logs "$APP_CONTAINER" >&2 || true
      exit 1
    fi
    sleep 3
  done

  echo ""
  echo "Manifest is up: http://localhost:${PORT}"
  echo "First boot: visit the URL above and complete the setup wizard at /setup."
}

cmd_down() {
  require_cli
  echo "stopping containers (data in volumes $PG_VOLUME and $RECORDINGS_VOLUME is kept)..."
  container stop --time 15 "$APP_CONTAINER" >/dev/null 2>&1 || true
  container stop --time 15 "$PG_CONTAINER" >/dev/null 2>&1 || true
  container delete "$APP_CONTAINER" >/dev/null 2>&1 || true
  container delete "$PG_CONTAINER" >/dev/null 2>&1 || true
  echo "done."
}

cmd_status() {
  require_cli
  for name in "$PG_CONTAINER" "$APP_CONTAINER"; do
    if is_running "$name"; then
      echo "$name: running at $(container_ip "$name")"
    else
      echo "$name: not running"
    fi
  done
  if is_running "$APP_CONTAINER"; then
    echo "app URL: http://localhost:${PORT}"
  fi
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 1
    ;;
esac
