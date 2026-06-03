# 09 · Roadmap

> Status: **0.2 is implemented.** Phases 0–4 (the 0.1 core) are done; 0.2 adds the
> Gemini inbound route, native OpenAI Responses streaming, full OAuth subscription
> providers (multi-account pools + hot-reload), and an admin-UI overhaul. The
> "remaining" list below is what is still deferred.

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

## Delivered in 0.2

Net-new since 0.1 — all verified live (see `implementation-notes.md`):

- **Gemini inbound route.** `POST /v1beta/models/{model}:generateContent` is mounted
  (issue #58) — Google/Gemini-format clients now reach the gateway (non-streaming).
  The earlier "transformer exists but no endpoint" gap is closed. See
  [05 · Protocol Translation](05-protocol-translation.md).
- **OpenAI Responses streaming.** `stream: true` on `/v1/responses` now returns a
  native `response.*` SSE stream terminated by a `response.completed` event (not the
  Chat-Completions `[DONE]` sentinel). The structured-400 rejection is gone.
- **OAuth subscription providers (issue #38).** Now a complete feature, not the
  deferred sketch the 0.1 note described: **interactive login** from the dashboard
  (Claude Pro/Max + ChatGPT Codex paste-the-redirect, GitHub Copilot device-code), a
  **persistent encrypted token store** (survives restarts), **multi-account pools**
  with per-account model curation / egress proxy / priority+schedulable, **hot-reload**
  of all of those (no restart), fail-closed subscription routing, and a stable
  per-account anti-ban device identity. ChatGPT Codex routes via the OpenAI Responses
  backend; GitHub Copilot via its OpenAI-compatible endpoint.
- **Admin UI overhaul.** Unified Providers UI + modals (key create/edit,
  connect/disconnect/manage), requests-list pagination + filters, editable key caps,
  and the per-key `max_lane` ceiling retired in favor of an allowed-lanes whitelist.
- **Classifier.** Multilingual non-Latin fallback guard + CJK word-boundary fixes +
  an expanded Layer-1 keyword vocabulary.

## Remaining / deferred

Verified against the code and `implementation-notes.md`:

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
