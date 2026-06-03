# Protocol Compatibility & Data-Loss Matrix

Helm translates every client protocol through one central, OpenAI-Chat-shaped
**IR** (`packages/core/src/protocol/ir.ts`): `nativeIn → IR → nativeOut`, never
N×N. This page documents, per source→target pair, **what survives the round-trip
losslessly, what degrades (and how), and what is preserved out-of-band** in the
IR `provider_raw` bag. It is the companion reference to
[05 · Protocol Translation](05-protocol-translation.md).

litellm (MIT, BerriAI/litellm) is the field-coverage reference. The matrix in
`packages/core/src/protocol/protocol-matrix.test.ts` generates all 4×4 = 16
round-trip paths and asserts each one's preservation or its **documented**
degradation, so this page and the tests stay in lock-step.

---

## How degradation works

There are exactly two ways a value can fail to reach a target, and both are
**observable** — Helm never silently drops data:

1. **`n_capped` (reject-clean cap).** A backend that emits a single candidate
   caps `n > 1` to `1` and records an `n_capped` warning. The request still runs;
   it just returns one choice. Multi-candidate backends (OpenAI Chat, Gemini's
   `candidateCount`) honor `n` natively, so no cap fires.
2. **`data_loss` (no native surface).** A parameter the target has no place for
   (e.g. token `logprobs` → Anthropic) records a `data_loss` warning and is
   dropped from the wire request.

Both warning kinds are appended to `provider_raw.warnings` on the IR. **They
never reach the wire** — every transformer strips `provider_raw` before
serialization — but the DecisionRecord and telemetry can read them off the IR.
See `packages/core/src/protocol/protocol-guards.ts`.

A third, non-degrading mechanism is **`provider_raw` passthrough**: upstream
data with no IR home (raw `stop_reason`, raw `usage`, provider-only echo fields)
is preserved verbatim so a *same-protocol* round-trip is lossless and billing can
reconstruct the original. The full list is in
[the passthrough section](#provider_raw-passthrough-the-lossless-bag) below.

---

## Capability-gated input modalities

Beyond the protocol translation itself, **routing** is modality-aware. A request
carrying audio, video, or a document is only routed to a backend that advertises
that modality in `capabilities.yaml` (`modalities: [audio|video|document]`);
otherwise the candidate is skipped with an explicit
`no_audio_support` / `no_video_support` / `no_document_support` reason (text and
image are gated separately — image by `supportsVision`). This is a *routing*
gate, not a translation loss: the request lands on a backend that can actually
accept the modality, or fails over per the normal fallback chain.

Built-in advertisements: **Gemini** = `audio, video, document`; **Claude** =
`document`. See `packages/core/src/capability/filter.ts`.

---

## The data-loss matrix

Rows are the **source** protocol (what the client sent); columns are the
**target** backend protocol. Each cell lists only what is *not* a clean
round-trip. "lossless" means every IR-modeled field maps both ways.

Legend: **cap** = `n>1` capped to 1; **drop** = dropped with a `data_loss`
warning; **raw** = preserved in `provider_raw` (recoverable, not on the target
wire); **degrade** = mapped to the nearest native shape.

| source ↓ \ target → | OpenAI Chat | Anthropic Messages | OpenAI Responses | Gemini |
|---|---|---|---|---|
| **OpenAI Chat** | lossless (identity) | `n>1`→**cap**; `logprobs`/`top_logprobs`→**drop**; `modalities`→**drop** (text-out only); audio/video input→routing-gated | reasoning ↔ reasoning summary; sampling knobs map | `logprobs`→`responseLogprobs`; reasoning_effort→`thinkingConfig`; remote http(s) image→**degrade** to text placeholder |
| **Anthropic Messages** | thinking→`reasoning_content`; `cache_creation`/`thinking_tokens`→usage detail; `stop_details`→**raw** | lossless (identity) | thinking→reasoning summary; cache usage maps | thinking→thought parts; document input maps to `inlineData`/`fileData` |
| **OpenAI Responses** | reasoning summary→`reasoning_content`; `store`/`previous_response_id`→**raw** (stateless) | `n>1`→**cap**; `logprobs`→**drop**; reasoning summary→thinking | lossless (identity) | reasoning→`thinkingConfig`; sampling knobs map |
| **Gemini** | `groundingMetadata`→`annotations`; `logprobsResult`→`logprobs`; `safetyRatings`→**raw** | `n>1`→**cap**; `safetyRatings`→**raw**; thought→thinking | grounding→annotations; thought→reasoning summary | lossless (identity) |

Notes on the recurring degradations:

- **`logprobs` → Anthropic.** Anthropic Messages exposes no token logprobs, so
  `logprobs`/`top_logprobs` are dropped with a `data_loss` warning.
- **`modalities` → Anthropic.** Anthropic Messages is text-out only; an output
  `modalities` request is dropped with a warning. (Document/image *input* is
  supported and maps.)
- **`n > 1` → Anthropic.** Anthropic returns a single message; `n` is capped to 1
  with an `n_capped` warning. OpenAI Responses also single-candidate on this axis.
- **Remote `http(s)` images → Gemini output.** Gemini's request shape wants
  inline base64 or a `gs://` / Files-API URI; an arbitrary remote image URL
  degrades to an explicit text placeholder (issue #49 non-goal). Inline base64
  images round-trip cleanly.
- **Responses statefulness → others.** `store` / `previous_response_id` describe
  a server-side conversation that other protocols don't model; they ride
  `provider_raw` so a Responses→Responses round-trip is lossless, but they are
  not replayed as real session continuation on a different backend.

---

## Cross-cutting field coverage (all four protocols)

These IR fields map **both ways** on every protocol that has a native surface for
them; where a protocol lacks one, the cell above shows the degradation.

- **Sampling / control:** `temperature`, `top_p`, `top_k`, `frequency_penalty`,
  `presence_penalty`, `seed`, `stop`, `n`, `logprobs`, `top_logprobs`,
  `parallel_tool_calls`, `stream_options.include_usage`, `reasoning_effort`,
  `user`, `service_tier`.
- **Reasoning / thinking:** a single bridge keeps `{type:"thinking"}` content
  parts and the flat `message.reasoning_content` / `thinking_blocks` in sync, so
  reasoning survives OpenAI ↔ Anthropic ↔ Responses ↔ Gemini in both directions
  (non-streaming and streaming).
- **Usage detail:** `reasoning_tokens`, `cache_creation_tokens`,
  `prompt_tokens_details`, `completion_tokens_details` (per-modality on Gemini).
  Cache reads are never double-counted: `input = prompt − cached`.
- **Multimodal I/O:** typed `image` / `audio` / `video` / `document` content
  parts. Each protocol maps to/from its native shape (OpenAI `image_url` /
  `input_audio` / `file`; Anthropic image / document blocks; Gemini `inlineData`
  by MIME + `fileData` + `videoMetadata`).
- **`finish_reason`:** stays a free string in the IR; each protocol completes the
  enum map **both ways**, and the raw value is always kept in
  `provider_raw.stop_reason`.

---

## `provider_raw` passthrough: the lossless bag

Upstream data with no IR home is carried verbatim in `provider_raw` and
re-emitted on a same-protocol round-trip. It is **never** sent to a *different*
target's wire (transformers strip `provider_raw` before serialization).

| Source | `provider_raw` keys |
|---|---|
| **All** | `stop_reason` (raw finish_reason), `usage` (raw upstream usage) |
| **OpenAI Chat** | `system_fingerprint` |
| **Anthropic** | `stop_details` (Sonnet 4+), request `metadata`, per-message thinking blocks |
| **OpenAI Responses** | response `reasoning` / `text` / `tool_choice` echo; request `store` / `previous_response_id` / `metadata` / `logit_bias`; legacy `function_call` (mapped to tool calls) |
| **Gemini** | `safety_ratings`, `prompt_feedback` (request-side `safetySettings` / `thinkingConfig` pass through to the wire) |
| **Guards** | `warnings` (`n_capped` / `data_loss`) |

**Out of scope here:** litellm's Vertex-only knobs (`labels`, `inference_geo`,
`container`) are not wired into Helm's Gemini face today — Gemini passes through
`safetySettings` / `thinkingConfig` instead. The `anthropic-beta` header is a
provider-execution (OAuth) concern, not protocol-translation `provider_raw`.

---

## Parity scorecard

Approximate litellm field-coverage per protocol, before → after the parity
upgrade (Phases 2–8):

| Protocol | Before | After |
|---|---|---|
| OpenAI Chat | 72 | 95 |
| Anthropic Messages | 62 | 90 |
| OpenAI Responses | 72 | 90 |
| Gemini | 55–60 | 88 |

The remaining gap is mostly provider-specific edges (Vertex-only fields, true
Responses session continuation, remote-image fetch on the Gemini output path) —
each one a documented non-goal above, not a silent loss.
