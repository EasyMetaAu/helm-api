# LiteLLM Protocol Gap Spec

Status: historical implementation plan with a source-checked backlog snapshot as
of 2026-07-16.

This file originally planned Helm's protocol-parity work against public
LiteLLM-style behavior. Most of that plan has shipped. It is no longer the
primary behavior contract; use:

- [05 · Protocol Translation](05-protocol-translation.md) for routes and wire
  behavior;
- [Protocol Compatibility](protocol-compatibility.md) for conservative
  source/target coverage and known loss;
- [Native Passthrough Fidelity](native-passthrough-fidelity-spec.md) for the
  same-protocol carrier path.

The code remains authoritative when these documents or fixtures disagree.

## Current implementation surfaces

Primary route and bridge files:

- `apps/gateway/src/routes/chat.ts`
- `apps/gateway/src/routes/messages.ts`
- `apps/gateway/src/routes/responses.ts`
- `apps/gateway/src/routes/gemini.ts`
- `apps/gateway/src/responses-websocket.ts`
- `apps/gateway/src/routes/execute.ts`

Primary protocol/provider files:

- `packages/core/src/protocol/`
- `packages/core/src/provider/anthropic.ts`
- `packages/core/src/provider/openai-responses.ts`
- `packages/core/src/provider/gemini.ts`
- `packages/core/src/provider/native-passthrough.ts`
- `packages/core/src/provider/protocol.ts`

Verification surfaces:

- `packages/core/src/protocol/protocol-matrix.fixtures.ts`
- `packages/core/src/protocol/protocol-matrix.test.ts`
- `scripts/protocol-compat/ast-grep-gates.sh`
- `scripts/passthrough/`

## Scope

The parity comparison covers four translated text faces:

1. OpenAI Chat Completions;
2. Anthropic Messages;
3. OpenAI Responses;
4. Google Gemini GenerateContent.

OpenAI Images, Gemini image generation through `generateContent`, and Gemini
Interactions are separate image-chain surfaces. They use the same governance and
fallback categories but are not part of the four-protocol text IR matrix.

## Principles retained from the original plan

1. Preserve a field when the target can safely represent it.
2. Keep auth, key caps, limits, budgets, routing, fallback, breakers, telemetry,
   payload capture, and memory active on every compatibility surface.
3. Prefer eligible same-protocol native passthrough over unnecessary translation.
4. Block known-unsafe cross-protocol state rather than silently inventing a
   representation.
5. Keep core transformers pure. Provider counting and remote media fetching stay
   outside `packages/core/src/protocol/`.
6. Treat `provider_raw` as internal, target-aware compatibility state—not a
   universal tunnel.
7. Never expose provider credentials or mutation/telemetry internals on a public
   wire.
8. Describe fidelity conservatively. Request acceptance or field forwarding does
   not prove end-to-end response preservation.

## Shipped status

| Area | Current source-backed state |
|---|---|
| Chat compatibility aliases | `/v1/chat/completions`, `/chat/completions`, Azure engines, and OpenAI deployment paths share the Chat handler. |
| Anthropic helpers | `/v1/messages/count_tokens` prefers provider counting with a deterministic estimate fallback; `/api/event_logging/batch` is an authenticated compatibility acknowledgement. |
| Responses aliases | HTTP/SSE create and lifecycle/helper routes are registered under `/v1/responses`, `/responses`, and `/openai/v1/responses`. |
| Responses lifecycle | Retrieve/delete/cancel/input-items dispatch through a key/account-scoped response registry to the creating provider when supported; unsupported operations fail closed. |
| Responses compact/input tokens | Codex compact is a real governed provider call; input tokens use a provider method or an explicit local estimate. |
| Responses WebSocket | Implemented on all three create paths. Sequential `response.create` messages bridge through the governed HTTP/SSE handler. Codex can reuse an upstream WebSocket and fall back to HTTP/SSE. |
| Responses structured output | `text.format` is canonicalized to/from the shared response-format shape. |
| Responses media input | The current IR-to-Responses request renderer emits `input_image`, `input_audio`, and `input_file`. |
| Responses native state guards | Native tools/items, `background`, and unsafe `previous_response_id` histories are blocked from non-Responses candidates with explicit skip reasons. |
| Provider profiles | Codex Responses and generic OpenAI Responses are separate profiles; Codex-only repairs are not applied to the generic profile. |
| Gemini route families | `/v1beta/models/*` and `/models/*` support generate, stream, and count operations. |
| Gemini native provider | Implements unary, streaming, and token-counting methods with `nativeProtocolProfile: "gemini"`. |
| Gemini remote media | Optional provider-layer materialization is config-gated and SSRF-guarded; the pure transformer performs no fetch. |
| Target-aware raw replay | `renderProviderRawForTarget` uses a protocol-specific allowlist and records stripped key names in request mutations. |
| Anthropic native cleanup | Empty text blocks and the billing CCH are stabilized before native dispatch; provider/profile changes are recorded where the shared ledger covers them. |
| Streaming fidelity | Each client face emits its own SSE framing. Native passthrough bypasses cross-protocol stream conversion and preserves raw frames when available. |
| Usage settlement | Cache, cache-creation, and reasoning totals are normalized. Interrupted native Responses streams can use an explicitly marked bounded partial estimate for internal settlement. |
| Structural gate | `test:protocol-compat:ast` protects selected route/provider structure and forbids the old target-blind raw replay loop. |

The old statement that Responses WebSocket was a non-goal is obsolete.

## Remaining backlog

### P1 — Remove translated Responses `provider_raw` from the public response

Current state:

`responsesTransformer.transformResponseOut` adds top-level `provider_raw`, and
the non-stream translated Responses route returns the transformer result
unchanged. This conflicts with the intended internal-only boundary.

Required outcome:

- strip `provider_raw` from the client-visible Responses response;
- retain the raw stop/usage data in IR, decision, and telemetry paths;
- add a route-level regression test, not only a transformer test;
- verify native passthrough still returns the provider's native object unchanged.

### P1 — Treat `response.cancelled` as a WebSocket terminal

Current state:

HTTP stream outcome tracking recognizes cancellation, but both the ingress
Responses WebSocket bridge and the Codex upstream WebSocket parser omit
`response.cancelled` from their terminal sets.

Required outcome:

- classify cancellation as terminal in both places;
- forward the cancellation event once;
- close/invalidate upstream session state consistently;
- do not append a synthetic bridge error after a clean cancellation;
- add ingress and provider WebSocket tests.

### P2 — Reconcile protocol matrix fixtures with current Responses rendering

Current state:

`protocol-matrix.fixtures.ts` still declares Responses-target multimodal and
JSON-schema request rendering as TODO. Current `responses.ts` implements typed
input parts and `text.format` canonicalization.

Required outcome:

- make the fixture assertions execute the implemented paths;
- retain explicit TODOs for genuinely unsupported media, including video and
  translated Responses generated-image output;
- avoid changing a TODO to passing solely because a helper exists—assert the
  actual route/provider shape.

### P2 — Define and test candidate multiplicity

Current state:

Chat preserves `choices[]`. Anthropic is single-message. Responses carries `n`
and Gemini maps `n` to `candidateCount`, but the current Responses and Gemini
response converters use the first IR choice/candidate.

Required decision:

- either implement multi-candidate output semantics for the affected client
  wires, or reject/cap the request explicitly;
- record the cap/degradation in route telemetry;
- add route-level tests so request forwarding is not mistaken for end-to-end
  support.

### P2 — Wire Anthropic target warnings into the shipping executor

Current state:

`transformRequestInWithWarnings` can produce `n_capped` and `data_loss`
warnings, but the executor/provider dispatch path does not consume it.

Required outcome:

- apply the target guard exactly once on the shipping translated path;
- attach warnings to decision/request-mutation telemetry;
- keep internal warnings off the client and provider wires;
- cover `n`, logprobs, modalities, penalties, and seed.

### P2 — Define translated Responses generated-media behavior

Current state:

The IR-to-Responses response renderer emits text, reasoning, annotations,
logprobs, and function calls, but ignores image parts as inbound-only.

Required decision:

- render a valid Responses image output item/part when the API supports it, or
- reject/document the unsupported cross-protocol generated-media path before
  dispatch.

Native Responses passthrough remains the high-fidelity path.

### P3 — Anthropic invalid-thinking-signature recovery

LiteLLM-style provider handling can recover from the specific invalid-thinking-
signature failure by stripping only the invalid history and retrying once. Helm
does not currently implement that targeted recovery.

Constraints:

- match only the explicit provider error;
- retry at most once;
- never remove thinking generically;
- preserve all unrelated turns/tools;
- record the retry and stripped-item count in mutation telemetry.

### P3 — Render annotations on Anthropic and Gemini client wires

IR annotations currently render to Chat and Responses. Anthropic and Gemini
client renderers do not emit them.

Required decision:

- implement a valid native citation/grounding representation where one exists, or
- retain an explicit documented degradation test.

Do not invent a provider-specific shape that the client SDK does not accept.

### P3 — Close advanced Gemini translated-field gaps

The standalone Gemini transformer retains fields such as `safetySettings` and
Google GenAI extras in `provider_raw`. The shipping translated executor's Gemini
allowlist currently forwards only `metadata`.

Required decision:

- promote supported fields to explicit IR/model fields;
- or extend the target allowlist with validation and tests;
- or state that those fields require native Gemini passthrough.

Do not reintroduce target-blind raw replay.

### P3 — Complete usage-detail symmetry where valuable

Aggregate input/output, cache read/write, and reasoning usage are covered.
Per-modality/native detail bags are not projected symmetrically on every target,
especially Responses and Gemini outbound rendering.

Only add mappings that affect billing, quotas, client compatibility, or useful
observability. Do not chase nominal 100% field coverage.

## Explicit non-goals

- Copying all provider-specific LiteLLM behavior into core transformers.
- Fetching remote media from protocol transformer code.
- Turning native passthrough into a blind proxy.
- Enabling cross-protocol native passthrough.
- Fabricating lifecycle success when no registry/provider path exists.
- Exposing provider credentials, mutation ledgers, or telemetry-only fields.
- Claiming byte identity after body mutation, JSON reserialization, or SSE
  reframing.
- Treating generated OpenAPI output as the complete route inventory.
- Restamping Chat response `model` by default; use the configured response-model
  policy.

## Completion evidence for future protocol work

A protocol-gap change is complete only when evidence covers the layer where the
gap existed:

- transformer unit tests for pure mappings;
- executor tests for target guards, mutation telemetry, and fallback;
- route tests for public JSON/SSE/WebSocket shape and auth;
- provider tests for native headers/body/session behavior;
- the structural AST gate when a cross-file invariant is involved;
- updated compatibility docs and fixture status.

Focused deterministic commands:

```bash
CI=true pnpm test:protocol-compat:ast
CI=true pnpm vitest run packages/core/src/protocol/protocol-matrix.test.ts packages/core/src/protocol/responses.test.ts apps/gateway/src/responses-websocket.test.ts
```

Native-passthrough scripts are additional evidence when that path changes:

```bash
CI=true pnpm test:passthrough:unit
CI=true pnpm test:passthrough:e2e
```

Live CLI suites require real local credentials and installed clients. They are
release evidence, not a deterministic replacement for the focused tests.
