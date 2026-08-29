# 05 · Protocol Translation

Status: current implementation contract, source-checked on 2026-07-16.

Helm accepts several client wire protocols, routes them through one governance and
fallback pipeline, and returns the response in the protocol used by the client.
The implementation is split between framework-free protocol code in
`packages/core/src/protocol/` and HTTP/WebSocket adapters in
`apps/gateway/src/routes/`.

This document describes the shipping routes. Generated OpenAPI output and the
`/docs` page are useful references, but they are not a complete route inventory:
compatibility aliases, helper routes, and the Responses WebSocket upgrade are
registered outside that inventory.

## Execution paths

Every text request follows one of two provider-attempt paths.

### Translated path

1. The route authenticates the Helm key and applies rate, concurrency, budget,
   memory-scope, and request-limit controls.
2. A protocol transformer validates the client body and normalizes modeled fields
   into the OpenAI-Chat-shaped IR in `packages/core/src/protocol/ir.ts`.
3. The shared classifier, lane resolver, capability filter, fallback executor,
   circuit breaker, telemetry, and payload-capture pipeline runs.
4. The selected provider receives its own wire shape.
5. The provider result is converted back into the client protocol.

Translation is hub-based: `native -> IR -> target`. Helm does not maintain a
separate converter for every source/target pair.

### Native-passthrough path

The route still parses enough of the request to run governance and routing, but
also attaches the original native body and headers as a carrier. On an eligible
same-protocol provider attempt, the executor sends that carrier without the
cross-protocol IR re-render and returns the native provider result.

Native passthrough is available for Anthropic Messages, OpenAI Responses
(Codex and generic profiles), and Gemini. It is per attempt: a same-protocol head
candidate can use passthrough even when a later fallback uses another protocol.
The path is best-effort fidelity, not a blind proxy or an unconditional
byte-identity promise. Model selection, memory, credential replacement,
provider-profile repair, reasoning policy, optional media processing, and stream
reframing can still mutate the request. See
[Native Passthrough Fidelity](native-passthrough-fidelity-spec.md).

OpenAI Chat is the IR's lingua franca, so it does not use the separate native
carrier path. Its translated identity covers fields modeled by the IR; arbitrary
unknown top-level request fields are not guaranteed to survive schema parsing.

## Authoritative public route inventory

### Text and compatibility routes

| Client surface | Routes | Transport |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions`, `POST /chat/completions`, `POST /engines/{model}/chat/completions`, `POST /openai/deployments/{model}/chat/completions` | JSON or SSE |
| Anthropic Messages | `POST /v1/messages` | JSON or Anthropic SSE |
| Anthropic token count | `POST /v1/messages/count_tokens` | JSON |
| Anthropic CLI event acknowledgement | `POST /api/event_logging/batch` | JSON |
| OpenAI Responses | `POST /v1/responses`, `POST /responses`, `POST /openai/v1/responses` | JSON, Responses SSE, or WebSocket upgrade |
| OpenAI Realtime V1/V2 | `POST /v1/realtime/calls`, then `/v1/realtime?call_id=...` | WebRTC SDP + WebSocket sideband |
| OpenAI Realtime V3 | `POST /v1/live`, then `/v1/live/{call_id}` | WebRTC SDP + Frameless WebSocket sideband |
| Gemini GenerateContent | `POST /v1beta/models/{model}:generateContent` and `POST /models/{model}:generateContent` | JSON |
| Gemini StreamGenerateContent | the same two prefixes with `:streamGenerateContent` | Gemini SSE |
| Gemini token count | the same two prefixes with `:countTokens` | JSON |

The Azure-style Chat routes take the model from the path and use it as the
request model. The normal Chat routes take `model` from the body.

### Responses lifecycle and helper routes

Each Responses prefix—`/v1/responses`, `/responses`, and
`/openai/v1/responses`—also registers:

| Method and suffix | Current behavior |
|---|---|
| `POST /compact` | Resolves an allowed Codex model, applies rate/concurrency/budget controls, calls the Codex compact provider method, and records telemetry. Fails closed when unavailable. |
| `POST /input_tokens` | Uses a provider method when available; otherwise returns a deterministic local estimate with `estimated: true`. |
| `GET /{response_id}` | Retrieves through the provider that created the registered response when that provider supports retrieval. |
| `DELETE /{response_id}` | Deletes through the registered provider when supported. |
| `POST /{response_id}/cancel` | Cancels through the registered provider when supported. |
| `GET /{response_id}/input_items` | Reads input items through the registered provider when supported. |

Created response IDs are stored in a best-effort registry scoped to the calling
account and key. Entries expire after 24 hours and remember the provider that
created the response. Lifecycle calls return not-found for an unknown,
expired, deleted, or differently owned ID, and return a capability error when
the responsible provider lacks the requested method. Helm does not fabricate
successful lifecycle results.

### Image-generation routes

Image generation is routed separately from the four-protocol text IR:

| Route | Client shape | Provider behavior |
|---|---|---|
| `POST /v1/images/generations` | OpenAI Images | Uses an image model or homogeneous image lane; Gemini image providers are adapted to/from `generateContent`. |
| `POST /v1/images/edits` | OpenAI Images | Accepts Codex JSON `images[].image_url` and OpenAI multipart `image`/`mask`; edit-capable OpenAI targets use the existing image fallback chain. |
| `POST /v1beta/interactions` | Gemini Interactions | Converts `{model,input,response_format}` to Gemini `generateContent` and maps generated text/images to `steps[].content[]`. |
| Gemini `:generateContent` with an output-image model | Native Gemini | Uses native Gemini generation, including `responseModalities` and returned `inlineData`. |

Image model/lane requests skip text classification. The image chain uses the
normal breaker and fallback categories: breaker-open candidates are skipped;
network, timeout, and eligible upstream failures can advance; client errors and
client aborts are terminal. A lane must not mix OpenAI-Images and Gemini member
kinds because their verbatim parameter surfaces differ.

When a connected ChatGPT OAuth account's live Codex catalog explicitly exposes
the non-Lite `gpt-5.4-mini` controller with the `image_generation` tool, Helm also
publishes `openai-codex/gpt-image-2` through the `chatgpt-image` lane. Generation
and editing keep the public Images routes above; the provider adapter converts
both operations to one Responses tool call (`action: generate|edit`) and maps the
completed base64 result back to `data[].b64_json`. This paid POST is sent once:
transport errors, overload responses, and 401s are not replayed or moved to a
sibling OAuth account.

## Protocol behavior

### OpenAI Chat Completions

Authentication uses `Authorization: Bearer <helm-key>`.

The inbound normalizer handles standard Chat messages, tools, structured output,
sampling controls, reasoning fields, and modeled multimodal parts such as
`image_url`, `input_audio`, and `file`. It preserves multiple response
`choices[]`. OpenAI-style streaming emits `data:` frames and ends with
`data: [DONE]`.

This is modeled identity, not arbitrary transparent forwarding. The request is
validated and narrowed through the IR schema, and target/provider policy can
rewrite fields such as the resolved model or reasoning effort.

### Anthropic Messages

Authentication accepts `x-api-key` first and Bearer auth as a fallback. Missing
or invalid credentials, request validation failures, rate limits, and provider
errors use the Anthropic error envelope.

The main route supports non-streaming Messages and typed Anthropic SSE ending in
`message_stop`. There is no OpenAI `[DONE]` sentinel on the Anthropic wire,
including synthesized Anthropic streams.

The transformer maps:

- top-level `system` and `messages[]` to IR roles;
- text, image, document, thinking, redacted-thinking, tool-use, and tool-result
  blocks;
- cache-read, cache-creation, thinking-token, service-tier, and inference-geo
  usage where modeled;
- Anthropic stop reasons to legal client-target finish reasons while retaining
  the raw value internally.

When a translated request targets Anthropic, tool names are normalized to the
implemented 64-character alphanumeric/underscore form and collisions receive a
stable suffix. Native Anthropic passthrough intentionally leaves client tool
names native.

Anthropic requires an output limit; the translated renderer supplies
`max_tokens: 4096` when the client/IR does not provide one.

`POST /v1/messages/count_tokens` validates a native Messages-shaped request,
prefers a provider counter, and falls back to
`{input_tokens, estimated: true}`. `POST /api/event_logging/batch` is an
authenticated compatibility acknowledgement and currently returns
`{status: "ok"}`; it is not the gateway telemetry ingestion API.

### OpenAI Responses over HTTP/SSE

Authentication uses Bearer auth and errors use the OpenAI envelope before the
stream starts.

The request transformer folds native Responses input into the IR:

- `instructions` and message input items;
- `function_call` / `function_call_output` and custom-tool counterparts;
- `input_text`, `input_image`, `input_audio`, and `input_file` parts;
- reasoning items and `reasoning.effort`;
- `text.format` structured output, canonicalized to the shared response-format
  shape;
- Responses-only state and controls retained in internal `provider_raw`.

Known function tools translate cross-protocol. Native-only tools (for example
MCP/file-search-like tool objects), native/unknown input items,
`background: true`, and every `previous_response_id` continuation cannot be
safely reconstructed on a non-Responses backend. The executor skips such
cross-protocol candidates with an explicit reason instead of silently dropping
the state. A continuation is also pinned to the provider alias recorded for the
referenced response; same-provider Responses passthrough remains eligible.

Translated non-stream output expands one IR choice into Responses `output[]`
message, reasoning, and function-call items. It renders citations on
`output_text.annotations` and maps cache-read, cache-creation, and reasoning
usage into Responses totals/details. It does not preserve every provider
modality-detail field.

Responses SSE has named `response.*` events, no `[DONE]` sentinel, and monotonic
`sequence_number` values on synthesized translated events. A stream can end with
`response.completed` or `response.incomplete` on the translated path. Native
Responses streams can also carry `response.failed` or `response.cancelled`;
gateway stream failures use an `error` event.

If a native Responses stream ends without reported terminal usage, Helm computes
a bounded partial estimate for telemetry, budgets, and cost settlement. It is
marked `measurement: "estimated_partial"` and is not injected as fabricated wire
usage.

### OpenAI Responses over WebSocket

WebSocket upgrades are supported on exactly:

- `/v1/responses`
- `/responses`
- `/openai/v1/responses`

The bridge validates the upgrade through the authenticated `/v1/models` route
and returns selected model/reasoning metadata as upgrade headers. The client may
send sequential JSON messages of the form:

```json
{"type":"response.create","model":"...","input":"..."}
```

The bridge removes `type`, forces `stream: true`, and submits each message
serially through the normal Responses HTTP/SSE handler. Auth, rate limits,
concurrency, routing, fallback, budgets, memory, telemetry, and payload capture
therefore still run. SSE event payloads are sent back as WebSocket text messages.

For a Codex subscription attempt, Helm can reuse one upstream Codex WebSocket for
the ingress session. Connection-upgrade failures and exhausted upstream
WebSocket-connection-limit retries can pin that session to HTTP/SSE fallback.
Closing the client socket closes the upstream session.

Current limitation: the WebSocket bridge and Codex WebSocket parser classify
`response.completed`, `response.failed`, `response.incomplete`, and `error`
as terminal, but do not yet classify `response.cancelled` as terminal. A
cancelled event can be forwarded and then followed by a bridge error when the
stream closes. This is tracked as an implementation gap, not promised behavior.

### Gemini GenerateContent

Both `/v1beta/models/*` and `/models/*` are mounted. The pure
`parseGeminiPath` function recognizes `generateContent`,
`streamGenerateContent`, and `countTokens`. Other operations such as
`embedContent` return 404 in the Gemini error shape.

Authentication prefers `x-goog-api-key` and accepts Bearer auth as a fallback.
The operation name selects streaming; `alt=sse` is not required and is not used
to decide whether the gateway streams.

The transformer maps Gemini contents, `systemInstruction`, function declarations
and calls, structured JSON output, `inlineData` / `fileData` media, thought
parts, grounding/citations, finish reasons, and usage into the IR. Gemini
function calls have no wire call ID, so Helm synthesizes a deterministic ID in
the IR and drops it when rendering Gemini again.

Gemini streaming emits nameless `data:` frames with incremental deltas, no
`event:` field, and no `[DONE]` sentinel. The terminal frame carries native
finish and usage data.

`countTokens` runs outside the generation pipeline after auth/rate/concurrency
checks. It prefers a provider count and otherwise returns a deterministic
`{totalTokens, estimated: true}` value.

## Transformer contract

Each protocol transformer exposes the applicable parts of the shared contract:

- `transformRequestOut`: client-native request to IR;
- `transformRequestIn`: IR request to provider-native request;
- `transformResponseIn`: provider-native response to IR;
- `transformResponseOut`: IR response to the client-native response.

Streaming uses explicit state machines rather than treating arbitrary provider
chunks as interchangeable. The major converters are:

- OpenAI Chat SSE parsing/serialization;
- `convertOpenAIStreamToAnthropic` and Anthropic reverse conversion;
- `convertOpenAIStreamToResponses` and Responses reverse conversion;
- Gemini `transformStreamIn` / `transformStreamOut`;
- per-protocol synthetic stream generation for a non-stream result.

Native-passthrough streams bypass these cross-protocol converters and preserve
raw SSE frames when the route/provider surface permits it.

## Shared modeled features and real boundaries

The IR models text roles, tools, typed content, structured output, reasoning,
sampling controls, finish reasons, usage, annotations, and provider-only state.
It improves cross-protocol coverage, but it is not a universal superset of every
provider API.

Important boundaries:

- OpenAI Chat preserves multiple choices. Anthropic is single-message. Responses
  and Gemini accept/request multiplicity controls, but their current response
  converters use only the first IR choice or first Gemini candidate; do not rely
  on end-to-end multi-candidate fidelity outside Chat.
- Reasoning summaries map across all four protocols. Native signatures,
  encrypted reasoning, and provider-specific histories are safest on same-protocol
  passthrough. Helm does not yet implement Anthropic's targeted
  invalid-thinking-signature strip-and-retry behavior.
- Citations/annotations render to OpenAI Chat and Responses. They remain in the IR
  but are not rendered to Anthropic or Gemini client responses.
- Remote `http(s)` media sent to Gemini cannot be fetched by the pure transformer.
  An optional provider-layer `remoteMediaFetch` materializer can fetch guarded
  public HTTPS media; otherwise the translated path records/degrades the remote
  reference.
- Advanced native Gemini fields, including `safetySettings` and Google GenAI
  extras, are most reliable through native passthrough. The shipping translated
  executor's target-aware `provider_raw` allowlist does not re-emit those fields.
- The standalone Anthropic transformer can produce `n_capped` and `data_loss`
  warnings for unsupported target knobs, but the shipping provider executor does
  not currently consume `transformRequestInWithWarnings`. Those route-level
  warnings are therefore not guaranteed.
- `provider_raw` is internal compatibility state, not a general lossless tunnel.
  The executor forwards only a target-specific allowlist and records stripped
  keys in request mutations. Most client renderers strip it. A known discrepancy
  remains: translated non-stream Responses currently returns a top-level
  `provider_raw` object.

The conservative per-feature and source/target view is in
[Protocol Compatibility](protocol-compatibility.md).
## Errors and disconnects

Pre-stream errors are translated to the client's protocol:

- OpenAI envelope for Chat and Responses;
- Anthropic envelope for Messages;
- Gemini `error.code/message/status` envelope for Gemini routes.

After a stream has started, the route emits the protocol's terminal error event
when the wire supports one. Client disconnects are treated as client aborts, not
provider failures, and do not open the provider circuit breaker.

See [07 · Error Model & Observability](07-observability.md) for the shared error
classes, telemetry, payload capture, and stream outcomes.

## Verification

The focused deterministic checks for this contract are:

```bash
CI=true pnpm test:protocol-compat:ast
CI=true pnpm vitest run packages/core/src/protocol/protocol-matrix.test.ts packages/core/src/protocol/responses.test.ts apps/gateway/src/responses-websocket.test.ts
```

The matrix is useful evidence but not a substitute for route/provider inspection.
Its current Responses multimodal and JSON-schema TODO declarations lag the
implemented transformer and are listed as verification debt in
[Protocol Compatibility](protocol-compatibility.md).
