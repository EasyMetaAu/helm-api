# 02 · Architecture

## Overview

> See also [Architecture & Data Flow (diagrams)](architecture.md) — the same pipeline as sequence, flow, and state diagrams.

```text
Client
  -> API Gateway (Hono)
  -> Auth Resolver               # mandatory API key (bootstrapped at first start)
  -> Rate Limiter                # per-key; off by default
  -> Protocol Adapter
  -> Task Classifier             # cascade: rules (always on) -> optional eval -> balanced
  -> Policy Engine
  -> Lane Resolver
  -> (Signal Feedback)           # opt-in ranked-lane health promotion
  -> Capability Filter
  -> Circuit Breaker
  -> Provider Executor
  -> Telemetry / Request Log
  -> (Memory Middleware)         # observe/inject, on by default; header-overridable per request
```

Positioning: Helm is **nginx for LLMs** — a declaratively-configured model
gateway. Clients see one standard interface and output shape; model assignment
and dispatch are driven entirely by the YAML configuration and the pipeline above.

The gateway (`apps/gateway`) is a thin Hono adaptation layer. The entire routing
brain lives in `packages/core` and imports no web framework: `routeRequest` (in
`packages/core/src/routing/route-request.ts`) is the single framework-agnostic
orchestrator, so the core can run headless. This separation is principle 1.

## Components

Each component is summarized here; deeper design lives in its own chapter.

### API Gateway

Built on Hono. Responsibilities:

- Accept the standard API requests on `/v1/chat/completions`, `/v1/messages`,
  `/v1/responses`, `/v1beta/models/{model}:generateContent` (Gemini), and
  `/v1/images/generations` (a dedicated image endpoint that accepts either an
  exact image model or an image lane, skips text classification, and can fail
  over inside the configured image chain).
- Normalize request headers and the request/trace id.
- Apply request-size and timeout limits (`runtime.max_request_bytes`,
  `runtime.request_timeout_ms`).
- Dispatch to the correct protocol adapter.

It also serves `/healthz` and `/version`, and mounts the Admin UI and admin
API under `/admin` when admin is enabled — i.e. when credentials are configured
(auto-enable) OR `HELM_ADMIN_ENABLED` / `admin.enabled` is set; otherwise
`/admin` and `/admin/api` return 404.

### Protocol Adapter

Normalizes each client protocol into the internal IR and translates responses
back to the client protocol, preserving streaming semantics. See
[05 · Protocol Translation](05-protocol-translation.md).

### Auth Resolver

Resolves an API key to an identity, attaches account/org/user/role and capability
metadata, and enforces authentication. API keys authenticate by sha256 hash; new
or rotated keys may also keep encrypted recovery material for admin reveal. The
plaintext key never appears in telemetry or logs. The resolved identity
carries the per-key caps (`allowed_lanes`, `allow_custom_model`, rate/budget
limits, `degrade_lane`, memory mode) that later stages enforce. See
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).

### Rate Limiter

Per-key limiter (`packages/core/src/ratelimit`). Off by default
(`runtime.rate_limit.enabled`) — a zero-overhead pass-through when disabled. It
sits **after** auth (it needs the resolved `key_id`) and **before** classification
(so cost is cut off before any classify/eval call). It enforces both the system
default and any per-key RPM/TPM override on every request surface. See
[06](06-auth-and-rate-limits.md).

### Task Classifier

The classification cascade producing `task_type` / `complexity` / `confidence` /
`constraints`. Layer-1 rules are **always on** (pure, zero-network); Layer-2 eval
is **off by default** and runs only when Layer-1 confidence is below the threshold;
Layer-3 is the `balanced` fail-open sink. So the live default cascade is
**rules → balanced**. See [03 · Classification Cascade](03-classification.md).

### Policy Engine

Applies explicit server-side policies. Responsibilities:

- Walk the policy list in declaration order; the **first** policy whose `match`
  fully holds wins the lane pin (`use_lane`).
- Accumulate the `allowed_lanes` whitelist (intersection) across **every** matching
  policy, so a restrict policy placed after a pin policy still binds.
- Produce a single matched-policy record for telemetry.

### Lane Resolver

Collapses the classifier + policy outcome into exactly one lane. Responsibilities:

- Honor **explicit passthrough** first: when `allow_custom_model` is set and the
  request names a lane, that lane's chain is used; a known concrete model becomes
  a single-element chain (an unknown model is rejected as `invalid_request`, never
  silently re-routed). `auto` is never explicit — it always forces classification.
- Otherwise apply the routing priority: policy pin (`use_lane`) → lane named after
  the `task_type` → complexity-fallback lane (simple→economy, medium→balanced,
  complex→premium) → `balanced`.
- Fall back straight to `balanced` when the classifier itself fell back (the
  outcome is not re-derived).
- Apply **per-key caps last** as the outer bound, after the policy caps. A per-key
  `degrade_lane` forces the request onto that lane (clamped to `allowed_lanes`) and
  suppresses explicit-model passthrough; it is a forced selection, not a rank ceiling.

The resolver itself never trips circuit breakers or calls providers; that is the
execution stage's job.

### Signal Feedback

Agentic Signals are aggregated, redacted health observations produced by the
background signal collector from already-persisted decision records. When
`runtime.signal_feedback.enabled` is true, `routeRequest` reads the latest signal
for the selected ranked lane and may promote it to a stronger ranked lane with
healthier aggregate success/error/fallback rates. This stage is fail-open and
bounded by explicit passthrough, classifier fallback, policy pins, budget
degradation, and policy/key caps.

### Capability Filter

Prunes candidates that cannot satisfy the request (`packages/core/src/capability`).
It checks tool support, JSON / structured-output support, vision / multimodal
support, and context length, returning an explicit skip reason. A candidate with
no catalog entry stays fail-open (it is not over-pruned).

### Circuit Breaker

Tracks per-provider-model health (`packages/core/src/circuit`). Responsibilities:

- Skip a circuit in the `OPEN` state.
- Use a `HALF_OPEN` probe lock before a real call.
- Record a failure only **before** the first valid provider chunk; record success
  only **after** a valid chunk/response.
- Treat a client abort as a non-provider fault (it never trips the breaker).

### Provider Executor

Executes candidates in lane order (`packages/core/src/executor`,
`apps/gateway/src/routes/execute.ts`). Responsibilities:

- Walk the candidate chain (primary → fallback[]), in declaration order.
- Translate the request to the provider's native protocol.
- Handle streaming and non-streaming paths consistently.
- Return a structured attempt record per candidate.

When a candidate is an OAuth subscription alias (Claude Pro/Max, ChatGPT Codex,
or Copilot), the lane has selected the provider/model alias only. The OAuth pool
then selects the concrete serving account inside that provider pool, using the
configured account strategy, sticky session key, account priority, schedulable
state, usage cooldowns, and fresh quota snapshots.

### Telemetry / Request Log

Persists the routing decision, the provider-attempt chain, the auth/key identity,
the final OAuth serving account when a subscription pool served the request, and
cost & latency. Secrets are redacted; the decision record carries no message
bodies. Full request/response payloads are captured separately (governed by the
`capture_payloads` runtime setting, on by default) into a dedicated payload store
and aged out per `payload_retention_days`. The error model and Debug UI are in
[07 · Error Model & Observability](07-observability.md).

## Lanes

Helm exposes a small fixed set of **lanes** (the only abstraction clients steer
toward; provider aliases stay internal). The shipped set is three ranked
quality/cost lanes — `economy`, `balanced`, `premium` — plus four task lanes —
`coding`, `json`, `vision`, `tool_use`. `balanced` is **mandatory**: it is the
terminal of the classification fallback and the tail every other lane drops
through. The chains live in `config/lanes.yaml`; see
[04 · Routing & Lanes](04-routing-and-lanes.md).

## Memory middleware

Memory is **on by default** and overridable per request via the `x-memory-mode`
header, normalized in core. Absent a header and a per-key default, the mode
resolves to `inject`; newly created API keys are also minted with `inject`.
Setting `x-memory-mode: off` (or a key default of `off`) touches no storage.
`observe` writes the turn back to memory; `inject` additionally does a synchronous
read-back that **fully replaces the message array before routing**, then also
writes. Both phases are wired on the chat, messages, responses, and Gemini
`generateContent` text surfaces (when the mode is `observe`/`inject`) — not on
image-only or models/listing surfaces. A background `MemoryWorker` (observer /
reflector / decay jobs) runs process-wide by default and can be disabled via env.
See [08 · Memory](08-memory-middleware.md).

## Internal request shape

The normalized `InternalRequest` that every protocol adapter produces:

```yaml
request_id: string
protocol: openai_chat | anthropic_messages | openai_responses | gemini
account_id: string
api_key_id: string
user_id: string | null
org_id: string | null
requested_model: string         # "auto" means "let the router decide"
messages: array
tools: array | null
response_format: object | null
attachments: array | null
max_tokens: number | null
stream: boolean
metadata:
  conversation_id: string | null   # from x-session-key; drives session momentum
  # memory-scope fields (docs/08), parsed from request headers:
  thread_id: string | null
  resource_id: string | null
  project_id: string | null
  memory_mode: off | observe | inject
```

## Decision record

Every routed request produces a redacted `DecisionRecord` (no message bodies) that
feeds telemetry and the Debug UI. It captures the classifier outcome (including
`decided_by`: `rules | eval | default | fallback`), the matched policy, the
selected lane and expanded candidate chain, every provider attempt (with skip
reasons), the final outcome, `fallback_count` (execution-stage swaps only), a
cost breakdown, `serving_account` for the final OAuth subscription account when
applicable, and a `memory` block of counts/ids only (never memory content).
Field-level detail lives in [07 · Error Model & Observability](07-observability.md).

The classifier `decided_by` describes **only** the classification stage; the
execution-stage provider fallback is a separate mechanism recorded under
`provider_attempts` / `fallback_count` (principle 5). See
[04 · Routing & Lanes](04-routing-and-lanes.md).

## Configuration files

Configuration lives in `config/` and is loaded and Zod-validated at startup. An
invalid file fails closed: the gateway refuses to boot (principle 2).

```text
config/
  lanes.yaml           # default lanes + task lanes (the lane abstraction)
  policies.yaml        # server-side routing policies
  classifier.yaml      # Layer-1 rule dimensions/weights/boundaries + Layer-2 eval + cache
  providers.yaml       # provider aliases and credential (env-var) references
  capabilities.yaml    # manual capability overrides over the generated catalog
  pricing.yaml         # manual pricing overrides over the generated catalog
  auth.yaml            # require_api_key + admin auth source
  runtime.yaml         # store driver, rate limit, timeouts, request size, signal feedback
  server.yaml          # host / port
  memory.yaml          # forgetting/decay layer (observer compaction is auto, not configured)
  model-aliases.yaml   # virtual vendor-model-id → lane | "auto" rewrite map (compatibility shim, optional)
```

Capability and pricing data originate from a checked-in **generated catalog**
(`packages/core/src/catalog/generated/catalog.json`), synced from upstream and
treated as a supply-chain input. At runtime, manual entries in `capabilities.yaml`
/ `pricing.yaml` override the generated catalog per field. The catalog is never
fetched at runtime.

## Security rules

- Production routing uses only active lanes and active allowlists.
- Generated catalog metadata never directly drives runtime selection.
- Provider `*/auto` aliases sit only at the tail of a fallback chain unless
  explicitly configured otherwise.
- The generated catalog is a supply-chain input, not policy.
- The Debug UI must explain why a provider was selected or skipped.
- Secrets are never logged in plaintext; API keys authenticate by sha256 hash,
  with optional encrypted recovery material for the admin surface.

## Admin surface and deployment

Beyond the request pipeline, Helm has a **management plane** (Admin UI): a web
console for keys, lanes, policies, classifier, OAuth providers, memory,
request debugging/retry, and runtime settings/cleanup. Runtime-mutable settings
apply without a restart. It is independent of API traffic and authenticated with
HTTP Basic credentials (file / environment). The admin surface is mounted when
admin is enabled — i.e. when credentials are configured (auto-enable) OR
`HELM_ADMIN_ENABLED` / `admin.enabled` is set; otherwise `/admin` and
`/admin/api` return 404. See [11 · Admin UI](11-admin-ui.md).

Deployment: **open-source, self-hosted, one-command Docker**, config-as-code,
local storage by default (SQLite), no hard dependency on external services. A
Supabase/Postgres store driver is also supported. See
[10 · Deployment](10-deployment.md).
