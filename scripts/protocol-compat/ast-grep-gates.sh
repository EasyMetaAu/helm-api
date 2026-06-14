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

require_rg() {
  local label="$1"
  local pattern="$2"
  shift 2
  if ! rg -n "$pattern" "$@" >/dev/null; then
    echo "missing expected structure: $label" >&2
    exit 1
  fi
}

require_no_match \
  "Responses transformer must not reject previous_response_id at inbound parse time" \
  --lang ts -p 'rejectUnsupportedPreviousResponseContinuation($ARG)' packages/core/src/protocol/responses.ts

require_no_match \
  "Responses lifecycle routes must not use the old unsupportedLifecycle stub" \
  --lang ts -p '$APP.$METHOD($PATH, unsupportedLifecycle($OP))' apps/gateway/src/routes/responses.ts

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

require_match \
  "Responses native previous_response_id passthrough must be positively recorded" \
  --lang ts -p '$MUTATIONS.responses_previous_response_id_native_passthrough = true' apps/gateway/src/routes/execute.ts

require_rg \
  "generic OpenAI Responses providers must be distinguished from Codex profile" \
  'nativeProtocolProfile: "generic_openai_responses"' packages/core/src/provider/openai-responses.ts

require_rg \
  "Gemini native providers must advertise the Gemini protocol profile" \
  'nativeProtocolProfile: "gemini"' packages/core/src/provider/gemini.ts

require_match \
  "Gemini route must branch countTokens before generation pipeline" \
  --lang ts -p 'if ($ROUTE.operation === "countTokens") { $$$ }' apps/gateway/src/routes/gemini.ts

require_rg \
  "Gemini provider must implement native countTokens" \
  'async countTokens' packages/core/src/provider/gemini.ts

require_rg \
  "Anthropic token counting must send the provider beta header" \
  'token-counting-2024-11-01' packages/core/src/provider/anthropic.ts

require_rg \
  "OpenAI Chat response_model_policy must be configurable" \
  'response_model_policy' packages/shared/src/config/schema.ts

require_match \
  "OpenAI Chat streaming response model restamping must be implemented" \
  --lang ts -p 'createOpenAIStreamModelRestamper($REQUESTED_MODEL)' apps/gateway/src/routes/chat.ts

require_match \
  "Gemini remote media materializer must be implemented outside the pure transformer" \
  --lang ts -p 'materializeGeminiRemoteMediaBody($BODY, $CONFIG, $FETCH, $SIGNAL)' packages/core/src/provider/gemini.ts

if rg -n 'from "node:http"|from "node:https"|fetch\(' packages/core/src/protocol/gemini >/tmp/helm-gemini-core-fetch.txt; then
  echo 'forbidden structure found: Gemini core transformer must stay network-I/O free' >&2
  cat /tmp/helm-gemini-core-fetch.txt >&2
  rm -f /tmp/helm-gemini-core-fetch.txt
  exit 1
fi
rm -f /tmp/helm-gemini-core-fetch.txt

if ! rg -n 'file_search' apps/gateway/src/routes/execute.test.ts >/tmp/helm-file-search-guard.txt; then
  echo 'missing expected structure: Responses file_search guard coverage' >&2
  rm -f /tmp/helm-file-search-guard.txt
  exit 1
fi
rm -f /tmp/helm-file-search-guard.txt

echo "protocol compatibility ast-grep gates passed"
