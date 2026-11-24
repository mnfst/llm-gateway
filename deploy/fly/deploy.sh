#!/usr/bin/env bash
set -euo pipefail

if ! command -v fly >/dev/null 2>&1; then
  echo "fly CLI is required. Install it from https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate Manifest secrets." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to inspect the Fly API response." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to inspect the attached Tigris bucket." >&2
  exit 1
fi

if ! fly auth whoami >/dev/null 2>&1; then
  echo "Run 'fly auth login' before deploying." >&2
  exit 1
fi

APP_NAME="${FLY_APP_NAME:-manifest-$(openssl rand -hex 3)}"
POSTGRES_APP_NAME="${FLY_POSTGRES_APP_NAME:-${APP_NAME}-db}"
REGION="${FLY_REGION:-cdg}"
ORG="${FLY_ORG:-personal}"
RECORDING_BUCKET_NAME="${FLY_RECORDING_BUCKET_NAME:-${APP_NAME}-recordings}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/manifest-fly.XXXXXX.toml")"

cleanup() {
  rm -f "$CONFIG_FILE"
}
trap cleanup EXIT

secret_exists() {
  local secret_name="$1"
  fly secrets list --app "$APP_NAME" | awk 'NR > 1 { print $1 }' | grep -Fxq "$secret_name"
}

bucket_exists() {
  fly storage status "$RECORDING_BUCKET_NAME" >/dev/null 2>&1
}

attached_bucket_name() {
  local auth_scheme auth_token payload response

  auth_token="$(fly auth token --json | jq -er '.token')"
  case "$auth_token" in
    ,* | fm1r_* | fm1a_* | fm2_* | *,fm1r_* | *,fm1a_* | *,fm2_*) auth_scheme="FlyV1" ;;
    *) auth_scheme="Bearer" ;;
  esac

  payload="$(jq -nc --arg name "$APP_NAME" '{
    query: "query AttachedTigris($name: String!, $type: AddOnType!) { app(name: $name) { addOns(type: $type) { nodes { name } } } }",
    variables: { name: $name, type: "tigris" }
  }')"
  response="$(curl --fail-with-body --silent --show-error \
    --config <(printf 'header = "Authorization: %s %s"\n' "$auth_scheme" "$auth_token") \
    --header 'Content-Type: application/json' \
    --data-binary "$payload" \
    "${FLY_API_BASE_URL:-https://api.fly.io}/graphql")"

  jq -er '
    if (.errors // [] | length) > 0 then
      error(.errors[0].message)
    elif .data.app == null then
      error("Fly app was not found")
    elif (.data.app.addOns.nodes | length) > 1 then
      error("Fly app has multiple Tigris attachments")
    else
      .data.app.addOns.nodes[0].name // ""
    end
  ' <<< "$response"
}

sed \
  -e "s/manifest-recordings-bucket/${RECORDING_BUCKET_NAME}/g" \
  -e "s/manifest-example/${APP_NAME}/g" \
  -e "s/primary_region = \"cdg\"/primary_region = \"${REGION}\"/" \
  "$SCRIPT_DIR/fly.toml" > "$CONFIG_FILE"

echo "Creating Fly app ${APP_NAME} in org ${ORG}..."
if ! fly status --app "$APP_NAME" >/dev/null 2>&1; then
  fly apps create "$APP_NAME" --org "$ORG" -y
else
  echo "Fly app ${APP_NAME} already exists."
fi

echo "Creating Tigris recording bucket ${RECORDING_BUCKET_NAME}..."
if ! attached_bucket="$(attached_bucket_name)"; then
  echo "Unable to inspect Tigris attachments for Fly app ${APP_NAME}." >&2
  exit 1
fi
if [[ -n "$attached_bucket" ]]; then
  if [[ "$attached_bucket" != "$RECORDING_BUCKET_NAME" ]]; then
    echo "Fly app ${APP_NAME} is already attached to Tigris bucket ${attached_bucket}." >&2
    echo "Keep FLY_RECORDING_BUCKET_NAME=${attached_bucket}, or migrate the bucket manually." >&2
    exit 1
  fi
  echo "Tigris bucket ${RECORDING_BUCKET_NAME} already exists."
elif bucket_exists; then
  echo "Tigris bucket ${RECORDING_BUCKET_NAME} exists but is not attached to ${APP_NAME}." >&2
  echo "Choose a new FLY_RECORDING_BUCKET_NAME or attach matching credentials manually." >&2
  exit 1
else
  fly storage create \
    --name "$RECORDING_BUCKET_NAME" \
    --org "$ORG" \
    --app "$APP_NAME" \
    --yes
fi

echo "Creating Fly Postgres app ${POSTGRES_APP_NAME} in ${REGION}..."
if ! fly status --app "$POSTGRES_APP_NAME" >/dev/null 2>&1; then
  fly postgres create \
    --name "$POSTGRES_APP_NAME" \
    --org "$ORG" \
    --region "$REGION" \
    --initial-cluster-size 1 \
    --vm-cpu-kind shared \
    --vm-cpus 1 \
    --vm-memory 512 \
    --volume-size 1
else
  echo "Fly Postgres app ${POSTGRES_APP_NAME} already exists."
fi

echo "Attaching Postgres to ${APP_NAME}..."
fly postgres attach "$POSTGRES_APP_NAME" \
  --app "$APP_NAME" \
  --database-name manifest \
  --database-user manifest \
  --yes

echo "Setting Manifest secrets..."
manifest_secret_args=(--app "$APP_NAME" --stage)

if secret_exists "BETTER_AUTH_SECRET"; then
  echo "BETTER_AUTH_SECRET already exists; leaving it unchanged."
else
  manifest_secret_args+=("BETTER_AUTH_SECRET=$(openssl rand -hex 32)")
fi

if secret_exists "MANIFEST_ENCRYPTION_KEY"; then
  echo "MANIFEST_ENCRYPTION_KEY already exists; leaving it unchanged."
else
  manifest_secret_args+=("MANIFEST_ENCRYPTION_KEY=$(openssl rand -hex 32)")
fi

if [ "${#manifest_secret_args[@]}" -gt 3 ]; then
  fly secrets set "${manifest_secret_args[@]}"
else
  echo "Manifest secrets already exist."
fi

echo "Deploying Manifest..."
fly deploy --app "$APP_NAME" --config "$CONFIG_FILE"

echo
echo "Manifest URL: https://${APP_NAME}.fly.dev"
echo "Health check: https://${APP_NAME}.fly.dev/api/v1/health"
