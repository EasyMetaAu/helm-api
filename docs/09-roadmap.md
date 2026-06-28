# 09 · Roadmap

> Status: **shipped — production.** The core gateway (routing, classification, provider
> execution, protocol translation, telemetry) runs in production, and several major
> subsystems have landed since the early releases: a memory middleware (observe +
> inject + background workers, on by default), per-key budgets / rate limits /
> concurrency limiting, runtime hot-reload settings with admin YAML write-back,
> verbatim payload capture, four streaming inbound protocols, full OAuth subscription
> providers, Agentic Signals feedback into ranked-lane routing, an admin-UI
> overhaul, auto-adaptive memory compaction, and permanent delete of revoked keys. The
> "deferred" list below is what is genuinely still out of scope or not yet wired.

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
  **off by default**. When enabled, it runs only when Layer-1 confidence is below
  the threshold; identical requests hit the cache instead of re-evaluating.

### Protocol translation

The Protocol Adapter accepts **four inbound protocols, all with streaming**:

- OpenAI Chat `POST /v1/chat/completions`
- Anthropic Messages `POST /v1/messages`
- OpenAI Responses `POST /v1/responses` — native `response.*` SSE stream, terminated
  by `response.completed` with a strictly monotonic `sequence_number` (no `[DONE]`).
- Google Gemini `POST /v1beta/models/{model}:generateContent` and
  `:streamGenerateContent?alt=sse` — auth via `x-goog-api-key`, native incremental
  delta frames.

Image generation is served by a dedicated `/v1/images/generations` surface
**outside** the Protocol Adapter — it is model-pinned (the client names the exact
image model) and does not go through cross-protocol translation or the IR.

Clients can mix SDKs; cross-protocol SSE conversion is covered per direction. See
[05 · Protocol Translation](05-protocol-translation.md).

### Memory middleware

Memory defaults to **inject** for new keys and for requests with no `x-memory-mode`
header (memory-on-by-default since #107); send `x-memory-mode: off` or set a per-key
default of `off` to opt out (zero DB touch):

- **`observe`** — write-only capture of inbound/outbound turns.
- **`inject`** — synchronous read-back that full-replaces the message array before
  routing, then also writes. Wired on the chat, Messages, and Responses surfaces.
- **Background `MemoryWorker`** runs process-wide by default (disable via
  `HELM_MEMORY_WORKER_DISABLED=1`), dispatching observer / reflector / decay jobs.
- **Forgetting & tiering** (short / mid / long, see [12 · Memory Tiering](12-memory-forgetting-and-tiering.md))
  has shipped, gated behind `config.memory.forgetting.enabled`. The Zod schema
  default is `false` (fail-safe), but the shipped `config/memory.yaml` enables it
  (`true`) since #106, so a default deployment runs decay/reinforcement; set it to
  `false` to get pre-docs/12 byte-identical behavior.
- The `DecisionRecord` carries a redacted `memory` block (counts / ids only, never
  content). See [08 · Memory Middleware](08-memory-middleware.md).

> Note: the observer / reflector / fact-extraction summarizers default to
> **deterministic local logic** (concatenate + truncate). An optional LLM-backed
> path (`config.memory.llm.enabled`, default `false`) calls the configured small
> model from background jobs and falls back to the deterministic output on
> failure, invalid JSON, or unavailable model. The `enable_llm_supersede`
> contradiction-path remains gated and not yet wired.

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
  re-bind the live config and apply on the next request — no restart. Since #115,
  classifier/lanes/policies edits are also persisted back to `config/*.yaml`
  (comment-preserving, atomic, fail-closed) before the live config rebinds, so they
  survive restarts rather than being reverted on restart.
- **Agentic Signals feedback.** The background collector aggregates redacted
  per-(task type, lane) health signals from decision records. Opt-in
  `runtime.signal_feedback` lets routing promote a degraded ranked lane to a
  healthier stronger ranked lane, while preserving explicit passthrough, policy
  pins, usage-budget degradation, and policy/key caps. Signal reads fail open.
- **Verbatim payload capture.** Full request/response bodies recorded to a separate
  `request_payloads` table (default on, 30-day retention), toggleable in System
  Settings.
- **Admin UI overhaul.** Unified Providers UI + modals (key create/edit,
  connect/disconnect/manage), requests-list pagination + filters, and progressive
  key-caps dialogs. See [11 · Admin UI](11-admin-ui.md).

## Deferred / out of scope

Verified against the code and `implementation-notes.md`:

- **Account-level credit accounting.** Per-key RPM/TPM and budgets have shipped.
  Helm is an internal/self-hosted gateway with no account/customer billing subject,
  so account-level / customer credit accounting is **out of scope** (not merely
  deferred). See [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).

## Success criteria

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
