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

## The four inbound text protocols

Each translated text protocol is parsed by a named transformer
(`nativeIn`/`nativeOut`), and all four are streaming-capable:

| Protocol | Endpoint | Transformer | Auth header |
|---|---|---|---|
| OpenAI Chat | `POST /v1/chat/completions` | `openai` | `Authorization: Bearer` |
| Anthropic Messages | `POST /v1/messages` | `anthropic` | `x-api-key` or `Authorization: Bearer` |
| OpenAI Responses | `POST /v1/responses` | `openai-responses` | `Authorization: Bearer` |
| Google Gemini | `POST /v1beta/models/{model}:generateContent` (+ `:streamGenerateContent?alt=sse`) | `gemini` | `x-goog-api-key` |
| OpenAI Images | `POST /v1/images/generations` | (none — image model/lane chain, no text transformer) | `Authorization: Bearer` |
| Gemini Interactions | `POST /v1beta/interactions` | (none — image model/lane chain, translated to `generateContent`) | `x-goog-api-key` |

The Images and Interactions rows are **additional image-generation surfaces**, not
fifth/sixth inbound text protocols: neither has a `nativeIn`/`nativeOut`
transformer pair, so the **four inbound text-protocol** framing (and the 4×4
matrix) above covers only the translated text ones. Image requests name either an
exact image model or an image lane, skip text classification, and can fail over
inside the configured image chain. The Interactions request (`{model, input,
response_format}`) is translated internally to a Gemini `generateContent` call —
upstream speaks `generateContent`, not interactions — and the response is mapped
back to `{id, steps:[…]}`. The native `:generateContent` endpoint likewise now
serves image models (`gemini-3.1-flash-image`, `gemini-3-pro-image`) via
`capabilities.outputImage`, so `responseModalities` → `inlineData` survives.

Gemini is mounted as catch-alls under both `POST /v1beta/models/:rest{.+}` and
`POST /models/:rest{.+}`. `generateContent` / `streamGenerateContent` run the
full pipeline; `countTokens` returns a Gemini-shaped count (provider-native or a
deterministic local estimate, the latter flagged `estimated: true`); any other
operation returns 404 in the native Gemini error shape. The Gemini and Responses
faces authenticate **inside** the handler so they can emit their own native error
envelopes.

---

## How degradation works

There are exactly two ways a value can fail to reach a target, and both are
**observable** — Helm never silently drops data:

1. **`n_capped` (reject-clean cap).** A backend that emits a single candidate
   caps `n > 1` to `1` and records an `n_capped` warning. The request still runs;
   it just returns one choice.
2. **`data_loss` (no native surface).** A parameter the target has no place for
   (e.g. token `logprobs` → Anthropic) records a `data_loss` warning and is
   dropped from the wire request.

Both warning kinds are appended to `provider_raw.warnings` on the IR and read off
by the DecisionRecord and telemetry; they never reach the wire. A third,
non-degrading mechanism is **`provider_raw` passthrough** (the lossless bag,
[below](#provider_raw-passthrough-the-lossless-bag)). See
`packages/core/src/protocol/protocol-guards.ts`.

The guard table is target-specific. The `n_capped` cap and the
`logprobs`/`top_logprobs`/`modalities` `data_loss` warnings fire **only for the
Anthropic target**; the `openai` and `gemini` targets are intentionally no-ops in
`TARGET_GUARDS`. Responses passes `n` through, and Gemini maps `n` →
`candidateCount`, so neither caps.

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

Legend: **cap** = `n>1` capped to 1 with an `n_capped` warning (Anthropic target
only); **drop** = dropped with a `data_loss` warning (Anthropic target only);
**raw** = preserved in `provider_raw` (recoverable, not on the target wire);
**degrade** = mapped to the nearest native shape.

| source ↓ \ target → | OpenAI Chat | Anthropic Messages | OpenAI Responses | Gemini |
|---|---|---|---|---|
| **OpenAI Chat** | lossless (identity) | `n>1`→**cap**; `logprobs`/`top_logprobs`→**drop**; `modalities`→**drop** (text-out only); audio/video input→routing-gated | reasoning ↔ reasoning summary; sampling knobs map | `logprobs`→`responseLogprobs`; reasoning_effort→`thinkingConfig`; remote http(s) image→**degrade** to text placeholder |
| **Anthropic Messages** | thinking→`reasoning_content`; `cache_creation`/`thinking_tokens`→usage detail; `stop_details`→**raw** | lossless (identity) | thinking→reasoning summary; cache usage maps | thinking→thought parts; document input maps to `inlineData`/`fileData` |
| **OpenAI Responses** | reasoning summary→`reasoning_content`; `store`/`previous_response_id`→**raw** (stateless) | `n>1`→**cap**; `logprobs`→**drop**; reasoning summary→thinking | lossless (identity) | reasoning→`thinkingConfig`; sampling knobs map |
| **Gemini** | `groundingMetadata`→`annotations`; `logprobsResult`→`logprobs`; `safetyRatings`→**raw** | `n>1`→**cap**; `safetyRatings`→**raw**; thought→thinking | grounding→annotations; thought→reasoning summary | lossless (identity) |

Notes (only what the table can't show):

- **`n > 1` is capped on the Anthropic target only.** Anthropic returns a single
  message, so `n` is clamped to 1 with an `n_capped` warning. The other three
  targets honor multiple candidates: OpenAI Chat and Responses pass `n` through,
  Gemini maps it to `candidateCount`.
- **Remote `http(s)` images → Gemini output.** Gemini's request shape wants
  inline base64 or a `gs://` / Files-API URI. By default an arbitrary remote
  image URL degrades to an explicit text placeholder — the pure core transformer
  does no network I/O. An optional, default-off provider-layer media materializer
  (`materializeGeminiRemoteMediaBody`, config-gated by `remoteMediaFetch` and
  SSRF-guarded via `assertPublicHttpsTarget`) can fetch the `https` image into
  `inlineData` when enabled. Inline base64 images round-trip cleanly.
- **Responses statefulness → others.** `store` / `previous_response_id` describe
  a server-side conversation that other protocols don't model; they ride
  `provider_raw` so a Responses→Responses round-trip is lossless, but they are
  not replayed as real session continuation on a different backend.

---

## Streaming shape

Each face emits its native SSE framing; standalone per-direction converters
(e.g. `convertOpenAIStreamToAnthropic`, `convertOpenAIStreamToResponses`, and
Gemini's `transformStreamIn` / `transformStreamOut`) bridge the IR delta stream.
Of the four transformers only Gemini exposes **both** `transformStreamIn` and
`transformStreamOut`; Anthropic exposes `transformStreamIn` only.

- **OpenAI Chat:** classic `data:` chunks terminated by a `[DONE]` sentinel.
- **OpenAI Responses:** **no `[DONE]` sentinel** — every event instead carries a
  strictly monotonic `sequence_number`; the client reads completion from the
  typed terminal event.
- **Anthropic Messages:** event-typed SSE ending with `message_stop`.
- **Gemini:** delta-based both inbound and outbound.
- **Synthesized streams** (a non-streaming upstream replayed as SSE via
  `synthesizeSSE`) follow the target's own framing — the OpenAI/Anthropic
  synthetic streams **do** append `[DONE]`.

---

## Tool / function calling

- **Anthropic** tool names are sanitized to `^[A-Za-z0-9_]+` — letters, digits,
  and underscore only (hyphens and other characters become `_`) — with a max
  length of 64; collisions are disambiguated with an FNV-1a hash suffix so
  distinct source names stay distinct after sanitization.
- **Gemini** tool calls have **no wire id**. Inbound, Helm synthesizes a
  deterministic `call_<name>_<occurrence>` id; outbound, that synthetic id is
  dropped (Gemini never sees it).
- `parallel_tool_calls` maps both ways where the target supports it.

---

## Reasoning budget mapping

`reasoning_effort` (`minimal|low|medium|high`) maps to each backend's native
thinking knob. The band values differ per target:

| effort | Anthropic (thinking budget) | Gemini (`thinkingConfig`) |
|---|---|---|
| minimal | 1024 | 128 |
| low | 1024 | 1024 |
| medium | 2048 | 8192 |
| high | 4096 | 24576 |

The Anthropic column is exact litellm parity (`minimal`/`low` both floor at 1024,
`medium` 2048, `high` 4096); the extended tiers `xhigh` → 8192 and `max` → 16384
continue above the four standard bands.

Anthropic Messages also defaults `max_tokens` to **4096** when the client omits
it (the field is required upstream but optional on the Helm face).

---

## Cross-cutting field coverage (translated text protocols)

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
target's wire — every transformer strips `provider_raw` before serialization
(the matrix tests assert this no-leak invariant on all 16 paths).

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

## Remaining gaps

Field coverage is asserted path-by-path against the litellm reference in
`protocol-matrix.test.ts`. The remaining gaps are provider-specific edges —
litellm's Vertex-only fields and true Responses session continuation — each a
documented non-goal above, not a silent loss. Remote-image fetch on the Gemini
output path is no longer unconditional: it degrades to a text placeholder by
default but can be materialized into `inlineData` by the optional, default-off
provider-layer `remoteMediaFetch` materializer (SSRF-guarded).
