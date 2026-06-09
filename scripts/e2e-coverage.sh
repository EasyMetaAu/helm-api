#!/usr/bin/env bash
# E2E code coverage for the 4 wire protocols (OpenAI Chat, Anthropic Messages,
# OpenAI Responses, Gemini). Runs the protocol + gemini Playwright specs against the
# BUILT gateway (dist) with V8 coverage, then remaps dist -> src via on-disk source
# maps with c8. Admin specs are intentionally excluded (API/protocol coverage only).
#
# Why built dist: under tsx the gateway src is transpiled in-memory with no on-disk
# source map, so c8 cannot remap it. The e2e test-server imports dist + flushes V8
# coverage periodically (Playwright SIGKILLs the webServer) only when NODE_V8_COVERAGE
# is set, so a normal `pnpm test:e2e` is completely unaffected.
#
# Usage: pnpm test:e2e:coverage   (text summary + table; lcov in .e2e-coverage/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COV_DIR="${E2E_COVERAGE_DIR:-$ROOT/.e2e-coverage}"
V8_DIR="$COV_DIR/v8"
rm -rf "$COV_DIR"
mkdir -p "$V8_DIR"

echo "==> Building gateway + deps (dist needs on-disk source maps for remapping)…"
pnpm --filter @helm/shared --filter @helm/core --filter @helm/gateway build

echo "==> Running 4-protocol E2E specs with V8 coverage…"
E2E_COVERAGE_DIR="$V8_DIR" \
  pnpm --filter @helm/gateway exec playwright test protocol.spec.ts gemini.spec.ts --project=gateway

echo "==> Generating coverage report (remap dist -> src)…"
pnpm exec c8 report \
  --temp-directory="$V8_DIR" \
  --report-dir="$COV_DIR" \
  --reporter=text-summary --reporter=text --reporter=lcov \
  --exclude-after-remap \
  --exclude='**/node_modules/**' \
  --exclude='**/*.test.ts' \
  --exclude='**/e2e/**' \
  --exclude='scripts/**' \
  --exclude='**/*.config.*' \
  --exclude='**/dist/**'

echo "==> lcov written to $COV_DIR/lcov.info"
