# 09 · Delivery Status and Roadmap

> Status: **production implementation**. This chapter is a current delivery map,
> not the original phase plan. The running version is defined by
> [`package.json`](../package.json); source, route wiring, schemas, and tests are
> authoritative.

Helm is no longer a gateway skeleton. The routing pipeline, four translated text
faces, image generation, key governance, OAuth pools, memory subsystem, admin UI,
self-service portal, two storage adapters, cleanup, and release automation all
ship. The final sections list the remaining implementation boundaries explicitly
so a design document is not mistaken for completed behavior.

## Delivered

### Routing and execution

- Framework-independent `packages/core` with an architecture test preventing
  Hono/SvelteKit imports.
- Deterministic Layer-1 classification, optional cached Layer-2 eval (off by
  default), and configurable default-lane fallback.
- Declarative quality, task, vendor-family, and image lanes; recursive expansion,
  deduplication, cycle protection, policies, per-key lane caps, absolute model
  blocking, compatibility aliases, requested-model promotion, and opt-in Agentic
  Signals promotion.
- Capability filtering, circuit breaker with a single HALF_OPEN probe,
  pre-first-byte retries, stream-idle watchdog, provider fallback, free-tier 429
  skipping, and client-abort isolation.
- Static API-key providers and pooled OAuth subscriptions for Anthropic,
  OpenAI Codex, GitHub Copilot, and experimental xAI/SuperGrok, including live
  curation, proxies, scheduling, quota/cooldown state, and guarded reset credits.

See [03 · Classification](03-classification.md) and
[04 · Routing & Lanes](04-routing-and-lanes.md).

### Public and compatibility surfaces

- OpenAI Chat Completions, including `/chat`, Azure deployment, and engine
  compatibility aliases.
- Anthropic Messages plus `count_tokens` and the Claude event-logging compatibility
  sink.
- OpenAI Responses over HTTP and inbound WebSocket, including input-token,
  compaction, retrieve/delete/cancel/input-items lifecycle helpers where the
  selected provider supports them.
- Google Gemini `generateContent` / `streamGenerateContent` on both `/v1beta/models`
  and `/models` compatibility paths.
- OpenAI Images and Gemini Interactions image generation, with image-lane failover.
- Key-aware model discovery and key-scoped usage statistics.
- Same-protocol native passthrough, cross-protocol translation, streaming state
  machines, tool/reasoning/media handling, mutation ledgers, and protocol-shaped
  errors.

`/docs` and `/openapi.json` describe the headline public API; they are not a
complete inventory of compatibility, lifecycle, admin, portal, or MCP routes.
See [05 · Protocol Translation](05-protocol-translation.md) and
[Protocol Compatibility](protocol-compatibility.md) for the complete contract.

### Authentication, governance, and user surfaces

- Mandatory SHA-256 API-key authentication. A first-run root key can be generated,
  written once to the configured `0600` recovery file, and printed once.
- Key naming, rotation, reveal when encrypted recovery material exists, soft
  revocation, explicit post-revocation deletion, lane/model/Fast-mode controls,
  RPM/TPM limiting, rolling request/token/spend budgets, concurrency queues, and
  per-key memory defaults.
- Basic-authenticated admin SPA with global routing/provider/key/memory/telemetry/
  settings/cleanup control.
- Bearer-authenticated `/portal` SPA with own-key usage and budgets, connection
  help, ownership-gated request/payload inspection, and scoped memory curation.

See [06 · Auth & Rate Limits](06-auth-and-rate-limits.md),
[11 · Admin UI](11-admin-ui.md), and
[Self-Service Portal](12-self-service-portal.md).

### Observability, storage, and operations

- Redacted `DecisionRecord` with classification, policies, attempts, protocol/
  passthrough metadata, final model/account, stream outcome, token provenance,
  cost provenance, and memory metadata.
- Separate full-payload parts with runtime capture control and scheduled retention.
- Deferred/batched writes, maintained memory summary counters, admin
  single-flight/stale caches, structured logs, graceful drain, and scheduled
  data cleanup/archive controls.
- SQLite by default and Postgres/Supabase through the same Store ports; migrations
  for both, with SQLite VACUUM exposed as an explicit/off-hours operation.
- Docker image with admin and portal static assets, health/version endpoints,
  unit/type/lint/build/Playwright/Docker CI jobs, and automated GHCR/GitHub releases.

See [07 · Observability](07-observability.md) and
[10 · Deployment](10-deployment.md).

### Memory

- Per-key `off` / `observe` / `inject` modes; new and root keys default to `off`,
  while explicit request headers can override user-key defaults.
- Account/project/thread isolation, automatic thread-signal derivation when a key
  opts into it, cache-friendly trailing-turn injection, observation/reflection
  workers, adaptive compaction, deterministic summarization, and an optional
  fail-open LLM path.
- Deterministic forgetting, reinforcement, archive/retention, eager salient-fact
  extraction, fact injection, and hybrid vector/full-text/score recall.
- Admin memory management, bearer-scoped Memory MCP tools, and the optional MCP
  OAuth 2.1 compatibility shim.

See [08 · Memory Middleware](08-memory-middleware.md),
[12 · Forgetting & Tiering](12-memory-forgetting-and-tiering.md),
[13 · Memory Admin & MCP](13-memory-admin-and-mcp.md), and
[14 · Deep Recall](14-memory-deep-recall.md).

## Remaining implementation gaps

These are current code boundaries, not promises hidden behind optimistic prose:

1. **Route base path.** `server.base_path` / `HELM_BASE_PATH` is parsed and
   validated, but the gateway still mounts routes at `/`. Deploy behind a reverse
   proxy for prefixing and keep the configured value `/` until mounting support is
   implemented.
2. **OpenAPI completeness.** The generated OpenAPI document covers the headline
   inference, image, model, usage, health, and version routes. Responses lifecycle,
   inbound WebSocket, Anthropic helper aliases, MCP/OAuth, portal, and admin routes
   are documented in prose/tests but are not all emitted into OpenAPI.
3. **Cluster-wide coordination.** Postgres makes durable stores shareable, but the
   circuit breaker, model/quota caches, sticky maps, admin refresh coordinator,
   write queue, and several schedulers are process-local. Auth cache invalidation
   across replicas is TTL-bounded. Multi-replica operation therefore does not yet
   provide a distributed breaker or one global refresh/scheduler lease.
4. **Compose environment forwarding.** The checked-in Compose file forwards only
   the variables listed in its `environment:` block. `.env` is interpolation, not
   an automatic `env_file`; optional provider/runtime variables require explicit
   forwarding.
5. **Memory contradiction supersede.** The deterministic supersede/reconciliation
   path ships, but `consolidate.enable_llm_supersede: true` is deliberately rejected
   because the separate LLM contradiction-discovery path is not wired.
6. **Recall reranking.** Hybrid fact recall ships; a cross-encoder reranker remains
   out of scope. Vector recall also requires a configured embedding model and
   driver support; otherwise recall intentionally uses full-text + score only.
7. **Protocol/provider edges.** The 4x4 translation matrix is covered, but some
   provider-specific lifecycle, remote-media, server-tool, and modality semantics
   cannot be losslessly generalized. Current concrete gaps include: translated
   non-stream Responses can expose top-level `provider_raw`; multiple
   choices/candidates collapse to the first result on some target faces;
   IR-generated images (for example, Gemini `inlineData` output) are not rendered
   by the translated Responses response path;
   Anthropic-target data-loss warnings are not consumed by the shipping executor;
   annotations re-render only to Chat/Responses; advanced Gemini fields rely on
   native passthrough for best fidelity; Responses WebSocket
   `response.cancelled` is not treated as terminal; and Responses usage does not
   preserve every modality-detail field. The canonical evidence is kept in
   [Protocol Compatibility](protocol-compatibility.md) and the
   [LiteLLM Gap Record](protocol-translation-litellm-gap-spec.md).
8. **Parsed routing controls that are not fully active.** `lane.constraints` is
   schema/admin-visible but is not carried into `ExecutionPlan`; capability gates
   currently come from request-derived constraints. `classifier.rules.enabled`
   does not disable Layer 1, and `eval.cache.enabled` does not disable the eval
   cache. Policies accept `project_id`, but the live policy context always supplies
   `null`, so a string project policy cannot match. Finally, `allowed_lanes` is
   enforced only when the array is non-empty: `[]` (including a disjoint policy
   intersection) currently behaves as unconstrained rather than deny-all.
9. **Admin YAML configuration.** `resolveAdminAuth` accepts a config object for
   direct callers/tests, but the shipping `loadConfig()` schema has no admin path.
   `buildServer()` admin enablement and credentials are therefore effectively
   `HELM_ADMIN_*` environment-only.
10. **Memory recall/observability edges.** Hybrid P8 recall is exposed through
    `memory_recall` MCP; it is not automatic per-turn fact retrieval in the inject
    path. Manual fact mutations do not enqueue an embedding immediately, so the
    vector leg can lag until the embedding worker discovers the row. The Postgres
    vector path requires `pgvector` and currently has no ANN index. Memory worker
    cost-sink interfaces are wired as no-ops in the composition root, and the
    `DecisionRecord.memory` block does not report injected-fact ids/counts.

## Deliberate non-goals

- No hosted SaaS control plane, customer billing ledger, markup, or account-level
  credit system. Helm's budgets are per API key and operator-owned.
- No multi-user admin RBAC. Admin Basic auth is one trusted operator boundary;
  key holders use the isolated portal.
- No Redis or mandatory external queue. This keeps a single-node deployment small,
  with the process-local scaling tradeoffs stated above.
- No promise that consumer subscription routing is permitted by a provider's
  terms. Claude/ChatGPT/Copilot subscription use is opt-in; xAI remains explicitly
  experimental until a stable third-party contract exists.
- No silent best-effort for unsupported security/config knobs. Invalid config,
  unknown fields on strict schemas, missing required secrets, and unsupported
  enabled features fail closed.

## Current acceptance boundary

A release is considered complete only when the relevant behavior is proven in the
smallest appropriate layer (pure/core test, gateway route test, protocol matrix,
or browser e2e), the workspace quality gates pass, the Docker image boots, and
`/version` identifies the intended build. Production deployment additionally
requires health, container, log, and changed-business-route evidence; a merged
commit or published tag alone is not runtime proof.
