# 01 · Overview & Positioning

## One-line definition

Helm API is an **open-source, self-hosted** LLM routing gateway (MIT license,
deployed with Docker). Think of it as "**nginx for the LLM world**": YAML and
runtime settings drive how models are assigned and dispatched, while clients keep
using their native OpenAI, Anthropic, or Gemini protocol against one Helm base URL.

It accepts standard AI API requests and, when the client has not selected an
exact permitted lane/model, classifies text requests by task type and complexity
before routing them to a lane. It then executes the resulting provider chain and
records the decision for debugging. A management interface ships alongside the
gateway for operations, configuration, and request debugging.

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

The routing brain (classification, lane selection, provider clients/primitives,
protocol translation, memory, Store ports, and storage adapters) lives in a
framework-free `core` package and runs **headless** — neither `packages/core` nor
`packages/shared` imports a web framework, and an architecture test enforces
that. The Hono gateway is the HTTP composition root and owns the concrete
candidate-chain executor; the Admin and Portal applications are separately built
static SvelteKit SPAs. The Admin surface is optional and is not mounted until its
environment-controlled authentication is enabled; the self-service Portal shell
is mounted independently.

## Client-facing API surface

Helm exposes standard AI API shapes. Four text protocols are wired and routed
today; translated requests normalize into one OpenAI-Chat-shaped internal
representation (IR) and share `routeRequest`. When the inbound and selected
provider protocols match, the executor can instead use the default-on native
passthrough path after the same auth, routing, capability, and circuit-breaker
governance:

- **OpenAI Chat Completions** — `POST /v1/chat/completions` (streaming and
  non-streaming).
- **Anthropic Messages** — `POST /v1/messages` (streaming and non-streaming),
  plus `POST /v1/messages/count_tokens`.
- **OpenAI Responses** — `POST /v1/responses` (JSON, SSE, and a WebSocket bridge
  on the creation endpoint), plus the implemented compact, input-token, retrieve,
  input-items, cancel, and delete lifecycle routes. `/responses` and
  `/openai/v1/responses` are compatibility prefixes for the same surface.
- **Google Gemini** — `POST /v1beta/models/{model}:generateContent` (non-streaming)
  and `:streamGenerateContent` (streaming via `?alt=sse`); `/models/{model}:...`
  is also accepted for Gemini SDK compatibility.

Alongside those four translated text protocols, Helm exposes separate **image-generation**
surfaces. The first is **OpenAI-Images-compatible** — `POST /v1/images/generations`
(non-streaming). Image generation is also available natively to **Gemini SDK
clients**: the existing `:generateContent` endpoint now serves image models
(`gemini-3.1-flash-image`, `gemini-3-pro-image`), and a dedicated
**`POST /v1beta/interactions`** endpoint (the Gemini Interactions API) is translated
to `generateContent` internally. Image requests name either an exact image model
or an image lane, skip text classification, and can fail over inside the
configured image chain. The two dedicated image routes do **not** share the text
`routeRequest` classification path; Gemini `generateContent` detects catalogued
image-output models before the text classifier and pins the exact model. See
[05 · Protocol Translation](05-protocol-translation.md).

Authenticated discovery and customer observability are also part of the public
API: `GET /v1/models`, `GET /v1/models/{id}`, and `GET /v1/usage/stats`. Public,
unauthenticated operational surfaces are `/`, `/healthz`, `/version`,
`/openapi.json`, and `/docs`.

All shipping routes are currently mounted at the server root. `server.base_path`
and `HELM_BASE_PATH` are parsed and validated but are not applied to route
mounting, so deployments must leave the effective value at `/`.

Clients should only need to change their `base_url` and API key. A client never
needs to know which provider or model actually executed the request.
Cross-protocol translation is described in
[05 · Protocol Translation](05-protocol-translation.md).

## Provider-facing surface

Provider adapters can target:

- OpenAI-compatible providers: OpenRouter, ZenMux, vLLM, DeepSeek, Qwen, local
  models, custom endpoints.
- Anthropic native.
- OAuth subscription providers — Claude Pro/Max, ChatGPT Codex, GitHub Copilot,
  and experimental xAI SuperGrok/X Premium — connected via provider-specific
  manual authorization-code or device-code flows, backed by a pooled,
  hot-reloadable, per-account credential store with model curation, egress proxy,
  scheduling, quota snapshots, selectable pool strategies, and guarded Codex
  reset-credit recovery.
- Gemini native request handling, including Gemini image models on
  `generateContent` and the Gemini Interactions image surface.

Provider aliases are an internal supply-chain detail. They are not the primary
user-facing surface.

## Memory

Memory is **opt-in per API key or request**. New user keys and the bootstrap root
key default to `off`; an explicit `x-memory-mode` header can select `off` (zero
memory DB touch), `observe` (write-only), or `inject`. Inject mode synchronously
loads a budgeted memory block and appends it as one trailing
`<system-reminder>` user turn before routing; it does not replace the live
conversation. The original inbound turn is observed only after injection, which
prevents same-turn self-injection, and the response is observed after serving.

The forgetting/tiering layer has shipped and is enabled in the checked-in
`config/memory.yaml` (`forgetting.enabled: true`), while the schema fallback used
when that file/block is absent remains off. This is separate from the per-key
memory-mode default: forgetting can be enabled globally while a key still makes
no memory reads or writes. See [08 · Memory Middleware](08-memory-middleware.md).

## Goals

1. Support the standard client APIs with minimal migration cost (change only
   `base_url` and the API key).
2. Classify text requests with deterministic rules (Layer 1); when the rules are
   uncertain, optionally consult a small-model eval (Layer 2); otherwise emit a
   classification fallback that the lane resolver sends to the configured
   terminal lane (`balanced` by default).
3. Route through configurable lanes rather than exposing raw provider aliases.
4. Execute each lane through a primary plus fallback providers.
5. Record every routing decision and provider attempt for debugging. Full
   request/response bodies are also captured to a separate `request_payloads`
   table (capture is on by default and a scheduled retention sweep prunes aged
   rows) — distinct from the redacted `DecisionRecord`.
6. Work out of the box: ship three quality/cost lanes, four task lanes,
   vendor-family compatibility lanes, and two image lanes, with Layer-2 eval
   **off** by default. `config/lanes.yaml` is the exact current inventory.
7. Enforce that an API key exists at startup; no anonymous access.
8. Open-source and self-hosted: one-command Docker deployment, config-as-code, no
   hard dependency on external services (see [10 · Deployment](10-deployment.md)).
9. Ship a management interface for keys, routing config, providers, memory,
   settings, and request debugging, authenticated with HTTP Basic credentials
   (see [11 · Admin UI](11-admin-ui.md)).
10. Keep memory as opt-in middleware controlled per key or per request (see
    [08 · Memory Middleware](08-memory-middleware.md)).
11. Provide a bearer-key self-service Portal under `/portal`, and an optional
    account-scoped Memory MCP JSON-RPC endpoint at `/mcp` when enabled (see
    [12 · Self-Service Portal](12-self-service-portal.md) and
    [13 · Memory Admin & MCP](13-memory-admin-and-mcp.md)).

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
  -> Request limits + Auth   # mandatory API key; rate/concurrency gates precede routing
  -> Protocol Adapter        # normalize, while retaining an optional native carrier
  -> Memory Middleware       # optional inject first, then observe the original turn
  -> Task Classifier         # when no exact path won: the three-layer cascade
  -> Policy / Lane Router    # select a lane
  -> Provider Adapter + Fallback   # breaker/capability gates; OAuth aliases pick an account inside the pool
  -> Protocol Response       # translate, or byte-relay an eligible native stream
  -> Telemetry / Memory      # deferred decision/payload/observe writes
```

Component responsibilities and data structures are in
[02 · Architecture](02-architecture.md); classification is in
[03 · Classification Cascade](03-classification.md); routing and lanes are in
[04 · Routing & Lanes](04-routing-and-lanes.md).
