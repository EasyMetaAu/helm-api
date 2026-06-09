#!/usr/bin/env bash
# Full gateway E2E code coverage. Unlike scripts/e2e-coverage.sh (protocol-focused),
# this runs every Playwright project/spec against the BUILT gateway with V8 coverage
# enabled, then remaps dist -> src via on-disk source maps with c8.
#
# Coverage scope: gateway/server-side code exercised by Playwright. Browser-side
# admin JavaScript is still covered by Vitest/jsdom unit and component tests.
#
# Usage: pnpm test:e2e:coverage:full   (lcov in .e2e-coverage-full/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COV_DIR="${E2E_COVERAGE_DIR:-$ROOT/.e2e-coverage-full}"
V8_DIR="$COV_DIR/v8"
rm -rf "$COV_DIR"
mkdir -p "$V8_DIR"

echo "==> Building all workspaces (gateway dist + admin static assets)…"
pnpm build

echo "==> Running the full Playwright E2E suite with V8 coverage…"
E2E_COVERAGE_DIR="$V8_DIR" pnpm --filter @helm/gateway exec playwright test

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
