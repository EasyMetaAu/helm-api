# 02 · Architecture

## Overview

```text
Client
  -> API Gateway (Hono)
  -> Auth Resolver               # mandatory API key (bootstrapped at first start)
  -> Rate Limiter                # per-key; off by default
  -> Protocol Adapter
  -> Task Classifier             # three-layer cascade: rules -> eval -> balanced
  -> Policy Engine
  -> Lane Resolver
  -> Capability Filter
  -> Circuit Breaker
  -> Provider Executor
  -> Telemetry / Request Log
  -> (Memory Middleware)         # observe phase wired on every surface
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
  `/v1/responses`, and `/v1beta/models/{model}:generateContent` (Gemini).
- Normalize request headers and the request/trace id.
- Apply request-size and timeout limits (`runtime.max_request_bytes`,
  `runtime.request_timeout_ms`).
- Dispatch to the correct protocol adapter.

It also serves `/healthz` and `/version`, and (when admin credentials are
configured) mounts the Admin UI and admin API under `/admin`.

### Protocol Adapter

Normalizes each client protocol into the internal IR and translates responses
back to the client protocol, preserving streaming semantics. See
[05 · Protocol Translation](05-protocol-translation.md).

### Auth Resolver

Resolves an API key to an identity, attaches account/org/user/role and capability
metadata, and enforces authentication. API keys are stored only as a sha256 hash;
the plaintext key never appears in telemetry or logs. See
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md).

### Rate Limiter

Per-key limiter (`packages/core/src/ratelimit`). Off by default
(`runtime.rate_limit.enabled`) — a zero-overhead pass-through when disabled. It
sits **after** auth (it needs the resolved `key_id`) and **before** classification
(so cost is cut off before any classify/eval call). It enforces both the system
default and any per-key RPM/TPM override on every request surface. See
[06](06-auth-and-rate-limits.md).

### Task Classifier

The three-layer classification cascade (rules → optional eval → balanced),
producing `task_type` / `complexity` / `confidence` / `constraints`. See
[03 · Classification Cascade](03-classification.md).

### Policy Engine

Applies explicit server-side policies. Responsibilities:

- Walk the policy list in declaration order; the **first** policy whose `match`
  fully holds wins the lane pin (`use_lane`).
- Accumulate caps (`max_lane` / `allowed_lanes`) across **every** matching policy,
  so a cap policy placed after a pin policy still binds.
- Produce a single matched-policy record for telemetry.

### Lane Resolver

Collapses the classifier + policy outcome into exactly one lane. Responsibilities:

- Apply the routing priority (policy pin → task lane → complexity-fallback lane).
- Fall back to `balanced` when the classifier itself fell back, or when no lane
  resolves.
- Preserve the lane's declared primary/fallback order (chain expansion happens in
  the orchestrator, not here).

The resolver itself never trips circuit breakers or calls providers; that is the
execution stage's job.

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

### Telemetry / Request Log

Persists the routing decision, the provider-attempt chain, the auth/key identity,
and cost & latency. Secrets are redacted; the decision record carries no message
bodies. Full request/response payloads are captured separately (governed by the
`capture_payloads` runtime setting, on by default) into a dedicated payload store
and aged out per `payload_retention_days`. The error model and Debug UI are in
[07 · Error Model & Observability](07-observability.md).

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

> Note: `protocol` is one of the four wired protocols. The Gemini value is
> emitted by the Gemini inbound surface (`POST /v1beta/models/{model}:generateContent`),
> which is routed through the same core pipeline (see
> [01 · Overview](01-overview.md)).

## Decision record

Every routed request produces a redacted `DecisionRecord` (no message bodies),
which feeds telemetry and the Debug UI:

```yaml
request_id: string
trace_id: string
requested_model: string
key_prefix: string | null          # display prefix only, never the plaintext key
classifier:
  task_type: string
  complexity: string
  confidence: number
  decided_by: rules | eval | default | fallback   # which layer picked the lane
  eval_cache_hit: boolean | null     # only meaningful when eval ran
  fallback_reason: string | null     # eval_disabled / eval_<reason> (only on "fallback")
  constraints: object
  explanation: array
policy:
  matched_policy_id: string | null
  reason: string
lane:
  selected_lane: string
  candidate_chain: array             # expanded primary + fallback aliases
provider_attempts:
  - alias: string
    skipped: boolean
    skip_reason: string | null       # circuit_open | capability:<reason> | free_429 | ...
    status: ok | error
    error_class: string | null
    latency_ms: number
    cost_usd: number | null
    error_detail: object | null      # redacted upstream failure detail
final:
  model_alias: string | null
  provider_model: string | null
  status: ok | error
  error_reason: string | null
latency_total_ms: number
fallback_count: number               # EXECUTION-stage swaps (served attempts - 1)
cost_breakdown:
  eval_usd: number | null            # Layer-2 small-model self-cost
  completion_usd: number | null      # sum of served attempts' cost
  total_usd: number | null
```

`decided_by` describes **only** the classification stage. The execution-stage
provider fallback is a separate mechanism recorded under `provider_attempts` /
`fallback_count`; the two fallbacks are never conflated (principle 5). See
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
  runtime.yaml         # store driver, rate limit, timeouts, request size
  server.yaml          # host / port
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
- Secrets are never logged in plaintext; API keys are stored as a sha256 hash.

## Admin surface and deployment

Beyond the request pipeline, Helm has a **management plane** (Admin UI): a web
console for basic rule management (lanes / policies / classifier / keys) and
request debugging, plus a "System Settings" page for runtime-mutable settings
(payload capture, retention, the rate-limit switch, log level) that apply without
a restart. It is independent of API traffic and authenticated with HTTP Basic
credentials (file / environment). The admin surface is mounted **only** when
credentials are configured; otherwise `/admin` and `/admin/api` return 404. See
[11 · Admin UI](11-admin-ui.md).

Deployment: **open-source, self-hosted, one-command Docker**, config-as-code,
local storage by default (SQLite), no hard dependency on external services. A
Supabase/Postgres store driver is also supported. See
[10 · Deployment](10-deployment.md).
