# 05 · Protocol Translation

The Protocol Adapter translates between client protocols and arbitrary upstream
provider protocols, so a client always sees one standard interface and output
shape. Open-source references, the coverage matrix, and the footgun checklist are
in [Research Notes](research-notes.md). The implementation lives in
`packages/core/src/protocol/`.

## Wired protocols

Three client protocols are wired and routed in 0.1:

| Endpoint | Protocol | Streaming |
|----------|----------|-----------|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Yes (SSE) and non-stream |
| `POST /v1/messages` | Anthropic Messages | Yes (SSE) and non-stream |
| `POST /v1/responses` | OpenAI Responses | **Non-streaming only** |

For **OpenAI Responses**, streaming is not yet implemented: there is no Responses
SSE (`response.*` event) transformer, so a `stream:true` request is rejected with
a structured `400 invalid_request` ("streaming is not yet supported on
/v1/responses; retry with stream:false") rather than being silently mis-served
(fail-closed, principle 2). The non-streaming path is fully wired and routed. See
`apps/gateway/src/routes/responses.ts`.

A **Gemini** transformer exists in `packages/core/src/protocol/gemini/`, but it is
**not** exported from the core entry point and **not** routed to any endpoint.
Native Gemini support (request/response plus a streaming state machine) is on the
roadmap; it is not a usable endpoint today. See [09 · Roadmap](09-roadmap.md).

## Responsibilities

- Normalize each wired client request (OpenAI Chat / Anthropic Messages / OpenAI
  Responses) into the unified internal representation (IR).
- Translate the provider's response back to the protocol the client requested.
- Preserve streaming semantics — mapping SSE events across protocols where
  streaming is supported.

## Design

The architecture is modeled on `musistudio/llms`, with `litellm` as the
correctness reference; the code is a clean reimplementation, not a copy.

- **The IR uses the OpenAI Chat shape as its hub**
  (`packages/core/src/protocol/ir.ts`), extended with thinking/reasoning blocks,
  typed multipart content (text/image/thinking), tool-call IDs, cache-control,
  and a `provider_raw` passthrough bag that carries upstream-native fields (raw
  `stop_reason` / `usage`) that cannot be mapped losslessly. The IR is the single
  Zod type source for the whole protocol layer.
- **One class per protocol, a five-member contract**
  (`transformRequestOut` / `transformResponseOut` / `transformRequestIn` /
  `transformResponseIn` / `endPoint`; see `protocol/transformer.ts`), with inbound
  and outbound translation in the same file.
- **Translation always goes `nativeIn → IR → nativeOut`**, never N×N direct
  conversion (N protocols need 2N transform functions, not N²).
- **Streaming is an explicit state machine** (`protocol/streaming.ts` plus the
  per-direction machines, e.g. `protocol/anthropic/stream.ts`): a monotonic
  content-block index allocator, an OpenAI-tool-index → Anthropic-block-index map,
  a temp-id → real-id upgrade table, and idempotent close guards. A JSON → SSE
  synthesizer (`synthesizeSSE`) covers cache hits and non-streaming upstreams so a
  streaming client is none the wiser.
- **Cross-cutting concerns are stackable behavior transformers** (max-token
  clamping, tool-use normalization, reasoning injection) that operate on the IR
  only.

## Footguns that are handled

These are the protocol-translation pits the implementation and its tests cover:

- **finish_reason / stop_reason enum mismatches** — mapped to a legal enum **and**
  the original value is kept in `provider_raw`.
- **Usage fields and cache billing** — `input = prompt − cached`; usage is
  buffered to the terminal stream event so a cache read is not double-counted.
- **Tool-call streaming index/ID reconciliation** — maintain the index→block map,
  upgrade a temporary id once the real id arrives on a later fragment, and
  tolerate fragmented/partial argument JSON.
- **Stream block/part ID and role consistency** — `start` before `delta` before
  `stop`; the first OpenAI chunk carries `role: "assistant"`.
- **System prompt and multimodal structural mismatches** — Anthropic's top-level
  `system`, the ban on consecutive same-role messages, and image `image_url` vs
  `source: {base64}`.
- **Responses API item expansion** — the flat `input[]` item stream folds into the
  IR and explodes back out.
- **Idempotent stream close** — every `content_block_stop` and `message_stop` is
  emitted at most once, guarding against the "controller already closed" bug.

Errors are also translated into each client protocol's native shape (the OpenAI
error envelope for `/v1/chat/completions` and `/v1/responses`, the Anthropic error
envelope for `/v1/messages`). See
[07 · Error Model & Observability](07-observability.md).
