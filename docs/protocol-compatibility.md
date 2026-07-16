# Protocol Compatibility and Data-Loss Matrix

Status: conservative implementation snapshot, source-checked on 2026-07-16.

This page describes what the shipping transformer, route, executor, and provider
layers do today. It intentionally avoids the old claim that every modeled field
is lossless. A field can be accepted by a request schema yet still be narrowed by
the IR, stripped for a target, reduced by a response converter, or preserved only
by native passthrough.

The companion route/transport contract is
[05 · Protocol Translation](05-protocol-translation.md). Native carrier behavior
is documented in
[Native Passthrough Fidelity](native-passthrough-fidelity-spec.md).

## Reading the tables

The four translated text protocols are:

- **Chat**: OpenAI Chat Completions;
- **Anthropic**: Anthropic Messages;
- **Responses**: OpenAI Responses;
- **Gemini**: Google GenerateContent.

The implementation uses `native -> IR -> target` for translated attempts. The IR
is OpenAI-Chat-shaped and extended with typed media, reasoning, usage detail,
annotations, and `provider_raw`.

Labels used below:

- **modeled**: the named feature has an explicit IR mapping;
- **native preferred**: same-protocol native passthrough provides the highest
  fidelity when its per-attempt guard succeeds;
- **guarded**: Helm skips an incompatible target instead of sending a known-lossy
  request;
- **degrades**: the request can run, but a documented detail is narrowed or lost.

These labels are field-level evidence, not promises that arbitrary unknown
provider fields survive.

## Source-to-target matrix

| source ↓ / target → | OpenAI Chat | Anthropic Messages | OpenAI Responses | Gemini |
|---|---|---|---|---|
| **OpenAI Chat** | **Modeled identity.** Multiple `choices[]` are preserved. Unknown top-level request fields outside the IR are not guaranteed. | Text, tools, standard media, structured output, and reasoning are modeled. Anthropic returns one message; unsupported sampling knobs have no native home, and route-level warning propagation is incomplete. | Messages, function tools, supported media, reasoning, and structured output are modeled. The Responses response renderer uses only the first IR choice. | Contents, functions, structured output, thinking config, and supported media are modeled. The Gemini response renderer emits one candidate; remote media needs provider materialization. |
| **Anthropic Messages** | Text/tool blocks and thinking map to Chat; cache/thinking usage maps to IR aggregates. Native signatures, redacted-thinking state, and Anthropic-only controls do not all have Chat wire homes. | **Native preferred.** If passthrough is disabled/ineligible, the transformer round-trip covers modeled fields and may apply compatibility rewrites. | Text, tools, thinking summaries, images/documents, and aggregate usage are modeled. Provider-native thinking state is not equivalent to Responses encrypted/native history. | Text/tools/media and thinking map to Gemini thought parts. Anthropic-only controls and citations have no general Gemini client rendering. |
| **OpenAI Responses** | Standard messages, function calls/results, supported parts, reasoning summaries, and structured output are modeled. Native tools/items, `background`, and some stateful history are **guarded** cross-protocol. | The same Responses guards apply. Supported function/message content can translate, but the result is single-message and unsupported Anthropic target knobs are not reliably warned at route level. | **Native preferred.** Codex and generic Responses profiles preserve the widest surface. Translated non-stream output currently leaks top-level `provider_raw`. | Standard content/functions/reasoning/structured output are modeled. Native tools/items, `background`, and unsafe stateful history are **guarded**. Advanced Gemini-native request fields cannot be synthesized from Responses. |
| **Gemini** | Only the first Gemini candidate is normalized. Text, functions, logprobs, thought, and grounding annotations map; safety/prompt-feedback data stays internal. | Only the first candidate is normalized. Text/tools/thought map; annotations are not rendered on the Anthropic client wire. | Only the first candidate is normalized. Grounding annotations can render on Responses `output_text`; translated output has the current `provider_raw` leak. | **Native preferred.** The translated round-trip covers modeled fields, but advanced Google GenAI fields are safest in the native carrier. |

Identity cells are not byte identity. Native passthrough may still rewrite the
model, append memory, replace credentials, apply provider-profile repairs, map
reasoning policy, materialize media, or reframe a stream.

## Feature support by client/target wire

| Feature | OpenAI Chat | Anthropic Messages | OpenAI Responses | Gemini |
|---|---|---|---|---|
| Text/system roles | `messages[]` with system/developer roles | top-level `system` plus messages | `instructions` plus input items | `systemInstruction` plus contents |
| Function tools | Native Chat tool shape; multiple tool calls | Native tools/tool-use/tool-result; translated names normalized to 64 chars with stable collision suffixes | Function/custom call items; non-function native tools guarded cross-protocol | Function declarations/calls/responses; Helm synthesizes IR call IDs |
| Structured output | `response_format` | native output config/schema mapping where supported | `text.format` canonicalized to/from shared `response_format` | response MIME/schema generation config |
| Input media | Modeled image, audio, and file/document parts; IR-shaped video is not a general OpenAI wire guarantee | Image and document blocks; no general audio/video request surface | `input_image`, `input_audio`, and `input_file`; translated renderer currently omits video | `inlineData`, `fileData`, and video metadata; provider capability and optional remote fetch still apply |
| Generated media | Message audio/images where modeled | Native image blocks map to IR images | The translated response renderer emits text/reasoning/functions but currently does not emit IR image parts; native passthrough is safest | `inlineData` image/audio maps to IR output carriers |
| Reasoning | flat `reasoning_content` plus IR thinking bridge | thinking/redacted-thinking blocks and signatures | reasoning items/config and summaries; encrypted/native state is safest via passthrough | thought parts and thinking config |
| Citations | Renders `message.annotations` | Not rendered from IR annotations | Renders annotations on `output_text` | Grounding/citation metadata normalizes into IR, but IR annotations are not rendered back to Gemini |
| Multiple candidates | End-to-end `choices[]` support in the Chat transformer | One message | Request `n` is modeled, but the current response renderer uses the first IR choice | `candidateCount` is modeled, but inbound/outbound response conversion uses the first candidate |
| Finish/stop | Legal Chat finish values; raw first stop kept internally | Legal Anthropic stop reason; raw kept internally | completed/incomplete status mapping; native failures/cancellations can pass through | finish-reason map with raw value kept internally |
| Usage | Prompt/completion, cache, reasoning, and modeled detail bags | Input/output, cache read/write, thinking, tier, geo where present | Input/output totals plus cache/cache-creation/reasoning projection; not every modality-detail field | Aggregate and inbound modality detail mapping; translated outbound projection is narrower |
| Unknown provider fields | Not transparent; closed IR request surface | Same-protocol passthrough gives best fidelity | Same-protocol passthrough gives best fidelity | Same-protocol passthrough gives best fidelity; translated target allowlist is narrow |

## Explicit protocol and capability guards

The executor has hard guards for request shapes that cannot safely cross a
protocol boundary. The attempt is recorded as skipped and fallback can continue:

| Skip reason | Trigger |
|---|---|
| `responses_previous_response_id_cross_protocol_blocked` | A Responses request relies on `previous_response_id` plus a tool-output history that cannot be reconstructed locally. |
| `responses_native_tools_cross_protocol_blocked` | The Responses request contains non-function/native tools. |
| `responses_native_items_cross_protocol_blocked` | The request contains native/custom/caller-linked or unknown Responses input items whose sequence cannot be represented safely. |
| `responses_background_cross_protocol_blocked` | A Responses request sets `background: true` and the target is not Responses. |
| `reasoning_history_incompatible` | A Responses reasoning-history request targets direct DeepSeek over OpenAI Chat, whose wire cannot safely represent that history. |

The Responses guards apply only when the target protocol is not Responses.
Same-protocol native passthrough can still run.

Routing also checks provider capabilities before dispatch. Unsupported image,
audio, video, or document input can skip a candidate with the corresponding
capability reason (for example `no_audio_support`,
`no_video_support`, or `no_document_support`). Context-window,
reasoning-effort, and provider-specific candidate guards run in the executor as
separate concerns from protocol transformation.

## Sampling and target-only controls

Common modeled controls include `temperature`, `top_p`, `top_k`,
`frequency_penalty`, `presence_penalty`, `seed`, `stop`, `n`,
`logprobs`, `top_logprobs`, `parallel_tool_calls`,
`reasoning_effort`, `user`, and `service_tier`. A target only receives a
field when its renderer/provider path has a native surface or an explicit shim.

The standalone Anthropic renderer has a guard helper that:

- caps `n > 1` to one and can produce an `n_capped` warning;
- can produce `data_loss` warnings for `logprobs`, `top_logprobs`,
  `modalities`, `frequency_penalty`, `presence_penalty`, and `seed`.

The shipping executor does not currently call
`transformRequestInWithWarnings`. Therefore those warnings are unit-tested
transformer behavior, not a guaranteed route-level telemetry contract. The
provider path can omit unsupported Anthropic controls without attaching those
specific warning records.

## Reasoning effort mapping

The transformer-level effort bands are:

| effort | Anthropic thinking budget | Gemini thinking budget |
|---|---:|---:|
| `none` | 0 | target policy may strip/disable |
| `minimal` | 1024 | 128 |
| `low` | 1024 | 1024 |
| `medium` | 2048 | 8192 |
| `high` | 4096 | 24576 |
| `xhigh` | 8192 | model policy maps or strips when unsupported |
| `max` | 16384 | model policy maps or strips when unsupported |

The executor can override these transformer defaults with lane-forced effort and
model capability policy. It records mapping/stripping shims in request mutation
metadata. Forced tool choice can suppress a conflicting forced reasoning change.

Reasoning text/summary is broadly portable. Signatures, encrypted content,
provider item IDs, and full reasoning history are provider-native state and are
not universally portable. Anthropic invalid-thinking-signature recovery
(strip only the invalid blocks and retry once) is not implemented.

## `provider_raw` is internal and target-aware

`provider_raw` stores modeled-adjacent data that has no shared IR field. It is
not a promise to replay every source value to every target.

The shipping executor re-emits only this target-specific request allowlist:

| Target protocol | `provider_raw` keys allowed into the translated provider body |
|---|---|
| OpenAI Chat | `metadata`, `store` |
| Anthropic Messages | `metadata`, `store`, `context_management`, `mcp_servers`, `container`, `speed`, `output_config` |
| OpenAI Responses | `metadata`, `store`, `container`, `responses_input_items`, `responses_tools`, `prompt_cache_options`, `reasoning_config`, `previous_response_id`, `include`, `text`, `truncation`, `logit_bias`, `context_management` |
| Gemini | `metadata` |

Other non-null keys are stripped and the executor records their names in request
mutation metadata. This is why Gemini `safetySettings` and Google GenAI extras
that can round-trip inside the standalone transformer still do not reliably
reach a Gemini provider through the shipping translated executor. Native Gemini
passthrough avoids that target-aware IR replay step.

Most client response renderers remove internal `provider_raw`. One source-backed
discrepancy remains: `responsesTransformer.transformResponseOut` currently
adds a top-level `provider_raw` object, and the non-stream Responses route returns
that object on the translated path. Native passthrough returns the provider's
native response and does not add it.

## Streaming compatibility

| Client wire | Framing and terminal behavior |
|---|---|
| OpenAI Chat | `data:` chunks followed by `data: [DONE]`. |
| Anthropic Messages | Named typed events ending in `message_stop`; no `[DONE]`. |
| OpenAI Responses | Named `response.*` events, no `[DONE]`. Translated completion ends in `response.completed` or `response.incomplete`; native streams may carry failed/cancelled terminals; gateway failures use `error`. |
| Gemini | Nameless incremental `data:` frames, no `event:` and no `[DONE]`. |

Native-passthrough routes preserve raw SSE frames when available, including
comments and keepalives. The mutation ledger marks streaming passthrough as
`stream_reframed` because the HTTP framework boundary can reframe the transport
even when event names and data payloads are unchanged.

Responses WebSocket uses the same three create paths as HTTP and serializes
sequential `response.create` messages through the HTTP/SSE route. The Codex
provider can reuse an upstream WebSocket session and fall back to HTTP/SSE. The
current WebSocket terminal classifier does not include
`response.cancelled`; see the known gaps below.

A native Responses stream without reported terminal usage is settled with a
bounded `estimated_partial` telemetry/budget estimate. Helm does not add that
estimate to the client stream as provider-reported usage.

## Native passthrough versus translation

| Concern | Native passthrough | Translated path |
|---|---|---|
| Eligibility | Same source/target protocol, native carrier, flag enabled, no required compatibility rewrite, matching unary/stream provider method | Used when passthrough is disabled, unavailable, mismatched, or unsafe |
| Unknown native body fields | Usually preserved except documented mutations/profile contracts | Only modeled IR fields and the target-aware raw allowlist survive |
| Headers | Anthropic/Responses preserve safe client headers and replace auth; Gemini builds provider headers | Provider client constructs target headers |
| Body | Original shape plus model/memory/policy/profile mutations | Re-rendered from IR/provider request |
| Response | Provider-native JSON/SSE shape | Provider result converted through IR into the client protocol |
| Fallback | Per attempt; a later cross-protocol candidate translates | Normal execution fallback |
| Telemetry/governance | Fully active | Fully active |

## Known implementation and verification gaps

The following are current source facts, not future guarantees:

1. **Responses matrix drift.**
   `protocol-matrix.fixtures.ts` still marks Responses-target multimodal and
   JSON-schema request rendering as TODO. The current
   `contentToResponsesParts` and structured-output canonicalization implement
   those paths. The fixture declarations and executable assertions need to be
   reconciled before the matrix can be called authoritative.
2. **Candidate multiplicity.**
   Responses and Gemini request controls can ask for multiple outputs, but current
   response conversion uses the first IR choice/candidate. Only OpenAI Chat
   preserves multiple choices end to end.
3. **Anthropic warning integration.**
   `n_capped`/`data_loss` warning helpers are not consumed by the shipping
   executor.
4. **Translated Responses internal-field leak.**
   Non-stream translated Responses output includes top-level `provider_raw`.
5. **Citation targets.**
   IR annotations render to Chat and Responses, not Anthropic or Gemini.
6. **Advanced Gemini translated fields.**
   The standalone transformer retains several Google-native extras, but the
   shipping translated executor does not re-emit them through its Gemini raw
   allowlist.
7. **Anthropic thinking-signature retry.**
   The targeted strip-invalid-signature-and-retry-once behavior is absent.
8. **Responses WebSocket cancellation.**
   `response.cancelled` is not classified as terminal by the ingress bridge or
   Codex upstream WebSocket parser.
9. **OpenAI Chat unknown fields.**
   OpenAI Chat is modeled-field identity, not transparent arbitrary-field
   forwarding.
10. **Usage detail symmetry.**
    Aggregate cache/cache-creation/reasoning totals are covered, but every native
    per-modality detail is not preserved across every target.
11. **Translated Responses generated media.**
    The current IR-to-Responses response renderer emits text, reasoning,
    annotations, logprobs, and function calls, but treats image parts as
    inbound-only and does not emit them on the Responses output wire.

## Executable evidence

The matrix fixture file enumerates 4×4 source/target paths and these dimensions:
request, response, streaming, tool call, multimodal, JSON schema, error, and
usage. It also contains focused tests for annotations and usage detail.

The fixture set is useful regression evidence, but its stale Responses TODOs mean
the documents, fixtures, and source are not currently in lock-step. Treat route
and provider code as authoritative until that debt is fixed.

Focused deterministic verification:

```bash
CI=true pnpm test:protocol-compat:ast
CI=true pnpm vitest run packages/core/src/protocol/protocol-matrix.test.ts packages/core/src/protocol/responses.test.ts apps/gateway/src/responses-websocket.test.ts
```
