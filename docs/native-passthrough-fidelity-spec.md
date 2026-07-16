# Native Passthrough Fidelity Spec

Status: implemented as a best-effort same-protocol path; source-checked on
2026-07-16.

Native passthrough avoids an unnecessary cross-protocol round-trip when a client
request and the selected provider speak the same non-Chat protocol. It preserves
more provider-native structure than the translated path, but it is not a blind
proxy and does not promise byte identity.

The source of truth is:

- `packages/core/src/provider/protocol.ts` — ordered eligibility guard;
- `packages/shared/src/native-passthrough.ts` — carrier and mutation ledger;
- `packages/core/src/provider/native-passthrough.ts` — shared header/body
  preparation for Anthropic and Responses providers;
- `apps/gateway/src/routes/execute.ts` — per-attempt choice, mutations, fallback,
  breaker, and telemetry;
- `apps/gateway/src/routes/native-memory-inject.ts` — additive memory mutation;
- `packages/core/src/provider/anthropic.ts` — Anthropic profile;
- `packages/core/src/provider/openai-responses.ts` — Codex and generic Responses
  profiles, including upstream Codex WebSocket sessions;
- `packages/core/src/provider/gemini.ts` — Gemini native provider and media
  materializer;
- `apps/gateway/src/responses-websocket.ts` — client-facing Responses WebSocket
  bridge;
- `scripts/passthrough/` — deterministic and live checks.

## Goal and boundary

When a native client and provider already agree on a wire protocol, Helm should
act as a governed relay instead of translating that body through the Chat-shaped
IR and back.

Governed relay means these responsibilities still belong to Helm:

- Helm API-key authentication and key capabilities;
- rate limits, concurrency queues, usage budgets, and model restrictions;
- classification where applicable, lane expansion, candidate selection, and
  fallback;
- capability filters, provider-account selection, circuit breakers, and
  cooldowns;
- model alias resolution and provider credential replacement;
- memory injection when enabled;
- payload capture, decision telemetry, cost/usage settlement, and stream outcome
  tracking;
- abort handling and request timeouts.

A client disconnect remains a client abort, not a provider failure.

## Supported native profiles

| Inbound protocol | Provider profile | Unary | Streaming | Notes |
|---|---|---:|---:|---|
| Anthropic Messages | `anthropic_messages` | Yes | Yes | Provider may apply Anthropic account/profile repairs. |
| OpenAI Responses | `codex_responses` | Yes | Yes | Codex profile applies subscription-safe body/header behavior and can use an upstream WebSocket for a named ingress session. |
| OpenAI Responses | `generic_openai_responses` | Yes | Yes | Separate from Codex; only configured generic request-contract shims apply. |
| Gemini GenerateContent | `gemini` | Yes | Yes | Native generate/stream plus provider token counting; client headers are not forwarded. |

OpenAI Chat does not use this carrier path because it is the internal lingua
franca. OpenAI Images and Gemini Interactions use the image chain and are outside
this text-protocol contract. A Gemini image model reached through native
`generateContent` can still benefit from the Gemini native provider method.

## Eligibility is per provider attempt

`canUseNativePassthrough()` returns true only when all checks pass, in this
contractual order:

1. Runtime setting `native_protocol_passthrough` is enabled. Its default is
   `true`.
2. The parsed request carries a valid native carrier.
3. The source protocol is not `openai_chat`.
4. The source protocol equals the current candidate's target protocol.
5. The candidate does not require a compatibility rewrite.
6. The provider implements the method required for this request:
   `nativePassthrough` for unary or `nativePassthroughStream` for streaming.

The first failing check becomes the stable disable reason:

- `feature_flag_disabled`
- `missing_native_request`
- `source_protocol_is_lingua_franca`
- `protocol_mismatch`
- `provider_requires_compatibility_rewrite`
- `provider_lacks_passthrough`

This decision is made separately for every candidate. A same-protocol head can
use native passthrough; if it fails before client-visible output, a later
same-protocol candidate can also use passthrough, while a later cross-protocol
candidate uses translation.

For Anthropic targets, an inline `developer` turn or an unsupported inline
`system` placement counts as a required compatibility rewrite. The guard has one
model-aware exception for the validated Claude Opus 4.8 mid-conversation system
shape; older, unknown, or differently placed shapes stay fail-closed onto the
rewrite path.

## Native carrier

The route stores:

```ts
interface NativePassthroughCarrier {
  protocol: "anthropic_messages" | "openai_responses" | "gemini";
  body: Record<string, unknown>;
  raw_body?: string;
  headers: Record<string, string | string[]>;
  mutations: NativePassthroughMutationLedger;
}
```

`raw_body` preserves the exact inbound JSON text only while no body mutation
invalidates it. Once the executor clones and changes the body, providers serialize
the changed object. Gemini's provider always serializes the native object after
model extraction and optional media materialization.

The carrier itself is never written into the public decision JSON or logs as a
full body/header object. The decision records body-free eligibility and mutation
metadata.

## Request mutations

Native passthrough deliberately allows the following current mutations.

### Common executor mutations

| Mutation | Shipping behavior |
|---|---|
| Model resolution | Rewrites `body.model` from the Helm alias/lane name to the selected provider model and records `model_rewritten`. |
| Memory | Appends one trailing protocol-native user reminder and records `memory_appended`. Existing system/instructions/history/tools stay in place. |
| Reasoning policy | Lane-forced effort and model capability policy can map, strip, disable, or skip a forced reasoning change; applied shims are recorded. |
| Optional visual compression | Anthropic attempts can run the configured visual-context compressor before token preflight/dispatch; the mutation is attached to attempt telemetry. |
| Stream transport | Streaming passthrough records `stream_reframed` because the gateway/framework boundary may reframe SSE even when native event payloads are retained. |

Memory append shapes:

- Anthropic: trailing `{role:"user", content:"<system-reminder>..."}` in
  `messages[]`;
- Responses: trailing user input item, appended text for string input, or a new
  input string;
- Gemini: trailing `{role:"user", parts:[{text: ...}]}` in `contents[]`.

The system-equivalent fields (`system`, `instructions`, and
`systemInstruction`) are not rewritten by memory injection.

### Provider-profile mutations

| Profile | Current provider-specific behavior |
|---|---|
| Anthropic | Strips empty text blocks/messages that would be rejected; stabilizes the billing-header `cch` against the cache-prefix fingerprint; can force `speed:"fast"` for an account; merges provider beta headers; forces `accept-encoding: identity` on OAuth streams; replaces auth and supplies provider identity headers. |
| Codex Responses | Forces `store:false`; removes unsupported `max_output_tokens` and `temperature`; strips invalid store-false item references and empty reasoning items; applies model/client-version/reasoning/service-tier compatibility; replaces auth and supplies Codex account/session headers. |
| Generic Responses | Applies only configured request-contract behavior, which can force SSE, force `store:false`, ensure default instructions, or reject unsupported `previous_response_id`. It must not inherit Codex-only defaults. |
| Gemini | Rewrites/removes the path model from the body as required by the provider request builder; optionally materializes guarded remote media; serializes JSON and constructs provider-only auth/content headers. |

Fast-mode and reasoning behavior is capability- and key-aware at the executor and
provider layers. The native path does not mean “client values always win.”

## Mutation ledger

The shared type is:

```ts
interface NativePassthroughMutationLedger {
  model_rewritten?: { from: string | null; to: string };
  memory_appended?: boolean;
  headers_dropped?: string[];
  headers_overwritten?: string[];
  auth_replaced?: boolean;
  content_length_recomputed?: boolean;
  accept_encoding_forced_identity?: boolean;
  provider_profile_applied?: string | null;
  body_shims_applied?: string[];
  stream_reframed?: boolean;
  [key: string]: unknown;
}
```

The executor stores the ledger on the provider attempt as
`passthrough_mutations` / request-mutation telemetry. Lists are deduplicated and
sorted by the shared helper. The ledger contains mutation names and safe
metadata, not credentials or full prompt content.

The ledger is broad enough for implementation-specific fields such as stripped
Anthropic block counts, Responses continuation markers, reasoning-policy shims,
and visual compression metadata.

Current limitation: not every provider-layer change passes through the shared
preparation helper. Gemini remote-media materialization and its strict
provider-header construction are not fully enumerated in the shared carrier
ledger. The ledger is therefore an important audit trail, but not a
cryptographically complete diff of every byte.

## Header behavior

### Anthropic and Responses profiles

`prepareNativePassthroughRequest` is forward-by-default for client headers and
then removes unsafe shapes. The deny rules cover:

- Helm and provider credentials (`authorization`, `proxy-authorization`,
  `x-api-key`, `x-cr-api-key`, and secret/token/auth/credential-shaped names);
- cookies;
- `x-helm-*` internal headers;
- host, content length, hop-by-hop transport headers, and WebSocket upgrade
  headers.

Provider authentication is then added from the selected provider credential or
OAuth account. Selected provider/client headers can be merged or preserved by
profile, including accepted content types, user agent, Anthropic beta,
Codex beta/session/turn state, client request IDs, and model metadata.

This filter is shape-based, not a complete secret-header allowlist. A generic
secret with an unusual name such as `x-functions-key` can pass to an Anthropic
or Responses upstream because it matches no current deny shape. These
passthrough upstreams are expected to be trusted first-party/provider endpoints;
do not treat the helper as safe for arbitrary third-party proxy destinations.

### Gemini profile

The Gemini provider does not forward the carrier's client headers. It constructs
`Content-Type` plus provider `x-goog-api-key` or Bearer auth. This is stricter
than the shared Anthropic/Responses behavior and means native Gemini fidelity is
primarily body/response fidelity, not request-header fidelity.

### Responses WebSocket bridge

The client WebSocket upgrade removes hop-by-hop/WebSocket headers before its
internal HTTP fetch. A process-local proof header is required before the HTTP
Responses route preserves the internal upstream-session marker, so an external
HTTP client cannot spoof long-lived upstream WebSocket reuse.

## Body and response fidelity levels

“Native” has several fidelity levels:

1. **Unchanged body with `raw_body` retained.** Anthropic/Responses providers can
   reuse the original JSON text after credential/header replacement.
2. **Native shape after documented mutation.** Model, memory, reasoning,
   provider-profile, or request-contract changes clear `raw_body` and serialize
   the modified object.
3. **Gemini native shape.** Gemini always serializes the body and may materialize
   remote media.
4. **Non-stream response.** Providers parse upstream JSON and the Hono route
   serializes an object to the client. Field shape can be native; whitespace,
   key ordering, and exact bytes are not preserved.
5. **Streaming response.** Provider readers and routes preserve raw SSE frames
   when available, including comments and keepalives, but decoding/framework
   boundaries can reframe transport bytes. Event names and data payloads are the
   compatibility target.

Native passthrough does not run the cross-protocol response transformer and does
not intentionally restamp upstream response IDs. Provider-native unknown event
types can survive the raw stream path.

## Responses WebSocket behavior

Client-facing upgrades are installed on:

- `/v1/responses`
- `/responses`
- `/openai/v1/responses`

The bridge:

1. authenticates/preflights through `GET /v1/models`;
2. accepts JSON `response.create` messages;
3. processes messages sequentially per client socket;
4. forces each create request to stream;
5. sends it through the normal governed Responses HTTP/SSE route;
6. forwards each typed event JSON as a WebSocket text message.

When the selected provider is Codex and the request carries the internal ingress
session marker, the Codex client can acquire/reuse one upstream WebSocket
connection. Successful `response.completed` turns can keep that connection
reusable. Upgrade failures (including HTTP 426 or transport failure) and
connection-limit exhaustion can mark the ingress session for HTTP/SSE fallback.
Closing or invalidating the ingress session closes the upstream connection.

The upstream WebSocket path still uses native Responses event semantics; it is a
transport optimization inside the native Responses attempt, not a bypass around
the route pipeline.

Current gap: `response.cancelled` is recognized by HTTP stream outcome tracking
but is not in the terminal set of either the ingress bridge or the Codex upstream
WebSocket parser. It can be forwarded and then followed by a bridge error when
the stream closes.

## Fallback and stream commitment

The executor peeks/buffers the pre-output portion of a native stream. A provider
failure or in-band terminal error before meaningful client output can still fault
that attempt and advance the fallback chain. After output is committed, a later
stream failure is surfaced to the client and is not replayed through another
provider.

A client abort does not count as a provider fault. Provider/account scoped auth
and quota failures follow the normal pool/breaker classification.

Responses requests carrying native-only tools/items, `background`, or unsafe
stateful history are blocked from cross-protocol fallback candidates with
explicit skip reasons. This preserves correctness at the cost of a narrower
fallback set.

## Usage, telemetry, and payload capture

Both native and translated attempts record:

- whether passthrough was considered and used;
- the disable reason when it was not used;
- source, target, and response protocols;
- selected provider/model;
- safe mutation metadata;
- upstream attempt status, latency, cost, and stream outcome;
- captured request/response/upstream bodies only when payload capture is enabled.

Native Anthropic, Responses, and Gemini usage is normalized for budgets and cost.
Responses terminal usage wins when present. If a native Responses stream ends
without reported usage, Helm may derive a bounded
`measurement:"estimated_partial"` value from the semantic upstream request and
observed text/reasoning/tool deltas. That estimate is internal accounting
provenance and is not emitted as provider wire usage.

## Acceptance

Focused deterministic checks do not require provider credentials:

```bash
CI=true pnpm test:passthrough:unit
CI=true pnpm test:passthrough:e2e
CI=true pnpm test:protocol-compat:ast
CI=true pnpm vitest run apps/gateway/src/responses-websocket.test.ts packages/core/src/provider/protocol.test.ts
```

The combined deterministic passthrough command is:

```bash
CI=true pnpm test:passthrough
```

Live checks require real local credentials and installed CLI clients:

```bash
CI=true pnpm test:passthrough:live:claude-cli
CI=true pnpm test:passthrough:live:codex-cli
CI=true pnpm test:passthrough:live
CI=true pnpm test:passthrough:final
```

Live scripts write `artifacts/passthrough-live-report.json`. Dry-run output is
development help, not merge/release acceptance.

## Non-goals

- Turning Helm into a blind HTTP/TCP proxy.
- Forwarding Helm or provider credentials supplied by the client.
- Cross-protocol native passthrough.
- Preserving arbitrary headers to Gemini.
- Promising exact JSON bytes after parsing or mutation.
- Hiding provider-profile repairs from telemetry.
- Replaying a committed stream on a fallback provider.
- Exposing the carrier, mutation ledger, credentials, or telemetry-only fields in
  client-visible bodies.
