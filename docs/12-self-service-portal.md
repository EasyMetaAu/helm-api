# Self-Service Portal

> Status: **implemented**. The static SvelteKit portal ships in the gateway image
> at `/portal`; its JSON API is mounted at `/portal/api/*` and is authenticated by
> the caller's Helm API key.

The portal is the API-key holder's view of Helm. It is intentionally not a small
admin console:

- the **admin UI** is an operator surface with global, writable access to routing,
  providers, keys, telemetry, and maintenance;
- the **portal** is scoped to the current key and exposes connection help, that
  key's usage and requests, and its memory pool.

The implementation lives in `apps/portal`,
`apps/gateway/src/routes/portal`, and
`packages/shared/src/decision/portal-view.ts`.

## Trust boundary and sign-in

The portal SPA is served unconditionally from `/portal`, independently of whether
the admin UI is enabled. The data API uses the same mandatory key authentication
as the model routes:

```http
Authorization: Bearer <helm-api-key>
```

The sign-in page stores the plaintext key in **`sessionStorage` only**. It is not
put in a cookie, `localStorage`, a URL, or an API body. Closing the browser tab
clears the browser session. Every portal API and MCP request sends the key in the
Authorization header.

The static shell is built with a strict Content Security Policy: scripts,
connections, images, forms, and framing are limited to the gateway origin (images
may also use `data:` URLs). The gateway sends the response-header policy and the
Svelte build embeds the hash needed by its bootstrap script.

Use HTTPS whenever the portal is reachable beyond localhost. The portal is not an
identity provider: possession of the API key is the login credential.

## Pages that ship

| Page | What the key holder can do |
|---|---|
| `/portal/login` | Paste a Helm key and validate it against the bearer-scoped API. |
| `/portal/` | View request, success, token, cost, latency, and throughput totals; budget progress; time-series charts; model distribution; and recent requests. |
| `/portal/connect` | Copy setup instructions for Claude Code, Codex, OpenAI-compatible SDKs, and Memory MCP when the MCP surface is available. |
| `/portal/requests` | Filter and page through this key's requests by time, status, model, or lane. |
| `/portal/requests/{requestId}` | View the customer-safe result, token/cost summary, and captured client request/response payload for an owned Helm request. |
| `/portal/memory` | Browse, search, add, edit, archive/restore, and delete facts; edit/delete reflections; and change this key's memory defaults. The content operations call `/mcp`. |
| `/portal/account` | Inspect the key's lane/rate/budget/memory settings. Operator-owned settings remain read-only. |

The portal ships seven locales: English, Simplified Chinese, Traditional Chinese,
Japanese, Korean, Spanish, and Portuguese.

## Bearer-scoped API

Every handler derives scope from `c.get("identity")`. Caller-supplied `key_id` or
`account_id` values are never trusted.

| Method and path | Contract |
|---|---|
| `GET /portal/api/me` | Safe projection of key prefix, role, allowed lanes, rate limits, budgets, and effective memory settings. Never returns hash, plaintext, or encrypted recovery material. |
| `PATCH /portal/api/memory-settings` | Changes only `memory_mode`, `memory_project_id`, and `memory_thread_source` for the current non-root key. Unknown/admin-owned fields are rejected. Root memory settings are read-only. |
| `GET /portal/api/usage/stats` | Aggregates only the authenticated `key_id`; returns totals, hourly/daily series, public model labels, and budget caps. Internal wire-model names are mapped to a public alias or `other`. |
| `GET /portal/api/requests` | Paginated, filtered request list with `apiKeyId` forced to the authenticated key. |
| `GET /portal/api/requests/{requestId}` | Ownership-gated, whitelist-projected request detail. The identifier is the unique value returned in `X-Helm-Request-Id`. A separate scoped client-trace lookup is described below. |
| `GET /portal/api/requests/{requestId}/payload?part=meta\|request\|response\|upstream_request` | Lazy access to the owned request, response, and forwarded body. Stored parts use encoded transport. |

The portal does not expose management APIs for key rotation, revocation, budgets,
rate limits, lane caps, provider accounts, runtime settings, or cleanup. The
owner-approved replay API below runs as ordinary traffic under the caller key.

## Request privacy and ownership

Telemetry lookup by request id is not self-scoping at the Store-port level, so the
portal applies an explicit guard before reading a record or payload:

1. read `getApiKeyId(requestId)`;
2. compare it with `identity.keyId`;
3. return the same `404 request not found` for a missing request and a request owned by
   another key;
4. only then read the decision record or payload.

This ordering prevents both cross-key reads and request-id existence probing.

`toPortalDecisionView()` remains the compact list projection. The single-request
endpoint also returns a schema-validated, credential-redacted `decision` containing
the recorded routing, classifier/eval, policy, provider attempts, wire model,
token/cost breakdown, and permitted upstream diagnostics. Upstream identities are
stable pseudonyms; stacks, causes, installation IDs, and unapproved headers are
removed. No management action or cross-key access is granted.

The detail viewer lazily reads request, response, and forwarded upstream bodies.
It uses the same fidelity markers and bounded session reconstruction as admin.
Session recovery additionally verifies the stored session belongs to the request's
key; exact payload reads do not require a session row. `metadata_only` requests do
not expose retained legacy bodies. Missing captures and pruned records remain
explicitly unavailable rather than fabricating content.

Stored bodies use encoded transport without server-side global blob expansion.
Non-streamed encoded reads acquire the shared response-work budget before a
size-bounded, single-table read; the lease is released after consumption/cancellation.
Portal does not expose the admin global blob endpoint. A request-scoped blob endpoint serves newly recorded, verified image references.
Historical externalized image references without recorded per-request provenance
remain unavailable; an arbitrary sentinel is never proof of ownership. Inline and URL images continue to render.

`GET /portal/api/requests/{requestId}/session-revisions` exposes bounded revision
pages only after request and session ownership checks, allowing browser-side
reconstruction when server-side recovery is too large.

## Memory scope

Memory has two nested boundaries:

- `account_id` is the hard tenant boundary and always comes from authentication;
- the effective project is `memory_project_id ?? key_id`.

The default therefore gives each key a private project. An operator or key holder
may set the same explicit project id on several keys in one account to share a
memory pool intentionally. The portal labels that state as shared. Changing a
project selects another pool; it does not migrate facts from the old pool.

The key's `memory_mode` controls automatic request observation/injection, not
whether an authenticated holder may curate already-stored memory. New keys are
minted with `memory_mode: off`; the holder can opt into `observe` or `inject` from
the portal. Explicit `x-memory-*` request headers still take precedence. See
[08 · Memory Middleware](08-memory-middleware.md).

Fact/reflection content operations use `POST /mcp`, so the portal Memory page
requires `memory.mcp.enabled: true`. The MCP server derives account/project scope
from the same bearer key; the browser never sends an account id or project id as a
trust input. See [13 · Memory Admin & MCP](13-memory-admin-and-mcp.md).

## Deployment and verification

`pnpm build` builds `apps/portal/build`; the Dockerfile copies it into the runtime
image, and the gateway serves it with SPA fallback routing. Portal REST routes are
registered even when the admin surface is disabled.

The security contract is covered by targeted tests for:

- cross-key list/detail/payload isolation and ownership-before-read ordering;
- `404` equivalence for missing and foreign request ids;
- whitelist projection of decision records and provider/wire-model non-disclosure;
- strict writable memory settings and root-key rejection;
- CSP/static routing and session-storage browser behavior;
- portal request, payload, memory, and localization UI behavior.

## Deliberate boundaries

- No user accounts, password login, teams, or server-side sessions.
- No self-service key creation, rotation, revocation, or sub-keys.
- No editing of budgets, limits, allowed lanes, blocked models, or provider policy.
- No real upstream account identities or provider-account management.
- No replay with operator privileges or another key's identity.
- No cross-key/global memory or telemetry views.

Management operations belong to the Basic-authenticated admin UI described in
[11 · Admin UI](11-admin-ui.md).


## Debug API contract — 2026-11-28

This backend contract is available independently of the Portal UI. No UI change
is required to deploy it. All paths below start with `/portal/api`; all require
bearer-key authentication. `key_id` and `account_id` parameters never change the
scope. Request-resource reads use `Cache-Control: no-store`.

### Account and usage

`GET /me` returns the following object. `null` rate limits inherit operator
defaults; `null` concurrency means no per-key concurrency limit. Content mode is
the key override, or the current runtime mode when the override is unset.
Retention applies to captured payloads and sessions. Embedded/custom route users
without runtime settings receive a null retention rather than an invented value.

```ts
type Budget = {
  requests: number | null;
  tokens: number | null;
  spend_usd: number | null;
  window_seconds: number | null;
  weekly_anchor: string | null;
  current_cycle: null | {
    period_start: string; // ISO timestamp
    resets_at: string;   // ISO timestamp
    requests: { limit: number; used: number; remaining: number } | null;
    tokens: { limit: number; used: number; remaining: number } | null;
    spend_usd: { limit: number; used: number; remaining: number } | null;
  };
  behavior: "reject" | "degrade";
};
type Me = {
  key_prefix: string;
  role: "root" | "user";
  allowed_lanes: string[] | null;
  client_policy: { allowed_clients: ("claude_cli" | "claude_desktop" | "codex_cli" | "codex_app" | "grok_cli")[] } | null;
  rate_limit: { rpm: number | null; tpm: number | null };
  concurrency_limit: number | null;
  allow_custom_model: boolean;
  allow_fast_mode: boolean;
  request_content: { mode: "none" | "session" | "payload"; retention_days: number | null };
  budget: Budget;
  memory: {
    mode: "off" | "observe" | "inject";
    project_id: string | null;
    project_name: string | null;
    thread_source: "header" | "auto";
  };
};
```

`GET /usage/stats?start=<ms>&end=<ms>&bucket=hour|day&tzOffsetMinutes=<minutes>`
returns a half-open time range. The default range is `[0, now)`, with daily
buckets. Model rows are merged by their public label; unmapped models use `other`.
`avg_tps` is the aggregate streaming output-token/generation-time ratio, not the
mean of per-request rates. `cache_hit_rate` is a fraction, cached input tokens
sum divided by prompt tokens sum, or null when the denominator is zero.

```ts
type UsageStats = {
  object: "usage_stats";
  api_key_id: string;
  range: { start_ms: number; end_ms: number; bucket: "hour" | "day"; tz_offset_minutes: number };
  totals: {
    requests: number; ok_count: number; error_count: number;
    prompt_tokens: number; completion_tokens: number; total_tokens: number;
    cached_tokens: number; cache_creation_tokens: number; cost_usd: number;
    avg_latency_ms: number | null; avg_tps: number | null; cache_hit_rate: number | null;
  };
  series: Array<{
    bucket_start_ms: number; requests: number;
    prompt_tokens: number; completion_tokens: number;
    cached_tokens: number; cache_creation_tokens: number; cost_usd: number | null;
  }>;
  by_model: Array<{
    model: string; requests: number;
    prompt_tokens: number; completion_tokens: number; total_tokens: number;
    cost_usd: number | null;
  }>;
  budget: Budget;
};
```

### Request list and lookup

`GET /requests` accepts `page`, `pageSize` (default 50, capped at 200), `start`,
`end`, `status`, `model`, `lane`, `decided_by`, `session_ref`, and `session`.
`decided_by` is `rules | eval | default | fallback`. `session` matches an exact
session reference or exact retained session label within this key. It is not a
substring search. A filter longer than 256 characters returns HTTP 400
`{error:"invalid session filter",code:"invalid_session"}`. A label matching more
than 256 retained references returns HTTP 422
`{error:"session filter is too broad",code:"session_filter_too_broad"}`. A pruned
label is no longer searchable, but `session_ref` can still filter telemetry.
Session labels are fetched in one bounded batch, then ownership-checked again.
SQLite migration 60 adds a VIRTUAL `trace_id` column and a composite
`(api_key_id, trace_id, created_at)` index. Postgres migration 59 uses the same
composite expression index on `decision_json ->> 'trace_id'`, avoiding a stored
column/table rewrite. Both migrations add `(api_key_id, external_session_id)` on
sessions; reference and label lookup use separate indexed, key-scoped probes.
Index creation still reads existing rows and holds the normal migration locks;
large installations need enough startup time and disk space for the index build.

```ts
type StreamOutcome = "completed" | "incomplete" | "failed" | "client_aborted" | "truncated" | null;
type CompactRequest = {
  request_id: string; trace_id: string; requested_model: string;
  served_model: string | null; lane: string; status: "ok" | "error";
  error_reason: string | null; latency_ms: number; cost_usd: number | null;
  usage: null | {
    prompt_tokens: number | null; completion_tokens: number | null;
    cached_tokens: number | null; cache_creation_tokens: number | null;
  };
  requested_reasoning_effort: string | null; reasoning_effort: string | null;
  generation_ms: number | null; tps: number | null; ttfb_ms: number | null;
  attempts: Array<{
    outcome: "success" | "error" | "timeout" | "rate_limited" | "circuit_open" | "skipped";
    latency_ms: number;
  }>;
};
type RequestList = {
  items: Array<CompactRequest & {
    created_at: number;
    decided_by: "rules" | "eval" | "default" | "fallback";
    fallback_count: number;
    stream_outcome: StreamOutcome;
    partial: boolean; // measured stream outcome is neither null nor completed
    serving_provider: string | null; // last non-skipped attempt's public provider name
    session_ref: string | null;
    session_label: string | null; // retained label only; never another key's label
  }>;
  total: number; page: number; page_size: number;
};
```

`GET /requests/{requestId}` returns HTTP 200:

```ts
type RequestDetail = CompactRequest & {
  created_at?: number;
  decision: PortalDecisionRecord & { key_name: string | null; created_at?: number };
};
```

`PortalDecisionRecord` has the complete field shape of
[`DecisionRecordSchema`](../packages/shared/src/decision/schema.ts), with the
following privacy projection (no field is sourced from another key):

- `serving_account.account` and every `serving_account.selection.candidates[].account`
  are `acct_` followed by 24 lowercase hex characters. A server-only random secret
  is initialized atomically in ConfigStore and shared across restarts/replicas.
  When `HELM_OAUTH_ENC_KEY` is configured, the secret is AES-GCM encrypted with
  the existing token cipher. An existing plaintext secret is atomically upgraded
  without changing pseudonyms. Without encryption configuration, the random
  server secret remains plaintext in the operator's ConfigStore.
  HMAC input includes both provider and account. Selection strategy/reason,
  priorities, exclusions, quota pressure/freshness, TTFT, TPS and reset timing stay
  intact. The admin's account labels are never added to this response.
- `provider_attempts[].outbound_requests[].account_ref` is also pseudonymized,
  in a separate provider/outbound-reference namespace.
- `provider_attempts[].error_detail` and `final.error_detail` retain
  `upstream_status:number|null`, `message:string`, `provider_raw:object|null`,
  optional `upstream_event:string|null`, and optional `provider_headers:object|null`.
  Any diagnostic field ending in `header` or `headers` (case-insensitive,
  including `Headers`, `response_headers`, and `rawHeaders`) is filtered. Object,
  pair-array and flat-array representations normalize to an object.
  Header names are lowercased. Only `x-request-id`, `request-id`, `x-amzn-requestid`,
  `cf-ray`, `openai-processing-ms`, `retry-after`, `anthropic-ratelimit-*`, and
  `x-ratelimit-*` remain. `stack`, `cause`, and valued installation IDs, including
  the client installation-ID variant, are removed recursively. Credential
  redaction remains in force.
- Free-text diagnostic emails (including Unicode local parts) and untrusted account fields use a fixed
  `[redacted-account]` marker. They are never HMACed: a caller-controlled trace ID
  or reflected provider error must not become an account-guessing oracle.
  Consequently an email-shaped client trace is redacted in the displayed decision;
  lookup still uses its original value. `org-[A-Za-z0-9]+` organization IDs in
  diagnostic text become `[redacted-organization]`.

If the secret cannot be initialized/decrypted (including a custom ConfigStore
without atomic CAS), gateway boot and normal client traffic continue. Portal
request list and owned decision lookup return HTTP 503
`{error:"portal privacy unavailable",code:"portal_privacy_unavailable"}`.
Missing/foreign request IDs still receive the uniform 404.

`GET /requests/by-trace/{clientTraceId}` returns the same `RequestDetail` only
when the trace identifies exactly one request for this key. URL-encode the trace.
Other keys' traces do not affect ambiguity. HTTP 409 means
`{error:"client trace id is not unique",code:"ambiguous_trace_id"}`.

Both lookup routes can return HTTP 202:

```json
{"status":"in_progress","request_id":"<Helm request ID>","phase":"telemetry_pending"}
```

This is positive evidence from the same gateway's bounded deferred telemetry
queue, including a batch being committed. It does not claim that an unknown ID is
running, or detect requests still executing upstream/on another replica. Absent
such evidence, missing, foreign, or pruned request resources all return HTTP 404:

```json
{"error":"request not found","code":"request_not_found"}
```

That same 404 body applies to request detail, client-trace lookup, payloads,
session revisions, request-scoped blobs, and replay. No foreign existence signal
is exposed. Authentication failures remain the normal gateway 401 envelope.

### Payloads, session revisions, and detached images

The existing `/requests/{requestId}/payload?part=meta|request|response|upstream_request`
and `/requests/{requestId}/session-revisions?after=<sequence>` ownership checks and
JSON shapes remain compatible. Forwarded metadata and captured errors are now
portal projections. Projected responses have `X-Helm-Payload-Projection: portal`.
Original caller request content and ordinary model output stay intact, including
user-written email addresses; the prohibition on real upstream account identities
is not a filter on the user's own content. Admin captures remain unchanged.

For stored parts, send `Accept: application/vnd.helm.payload`. The response is
encoded bytes: `Content-Encoding: gzip` means gzip, otherwise raw UTF-8. Projected
`response`/`upstream_request` parts use raw UTF-8 after a bounded decode. Chunked
response captures are preflighted by raw byte count and collected under the same
response-work lease before projection. Forwarded top-level fields are explicitly
allow-listed to protocol content/options (the authoritative list is
`forwardedFields` in `routes/portal/payload-privacy.ts`). `prompt_cache_key`, `user`,
`safety_identifier`, and unknown top-level fields are omitted. Original caller
request parts remain intact. Forwarded `metadata`/`client_metadata` lose installation/account identity fields (including
string-encoded Codex turn metadata); JSON and whole SSE error frames receive
diagnostic redaction. Multi-line SSE data is parsed as one event; an undecodable
declared error is replaced with `portal_unreadable_error`. Session revision `responseJson`
and reconstructed response values receive the same error projection. Original
request parts retain the existing streamed/encoded transport. Oversized projected
parts are unavailable rather than returning unfiltered bytes. Do not present a
projected part as byte-for-byte upstream evidence.

The existing payload JSON variants are:

```ts
type PayloadMeta = {
  captured: true; source: "payload" | "session"; exact: boolean; fidelity: string;
  created_at: number;
  parts: { request: boolean; response: boolean; upstream_request: boolean };
};
type RecoveredPayloadPart = {
  captured: true; source: "session"; exact: false; fidelity: string;
  part: "request" | "response"; value: unknown; created_at: number;
};
type PayloadUnavailable = {
  captured: false; source?: "unavailable"; reason: string;
};
type SessionRevisionPage = {
  captured: true; sessionRef: string; targetRequestId: string;
  nextSequence: number | null;
  revisions: Array<{
    requestId: string; sequence: number; createdAt: number; parentRequestId: string | null;
    retainCount: number; requestDeltaJson: string; requestEnvelopeJson: string;
    responseId: string | null; responseJson: string | null;
  }>;
};
```

Unavailable reasons include `metadata_only`, `no_session`, `session_unavailable`,
`session_incomplete`, `session_recovery_limited`, `response_unavailable`,
`payload_recovery_limited`, and `encoded_payload_required` (HTTP 406 when an encoded
part is requested without the required Accept header). Invalid parts return HTTP
400 `{error:"invalid payload part"}`. Request/session authorization failures use
the uniform HTTP 404 body above.

`GET /requests/{requestId}/payload-blobs/{sha256}` returns the binary image, with
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and a restrictive CSP.
A syntactically safe image MIME is used; other MIME values fall back to
`application/octet-stream`. The caller must own the request and the persisted
provenance table must show that actual image bytes were externalized in that
payload. Merely placing a hash/sentinel in another request does not confer access.
Metadata-only records cannot serve images. Missing/foreign/unproven/oversized
blobs use the same HTTP 404. Temporary memory admission failure is HTTP 503
`{error:"response capacity unavailable",code:"response_capacity"}`.
At most two blob responses per key may hold leases on one gateway instance.
Further calls return HTTP 429
`{error:"too many blob responses",code:"blob_concurrency_limited"}` with
`Retry-After: 1`; consumption, cancellation, and failed reads release the slot.
Other keys have separate slots; shared response admission remains authoritative.
The per-blob bound is `min(16 MiB, response-work capacity / 8)`, before allocation.
The admin's global `/admin/api/payload-blobs/{sha256}` remains admin-only.

SQLite migration 59 and Postgres migration 58 add `request_payload_blob_refs`
with a composite `(request_id, sha256)` primary key and no cross-table foreign
key, so migration does not depend on the historical payload table being present.
Writes replace provenance in the same transaction as the payload and blob bytes.
Retention deletes each payload batch and its references in one transaction, using
only the request IDs actually deleted; payloads at the cutoff remain intact.
There is deliberately no inferred historical backfill: a retained sentinel alone
cannot prove who supplied the bytes.

### Memory statistics

`GET /memory/stats` ignores caller-supplied scope. It uses authenticated
`accountId` and effective `memoryProjectId ?? keyId`. Sharing an explicitly named
project inside the same account intentionally shares its statistics. It returns:

```ts
type MemoryStats = {
  generated_at: string; // ISO timestamp
  project_id: string;
  shared: boolean;
  storage: {
    threads: number; messages: number; observations: number;
    facts: number; activeFacts: number; reflections: number; activeReflections: number;
  };
  queue: {
    pending: number; running: number; done: number; failed: number; open: number;
    staleRunning: number;
    oldestPendingAt: string | null; oldestRunningAt: string | null;
    newestDoneAt: string | null; newestFailedAt: string | null;
    byType: Array<{ type: string; status: string; count: number }>;
  };
  leases: { running: number; stale: number }; // stale is a subset of running
  activity: {
    lastMessageAt: string | null; lastObservationAt: string | null;
    lastFactUpdatedAt: string | null; lastReflectionUpdatedAt: string | null;
  };
};
```

The endpoint permits one scan per key per ten seconds per gateway instance,
including failed scans; it returns HTTP 429
`{error:"memory stats rate limit exceeded",code:"memory_stats_rate_limited"}` with
`Retry-After: 10` for another scan in that interval. The limiter keeps at most
5000 active key windows and rejects additional scans until slots expire.
Caller-supplied account/project query parameters cannot bypass this limit.
Memory project selection is unchanged.

A store without memory statistics returns HTTP 503
`{error:"memory stats unavailable",code:"memory_unavailable"}`. This read does not
require enabling Memory MCP and does not change memory content/settings.

### Replay

`POST /requests/{requestId}/replay` requires a new UUID in `Idempotency-Key` for
one intentional replay. Keep the same UUID when retrying an uncertain HTTP result.
The request body is not an editing interface: the server loads the owned original
client body. Supported native operations are Chat Completions, Messages,
Responses (including `/compact`), and Gemini generate/streamGenerateContent.
Missing protocol/body, metadata-only capture, oversized recovery, and unproven
image references reject replay. Session-only captures use bounded reconstruction.
Images restore only from that request's proven blob references.

Replay re-enters the actual client route with the caller's credentials and user
agent, never a stored upstream credential or root fallback. Key state is reread
without the normal auth cache, including rotation/revocation and a key-ID match.
Normal client policy, lane/model/fast caps, rate limits, concurrency, capture,
memory defaults, telemetry, and budget settlement apply. An exhausted budget is
rejected even if the key normally allows degradation. Stored original HTTP headers
are not replayed; current caller authentication/client headers and current key
settings apply. Streaming responses are drained to settle usage and capture a new
request. The UI should open the returned new request ID.

```ts
type ReplayResult = {
  status: "in_progress" | "recorded" | "recording_pending" | "rejected" | "outcome_unknown";
  source_request_id: string;
  request_id: string | null;
  upstream_status: number | null; // status from the normal gateway client route
  code?: "client_request_rejected" | "replay_payload_unavailable" | "replay_outcome_unknown";
};
```

- HTTP 200 / `recorded`: a new telemetry row was read back with this key as owner.
  The model attempt itself may have failed; inspect `upstream_status` and detail.
- HTTP 202 / `in_progress`: a durable receipt exists and another attempt must not
  be sent. `request_id` can still be null. A crash can leave this state until expiry.
- HTTP 202 / `recording_pending`: the client route returned, but no owned telemetry
  row was found yet. Telemetry is fail-open on the normal request path; do not
  interpret this as guaranteed eventual recording.
- HTTP 409 / `rejected`: replay could not load the capture, or the normal client
  route rejected the request without writing telemetry. The latter includes
  `code:"client_request_rejected"` and its status, e.g. `upstream_status:429`.
- HTTP 503 / `outcome_unknown`: dispatch may have happened but completion could
  not be confirmed, or an unfinished receipt is at least ten minutes old. It is
  never automatically replayed. A ten-minute replay deadline also bounds work.

Other pre-dispatch errors are JSON `{error:string,code:string}`:

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `idempotency_key_required` | Missing/invalid UUID header. |
| 401 | `auth_error` | Fresh key is absent, disabled, suspended, or rotated. |
| 404 | `request_not_found` | Same missing/foreign response as other request routes. |
| 409 | `idempotency_conflict` | This key already used that token for a different source. |
| 409 | `replay_payload_unavailable` | No supported replayable capture/protocol. |
| 429 | `replay_rate_limited` | At most one new replay per key per ten seconds; `Retry-After: 10`. |
| 503 | `replay_unavailable` | Atomic receipt/throttle/expiry storage is not available. |
| 503 | `response_capacity` | Recovery could not obtain memory admission; nothing was dispatched. Retry the same token after `Retry-After: 1`. |

The additional replay throttle is durable and applies even when ordinary rate
limiting is disabled. Duplicate receipts survive restarts and replica changes.
A concurrent duplicate may receive the existing receipt or a throttle response,
but cannot dispatch twice. Receipts are kept in ConfigStore (hashed key/token
address, no bearer credential) for seven days from first acceptance. Within that
window, the same token never dispatches twice across restarts or replicas. After
seven days the token can be treated as a new replay: **never automatically retry
an uncertain replay beyond this window**. A deliberate later replay should use a
fresh UUID. Budget, route, and upstream failures do not authorize automatic replay
with a fresh token.

SQLite migration 61 / Postgres migration 60 add nullable `config_kv.expires_at`
and its partial index. Permanent config stays unexpired. Existing replay rows
receive a seven-day cleanup grace period on migration; their idempotency guarantee
is still seven days from the receipt's original start. New throttle rows expire
after ten seconds. Cleanup removes at most 1000 expired entries on each replay
and on a minute timer (the timer is disabled by `HELM_CLEANUP_DISABLED=1`).
Inactive expired rows may remain until the next sweep but are not reused as live
receipts. Pre-dispatch capacity denial removes only its own exact receipt and rate
reservation; it writes no terminal rejection, so same-token retry is safe.
