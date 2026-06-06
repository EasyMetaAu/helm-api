# 01 · Overview & Positioning

## One-line definition

Helm API is an **open-source, self-hosted** LLM routing gateway (MIT license,
deployed with Docker). Think of it as "**nginx for the LLM world**": simple YAML
configuration drives how models are assigned and dispatched, while clients always
see one standard interface and output shape.

It accepts standard AI API requests, classifies each request's task type and
complexity, routes it to the appropriate lane, executes it through a provider
adapter, and records every decision for debugging. A management interface ships
alongside the gateway for basic rule management.

Manage traffic as **configuration**, not as **code**.

## The problem

AI application developers do not want to manage hundreds of models, the quirks of
each provider, fallback behavior, cost trade-offs, and long-term routing
decisions inside every client. They want one API that is cheap enough, reliable
enough, sensible by default, and debuggable when something goes wrong.

The earlier `llm-router` project drifted too broad: too many provider aliases, a
model-marketplace mindset, and too much logic in the routing core. Helm API is
deliberately more focused.

## Analogy: nginx for the LLM world

The analogy constrains the product boundary:

- nginx does not host content → Helm **does not own models**; it exposes a lane
  abstraction, not a model marketplace.
- nginx configuration is declarative → behavior lives in `lanes.yaml` /
  `policies.yaml`; no code changes.
- nginx has upstreams + health checks + failover → a lane has `primary +
  fallback[]` plus a circuit breaker.
- nginx is the "boring but reliable" infrastructure you deploy yourself → Helm is
  likewise **open-source and self-hosted**, not a SaaS.

## Headless core

The routing brain (classification, lane selection, provider execution, protocol
translation, storage) lives in a framework-free `core` package and runs
**headless** — it imports no web framework, and an architecture test enforces
that. The gateway and admin UI are thin layers on top. The admin interface is
**optional**: it stays disabled (its routes 404) until admin credentials are
configured.

## Client-facing API surface

Helm exposes standard AI API shapes. Four client protocols are wired and routed
today; all four normalize into one OpenAI-Chat-shaped internal representation
(IR) and share a single routing core (`routeRequest`):

- **OpenAI Chat Completions** — `POST /v1/chat/completions` (streaming and
  non-streaming).
- **Anthropic Messages** — `POST /v1/messages` (streaming and non-streaming).
- **OpenAI Responses** — `POST /v1/responses` (streaming and non-streaming; the
  SSE stream terminates with a `response.completed` event).
- **Google Gemini** — `POST /v1beta/models/{model}:generateContent` (non-streaming)
  and `:streamGenerateContent` (streaming via `?alt=sse`, emitted as nameless `data:`
  delta frames).

Clients should only need to change their `base_url` and API key. A client never
needs to know which provider or model actually executed the request.
Cross-protocol translation is described in
[05 · Protocol Translation](05-protocol-translation.md).

## Provider-facing surface

Provider adapters can target:

- OpenAI-compatible providers: OpenRouter, ZenMux, vLLM, DeepSeek, Qwen, local
  models, custom endpoints.
- Anthropic native.
- OAuth subscription providers — Claude Pro/Max, ChatGPT Codex, GitHub Copilot —
  connected via manual authorization-code paste (Claude/Codex) or device-code
  flow (Copilot), backed by a pooled, hot-reloadable, per-account credential store
  (issue #38; see [09 · Roadmap](09-roadmap.md)).
- Gemini native (future).

Provider aliases are an internal supply-chain detail. They are not the primary
user-facing surface.

## Memory

Memory is **per-request and on by default (`inject`)**, overridable via header. The `x-memory-mode`
header selects `off` (zero DB touch), `observe` (write-only), or `inject`
(read-back that hydrates the message array before routing, then writes). The
forgetting / tiering layer (short / mid / long term, decay) has **shipped** but is
opt-in behind a config flag that defaults to off — with forgetting off, runtime
is byte-identical to before. See [08 · Memory Middleware](08-memory-middleware.md).

## Goals

1. Support the standard client APIs with minimal migration cost (change only
   `base_url` and the API key).
2. Classify every request with deterministic rules (Layer 1); when the rules are
   uncertain, optionally consult a small-model eval (Layer 2); otherwise fall back
   to `balanced` (Layer 3).
3. Route through configurable lanes rather than exposing raw provider aliases.
4. Execute each lane through a primary plus fallback providers.
5. Record every routing decision and provider attempt for debugging. Full
   request/response bodies are also captured to a separate `request_payloads`
   table (on by default, retention-pruned) — distinct from the redacted
   `DecisionRecord`.
6. Work out of the box: default lanes shipped (three quality/cost tiers — economy,
   balanced, premium — plus task lanes coding, json, vision, tool_use), with the
   LLM eval **off** by default.
7. Enforce that an API key exists at startup; no anonymous access.
8. Open-source and self-hosted: one-command Docker deployment, config-as-code, no
   hard dependency on external services (see [10 · Deployment](10-deployment.md)).
9. Ship a management interface for basic rule management, authenticated with HTTP
   Basic credentials (see [11 · Admin UI](11-admin-ui.md)).
10. Keep memory as opt-in middleware (see [08 · Memory Middleware](08-memory-middleware.md)).

## Non-goals

- Do not build a model marketplace.
- Do not make hundreds of provider aliases the user-facing surface.
- Do not implement a full RAG product inside the routing core.
- Do not make the first routing layer depend on a black-box LLM classifier
  (deterministic rules come first).
- Do not use provider benchmarks as the primary runtime decision mechanism.
- Do not become a SaaS, a hosted multi-tenant platform, or a commercial product
  (open-source, self-hosted, MIT).

## The core product loop

```text
Client request
  -> Protocol Adapter        # normalize the client protocol to the internal IR
  -> Auth / API Key          # mandatory; a key must exist at startup
  -> Task Classifier         # the three-layer classification cascade
  -> Policy / Lane Router    # select a lane
  -> Provider Adapter + Fallback   # execute + in-chain fallback
  -> Telemetry / Debug UI    # decision record + payload capture
```

Component responsibilities and data structures are in
[02 · Architecture](02-architecture.md); classification is in
[03 · Classification Cascade](03-classification.md); routing and lanes are in
[04 · Routing & Lanes](04-routing-and-lanes.md).
