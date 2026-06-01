# 01 · Overview & Positioning

## One-line definition

Helm API is an **open-source, self-hosted** LLM routing gateway (MIT license,
deployed with Docker). Think of it as "**nginx for the LLM world**": simple YAML
configuration drives how models are assigned and dispatched, while clients always
see one standard interface and output shape.

It accepts standard AI API requests, identifies each request's task type and
complexity, routes it to the appropriate lane, executes it through a provider
adapter, and records full request logs for debugging. A management interface
ships alongside the gateway for basic rule management.

Manage traffic as **configuration**, not as **code**.

## The problem

AI application developers do not want to manage hundreds of models, the quirks of
each provider, fallback behavior, cost trade-offs, and long-term routing
decisions inside every client. They want one API that is cheap enough, reliable
enough, sensible by default, and debuggable when something goes wrong.

The earlier `llm-router` project drifted too broad: too many provider aliases, a
model-marketplace mindset, and too much logic stuffed into the routing core. Helm
API is deliberately more focused and convergent.

## Analogy: nginx for the LLM world

This analogy explains what Helm is and is not — it constrains the product
boundary:

- nginx does not host content → Helm **does not own models**; it exposes a lane
  abstraction, not a model marketplace.
- nginx configuration is declarative → everything lives in `lanes.yaml` /
  `policies.yaml`; no code changes.
- nginx has upstreams + health checks + failover → a lane has `primary +
  fallback[]` plus a circuit breaker.
- nginx is the "boring but reliable" infrastructure you deploy yourself → Helm is
  likewise **open-source and self-hosted**, not a SaaS or platform.

If you are not familiar with nginx, that is fine: treat Helm as "an API gateway
you run yourself that manages model traffic through configuration".

## Client-facing API surface

Helm exposes standard AI API shapes. Three client protocols are wired and routed
today:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` (streaming and
  non-streaming).
- **Anthropic Messages** — `POST /v1/messages` (streaming and non-streaming).
- **OpenAI Responses** — `POST /v1/responses` (**non-streaming only** in 0.1; a
  `stream:true` request is rejected with a structured 400).

A **Gemini** transformer exists in the codebase but is not yet routed to an
endpoint; native Gemini support is on the roadmap (see
[09 · Roadmap](09-roadmap.md)), not a usable endpoint today.

Clients should only need to change their `base_url` and API key. A client never
needs to know which provider or model actually executed the request.
Cross-protocol translation is described in
[05 · Protocol Translation](05-protocol-translation.md).

## Provider-facing surface

Provider adapters can target:

- OpenAI-compatible providers: OpenRouter, ZenMux, vLLM, DeepSeek, Qwen, local
  models, custom endpoints.
- Anthropic native.
- Gemini native (future).
- Future OAuth/subscription providers such as Claude Code, Codex, or Copilot.

Provider aliases are an internal supply-chain detail. They are not the primary
user-facing surface.

## Goals

1. Support the standard client APIs with minimal migration cost (change only
   `base_url` and the API key).
2. Classify every request with deterministic rules (Layer 1); when the rules are
   uncertain, optionally consult a small-model eval (Layer 2); if nothing decides,
   fall back to `balanced` (Layer 3).
3. Route requests through configurable lanes rather than exposing raw provider
   aliases.
4. Execute each lane through a primary plus fallback providers.
5. Record every routing decision and every provider attempt for debugging.
6. Work out of the box: three default lanes shipped, and the LLM eval **off** by
   default.
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
  -> Request Log / Debug UI  # full telemetry
```

Component responsibilities and data structures are in
[02 · Architecture](02-architecture.md); classification is in
[03 · Classification Cascade](03-classification.md); routing and lanes are in
[04 · Routing & Lanes](04-routing-and-lanes.md).
