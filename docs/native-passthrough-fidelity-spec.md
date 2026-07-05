# Native Passthrough Fidelity Spec

Status: **implemented** for the native protocol passthrough path.

This document records the current contract for forwarding a native client request
to a same-protocol upstream without translating it through the OpenAI-Chat IR.
The source of truth is:

- `packages/core/src/provider/protocol.ts` — passthrough eligibility guard.
- `packages/shared/src/native-passthrough.ts` — carrier and mutation ledger.
- `packages/core/src/provider/native-passthrough.ts` — header/body preparation.
- `packages/core/src/provider/anthropic.ts` — Anthropic native passthrough.
- `packages/core/src/provider/openai-responses.ts` — Codex and generic OpenAI
  Responses native passthrough.
- `packages/core/src/provider/gemini.ts` — Gemini native provider and remote-media
  materializer.
- `apps/gateway/src/routes/execute.ts` — per-attempt execution, telemetry, and
  fallback behavior.
- `apps/gateway/src/routes/native-memory-inject.ts` — additive native memory
  injection.
- `scripts/passthrough/` — deterministic and live acceptance checks.

## Goal

When the inbound protocol already matches the selected upstream protocol, Helm
should act as a governance gateway, not as an unnecessary protocol adapter. The
client-visible request and response should stay as close as possible to the
native protocol shape the client sent.

Native passthrough is still not a blind proxy. Helm continues to own auth,
authorization, rate limits, budgets, routing, fallback, provider credentials,
telemetry, payload capture, and optional memory injection.

## Scope

Native passthrough is meaningful for non-lingua-franca protocols:

| Inbound protocol | Upstream profile | Passthrough support |
|---|---|---|
| Anthropic Messages | `anthropic_messages` | Non-stream and stream |
| OpenAI Responses | `codex_responses` | Non-stream and stream |
| OpenAI Responses | `generic_openai_responses` | Non-stream and stream |
| Gemini GenerateContent | `gemini` | Non-stream, stream, and countTokens provider support |

OpenAI Chat is Helm's internal lingua franca, so the guard intentionally disables
"native passthrough" for inbound `openai_chat`: there is no translation to save.
OpenAI Images and Gemini Interactions use the image chain and are outside this
text-protocol passthrough contract.

## Eligibility

`canUseNativePassthrough()` returns true only when all of these are true:

1. Runtime setting `native_protocol_passthrough` is enabled. The runtime schema
   defaults it to enabled.
2. The parsed request carries a native request carrier.
3. The inbound protocol is not `openai_chat`.
4. The inbound protocol equals this attempt's target provider protocol.
5. The selected provider does not require a compatibility rewrite.
6. The selected provider implements the relevant passthrough method. For stream
   requests, execute feature-detects the streaming method.

The first failed check becomes the recorded disable reason:

- `feature_flag_disabled`
- `missing_native_request`
- `source_protocol_is_lingua_franca`
- `protocol_mismatch`
- `provider_requires_compatibility_rewrite`
- `provider_lacks_passthrough`

## Governance Still Runs

Passthrough happens inside the normal execution path. These controls are not
bypassed:

- API-key auth, key role/cap checks, and key-level allowed lanes.
- Per-key RPM/TPM rate limits, concurrency queues, and usage budgets.
- Routing, provider selection, provider account selection, pool strategy, and
  provider breaker/cooldown behavior.
- Same-protocol fallback. A native carrier can be retried on another candidate
  only when the next attempt is still same-protocol and supports passthrough.
- Telemetry, decision records, request payload capture, and upstream attempt
  metadata.
- Client abort semantics. A client disconnect is not recorded as a provider fault.

## Allowed Mutations

The passthrough path may make only documented mutations:

| Mutation | Why it is allowed |
|---|---|
| Replace provider auth headers | Helm must never forward the Helm API key upstream. |
| Drop hop-by-hop and secret-like headers | HTTP proxy safety and credential isolation. |
| Recompute `content-length` | Required after a body mutation. |
| Rewrite `model` | The client may name a Helm alias, lane, or provider-prefixed alias that the upstream does not accept. |
| Append memory | Memory injection is a Helm feature and is additive only. |
| Apply explicit provider-profile shims | Subscription backends sometimes require safe account-profile behavior. |
| Normalize streaming transport when byte identity is impossible | Event names and payloads must still be preserved, and the ledger marks `stream_reframed`. |

Any mutation must be reflected in the native passthrough mutation ledger. The
ledger must never include secrets or full body content.

## Mutation Ledger

The shared ledger type supports these fields and allows additional
implementation-specific flags:

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

The decision record stores passthrough metadata per provider attempt, including
whether passthrough was considered, used, disabled, and which mutations were
applied.

## Header Rules

The preparation helper removes unsafe headers before forwarding to the upstream.
The denylist includes provider credentials, Helm-internal headers, cookies,
hop-by-hop transport headers, WebSocket upgrade headers, and secret-like client
headers. Provider auth is then written from the selected provider credential or
OAuth account.

Safe client identity and SDK headers can be preserved, such as user agent,
accepted content types, Anthropic version/beta headers, OpenAI beta/session
headers, and client request IDs. Provider clients may add stricter rules for a
specific upstream profile, but they must record those mutations.

## Body Rules

The native request body is preserved except for the allowed mutations above.

Model rewrite is allowed when Helm selected a provider model that differs from
the client's alias. If the value is already the upstream model, it is not recorded
as a rewrite.

Memory injection is append-only:

- Anthropic: append a trailing user message containing the memory reminder.
- Responses: append a trailing input item/message containing the memory reminder.
- Gemini: append the memory reminder to the native content list.

Memory injection must not rewrite existing `system`, `instructions`, history,
tools, cache-control prefix, or provider-specific state.

## Provider Profiles

Provider profiles may apply explicit, ledgered shims:

- Anthropic native passthrough strips empty text blocks before dispatch and can
  force `accept-encoding: identity` for profiles where compressed SSE is unsafe.
- Anthropic and Responses Fast-mode fields are preserved only when the key allows
  Fast-mode passthrough; otherwise the request is downgraded and the ledger records
  the body/header shim.
- Codex Responses can apply Codex-specific request repair, such as account/session
  headers and body shims required by the ChatGPT/Codex backend.
- Generic OpenAI Responses is a separate profile and must not receive Codex-only
  defaults.

These profiles are account/backend compatibility behavior, not generic protocol
translation behavior.

## Streaming

Native streaming should be raw or near-raw:

- Do not run stream protocol transformers on the passthrough path.
- Do not synthesize Responses prelude events before an upstream Responses stream.
- Do not rewrite upstream response IDs.
- Preserve upstream event order and data payloads.
- Preserve comments, keepalives, no-data frames, and unknown events when the
  framework surface allows it.
- If exact byte identity is impossible, preserve event names and payload strings
  and set `stream_reframed: true`.

Responses streaming is authoritative from the upstream: no Helm-generated
`response.created` / `response.in_progress` frames on passthrough. Anthropic
streaming forwards native Anthropic `event:` / `data:` frames.

## Gemini Native Specifics

Gemini native providers advertise `nativeProtocolProfile: "gemini"` and implement
native `generateContent`, `streamGenerateContent`, and `countTokens`.

Remote media materialization is provider-layer behavior, not transformer behavior.
The pure Gemini transformer does not fetch network resources. When
`remoteMediaFetch` is enabled for the provider, `materializeGeminiRemoteMediaBody`
can fetch public `https://` media under SSRF guards and convert it to Gemini
`inlineData` / `fileData`; otherwise remote media degrades in the documented
protocol-compatibility way.

## Acceptance

Deterministic checks require no real provider credentials:

```bash
pnpm test:passthrough:unit
pnpm test:passthrough:e2e
pnpm test:passthrough
pnpm test:protocol-compat:ast
```

Live checks are fail-closed and require real local Helm credentials plus installed
CLI clients:

```bash
pnpm test:passthrough:live:claude-cli
pnpm test:passthrough:live:codex-cli
pnpm test:passthrough:live
pnpm test:passthrough:final
```

The live scripts write `artifacts/passthrough-live-report.json`. Dry-run mode is
available for local development only and is not an acceptance substitute for
merge or release.

## Non-Goals

- Do not turn Helm into a blind TCP/HTTP proxy.
- Do not forward Helm credentials upstream.
- Do not enable cross-protocol native passthrough.
- Do not silently rewrite client prompts, tools, or sampling parameters for
  generic compatibility.
- Do not expose mutation ledgers, provider credentials, or telemetry-only fields
  in client-visible protocol bodies.
