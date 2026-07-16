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
| `/portal/requests/{traceId}` | View the customer-safe result, token/cost summary, and captured client request/response payload for an owned trace. |
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
| `GET /portal/api/requests/{traceId}` | Ownership-gated, whitelist-projected request detail. |
| `GET /portal/api/requests/{traceId}/payload?part=meta\|request\|response` | Lazy access to the owned client request/response only. `upstream_request` is deliberately unavailable. |

The portal does not expose an API for key rotation, revocation, budgets, rate
limits, lane caps, provider accounts, runtime settings, cleanup, or replay.

## Request privacy and ownership

Telemetry lookup by trace id is not self-scoping at the Store-port level, so the
portal applies an explicit guard before reading a record or payload:

1. read `getApiKeyId(traceId)`;
2. compare it with `identity.keyId`;
3. return the same `404 request not found` for a missing trace and a trace owned by
   another key;
4. only then read the decision record or payload.

This ordering prevents both cross-key reads and trace-id existence probing.

`toPortalDecisionView()` is an allow-list projection. It exposes only:

- request id and requested model;
- public served-model alias and selected lane;
- terminal status/error class;
- total latency and cost;
- prompt, completion, cache-read, and cache-creation token counts.

It deliberately omits classifier/eval reasoning, policy internals, candidate and
provider-attempt chains, provider names, wire model ids, OAuth account labels,
service tier/region details, upstream errors, and upstream payloads. Adding a new
field to `DecisionRecord` therefore cannot silently add it to the portal.

Captured client request/response bodies are still sensitive. They are available
only when the operator has enabled payload capture and the authenticated key owns
the trace. See [07 · Error Model & Observability](07-observability.md).

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
- `404` equivalence for missing and foreign trace ids;
- whitelist projection of decision records and provider/wire-model non-disclosure;
- strict writable memory settings and root-key rejection;
- CSP/static routing and session-storage browser behavior;
- portal request, payload, memory, and localization UI behavior.

## Deliberate boundaries

- No user accounts, password login, teams, or server-side sessions.
- No self-service key creation, rotation, revocation, or sub-keys.
- No editing of budgets, limits, allowed lanes, blocked models, or provider policy.
- No provider/fallback topology, OAuth serving-account identity, or eval internals.
- No request replay from the portal.
- No cross-key/global memory or telemetry views.

Those operations belong to the Basic-authenticated admin UI described in
[11 · Admin UI](11-admin-ui.md).
