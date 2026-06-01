# 09 · Roadmap

> Status: **0.1 is implemented.** Phases 0–4 are done; the gateway routes real
> traffic, translates protocols, classifies and routes with fallback and circuit
> breaking, supports optional eval, and ships an admin UI. The "remaining" list
> below is what is deferred past 0.1.

## Delivered in 0.1 (phases 0–4)

The build followed an order where each phase runs on its own.

- **Phase 0 — Skeleton · done.** HTTP gateway + mandatory API-key auth (with
  root-key bootstrap) + single-protocol passthrough (OpenAI Chat) + telemetry
  persistence + Docker deployment (config/data volumes). It authenticates,
  forwards, logs, and runs in a container. See
  [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) and
  [10 · Deployment](10-deployment.md).
- **Phase 1 — Routing core · done.** Layer-1 deterministic rule classifier + the
  default lanes + the provider executor + capability filtering + circuit breaker +
  the in-chain fallback. It serves real traffic; an uncertain classification falls
  open to `balanced`. See [03 · Classification Cascade](03-classification.md) and
  [04 · Routing & Lanes](04-routing-and-lanes.md).
- **Phase 2 — Protocol translation · done.** The Protocol Adapter translates
  OpenAI Chat, Anthropic Messages, and OpenAI Responses (with streaming for Chat
  and Messages), rewritten with musistudio/llms as the architecture blueprint and
  litellm as the correctness spec. Clients can mix SDKs. See
  [05 · Protocol Translation](05-protocol-translation.md).
- **Phase 3 — Eval layer · done.** The Layer-2 small-model evaluator with a
  content-hash cache (disabled by default). When enabled, its verdict selects a
  lane; identical requests hit the cache instead of re-evaluating.
- **Phase 4 — Admin UI · done.** A web console (HTTP Basic auth) for basic rule
  management (lanes / policies / classifier / keys / system settings) plus request
  debugging (list / detail / decision trail). See [11 · Admin UI](11-admin-ui.md).

## Remaining / deferred past 0.1

Verified against the code and `implementation-notes.md`:

- **Gemini client route.** The Gemini protocol transformer exists and is
  unit-tested (`packages/core/src/protocol/gemini/`), but it is **not mounted as
  an inbound route** yet — there is no `/v1beta/models/...` endpoint. A
  `parseGeminiPath` helper and the `x-goog-api-key` header constant are in place;
  the gateway wiring is the remaining work.
- **OpenAI Responses streaming.** The Responses route is wired for non-streaming
  only. A `stream: true` Responses request returns a structured 400 (it does not
  silently downgrade, per Principle 2) because the `response.*` SSE transformer
  is not implemented yet.
- **Memory inject phase.** The `observe` phase is wired; the `inject` phase
  (`assembleInjectedContext`) and the background Observer/Reflector jobs are not.
  See [08 · Memory Middleware](08-memory-middleware.md).
- **Fuller quota / rate-limit features.** Per-key RPM/TPM limiting ships
  (disabled by default); full quota / billing / credit accounting is deferred. See
  [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).
- **Agentic Signals feedback layer.** The store ports and the redacted
  `RoutingSignal` shape exist, but nothing reads signals back into routing yet.

## Success criteria (met by 0.1)

- A new client can point an OpenAI-compatible SDK at Helm and get usable routing
  with no custom config.
- The default economy / balanced / premium lanes work out of the box, with LLM
  evaluation off by default.
- On first start with no key, a root key is generated; requests without a key are
  rejected.
- Layer-1 rules route directly to the matching lane when classification is
  certain; an uncertain request with eval off falls to `balanced`.
- With eval on, the small model's verdict selects a lane, and an identical request
  hits the cache instead of re-evaluating.
- A coding request routes to a coding lane when one is configured, otherwise it
  falls back to premium or balanced.
- A request with a JSON constraint is never silently routed to a model that would
  ignore that constraint.
- Any surprising provider choice can be explained from the request log (which
  layer, which rule, which provider attempt). See [07 · Error Model &
  Observability](07-observability.md).
