#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

require_match() {
  local label="$1"
  shift
  if ! ast-grep "$@" >/dev/null; then
    echo "missing expected structure: $label" >&2
    exit 1
  fi
}

require_no_match() {
  local label="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  if ast-grep "$@" >"$tmp"; then
    echo "forbidden structure found: $label" >&2
    cat "$tmp" >&2
    rm -f "$tmp"
    exit 1
  fi
  rm -f "$tmp"
}

require_no_match \
  "Responses route must not synthesize a duplicate stream prelude" \
  --lang ts -p 'responseStreamPrelude($$$)' apps/gateway/src/routes/responses.ts

require_match \
  "provider_raw forwarding must be target-protocol aware" \
  --lang ts -p 'renderProviderRawForTarget($RAW, $TARGET)' apps/gateway/src/routes/execute.ts

require_match \
  "Anthropic native passthrough must strip empty text blocks before dispatch" \
  --lang ts -p 'stripEmptyAnthropicTextBlocks($MESSAGES)' apps/gateway/src/routes/execute.ts

require_no_match \
  "provider_raw must not use a target-blind global forwarding loop" \
  --lang ts -p 'for (const $KEY of PROVIDER_RAW_FORWARD_KEYS) { $$$ }' apps/gateway/src/routes/execute.ts

if rg -n '"cache_control",' apps/gateway/src/routes/execute.ts >/tmp/helm-cache-control-forward.txt; then
  echo 'forbidden structure found: cache_control is unconditionally forwarded' >&2
  cat /tmp/helm-cache-control-forward.txt >&2
  rm -f /tmp/helm-cache-control-forward.txt
  exit 1
fi
rm -f /tmp/helm-cache-control-forward.txt

require_match \
  "top-level cache_control must be Anthropic-target-only" \
  --lang ts -p 'if ($TARGET === "anthropic_messages" && $REQ.cache_control !== undefined) { $$$ }' apps/gateway/src/routes/execute.ts

echo "protocol compatibility ast-grep gates passed"
