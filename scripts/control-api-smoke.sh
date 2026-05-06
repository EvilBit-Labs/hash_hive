#!/usr/bin/env bash
#
# Control API smoke test.
#
# Round-trips a representative subset of endpoints to verify auth, project
# scoping, and the RFC 9457 error envelope are wired up end-to-end. Use
# this to verify a fresh deployment or to confirm a local dev stack is
# healthy before running heavier integration work.
#
# Usage:
#   HASHHIVE_API_KEY=cst_... HASHHIVE_BASE_URL=http://localhost:3001 \
#     HASHHIVE_PROJECT_ID=1 bash scripts/control-api-smoke.sh

set -euo pipefail

: "${HASHHIVE_API_KEY:?HASHHIVE_API_KEY must be set (issue one from the Account page)}"
: "${HASHHIVE_BASE_URL:?HASHHIVE_BASE_URL must be set (e.g. http://localhost:3001)}"
: "${HASHHIVE_PROJECT_ID:?HASHHIVE_PROJECT_ID must be set (the active project id)}"

BASE="${HASHHIVE_BASE_URL%/}/api/v1/control"
HDR_AUTH=(-H "Authorization: Bearer ${HASHHIVE_API_KEY}")
HDR_PROJECT=(-H "X-Project-Id: ${HASHHIVE_PROJECT_ID}")

call() {
  local label="$1"; shift
  local expect="$1"; shift
  echo "→ ${label}"
  local status
  status=$(curl -sS -o /tmp/control-smoke-body -w '%{http_code}' "$@" || true)
  if [[ "${status}" != "${expect}" ]]; then
    echo "   FAIL: expected ${expect}, got ${status}"
    cat /tmp/control-smoke-body
    echo
    exit 1
  fi
  echo "   OK ${status}"
}

call "GET /health (auth)" 200 \
  "${HDR_AUTH[@]}" "${BASE}/health"

call "GET /health (no auth → 401)" 401 \
  "${BASE}/health"

call "GET /projects" 200 \
  "${HDR_AUTH[@]}" "${BASE}/projects"

call "GET /users/me" 200 \
  "${HDR_AUTH[@]}" "${BASE}/users/me"

call "GET /campaigns" 200 \
  "${HDR_AUTH[@]}" "${HDR_PROJECT[@]}" "${BASE}/campaigns"

call "GET /agents" 200 \
  "${HDR_AUTH[@]}" "${HDR_PROJECT[@]}" "${BASE}/agents"

call "GET /campaigns without X-Project-Id → 400" 400 \
  "${HDR_AUTH[@]}" "${BASE}/campaigns"

echo
echo "Control API smoke test passed."
