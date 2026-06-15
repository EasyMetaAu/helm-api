# 05 · Protocol Translation

The Protocol Adapter translates between client protocols and arbitrary upstream
provider protocols, so a client always sees one standard interface and output
shape. Open-source references and the coverage matrix are in
[Research Notes](research-notes.md). The implementation lives in
`packages/core/src/protocol/`.

## Wired protocols

Four client protocols are wired and routed:

| Endpoint | Protocol | Streaming |
|----------|----------|-----------|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Yes (SSE) and non-stream |
| `POST /v1/messages` | Anthropic Messages | Yes (SSE) and non-stream |
| `POST /v1/responses` | OpenAI Responses | Yes (SSE) and non-stream |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | Yes (SSE via `:streamGenerateContent`) and non-stream |

**OpenAI Responses** streaming returns a native Responses SSE stream of
`response.*` events terminated by a `response.completed` event. There is **no**
`[DONE]` sentinel; instead every event carries a strictly monotonic
`sequence_number` (the Responses wire contract). The `response.*` SSE machine is
`convertOpenAIStreamToResponses` in `packages/core/src/protocol/responses-stream.ts`;
see `apps/gateway/src/routes/responses.ts` for the route.

**Gemini** is mounted as a catch-all `POST /v1beta/models/:rest{.+}` (Hono can't
match the literal `:` in `{model}:generateContent` with a named param). The core
`parseGeminiPath` recognizes `:generateContent`, `:streamGenerateContent`, and
`:countTokens`; `:countTokens` is served (200) and returns a Gemini-shaped token
count — either a provider-native count or a deterministic local estimate
`{totalTokens, estimated:true}` — without routing through the generation pipeline.
Any other op (`:embedContent`, …) returns a `404` in the **Gemini error shape**,
never a generic gateway error. Auth is `x-goog-api-key` (the Gemini SDK default),
with `Authorization: Bearer` as a fallback. Streaming is selected by the
`:streamGenerateContent` operation name; `alt=sse` affects the Google wire format
but is **not required** by the gateway — the query parameter is ignored when
deciding stream vs. non-stream. Streaming emits nameless `data:` `GenerateContentResponse`
frames each carrying an **incremental** text delta (matching real Gemini — clients
accumulate `chunk.text`), with **no** `event:` name and **no** `[DONE]` sentinel;
the terminal frame carries the completed `functionCall` parts, `finishReason`, and
`usageMetadata`. The transformers live in `packages/core/src/protocol/gemini/`;
see `apps/gateway/src/routes/gemini.ts` for the route.

> **litellm parity.** All four faces are aligned to litellm's field coverage:
> the full sampling/control knob set, usage detail (reasoning / cache /
> per-modality), a unified reasoning bridge, full multimodal I/O, and both-ways
> `finish_reason` maps. The per-pair data-loss matrix and the parity scorecard
> live in [Protocol Compatibility](protocol-compatibility.md).

## Responsibilities

- Normalize each wired client request (OpenAI Chat / Anthropic Messages / OpenAI
  Responses / Google Gemini) into the unified internal representation (IR).
- Translate the provider's response back to the protocol the client requested.
- Preserve streaming semantics — mapping SSE events across protocols where
  streaming is supported.

## Design

The architecture is modeled on `musistudio/llms`, with `litellm` as the
correctness reference; the code is a clean reimplementation, not a copy.

- **The IR uses the OpenAI Chat shape as its hub**
  (`packages/core/src/protocol/ir.ts`), extended with thinking/reasoning blocks,
  typed multipart content (text / image / thinking / audio / video / document),
  the full litellm sampling/control knob set (`top_p`, `top_k`,
  `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `n`, `logprobs`,
  `top_logprobs`, `parallel_tool_calls`, `reasoning_effort`, `service_tier`, …),
  usage detail (`reasoning_tokens` / `cache_creation_tokens` / per-modality token
  details), tool-call IDs, cache-control, and a `provider_raw` passthrough bag
  that carries upstream-native fields (raw `stop_reason` / `usage` and
  provider-only echoes) that cannot be mapped losslessly. The IR is the single Zod
  type source for the whole protocol layer.
- **One transformer per protocol, a four-method contract** — two request/response
  pairs covering both directions: `transformRequestOut` / `transformRequestIn`
  (native ↔ IR request) and `transformResponseOut` / `transformResponseIn`
  (IR ↔ native response). All four faces stream, but the SSE machines are
  standalone per-direction conversion functions — `convertOpenAIStreamToAnthropic`,
  `convertOpenAIStreamToResponses`, the Gemini `transformStreamIn` /
  `transformStreamOut` pair — plus the `synthesizeSSE` synthesizer for synthetic
  streams. As transformer **methods**, only Gemini exposes both `transformStreamIn`
  and `transformStreamOut`; Anthropic exposes `transformStreamIn` only. Inbound and
  outbound translation live in the same file; see `protocol/transformer.ts`.
- **Reasoning crosses the IR through one bridge** (`protocol/reasoning.ts`):
  `{type:"thinking"}` content parts and the flat `message.reasoning_content` /
  `thinking_blocks` are kept in sync, so reasoning survives every cross-protocol
  hop (OpenAI ↔ Anthropic ↔ Responses ↔ Gemini), streaming and non-streaming.
  `reasoning_effort` maps to a per-protocol thinking-budget band
  (`anthropic/request.ts` `REASONING_EFFORT_TO_BUDGET` and
  `gemini/gemini-transformer.ts` `REASONING_EFFORT_BUDGET`) — Anthropic
  `{none:0, minimal:1024, low:1024, medium:2048, high:4096, xhigh:8192, max:16384}`
  (litellm parity; the previous low:2048/medium:8192/high:16384 over-budgeted 2–4×
  and were replaced to avoid billing/latency inflation), Gemini
  `{minimal:128, low:1024, medium:8192, high:24576}`.
- **Non-mappable knobs degrade observably, never silently**
  (`protocol/protocol-guards.ts`): guards fire **only for the Anthropic target** —
  `n>1` is capped to 1 (`n_capped`), and `logprobs` / `top_logprobs` / `modalities` /
  `frequency_penalty` / `presence_penalty` / `seed` are dropped with a `data_loss`
  warning (Anthropic Messages has no native surface for these sampling knobs). The
  `openai` and `gemini` targets are an
  intentional no-op: every guarded knob has a native home (Responses passes `n`
  through; Gemini maps `n` → `candidateCount`). Warnings ride
  `provider_raw.warnings` and are stripped before the wire — telemetry sees them,
  the upstream never does.
- **`provider_raw` never reaches the wire.** The IR-internal passthrough bag is
  stripped by every `transformRequestIn` / `transformResponseIn` before output;
  the no-leak invariant is enforced by the protocol matrix tests across every
  pair.
- **Translation always goes `nativeIn → IR → nativeOut`**, never N×N direct
  conversion (N protocols need 2N transform functions, not N²).
- **Streaming is an explicit state machine** (`protocol/streaming.ts` plus the
  per-direction machines, e.g. `protocol/anthropic/stream.ts`): a monotonic
  content-block index allocator, an OpenAI-tool-index → Anthropic-block-index map,
  a temp-id → real-id upgrade table, and idempotent close guards. The Anthropic SSE
  stream ends with a `message_stop` event; `synthesizeSSE` covers cache hits and
  non-streaming upstreams so a streaming client is none the wiser (synthesized
  OpenAI/Anthropic streams *do* append `[DONE]`).
- **Cross-cutting concerns are stackable behavior transformers** (e.g. IR-only
  clamps and normalizations such as Anthropic's `max_tokens` default of `4096`
  when omitted) that operate on the IR only.

## Footguns that are handled

These are the protocol-translation pits the implementation and its tests cover;
the full per-pair degradation matrix is in
[Protocol Compatibility](protocol-compatibility.md).

- **finish_reason / stop_reason enum mismatches** — mapped to a legal enum **and**
  the original value is kept in `provider_raw`.
- **Usage fields and cache billing** — `input = prompt − cached`; usage is
  buffered to the terminal stream event so a cache read is not double-counted.
- **Tool-call streaming index/ID reconciliation** — maintain the index→block map,
  upgrade a temporary id once the real id arrives on a later fragment, and
  tolerate fragmented/partial argument JSON.
- **Gemini tool-call IDs** — Gemini `functionCall` has no wire id, so a
  deterministic `call_<name>_<occurrence>` id is synthesized inbound (to pair the
  matching `functionResponse`) and dropped again outbound.
- **Stream block/part ID and role consistency** — `start` before `delta` before
  `stop`; the first OpenAI chunk carries `role: "assistant"`.
- **System prompt and multimodal structural mismatches** — Anthropic's top-level
  `system`, the ban on consecutive same-role messages, and image `image_url` vs
  `source: {base64}`.
- **Responses API item expansion** — the flat `input[]` item stream folds into the
  IR and explodes back out.
- **Idempotent stream close** — every `content_block_stop` and `message_stop` is
  emitted at most once, guarding against the "controller already closed" bug.
- **Reasoning shape mismatch** — Anthropic/Responses/Gemini express reasoning as a
  content block while OpenAI uses a flat `reasoning_content` field; the bridge
  populates and reads both, so reasoning is neither dropped nor leaked into visible
  text on any hop.

Errors are also translated into each client protocol's native shape (the OpenAI
error envelope for `/v1/chat/completions` and `/v1/responses`, the Anthropic error
envelope for `/v1/messages`, the Gemini error shape for `/v1beta/models/*`). See
[07 · Error Model & Observability](07-observability.md).
