#!/usr/bin/env bash
set -euo pipefail

# Real PostgreSQL E2E URL precedence:
#   1. PG_TEST_URL (canonical CI/test harness input)
#   2. HELM_TEST_POSTGRES_URL (backward-compatible local input)
#   3. a hermetic digest-pinned PostgreSQL 17 + pgvector container
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGVECTOR_IMAGE="pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21"
CONTAINER_ID=""
CONTAINER_NAME="helm-api-e2e-pg-${$}-${RANDOM}"

cleanup() {
  if [[ -n "${CONTAINER_ID}" ]]; then
    docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "${PG_TEST_URL:-}" ]]; then
  TEST_POSTGRES_URL="${PG_TEST_URL}"
  echo "[real-pg] using PG_TEST_URL"
elif [[ -n "${HELM_TEST_POSTGRES_URL:-}" ]]; then
  TEST_POSTGRES_URL="${HELM_TEST_POSTGRES_URL}"
  echo "[real-pg] using HELM_TEST_POSTGRES_URL"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "[real-pg] ERROR: neither PG_TEST_URL nor HELM_TEST_POSTGRES_URL is set, and Docker is not installed" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "[real-pg] ERROR: neither PG_TEST_URL nor HELM_TEST_POSTGRES_URL is set, and Docker is unavailable" >&2
    exit 1
  fi

  echo "[real-pg] starting digest-pinned PostgreSQL 17 + pgvector test container"
  CONTAINER_ID="$(docker run --detach --rm \
    --name "${CONTAINER_NAME}" \
    --env POSTGRES_USER=helmtest \
    --env POSTGRES_PASSWORD=helmtest \
    --env POSTGRES_DB=helm_api_lease_test \
    --publish 127.0.0.1::5432 \
    "${PGVECTOR_IMAGE}")"

  PORT_MAPPING="$(docker port "${CONTAINER_ID}" 5432/tcp)"
  TEST_POSTGRES_PORT="${PORT_MAPPING##*:}"
  if [[ -z "${TEST_POSTGRES_PORT}" || "${TEST_POSTGRES_PORT}" == "${PORT_MAPPING}" ]]; then
    echo "[real-pg] ERROR: Docker did not publish a random PostgreSQL port" >&2
    exit 1
  fi

  ready=0
  for _ in $(seq 1 60); do
    if docker exec "${CONTAINER_ID}" pg_isready \
      --username helmtest --dbname helm_api_lease_test >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "${ready}" != "1" ]]; then
    echo "[real-pg] ERROR: PostgreSQL container failed its health check within 60s" >&2
    docker logs "${CONTAINER_ID}" >&2 || true
    exit 1
  fi

  TEST_POSTGRES_URL="postgresql://helmtest:helmtest@127.0.0.1:${TEST_POSTGRES_PORT}/helm_api_lease_test"
  echo "[real-pg] hermetic PostgreSQL is ready"
fi

# Export both names so the Playwright suite and the dedicated no-skip Vitest
# contract use the same ephemeral database without logging credentials.
export PG_TEST_URL="${TEST_POSTGRES_URL}"
export HELM_TEST_POSTGRES_URL="${TEST_POSTGRES_URL}"

REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
pnpm --dir "$REPOSITORY_ROOT" exec vitest run \
  --config apps/gateway/e2e/vitest.real-postgres.config.ts

pnpm exec playwright test "$@"
