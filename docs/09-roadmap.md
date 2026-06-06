# 09 · Roadmap

> Status: **shipped — 0.6.0.** The core gateway (routing, classification, provider
> execution, protocol translation, telemetry) runs in production, and several major
> subsystems have landed since the early releases: a memory middleware (observe +
> inject + background workers, opt-in), per-key budgets / rate limits / concurrency
> limiting, runtime hot-reload settings, verbatim payload capture, four streaming
> inbound protocols, full OAuth subscription providers, and an admin-UI overhaul.
> The "deferred" list below is what is genuinely still out of scope or not yet wired.

## Delivered

### Core gateway

- **Skeleton.** HTTP gateway + mandatory API-key auth (root-key bootstrap when the
  key store is empty) + telemetry persistence + Docker deployment (config/data
  volumes). See [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) and
  [10 · Deployment](10-deployment.md).
- **Routing core.** Layer-1 deterministic rule classifier + the default lanes + the
  provider executor + capability filtering + per-model circuit breaker + in-chain
  execution fallback. An uncertain classification falls open to `balanced`. See
  [03 · Classification Cascade](03-classification.md) and
  [04 · Routing & Lanes](04-routing-and-lanes.md).
- **Eval layer.** The Layer-2 small-model evaluator with a content-hash cache,
  **on in the shipped config** (schema default off). It runs only when Layer-1
  confidence is below the threshold; identical requests hit the cache instead of
  re-evaluating.

### Protocol translation

The Protocol Adapter accepts **four inbound protocols, all with streaming**:

- OpenAI Chat `POST /v1/chat/completions`
- Anthropic Messages `POST /v1/messages`
- OpenAI Responses `POST /v1/responses` — native `response.*` SSE stream, terminated
  by `response.completed` with a strictly monotonic `sequence_number` (no `[DONE]`).
- Google Gemini `POST /v1beta/models/{model}:generateContent` and
  `:streamGenerateContent?alt=sse` — auth via `x-goog-api-key`, native incremental
  delta frames.

Clients can mix SDKs; cross-protocol SSE conversion is covered per direction. See
[05 · Protocol Translation](05-protocol-translation.md).

### Memory middleware

Opt-in per request via the `x-memory-mode` header (default `off` — zero DB touch):

- **`observe`** — write-only capture of inbound/outbound turns.
- **`inject`** — synchronous read-back that full-replaces the message array before
  routing, then also writes. Wired on the chat, Messages, and Responses surfaces.
- **Background `MemoryWorker`** runs process-wide by default (disable via
  `HELM_MEMORY_WORKER_DISABLED=1`), dispatching observer / reflector / decay jobs.
- **Forgetting & tiering** (short / mid / long, see [12 · Memory Tiering](12-memory-tiering.md))
  has shipped, gated behind `config.memory.forgetting.enabled` — **default `false`**,
  so with forgetting off the runtime is byte-identical to before.
- The `DecisionRecord` carries a redacted `memory` block (counts / ids only, never
  content). See [08 · Memory Middleware](08-memory-middleware.md).

> Note: the observer / reflector / fact-extraction summarizers are currently
> **deterministic non-LLM stubs** (concatenate + truncate). The real LLM
> summarize / merge path is the one genuinely deferred piece of this subsystem.

### OAuth subscription providers

Three built-in subscription channels — Anthropic (Claude Pro/Max), GitHub Copilot,
and OpenAI Codex (ChatGPT):

- **Interactive login** from the dashboard — authorization-code paste for Anthropic
  and OpenAI Codex, device-code for GitHub Copilot.
- **Encrypted token store** (AES-256-GCM, survives restarts; requires
  `HELM_OAUTH_ENC_KEY`).
- **Multi-account pools** with per-account model curation, egress proxy
  (http/https/socks5), device identity, and priority.
- **Hot-reload** of all of the above, with no restart, and fail-closed subscription
  routing.

### Platform & admin

- **Per-key caps.** Allowed-lanes whitelist, `allow_custom_model`, RPM/TPM rate
  limits, usage budgets (requests / tokens / spend over a rolling window with
  degrade-to-cheaper-lane or reject), and concurrency limiting — all metered **per
  API key**.
- **Runtime hot-reload settings.** Lanes, policies, classifier, and system settings
  re-bind the live config and apply on the next request — no restart.
- **Verbatim payload capture.** Full request/response bodies recorded to a separate
  `request_payloads` table (default on, 30-day retention), toggleable in System
  Settings.
- **Admin UI overhaul.** Unified Providers UI + modals (key create/edit,
  connect/disconnect/manage), requests-list pagination + filters, and progressive
  key-caps dialogs. See [11 · Admin UI](11-admin-ui.md).

## Deferred / out of scope

Verified against the code and `implementation-notes.md`:

- **LLM-backed memory summarization.** The observer / reflector / fact-extraction
  paths use deterministic stubs today; swapping in a real small-model summarize +
  merge step is the next memory milestone.
- **Account-level credit accounting.** Per-key RPM/TPM and budgets have shipped.
  Helm is an internal/self-hosted gateway with no account/customer billing subject,
  so account-level / customer credit accounting is **out of scope** (not merely
  deferred). See [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).
- **Agentic Signals feedback layer.** The store ports and the redacted
  `RoutingSignal` shape exist, but nothing reads signals back into routing yet.

## Success criteria

- A new client can point an OpenAI-compatible SDK at Helm and get usable routing
  with no custom config.
- The default economy / balanced / premium lanes work out of the box, with LLM
  evaluation on by default (shipped config).
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
