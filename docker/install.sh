#!/usr/bin/env bash
# Manifest — self-host install and upgrade helper
#
# Downloads the Docker Compose file and the `.env.example` template,
# generates a BETTER_AUTH_SECRET and a MANIFEST_ENCRYPTION_KEY, writes them
# into a local `.env`, then brings up the stack. Designed for first-time
# self-hosters who want a one-command setup. Give it a couple of minutes —
# Docker needs to pull the app image and Postgres on a cold cache.
# Once healthy, visit http://localhost:2099 and the setup wizard will
# walk you through creating the first admin account.
#
# Usage:
#   bash install.sh                  # install into $HOME/manifest
#   bash install.sh --dir /opt/mnfst # install into a custom directory
#   bash install.sh --port 8080      # serve the dashboard on a different port
#   bash install.sh --upgrade        # safely upgrade $HOME/manifest
#   bash install.sh --upgrade --dir /opt/mnfst
#   bash install.sh --dry-run        # print what would happen, do nothing
#   bash install.sh --yes            # skip confirmation prompt (non-interactive)
#
# Re-running against an existing install directory resumes it: the compose
# file and the generated secrets are left alone and the stack is brought
# back up. Pass --upgrade to back up and replace only the managed Compose
# file; `.env` and `docker-compose.override.yml` remain untouched.
#
# Review before running:
#   curl -sSLO https://raw.githubusercontent.com/mnfst/llm-gateway/main/docker/install.sh
#   less install.sh
#   bash install.sh --dry-run
#   bash install.sh
#
# If you trust the source, one-shot:
#   bash <(curl -sSL https://raw.githubusercontent.com/mnfst/llm-gateway/main/docker/install.sh)

set -euo pipefail

# Override via MANIFEST_INSTALLER_SOURCE when you need the installer to
# pull files from somewhere other than `main` — a fork, a release branch,
# or a local HTTP server hosting a pre-release copy (this is how the
# Docker smoke CI exercises the script end-to-end against the branch
# under test, not the published files on GitHub).
REPO_RAW="${MANIFEST_INSTALLER_SOURCE:-https://raw.githubusercontent.com/mnfst/llm-gateway/main/docker}"
# Default to $HOME/manifest so running the one-liner from inside another
# project (a git worktree, a dotfiles checkout, etc.) doesn't silently
# litter that directory with `./manifest/`.
DEFAULT_DIR="${HOME:-.}/manifest"
INSTALL_DIR="$DEFAULT_DIR"
HOST_PORT=2099
DRY_RUN=0
ASSUME_YES=0
UPGRADE=0
NEW_COMPOSE_PATH=""
BACKUP_PATH=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  if [[ -n "$NEW_COMPOSE_PATH" && -f "$NEW_COMPOSE_PATH" ]]; then
    rm -f "$NEW_COMPOSE_PATH"
  fi
}
trap cleanup EXIT

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    \033[2m$ %s\033[0m\n' "$*"
  else
    "$@"
  fi
}

usage() {
  # Print the header comment block: every line from line 2 up to (but not
  # including) the first non-comment line. Computed rather than a hardcoded
  # range so editing the header above can't silently truncate --help.
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)     INSTALL_DIR="${2:?--dir requires a path}"; shift 2 ;;
    --port)    HOST_PORT="${2:?--port requires a port number}"; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    -h|--help) usage ;;
    *)         die "Unknown flag: $1 (use --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 \
  || die "docker not found. Install Docker first: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 \
  || die "'docker compose' plugin not found. Upgrade Docker to a version that bundles Compose v2."
command -v curl >/dev/null 2>&1 || die "curl is required."

COMPOSE_PATH="$INSTALL_DIR/docker-compose.yml"
ENV_PATH="$INSTALL_DIR/.env"

# An existing install directory is a resume, not an error. The common way to
# land here is a first run that downloaded the files and then failed at
# `docker compose up` (no disk space, a Docker daemon hiccup, an exhausted
# network address pool). Re-running used to hard-fail with "already exists",
# which pointed at --dir or `rm -rf` — and `rm -rf` throws away the generated
# BETTER_AUTH_SECRET, invalidating every session and, if the volume survived,
# every provider credential encrypted with it. So: keep what's there and
# just bring the stack up.
RESUME=0
if [[ "$UPGRADE" -eq 1 ]]; then
  [[ -d "$INSTALL_DIR" ]] \
    || die "No installation found at $INSTALL_DIR. Remove --upgrade to create one."
  [[ -f "$COMPOSE_PATH" ]] \
    || die "Missing $COMPOSE_PATH. Cannot upgrade this installation safely."
  [[ -f "$ENV_PATH" ]] \
    || die "Missing $ENV_PATH. Cannot upgrade without the existing configuration."
  RESUME=1
elif [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
  if [[ -f "$INSTALL_DIR/docker-compose.yml" && -f "$INSTALL_DIR/.env" ]]; then
    RESUME=1
  else
    die "$INSTALL_DIR already exists, is not empty, and does not look like a Manifest install (no docker-compose.yml + .env). Pass --dir to choose another location, or remove it first."
  fi
fi

SECRET_TOOL=""
if [[ "$RESUME" -eq 0 ]]; then
  if command -v openssl >/dev/null 2>&1; then
    SECRET_TOOL="openssl"
  elif [[ -r /dev/urandom ]]; then
    SECRET_TOOL="urandom"
  else
    die "Need either openssl or /dev/urandom to generate a secret."
  fi
fi

read_env_value() {
  local key="$1"
  local file="$2"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s\n' "${line#*=}"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

if [[ "$UPGRADE" -eq 1 ]]; then
  configured_host_port="$(read_env_value HOST_PORT "$ENV_PATH" || true)"
  configured_app_port="$(read_env_value PORT "$ENV_PATH" || true)"
  HOST_PORT="${configured_host_port:-${configured_app_port:-2099}}"
fi

if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] ||
  (( HOST_PORT < 1 || HOST_PORT > 65535 )); then
  die "Dashboard port must be a number between 1 and 65535 (got: $HOST_PORT)"
fi

# Nothing we install will start if the host port is already taken; surface
# that now with a pointer to the fix, rather than letting `docker compose up`
# fail with a less obvious message below. Skipped when resuming — the port is
# very likely held by this install's own container.
if [[ "$DRY_RUN" -eq 0 && "$RESUME" -eq 0 ]]; then
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[: ]${HOST_PORT}\\b"; then
    die "Port ${HOST_PORT} is already in use on this host. Stop whatever is bound to it, or re-run with a different port: bash install.sh --port 8080"
  fi
fi

if [[ "$UPGRADE" -eq 1 ]]; then
  operation="upgrade"
else
  operation="install"
fi

log "Manifest self-host ${operation}"
printf '    Install directory: %s\n' "$INSTALL_DIR"
printf '    Dashboard port:    %s\n' "$HOST_PORT"
printf '    Source:            %s\n' "$REPO_RAW"
printf '    Mode:              %s\n' "$([[ $DRY_RUN -eq 1 ]] && echo "dry-run ${operation} (no changes)" || echo "live ${operation}")"
if [[ "$RESUME" -eq 1 && "$UPGRADE" -eq 0 ]]; then
  printf '    Existing install:  resuming (compose file and .env left untouched)\n'
fi
echo

if [[ "$UPGRADE" -eq 1 ]] && ! grep -q '^# manifest-compose-version:' "$COMPOSE_PATH"; then
  warn "This is the first managed Compose upgrade for this installation."
  warn "The current docker-compose.yml will be backed up and replaced."
  warn "Move custom edits to .env or docker-compose.override.yml after the upgrade."
  echo
fi

if [[ "$ASSUME_YES" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  # `bash <(curl ...)` and `curl | bash` can leave stdin detached or
  # consumed by the pipe. Read from the controlling terminal when stdin
  # isn't a tty; if there's no terminal at all, tell the user how to
  # skip this prompt non-interactively.
  if [[ -t 0 ]]; then
    read -r -p "Proceed? [y/N] " reply
  elif [[ -r /dev/tty ]]; then
    read -r -p "Proceed? [y/N] " reply < /dev/tty
  else
    die "No terminal available for the confirmation prompt. Re-run with --yes to skip it, or download the script first: curl -sSLO ${REPO_RAW}/install.sh && bash install.sh"
  fi
  [[ "$reply" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 1; }
fi

gen_secret() {
  case "$SECRET_TOOL" in
    openssl) openssl rand -hex 32 ;;
    urandom) head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' ;;
  esac
}

restore_previous_compose() {
  local restart="${1:-0}"
  if [[ -z "$BACKUP_PATH" || ! -f "$BACKUP_PATH" ]]; then
    return
  fi
  warn "Restoring the previous Compose configuration."
  cp -p "$BACKUP_PATH" "$COMPOSE_PATH"
  if [[ "$restart" -eq 1 ]] && ! (cd "$INSTALL_DIR" && docker compose up -d); then
    warn "The previous Compose file was restored, but its containers did not restart."
  fi
}

if [[ "$UPGRADE" -eq 1 ]]; then
  log "Downloading and validating the managed compose file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    \033[2m$ curl -sSLf %s/docker-compose.yml -o %s/.docker-compose.yml.<temporary>\033[0m\n' "$REPO_RAW" "$INSTALL_DIR"
    printf '    \033[2m$ docker compose --env-file %s -f <temporary> config --quiet\033[0m\n' "$ENV_PATH"
    printf '    \033[2m$ backup %s, then replace it atomically\033[0m\n' "$COMPOSE_PATH"
  else
    NEW_COMPOSE_PATH="$(mktemp "$INSTALL_DIR/.docker-compose.yml.XXXXXX")"
    curl -sSLf "$REPO_RAW/docker-compose.yml" -o "$NEW_COMPOSE_PATH" \
      || die "Failed to download docker-compose.yml"
    grep -qE '^# manifest-compose-version: [0-9]+$' "$NEW_COMPOSE_PATH" \
      || die "Downloaded docker-compose.yml is not a managed Manifest Compose file."
    docker compose --env-file "$ENV_PATH" -f "$NEW_COMPOSE_PATH" config --quiet \
      || die "Downloaded docker-compose.yml is invalid for the existing .env."

    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    BACKUP_PATH="${COMPOSE_PATH}.backup.${timestamp}"
    cp -p "$COMPOSE_PATH" "$BACKUP_PATH"
    mv "$NEW_COMPOSE_PATH" "$COMPOSE_PATH"
    NEW_COMPOSE_PATH=""

    if ! (cd "$INSTALL_DIR" && docker compose config --quiet); then
      restore_previous_compose 0
      die "The updated Compose configuration conflicts with a local override."
    fi
    printf '    Previous compose: %s\n' "$BACKUP_PATH"
  fi
elif [[ "$RESUME" -eq 1 ]]; then
  log "Reusing existing install (skipping download and secret generation)"
  printf '    Keeping %s and %s as they are.\n' "$INSTALL_DIR/docker-compose.yml" "$ENV_PATH"
else
  log "Creating install directory"
  run mkdir -p "$INSTALL_DIR"

  log "Downloading compose file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    \033[2m$ curl -sSLf %s/docker-compose.yml -o %s/docker-compose.yml\033[0m\n' "$REPO_RAW" "$INSTALL_DIR"
  else
    curl -sSLf "$REPO_RAW/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml" \
      || die "Failed to download docker-compose.yml"
  fi

  log "Downloading .env.example"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    \033[2m$ curl -sSLf %s/.env.example -o %s\033[0m\n' "$REPO_RAW" "$ENV_PATH"
  else
    curl -sSLf "$REPO_RAW/.env.example" -o "$ENV_PATH" \
      || die "Failed to download .env.example"
  fi

  log "Generating BETTER_AUTH_SECRET and MANIFEST_ENCRYPTION_KEY"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    SECRET="<generated-at-install-time>"
    ENCRYPTION_KEY="<generated-at-install-time>"
    printf '    \033[2m$ openssl rand -hex 32   # BETTER_AUTH_SECRET\033[0m\n'
    printf '    \033[2m$ openssl rand -hex 32   # MANIFEST_ENCRYPTION_KEY\033[0m\n'
  else
    SECRET="$(gen_secret)"
    # A second, independent key. Left unset the backend falls back to
    # BETTER_AUTH_SECRET for at-rest encryption and warns about it on every
    # boot — which means one leaked session-signing secret also decrypts every
    # stored provider key and OAuth token. It costs nothing to generate here,
    # and after first boot it can never be introduced without re-encrypting
    # what is already in the database.
    ENCRYPTION_KEY="$(gen_secret)"
  fi

  log "Writing secrets into .env"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    \033[2m$ replace "BETTER_AUTH_SECRET=" → "BETTER_AUTH_SECRET=<generated>" in %s\033[0m\n' "$ENV_PATH"
    printf '    \033[2m$ replace "# MANIFEST_ENCRYPTION_KEY=" → "MANIFEST_ENCRYPTION_KEY=<generated>" in %s\033[0m\n' "$ENV_PATH"
  else
    if ! grep -qE '^BETTER_AUTH_SECRET=$' "$ENV_PATH"; then
      die "Expected empty BETTER_AUTH_SECRET= line not found in $ENV_PATH — refusing to proceed."
    fi
    if ! grep -qE '^# MANIFEST_ENCRYPTION_KEY=$' "$ENV_PATH"; then
      die "Expected commented # MANIFEST_ENCRYPTION_KEY= line not found in $ENV_PATH — refusing to proceed."
    fi
    # Line-based rewrite — no sed, no quoting edge cases. openssl rand -hex
    # produces only [0-9a-f], so interpolation into the line is safe.
    new_content=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "BETTER_AUTH_SECRET=" ]]; then
        new_content+="BETTER_AUTH_SECRET=$SECRET"$'\n'
      elif [[ "$line" == "# MANIFEST_ENCRYPTION_KEY=" ]]; then
        new_content+="MANIFEST_ENCRYPTION_KEY=$ENCRYPTION_KEY"$'\n'
      else
        new_content+="$line"$'\n'
      fi
    done < "$ENV_PATH"
    printf '%s' "$new_content" > "$ENV_PATH"

    # The compose file reads ${PORT:-2099} for both the published host port and
    # the backend's own listener, and BETTER_AUTH_URL defaults to
    # http://localhost:${PORT:-2099} — so pinning PORT is the whole job. Only
    # written when it differs from the default, to keep .env close to stock.
    if [[ "$HOST_PORT" -ne 2099 ]]; then
      printf 'PORT=%s\n' "$HOST_PORT" >> "$ENV_PATH"
    fi

    chmod 600 "$ENV_PATH"
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ "$UPGRADE" -eq 1 && "${MANIFEST_INSTALLER_SKIP_PULL:-0}" != "1" ]]; then
    printf '    \033[2m$ (cd %s && docker compose pull)\033[0m\n' "$INSTALL_DIR"
  fi
  printf '    \033[2m$ (cd %s && docker compose up -d)\033[0m\n' "$INSTALL_DIR"
  log "Dry run complete. No changes made."
  exit 0
fi

if [[ "$UPGRADE" -eq 1 && "${MANIFEST_INSTALLER_SKIP_PULL:-0}" != "1" ]]; then
  log "Pulling release images"
  if ! (cd "$INSTALL_DIR" && docker compose pull); then
    restore_previous_compose 0
    die "Image pull failed. The previous Compose configuration was restored."
  fi
fi

if [[ "$UPGRADE" -eq 1 ]]; then
  log "Applying the upgrade"
else
  log "Starting the stack"
fi
if ! (cd "$INSTALL_DIR" && docker compose up -d); then
  if [[ "$UPGRADE" -eq 1 ]]; then
    restore_previous_compose 1
    die "Upgrade failed. The previous Compose configuration was restored."
  fi
  die "docker compose up failed"
fi

log "Waiting for Manifest to become healthy (up to 120s)"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/api/v1/health"
for _ in $(seq 1 24); do
  if curl -sSf "$HEALTH_URL" >/dev/null 2>&1; then
    log "Manifest is up."
    if [[ "$UPGRADE" -eq 1 ]]; then
      cat <<EOF

  Upgraded: $INSTALL_DIR
  Config:   $ENV_PATH  (preserved)
  Backup:   $BACKUP_PATH
  Verify:   curl -sSf $HEALTH_URL
EOF
      exit 0
    fi
    cat <<EOF

  Open:   http://localhost:${HOST_PORT}

  Next:   1. Create your admin account — the first visit walks you through it.
          2. Connect a provider: Providers → Usage-based (API key) or
             Subscriptions, in the dashboard sidebar.
          3. Copy your agent's mnfst_ key and point your agent at
             http://localhost:${HOST_PORT}/v1

  Config: $INSTALL_DIR/.env  (secrets, OAuth keys, email provider)
  Verify: curl -sSf http://localhost:${HOST_PORT}/api/v1/health

  Note:   Port ${HOST_PORT} is bound to 127.0.0.1 only. To expose on your LAN,
          edit $INSTALL_DIR/docker-compose.yml and change the ports line
          from "127.0.0.1:\${PORT:-2099}:\${PORT:-2099}" to "\${PORT:-2099}:\${PORT:-2099}",
          then set BETTER_AUTH_URL in .env to the host you'll reach it on
          (e.g. http://192.168.1.20:${HOST_PORT}) — it must match the browser URL.

  Stop:  (cd $INSTALL_DIR && docker compose down)
  Wipe:  (cd $INSTALL_DIR && docker compose down -v)
EOF
    exit 0
  fi
  sleep 5
done

if [[ "$UPGRADE" -eq 1 ]]; then
  restore_previous_compose 1
  die "Manifest did not become healthy after the upgrade. The previous Compose configuration was restored."
fi

warn "Manifest did not become healthy within 120s. Check logs with:"
warn "  (cd $INSTALL_DIR && docker compose logs -f manifest)"
exit 1
