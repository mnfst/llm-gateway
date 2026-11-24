#!/usr/bin/env bash

set -euo pipefail

PACKAGE_NAME=${NPM_PACKAGE_NAME:-mnfst-gateway-cli}
EXPECTED_MAINTAINER=${NPM_PACKAGE_MAINTAINER:-guillaumegay}
VERSION=${NPM_PACKAGE_VERSION:-$(jq -r .version packages/cli/package.json)}

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "GITHUB_OUTPUT is required." >&2
  exit 1
fi

echo "version=$VERSION" >> "$GITHUB_OUTPUT"

# Only an E404 means "not published". Any other npm view failure stops the
# run rather than risking a duplicate publish.
set +e
VIEW_OUTPUT=$(npm view "${PACKAGE_NAME}@${VERSION}" version 2>&1)
VIEW_STATUS=$?
set -e

if [ "$VIEW_STATUS" -eq 0 ]; then
  # An unscoped name is global. Confirm the known project maintainer before a
  # retry reports a green no-op for an existing package.
  MAINTAINERS=$(npm view "${PACKAGE_NAME}@${VERSION}" maintainers --json)
  if ! printf '%s' "$MAINTAINERS" | jq -e --arg expected "$EXPECTED_MAINTAINER" \
    'type == "array" and any(.[]; split(" <")[0] == $expected)' \
    >/dev/null; then
    echo "${PACKAGE_NAME}@${VERSION} exists but is not maintained by ${EXPECTED_MAINTAINER}." >&2
    echo "Refusing to report success for someone else's package." >&2
    exit 1
  fi

  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "${PACKAGE_NAME}@${VERSION} is already published by us; nothing to do."
elif printf '%s' "$VIEW_OUTPUT" | grep -q 'E404'; then
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "${PACKAGE_NAME}@${VERSION} is not on npm yet."
else
  echo "npm view failed for a reason other than E404; refusing to guess:" >&2
  printf '%s\n' "$VIEW_OUTPUT" >&2
  exit 1
fi
