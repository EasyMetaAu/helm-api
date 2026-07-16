# 13 · Memory Admin UI and Memory MCP Server

> Current implementation reference, verified against the source on 2026-07-16.
>
> The Admin `/memory` page is implemented and mounted with the normal Admin
> surface. The memory MCP endpoint is optional: `POST /mcp` exists only when
> `memory.mcp.enabled=true` and the selected store implements the complete
> management surface. MCP defaults off.

Builds on [08 · Memory Middleware](08-memory-middleware.md),
[12 · Forgetting and Tiering](12-memory-forgetting-and-tiering.md), and
[14 · Memory Deep Recall](14-memory-deep-recall.md).

## Management boundary

The management surfaces expose the durable long tier:

- `memory_facts`;
- `memory_reflections`.

They do not expose raw `memory_messages` or `memory_observations` content. The
Admin page does show aggregate raw/observation counts and activity timestamps,
but not those bodies.

Admin is an operator surface protected by Admin HTTP Basic authentication. MCP
is an account-scoped agent surface protected by a Helm API key or the optional
MCP OAuth shim. Their authorization models are intentionally different:

- Admin may select `accountId` and manage multiple accounts in one deployment.
- MCP always derives `accountId` from the authenticated identity; no tool
  argument can override it.

## Scope and key semantics

The tenant boundary is `owner_id = accountId`. Project/resource/thread are
in-account scopes.

A key's effective project is:

```text
memory_project_id ?? key_id
```

Consequences:

- keys are isolated by their own key id when no explicit project is configured;
- several keys share memory only when they belong to the same account and are
  configured with the same `memory_project_id`;
- revoking a key does not delete its facts/reflections;
- the Admin **By Key** view resolves the key to exactly this effective project,
  not to an account-wide null project.

## `MemoryStore` management contract

Both real adapters implement these optional port methods. The Admin route
returns 503 when the active store lacks the required surface; `/mcp` is not
mounted in that case.

| Method | Current behavior |
|---|---|
| `listMemoryScopes` | Groups active/unexpired facts and active reflections by `(account, project, resource, thread)`, with counts and latest activity. |
| `getMemoryAdminStats` | Read-only storage, queue, stale-lease, and activity snapshot; no message bodies. |
| `getFactById` | Account-guarded read by id, any status. |
| `listFacts` | Paginated scope/search/status management read. `all` includes superseded/archived/pruned rows. |
| `insertFactsReconciled` | Add/dedup/resurrect/supersede facts transactionally. |
| `updateFact` | Edit text, importance, status, or `invalidAt`; text edit recomputes the hash but not `subjectKey`. |
| `deleteFact` | Soft delete: `status='pruned'` and `expired_at=now`. |
| `listReflections` | Paginated scope/status read; by default latest matching version per scope, with optional full version history. |
| `getReflectionById` | Account-guarded read by id, any status. |
| `updateReflectionText` | In-place text edit, token estimate refresh, and `updated_at` stamp; no version bump. |
| `deleteReflection` | Two-stage: active scope versions become archived; deleting an already archived row hard-purges archived versions for that scope. |
| `getReflectionVersionHighWater` | Maximum version across every status, used for monotonic new versions. |

Fact text collisions raise `MemoryFactContentHashConflictError`; Admin maps this
to HTTP 409 and MCP maps it to a tool-level error.

## Admin HTTP API

All routes are under `/admin/api/memory` and inherit Admin Basic Auth.

| Method and path | Contract |
|---|---|
| `GET /scopes` | Optional `accountId`; returns active scope summaries. |
| `GET /stats` | Optional account/project/resource/thread filters; returns operational snapshot. Cached in-process for 10 seconds per exact scope. |
| `GET /by-key/:keyId` | Resolves a key to `{key_id, accountId, effective projectId}`; 404 when absent. |
| `GET /facts` | Filters: account/scope, `status`, `subjectKey`, `search`, `limit`, `offset`. Default status is `all`; default limit 50, max 200. |
| `POST /facts` | Scope in query; strict body `{subjectText, factText, importance?}`. Returns created/resurrected row plus reconcile summary. |
| `GET /facts/:id` | Account-guarded fact read. |
| `PATCH /facts/:id` | Strict partial patch `{factText?, importance?, status?, invalidAt?}`. |
| `DELETE /facts/:id` | Soft-prunes an active fact; 404 for unknown/cross-account/already-pruned id. |
| `GET /reflections` | Filters: account/scope, `status=active|archived|all`, `includeAllVersions`, pagination. Default status is `all`. |
| `GET /reflections/:id` | Account-guarded reflection read. |
| `PATCH /reflections/:id` | Strict body `{reflectionText}`; edits in place. |
| `DELETE /reflections/:id` | First call archives an active scope; call on archived row permanently purges archived versions. |

Bad strict Admin bodies return 400; unknown/cross-account ids return 404; fact
hash collision returns 409. A store exception not explicitly mapped is allowed to
surface as a management error; fail-open serving guarantees apply to model
traffic, not privileged management mutations.

## Admin SPA `/memory`

Current UI behavior:

- operational status cards for queue depth, oldest pending/running age, stale
  running jobs, raw/derived row counts, and last activity;
- shared refresh control and refresh cadence;
- **By Scope** and **By Key** browsing;
- reflections shown before facts for the selected scope;
- fact text search, status filter, and pagination (25 rows per UI page);
- status views for active, superseded, archived, pruned, and all facts;
- add-fact flow using the same reconcile path as MCP;
- in-place fact/reflection edits;
- explicit soft-delete copy for facts and active reflections;
- permanent-delete warning for an already archived reflection;
- deep link `/memory?key=<keyId>` from key detail.

The operational stats endpoint is important during incidents: raw message writes
can be advancing while facts/reflections remain empty, and queue depth can show
whether formation is delayed rather than disabled.

## MCP HTTP transport

The MCP route is a direct, stateless JSON-RPC 2.0 implementation of the
non-streaming Streamable HTTP request/response shape. It does **not** currently
use `@modelcontextprotocol/sdk` at runtime.

Supported request methods:

```text
initialize
ping
tools/list
tools/call
```

Supported protocol versions on initialize are `2025-11-25`, `2025-06-18`,
`2025-03-26`, and `2024-11-05`. A supported requested version is echoed;
otherwise the server falls back to `2025-06-18`.

Transport details:

- only `POST /mcp` is registered;
- single messages and JSON-RPC batches are accepted;
- notifications receive no JSON-RPC response; notification-only input returns
  HTTP 202;
- normal JSON-RPC and tool errors use HTTP 200 envelopes;
- there is no SSE session, resumability, `Mcp-Session-Id`, GET stream, or DELETE
  session endpoint;
- resources, prompts, subscriptions, and completion methods are not exposed.

The tool schemas use Zod validation, but unlike the strict Admin patch/create
schemas they are ordinary `z.object(...)` schemas; unknown tool arguments are
currently stripped rather than rejected.

## MCP authentication and mounting

With `memory.mcp.enabled=true`:

1. the composition root checks the store with `supportsMemoryAdmin()`;
2. it mounts auth before `/mcp`;
3. it registers the MCP route only after both checks pass.

When OAuth is off, the normal Helm Bearer API-key middleware is used. The MCP
context receives:

- `accountId` from the authenticated key;
- `defaultProjectId` from the key's effective project;
- no caller-controlled account field.

Id-addressed reads/writes recheck `owner_id=accountId`, so a guessed foreign id
is returned as not found.

## MCP tools

Seven tools are exposed.

### `memory_add`

```text
{ type: fact|reflection, text, subject?, importance?, projectId?, resourceId?, threadId? }
```

- fact: normalizes through `buildReconciledFactBatch`, cap 1, then uses
  `insertFactsReconciled`; returns `added`, `resurrected`, `superseded`, and
  `deduped`;
- reflection: writes a new row at scope high-water + 1.

Scope defaults to the authenticated key's effective project.

### `memory_search`

Exact text-oriented search. Fact search uses the adapter's case-insensitive
substring filter. Reflection search loads up to 1000 matching-scope rows and
applies lowercase `includes()` in JavaScript before the requested limit.
`includeInactive` switches management visibility on.

### `memory_recall`

Deep fact recall from doc 14. It uses hybrid fact retrieval when enabled and
available, otherwise returns the ordinary fact substring result with
`degraded:true`. A query embedding failure drops only the vector leg. Successful
hybrid results receive a fire-and-forget fact reference bump.

### `memory_list`

Paginated fact or reflection list. Active only by default; `includeInactive`
uses `all`.

### `memory_get`

Fetches one fact/reflection by id with an account guard. Missing ids are
tool-level errors.

### `memory_update`

- fact: text, importance, status, and nullable ISO `invalidAt`;
- reflection: `text` is required and edited in place without version bump.

### `memory_delete`

- fact: soft-prunes;
- active reflection: archives its scope;
- already archived reflection: the underlying store performs the second-stage
  permanent purge.

The tool returns `{deleted, id}` even when `deleted` is false; callers should
inspect the boolean.

## Optional MCP OAuth shim

`memory.mcp.oauth.enabled=true` adds unauthenticated authorization-server
endpoints in front of the protected MCP resource:

```text
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
GET  /.well-known/oauth-authorization-server/mcp
GET  /authorize
POST /authorize
POST /token
```

Current config:

```yaml
mcp:
  enabled: false
  oauth:
    enabled: false
    # issuer: https://helm.example.com
    access_token_ttl_seconds: 2592000
    allowed_redirect_prefixes:
      - https://chatgpt.com/connector/oauth/
      - https://chat.openai.com/connector/oauth/
```

OAuth requires `HELM_OAUTH_ENC_KEY`; startup fails when OAuth is enabled without
a valid key. A domain-separated HMAC derivation supplies the HS256 signing key.

Flow and limits:

- authorization code + PKCE S256 only;
- the user pastes a Helm API key into the authorize form;
- redirect URIs must be HTTPS and begin with an allowed prefix;
- the authorization code is a stateless signed JWT valid for 60 seconds;
- the access token is a stateless signed JWT; no refresh token is issued;
- `/mcp` accepts either the access JWT or a raw Helm API key;
- codes have no one-time-use store and are replayable inside their 60-second
  lifetime;
- access tokens have no denylist and cannot be individually revoked before
  expiry; rotate `HELM_OAUTH_ENC_KEY` to invalidate all of them;
- key account/project/mode claims are snapshotted into the token at authorize
  time. Later key disable/settings changes are not re-read for an already issued
  access token.

These are accepted constraints of the current self-hosted shim, not a full
general-purpose authorization server.

## Configuration source of truth

`MemoryMcpSchema` and `McpOAuthSchema` live in
`packages/shared/src/config/memory-schema.ts`. Both objects are strict and both
feature switches default false. Unknown config keys refuse startup.

`/mcp` remaining 404 when disabled is intentional fail-closed behavior. Admin
memory routes are independent of the MCP switch.

## Current limitations

- No raw-message or observation CRUD through Admin/MCP.
- No audit-event table specifically recording Admin/MCP memory edits.
- Admin can intentionally cross accounts; account authorization is the Admin
  Basic-auth boundary, not per-route role filtering.
- MCP transport is stateless JSON-RPC request/response, not a complete
  sessionful Streamable HTTP implementation.
- OAuth tokens are stateless and non-revocable individually.
- Manual fact add/edit clears or creates vector state but does not itself enqueue
  an embedding job; vector population waits for a later Observer/Reflector job
  to enqueue account embedding work. FTS/substrings remain immediately usable.

## Verification map

- backend routes: `apps/gateway/src/routes/admin/memory.test.ts`
- Admin UI: `apps/admin/src/routes/memory/memory.test.ts`
- MCP transport/tools: `apps/gateway/src/routes/mcp/mcp.test.ts` and
  `tools.test.ts`
- OAuth: `apps/gateway/src/routes/mcp/oauth.test.ts`
- adapter management parity: SQLite/Postgres `memory-admin.test.ts`
- locale coverage: `apps/admin/src/lib/i18n/mcp-locales.test.ts`.
