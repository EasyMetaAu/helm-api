# 07 · Error Model & Observability

> Status: **implemented**. The structured error model, the redacted
> decision record, and the separate full-payload capture all ship.

This chapter covers the error model, the redacted decision record, the separate
payload capture, and what the Debug UI surfaces. The decision record's structural
place in the pipeline is described in [02 · Architecture](02-architecture.md).

## Error model

Every error is **structured** and is returned in the **error shape of the
protocol the client used** (an OpenAI client gets an OpenAI-shaped error; an
Anthropic client gets an Anthropic-shaped error), so existing SDKs parse it
without special casing.

The unified internal error (`HelmError`, single source of truth in
`packages/shared/src/error/schema.ts`):

```ts
{
  error_class: "auth_error" | "invalid_request" | "lane_unavailable"
             | "all_providers_failed" | "capability_unsatisfiable"
             | "upstream_error" | "timeout" | "rate_limited" | "client_abort",
  http_status: number,                          // mapped from error_class (see below)
  message: string,                              // redacted, human-readable
  trace_id: string,                             // links the decision record; restorable in the Debug UI
  provider_raw: Record<string, unknown> | null, // upstream raw error (redacted), for debugging
}
```

The `error_class → HTTP status` map is authoritative (`ERROR_CLASS_HTTP_STATUS`),
and `makeHelmError` guarantees `http_status` always agrees with the class —
callers cannot supply a mismatched status:

| `error_class` | HTTP | Meaning |
|---|---|---|
| `auth_error` | 401 | Missing / invalid key |
| `invalid_request` | 400 | Malformed request / protocol field error |
| `lane_unavailable` | 503 | The selected lane has no usable candidate |
| `all_providers_failed` | 502 | The whole candidate chain failed |
| `capability_unsatisfiable` | 422 | No candidate satisfies the capability constraints (e.g. forced JSON / vision) |
| `upstream_error` | 502 | An upstream provider returned an error |
| `timeout` | 504 | Timed out |
| `rate_limited` | 429 | Rate limit tripped |
| `client_abort` | 499 | Client disconnected mid-request (not a provider fault); the executor stops the chain and records this instead of `upstream_error` |

Per **Principle 7**, `message` and `provider_raw` must already be redacted by the
producer. The Protocol Adapter's response-out stage translates this unified error
into each client protocol's error shape (see [05 · Protocol
Translation](05-protocol-translation.md)).

Two cases never become a generic 5xx leak (`apps/gateway/src/middleware/error-handler.ts`):

- An **unknown / non-`HelmError` throw** falls back to a redacted
  `upstream_error` (502) — fail-open (Principle 3), with no stack or raw message
  leaked to the client.
- A **client-initiated disconnect** is not a provider fault and not a server
  timeout: the handler detects the client's own abort signal and returns **499**
  (not a 5xx, no synthesized 504; see [02 · Architecture](02-architecture.md)).

## Decision record (redacted)

For every request the gateway persists a `DecisionRecord` (single source of truth
in `packages/shared/src/decision/schema.ts`) via the `TelemetryStore`. It is the
full routing trail and is **redacted** as defence-in-depth — it carries no
plaintext key and no private payload. The record holds:

- `request_id` / `trace_id` (correlation across logs and the Debug UI);
  `requested_model`; `key_prefix` (display prefix only, e.g. `helm_live_ab12`,
  never the plaintext key).
- `classifier`: `task_type`, `complexity`, `confidence`, **`decided_by`**
  (`rules` / `eval` / `default` / `fallback`), `eval_cache_hit`,
  `fallback_reason`, `constraints`, and `explanation` (matched dimensions /
  signals). When opt-in Agentic Signals feedback promotes a ranked lane, the
  explanation includes a redacted `routing_signal_feedback` item with from/to
  lanes, thresholds, and aggregate signal summaries.
- `policy`: the matched policy id and a reason.
- `lane`: the selected lane and the ordered candidate chain.
- `provider_attempts[]`: per attempt — alias, `skipped` + `skip_reason`, status,
  `error_class`, latency, cost, and `error_detail` (the real upstream status +
  redacted message + redacted `provider_raw`, captured even when a later
  candidate served the request).
- `final`: the served model alias / provider model, status, and error reason.
- `latency_total_ms`, `fallback_count` (execution-stage count), and
  `cost_breakdown` (`eval_usd` / `completion_usd` / `total_usd`).
- `memory`: stamped by the gateway **after** the inject phase ran (the routing
  core never touches memory); `null` when memory inject was off / skipped /
  failed. Counts and ids only — **never memory content** (Principle 7):
  `memory_hydrated`, `reflection_version`, `observation_count`,
  `memory_tokens_injected`, `observer_job_id`, `memory_writeback_status`
  (`queued` / `skipped` / `failed`), `degraded`, and `thread_source` (which
  fallback-chain link produced the thread anchor). See [08 ·
  Memory](08-memory-middleware.md).

Per **Principle 5**, the **classification** fallback (`classifier.decided_by` /
`fallback_reason`) and the **execution** fallback (`provider_attempts` /
`fallback_count`) are separate fields and are never conflated.

### Redaction

`packages/core/src/telemetry/redaction.ts` is the last gate before anything is
persisted or logged. It is pure (never mutates its input) and framework-agnostic:

- Plaintext keys / credentials → irreversible `sha256:<prefix>` fingerprints
  (reconcilable with the keystore hash, not reversible to plaintext).
- Private payload fields (`messages`, `attachments`, `prompt`, `content`,
  `input`) → summaries (kind + size), not their contents.
- Keys matching the secret pattern (`api_key`, `authorization`, `password`,
  `secret`, `token`, `credential`) are handled **by value type**: a **string**
  is fingerprinted, an **object / array** is summarized (it could hold
  credentials), but a **scalar** (number, boolean, null, undefined) passes
  through **verbatim** — it can never carry key material, and summarizing it
  would corrupt a legitimate counter. This is why `memory_tokens_injected` (a
  token *count* whose name matches `token`) survives intact; persisting it as
  `{redacted:true,kind:"number"}` previously broke the schema on read and 502-ed
  the requests list.
- `key_prefix` deliberately does **not** match the secret pattern (it is a
  display fragment, not a credential), so it survives redaction and reaches the
  Debug UI.
- Non-sensitive fields (`trace_id`, latency, cost, status, …) pass through
  verbatim.

## Full payload capture

Separately from the redacted decision record, Helm can record the **complete,
verbatim** request and response bodies into a dedicated `request_payloads` table
(`InsertPayloadInput` / `getPayload` / `prunePayloads` on the `TelemetryStore`).
This is deliberately split from the decision record so it prunes independently and
never bloats the decision JSON.

- `capture_payloads` defaults to **ON** (`RuntimeSettingsSchema`) and is
  toggleable at runtime from the admin "System Settings" page; toggled off, the
  capture path is skipped entirely (zero storage).
- `payload_retention_days` (default 30) bounds the storage footprint and the
  exposure window; older payloads are auto-pruned.
- Capture is **not** redacted — it is the verbatim client request body plus the
  assembled provider response. It still carries no plaintext API key, because the
  bearer key lives in the `Authorization` header, never in the chat body that is
  stored.
- Writes are idempotent (upsert by `request_id`): a streamed response may write
  the request first, then backfill the assembled response.

## Debug UI

The admin Debug UI ([11 · Admin UI](11-admin-ui.md)) is a pure consumer of the
redacted decision record plus the optional captured payload.

The request **list** shows per row: time, key prefix, requested model, classified
task type, complexity, the decision stage (`decided_by`: rules / eval / default /
fallback), selected lane, final model, fallback count, status, latency, cost, and
error reason.

The request **detail** shows: request metadata, the classifier output (with
confidence and matched dimensions/signals), whether eval ran and whether it hit
the cache, the matched policy, the lane candidate chain, every provider attempt
(including upstream `error_detail`), the final response metadata or structured
error, the cost split (including eval's own self-cost), and the trace id. When
`capture_payloads` is on and the row is present, the detail can also load the full
captured request/response bodies.
