# LiteLLM Protocol Gap Spec

Status: source-checked current status and remaining backlog.

This document used to be the implementation backlog for closing Helm's protocol
compatibility gaps against LiteLLM-style behavior. Most P1/P2 items have since
landed. Keep this file as a compact status map; the detailed behavior contract now
lives in:

- [05 · Protocol Translation](05-protocol-translation.md)
- [Protocol Compatibility & Data-Loss Matrix](protocol-compatibility.md)
- [Native Passthrough Fidelity Spec](native-passthrough-fidelity-spec.md)

Primary source files:

- `apps/gateway/src/routes/chat.ts`
- `apps/gateway/src/routes/messages.ts`
- `apps/gateway/src/routes/responses.ts`
- `apps/gateway/src/routes/gemini.ts`
- `apps/gateway/src/routes/execute.ts`
- `packages/core/src/protocol/`
- `packages/core/src/provider/anthropic.ts`
- `packages/core/src/provider/openai-responses.ts`
- `packages/core/src/provider/gemini.ts`
- `scripts/protocol-compat/ast-grep-gates.sh`

## Scope

The comparison covers the four translated text protocol faces:

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses
- Google Gemini GenerateContent

Image generation is handled separately through the OpenAI Images route, Gemini
image models on `generateContent`, and Gemini Interactions. Those surfaces do not
participate in the text IR matrix.

## Principles

1. Client protocol fields should be preserved when the target protocol can safely
   represent them.
2. Auth, rate limits, budgets, concurrency, routing, fallback, telemetry, payload
   capture, and memory must never be bypassed for compatibility.
3. Same-protocol native passthrough is preferred over lossy translation when the
   selected provider supports it.
4. Cross-protocol loss must be explicit: structured rejection or a recorded
   warning, not silent field loss.
5. `provider_raw` is target-aware. Provider-specific fields can only be forwarded
   to compatible native targets.
6. Core protocol transformers stay pure. Network work such as remote media
   fetching and provider token counting belongs in gateway/provider code.
7. Internal telemetry, mutation ledgers, and provider credentials are never
   exposed in public response bodies.

## Current Status Matrix

| Area | Current source-backed status |
|---|---|
| OpenAI Chat content normalization | The route uses `openaiTransformer.transformRequestOut()` as the normalizer, so multimodal content such as bare-string `image_url` is normalized before execution. |
| OpenAI-compatible `cache_control` cleanup | `execute.ts` strips nested `cache_control` from OpenAI-compatible target bodies and records the mutation. Top-level `cache_control` is Anthropic-target-only. |
| Target-aware `provider_raw` | `renderProviderRawForTarget()` filters provider-specific raw fields by target protocol. The AST gate forbids the old target-blind forwarding loop. |
| Anthropic empty text blocks | Anthropic native dispatch strips empty text blocks before upstream dispatch. |
| Anthropic public responses | Public Anthropic response bodies do not expose internal `provider_raw`; raw details stay in IR/telemetry. |
| Anthropic beta/count tokens | Anthropic provider code includes token-counting support and provider beta handling. |
| Responses `previous_response_id` | The inbound transformer preserves `previous_response_id`; cross-protocol gaps are guarded later, while native passthrough can forward it. |
| Responses lifecycle routes | The old `unsupportedLifecycle` stub is gone. Routes support registry-backed lifecycle dispatch where available and local/provider `input_tokens` behavior. |
| Responses streaming prelude | The route no longer synthesizes a duplicate prelude; stream state belongs to the converter or native upstream stream. |
| Responses provider profiles | Generic OpenAI Responses and Codex/ChatGPT Responses are separate provider profiles. Codex-only defaults do not apply to generic OpenAI Responses. |
| Responses MCP/file_search tools | Cross-protocol behavior is guarded; same-protocol native passthrough can preserve supported raw tools. |
| Gemini countTokens | Gemini route branches `countTokens` before generation, under both `/v1beta/models/*` and `/models/*`; provider count is preferred, local estimate is fallback. |
| Gemini native provider | `packages/core/src/provider/gemini.ts` advertises `nativeProtocolProfile: "gemini"` and implements native generation, streaming, and token counting. |
| Gemini schema fidelity | Gemini tool schemas and response JSON schema fields are represented in protocol tests and transformer behavior. |
| Gemini remote media | Remote media materialization is provider-layer and config-gated by `remoteMediaFetch`, with SSRF guards. Core Gemini protocol code performs no network fetch. |
| OpenAI Chat response model policy | `response_model_policy` is configurable, and streaming model restamping exists when that compatibility mode is enabled. |
| Protocol gates | `pnpm test:protocol-compat:ast` enforces the structural guarantees above. |

## Remaining Gaps and Non-Goals

### P3 — Anthropic thinking-signature recovery

LiteLLM has provider-error recovery for a specific invalid-thinking-signature
failure: strip invalid thinking blocks and retry once. Helm does not currently
generalize that retry. If production telemetry proves this is needed, implement a
single targeted retry in the Anthropic provider executor and record a mutation
such as `thinking_signature_retry_stripped:true`.

Constraints:

- Match only the explicit Anthropic invalid-thinking-signature error.
- Retry at most once.
- Never strip thinking generically.
- Record the retry in telemetry/mutation metadata.

### P3 — Responses WebSocket

LiteLLM exposes Responses WebSocket behavior. Helm does not. Keep this a non-goal
unless a real SDK/client integration requires it. The current supported surface is
HTTP plus SSE streaming.

### Explicit Non-Goals

- Do not copy all provider-specific LiteLLM behavior into core transformers.
- Do not fetch remote media inside `packages/core/src/protocol`.
- Do not fake Responses retrieve/delete/cancel success without a registry/provider
  path.
- Do not bypass Helm governance for compatibility.
- Do not expose `provider_raw`, mutation ledgers, or telemetry-only fields in
  client-visible protocol responses.
- Do not restamp OpenAI Chat response `model` by default; use
  `response_model_policy` when a client needs that compatibility behavior.

## Verification

Run the structural protocol compatibility gate:

```bash
pnpm test:protocol-compat:ast
```

For native passthrough behavior:

```bash
pnpm test:passthrough
```

For release-level passthrough confidence, run the live CLI suite when real local
credentials and CLI binaries are available:

```bash
pnpm test:passthrough:final
```

The deterministic suites should remain credential-free. Live suites are
intentionally fail-closed and must not be replaced by dry-run output for merge or
release acceptance.
