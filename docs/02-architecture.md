# 02 · Architecture

## Overview

> See also [Architecture & Data Flow (diagrams)](architecture.md) — the same pipeline as sequence, flow, and state diagrams.

```text
Client
  -> API Gateway (Hono)
  -> Request Limits              # body size + whole-request timeout
  -> Auth Resolver               # mandatory API key (bootstrapped at first start)
  -> Rate Limiter                # per-key; off by default
  -> Concurrency / Budget Gates  # per-key; runtime/key controlled
  -> Protocol Adapter            # IR plus an optional verbatim native carrier
  -> (Memory Middleware)         # opt-in: inject first, then observe original input
  -> Task Classifier             # local rules -> optional eval -> terminal fallback
  -> Policy Engine
  -> Lane Resolver
  -> (Signal Feedback)           # opt-in ranked-lane health promotion
  -> Circuit Breaker
  -> Capability / Protocol Gates
  -> Provider Executor
  -> Protocol Response
  -> Deferred Telemetry / Payload / Memory Writes
```

Positioning: Helm is **nginx for LLMs** — a declaratively-configured model
gateway. Clients see standard protocol interfaces; model assignment and dispatch
are driven by boot YAML, Store-backed runtime settings, per-key controls, and the
pipeline above.

The gateway (`apps/gateway`) is the Hono composition root: it owns HTTP middleware,
route-specific authentication/error envelopes, provider client construction,
native passthrough, the concrete executor, static-app hosting, and background
workers. Classification, routing policy, protocol transforms, memory algorithms,
Store ports, and both SQLite/Postgres adapters live in `packages/core`, which
imports no web framework. `routeRequest`
(`packages/core/src/routing/route-request.ts`) is the framework-agnostic routing
orchestrator and accepts execution as an injected dependency, so the core can run
headless. `packages/shared` owns the Zod schemas/types. `apps/admin` and
`apps/portal` are separately built static SvelteKit SPAs.

## Components

Each component is summarized here; deeper design lives in its own chapter.

### API Gateway

Built on Hono. Responsibilities:

- Accept the routed generation surfaces: OpenAI Chat, Anthropic Messages,
  OpenAI Responses (HTTP/SSE and WebSocket creation, plus lifecycle helpers),
  Gemini `generateContent`/`streamGenerateContent`, OpenAI Images, and Gemini
  Interactions. Compatibility prefixes exist for Chat, Responses, and Gemini;
  [05 · Protocol Translation](05-protocol-translation.md) lists them exactly.
- Serve authenticated model discovery (`/v1/models`) and key-scoped usage
  (`/v1/usage/stats`).
- Normalize request headers, generate Helm's internal `request_id`, and resolve
  the independent client-facing `trace_id`.
- Apply the request timeout (`runtime.request_timeout_ms`); request-body size is
  enforced by the deployment's reverse proxy.
- Dispatch to the correct protocol adapter.

It also serves the public landing page, `/healthz`, `/version`, `/openapi.json`,
and `/docs`. The Admin UI/API is mounted under `/admin` when effective environment
configuration enables it: supplying both `HELM_ADMIN_USER` and
`HELM_ADMIN_PASSWORD` auto-enables it unless `HELM_ADMIN_ENABLED=false`; the flag
can also enable it explicitly. Disabled means 404; enabled without both
credentials mounts the surface but Basic Auth rejects every request with 401.
The checked-in YAML loader has no `admin.enabled` config file/field. The public
Portal shell is mounted unconditionally under `/portal`, while `/portal/api/*`
is bearer-key authenticated. `/mcp` is mounted only when Memory MCP is enabled
and the selected store supports its management methods.

`server.base_path` and its `HELM_BASE_PATH` override are parsed and validated but
are not currently used when Hono mounts routes. All surfaces above remain rooted
at `/`; keep the effective base path `/` until route-prefix composition is wired.

### Protocol Adapter

Normalizes each client protocol into the internal IR and translates responses
back to the client protocol, preserving streaming semantics. Anthropic,
Responses, and Gemini inputs also retain a sanitized verbatim `native_request`
carrier. With the default-on `native_protocol_passthrough` runtime setting, an
eligible same-protocol provider attempt can forward that carrier after Helm
rewrites governed fields such as model/auth/memory; cross-protocol attempts still
use IR translation. See
[05 · Protocol Translation](05-protocol-translation.md).

### Auth Resolver

Resolves an API key to an identity, attaches account/org/user/role and capability
metadata, and enforces authentication. API keys authenticate by sha256 hash; new
or rotated keys may also keep encrypted recovery material for admin reveal. The
plaintext key never appears in telemetry or logs. The resolved identity
carries the per-key caps (`allowed_lanes`, `blocked_models`,
`allow_custom_model`, Fast-mode permission, rate/budget/concurrency limits,
`degrade_lane`, and memory defaults) that later stages enforce. See
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).

### Rate Limiter

Per-key limiter (`packages/core/src/ratelimit`). Off by default
(`runtime.rate_limit.enabled`) — a zero-overhead pass-through when disabled. It
sits **after** auth (it needs the resolved `key_id`) and **before** classification
(so cost is cut off before any classify/eval call). It enforces both the system
default and any per-key RPM/TPM override on routed generation surfaces; read-only
model/usage/Portal/Admin endpoints are not charged by this gate. See
[06](06-auth-and-rate-limits.md).

### Concurrency and Budget Gates

The optional per-key concurrency overflow queue runs after rate limiting and
before classification. It is process-local, shared across the routed generation
surfaces, and only applies when `concurrency_queue_enabled` is on and the key has
a `concurrency_limit`; the lease is held until a stream finishes. Queue-full or
wait-timeout outcomes are 429.

Per-key rolling usage budgets are checked before routing. An over-budget key
either receives 429 (`reject`) or gets a forced `degrade_lane`; the key's
`allowed_lanes` remains the harder outer bound. Budget reads fail closed so a
store fault cannot silently bypass a cap. Settlement occurs after a served
request (after streamed usage/cost backfill when relevant) and fails open so an
accounting write cannot break an already-served response. See
[06](06-auth-and-rate-limits.md).

### Task Classifier

The classification cascade producing `task_type` / `complexity` / `confidence` /
`constraints`. Layer-1 rules are **always on** and zero-network; their pure
scorers may be adjusted by process-local session momentum. Layer-2 eval
is **off by default** and runs only when Layer-1 confidence is below the threshold;
Layer-3 emits a terminal fallback. The lane resolver uses the live
`runtime.default_lane` (`balanced` by default). So the shipped cascade is
**rules → terminal**, with no eval call unless enabled. See
[03 · Classification Cascade](03-classification.md).

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
  complex→premium) → the live terminal lane (`runtime.default_lane`, or
  `balanced` when missing/stale).
- Fall back straight to that live terminal lane when the classifier itself fell
  back (the outcome is not re-derived).
- Apply **per-key caps last** as the outer bound, after the policy caps. A per-key
  `degrade_lane` forces the request onto that lane (clamped to `allowed_lanes`) and
  suppresses explicit-model passthrough; it is a forced selection, not a rank ceiling.
- Filter `blocked_models` from every expanded candidate chain and reject a direct
  blocked model or a chain with no permitted candidate.
- On classified requests only, promote the requested model to the head when an
  equivalent concrete model already exists in the selected chain; this is
  reorder-only and is suppressed by alias-to-`auto` and budget degradation.

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

Prunes candidates that cannot satisfy the normalized request
(`packages/core/src/capability`). It checks tools, JSON object/schema support,
vision, streaming, cached content, context + requested output, and audio/video/
document modalities, returning an explicit skip reason. Protocol-history and
candidate-specific guards add further skips in the gateway executor. A candidate
with no catalog entry normally stays fail-open; required `cached_content` is the
notable fail-closed exception. Lane-level `constraints` are currently validated
metadata but are not passed into this filter; request shape is authoritative.

### Circuit Breaker

Tracks process-local health per routing alias (`packages/core/src/circuit`), not
per concrete OAuth account. Responsibilities:

- Skip a circuit in the `OPEN` state.
- Use a `HALF_OPEN` probe lock before a real call.
- Record a failure only **before** the first valid provider chunk; record success
  only **after** a valid chunk/response.
- Treat a client abort as a non-provider fault (it never trips the breaker).

### Provider Executor

Executes candidates in lane order (`apps/gateway/src/routes/execute.ts`; core
defines the attempt-record contract). Responsibilities:

- Walk the candidate chain (primary → fallback[]), in declaration order.
- Resolve the alias to a provider/client and real upstream `provider_model`.
- Gate breaker first, then capability/protocol/context compatibility.
- Translate to the provider protocol, or use eligible native passthrough.
- Handle streaming and non-streaming paths consistently.
- Return a structured attempt record per candidate and distinguish terminal
  invalid-request, capability-unsatisfiable, lane-unavailable, client-abort, and
  all-providers-failed outcomes.

When a candidate is an OAuth subscription alias (Claude Pro/Max, ChatGPT Codex,
Copilot, or experimental xAI), the lane has selected the provider/model alias
only. The OAuth pool
then selects the concrete serving account inside that provider pool, using the
configured account strategy, sticky session key, account priority, schedulable
state, usage cooldowns, and fresh quota snapshots.

An optional process-local per-account user-message queue serializes genuine user
turns sent to the same OAuth account and inserts a configured delay between
completions. Tool-result/assistant continuations bypass it. Its wait timeout is
terminal `lane_unavailable` (503) and does not fault the breaker or spill onto a
fallback, because doing so would bypass the operator's throttle.

### Telemetry / Request Log

Persists the routing decision, the provider-attempt chain, the auth/key identity,
the final OAuth serving account when a subscription pool served the request, and
cost & latency. Secrets are redacted; the decision record carries no message
bodies. Incremental Session transcripts and available semantic response snapshots
are the default content mode; full request/response payloads are optional and
governed by the mutually exclusive `capture_sessions` / `capture_payloads` runtime
settings. Both are aged out by
the independent scheduled cleanup runner when payload cleanup is enabled
(`payload_retention_days`, 30 by default). Redacted telemetry has its own
cleanup switch/window (90 days by default). The deferred write queue batches
telemetry, payload, and memory-observe writes and is drained during graceful
shutdown. The error model and Debug UI are in
[07 · Error Model & Observability](07-observability.md).

## Lanes

Helm exposes configured **lanes** (the abstraction clients steer toward; provider
aliases stay internal). The checked-in file currently has 22: three ranked
quality/cost lanes (`economy`, `balanced`, `premium`), four task lanes (`coding`,
`json`, `vision`, `tool_use`), 13 vendor-family compatibility lanes, and two
image lanes. The lane map must contain at least one lane, and the live terminal
fallback must name one of them (`balanced` is only the shipped default). Not every
task/image lane transitively includes `balanced`; the exact chains live in
`config/lanes.yaml`. See
[04 · Routing & Lanes](04-routing-and-lanes.md).

## Memory middleware

Memory is **off by default** for newly created user keys and for the bootstrap
root key. An explicit `x-memory-mode` header overrides the key default with
`off`, `observe`, or `inject`; `off` touches no memory storage. In `inject` mode,
the synchronous read/assembly happens **before** inbound observation, then one
trailing `<system-reminder>` user turn is appended while every live message and
the prompt-cache prefix remain unchanged. The original, non-injected request is
then observed; `observe` mode performs only this write. Outbound observation runs
after serving. These phases are wired on Chat, Messages, Responses, and Gemini
text generation—not on the dedicated image, discovery, or usage surfaces.

Observe writes are normally queued/batched; injection reads remain on the request
path. A process-wide `MemoryWorker` drains observer/reflector/decay/embedding jobs
by default and can be disabled by environment. The checked-in memory file enables
forgetting, while the schema fallback for an absent file disables it; neither
changes the per-key `off` default.
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
provider_raw: object | omitted       # normalized passthrough-only fields
native_request: object | omitted     # sanitized native carrier for same-protocol attempts
stream: boolean
metadata:
  trace_id: string | omitted       # HTTP gateway stamps client correlation; headless may omit
  conversation_id: string | null   # from x-session-key; drives session momentum
  # memory-scope fields (docs/08), parsed from request headers:
  thread_id: string | null
  resource_id: string | null
  project_id: string | null
  memory_mode: off | observe | inject
  client_billing_header: string | null
```

The schema also carries the OpenAI/LiteLLM controls that must survive routing
(`temperature`, sampling/penalty fields, `tool_choice`, reasoning, caching,
modalities, etc.) and trusted internal fields such as per-candidate attempt
timeout. `packages/shared/src/request/schema.ts` is the exhaustive source of
truth; the shape above shows the architectural fields rather than duplicating
every forwarded option.

## Decision record

Every routed request produces a redacted `DecisionRecord` (no message bodies) that
feeds telemetry and the Debug UI. It captures the classifier outcome (including
`decided_by`: `rules | eval | default | fallback`), the matched policy, the
selected lane and expanded candidate chain, every provider attempt (with skip
reasons), the final outcome, `fallback_count` (execution-stage swaps only), a
cost breakdown, `serving_account` for the final OAuth subscription account when
applicable, and a `memory` block of counts/ids only (never memory content).
It also records source/target protocol and native-passthrough mutation metadata
per attempt, redacted upstream error detail, served token/cost provenance,
stream outcome, and streamed generation duration when available. Its unique,
server-generated `request_id` is the telemetry/payload ownership key; the
independent `trace_id` is caller-facing correlation metadata and may repeat.
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
  lanes.yaml           # quality, task, vendor-family, and image lane chains
  policies.yaml        # server-side routing policies
  classifier.yaml      # Layer-1 rule dimensions/weights/boundaries + Layer-2 eval + cache
  providers.yaml       # provider aliases and credential (env-var) references
  capabilities.yaml    # manual capability overrides over the generated catalog
  pricing.yaml         # manual pricing overrides over the generated catalog
  auth.yaml            # require_api_key + root-key bootstrap policy
  runtime.yaml         # store driver, rate limit, timeouts, request size, signal feedback
  server.yaml          # host / port
  memory.yaml          # compaction, optional memory LLM/MCP, recall, forgetting/retention
  model-aliases.yaml   # virtual vendor-model-id → lane | "auto" rewrite map (compatibility shim, optional)
```

Capability and pricing data originate from a checked-in **generated catalog**
(`packages/core/src/catalog/generated/catalog.json`), synced from upstream and
treated as a supply-chain input. At runtime, manual entries in `capabilities.yaml`
/ `pricing.yaml` override the generated catalog per field. The catalog is never
fetched at runtime.

## Security rules

- API-key auth, rate/budget reads, configuration validation, and provider
  credential boundaries fail closed.
- Per-key lane/model caps are applied after policy routing; direct blocked-model
  requests are rejected before provider execution.
- Generated catalog metadata never directly drives runtime selection.
- Provider `*/auto` aliases sit only at the tail of a fallback chain unless
  explicitly configured otherwise.
- The generated catalog is a supply-chain input, not policy.
- The Debug UI must explain why a provider was selected or skipped.
- Secrets are never logged in plaintext; API keys authenticate by sha256 hash,
  with optional encrypted recovery material for the admin surface.

## Admin surface and deployment

Beyond the request pipeline, Helm has an operator **management plane** (Admin UI): a web
console for keys, lanes, policies, classifier, OAuth providers, memory,
request debugging/retry, and runtime settings/cleanup. Runtime-mutable settings
apply without a restart and persist in the Store's `config_kv` table. It is
independent of API traffic and authenticated with HTTP Basic credentials from
`HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`; credentials auto-enable it unless the
environment toggle explicitly disables it. See [11 · Admin UI](11-admin-ui.md).

The customer **self-service plane** is a separate static Portal under `/portal`.
Its shell is public, but every `/portal/api/*` read/write is bearer-key scoped;
it exposes only the caller's identity/caps, usage, owned requests/payloads, and
memory settings. The optional Memory MCP endpoint is also account-scoped to the
authenticated key and can accept raw Helm keys or its optional OAuth shim. See
[12 · Self-Service Portal](12-self-service-portal.md) and
[13 · Memory Admin & MCP](13-memory-admin-and-mcp.md).

Deployment: **open-source, self-hosted, one-command Docker**, config-as-code,
local storage by default (SQLite), no hard dependency on external services. A
Supabase/Postgres store driver is also supported. See
[10 · Deployment](10-deployment.md).
