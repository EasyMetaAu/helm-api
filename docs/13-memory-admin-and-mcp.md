# 13 — Memory Admin UI + Memory MCP Server

> Status: proposed (issue) → in implementation on branch `worktree-memory-admin-mcp`.
> Builds on [08 — memory middleware](08-memory-middleware.md), [11 — admin UI](11-admin-ui.md),
> [12 — memory forgetting & tiering](12-memory-forgetting-and-tiering.md).

## Problem

The memory subsystem (threads → observations → reflections + facts) accumulates state but is
**unobservable and unmanageable**:

- Operators cannot see, correct, or delete what the gateway has remembered. A wrong fact
  ("user prefers X") lives until it is superseded by chance.
- No programmatic surface exists for **external agents** (Claude Code, Codex, other tools) to read
  or write memory — the gateway is the only writer, and only via background extraction.

This doc adds two surfaces over the **existing** `memory_facts` + `memory_reflections` tiers:

1. **Admin page** `/memory` — manage **facts + reflections**, with **By Key** and **By Scope** views.
2. **Memory MCP server** `POST /mcp` — **full CRUD** tools, API-key authed, for external agents.

Raw `memory_messages` / `memory_observations` (the short/mid tiers) are intentionally **out of
scope** — they are transient and internal; the long tier (facts + reflections) is the durable,
human-meaningful memory worth managing.

## Data model recap (no schema changes)

Memory is scoped by `ownerId = accountId` + optional `projectId / resourceId / threadId`. It is
**not** keyed to an API Key. A Key resolves to an `accountId` and carries memory defaults
(`memory_mode`, `memory_project_id`, `memory_thread_source`). **Multiple keys can share one
account.** Therefore:

- **"By Key"** = facts/reflections for **(that key's account, that key's default project)**.
  Two keys on the same account+project see the *same* memory; revoking a key does not isolate it.
  The UI states this explicitly.
- **"By Scope"** = browse the distinct `(account, project, resource, thread)` groups directly.

Bi-temporal fact fields stay as in doc 12: `validFrom` (became true), `invalidAt` (became false),
`expiredAt` (system learned it was superseded), `status` (`active|archived|pruned`). The dedup
boundary is `UNIQUE(owner_id, content_hash)` where `content_hash = sha256(normalized fact_text)`.

## Surface 1 — Admin

### New `MemoryStore` port methods (both SQLite + Postgres adapters)

All **optional** (`?`) on the port — additive, so existing fakes stay valid; routes 503 when absent.

| Method | Purpose |
|---|---|
| `listMemoryScopes({ accountId? })` | Enumerate `(account,project,resource,thread)` groups with fact/reflection counts + last-updated. **By Scope** tab. Facts ⊎ reflections via `UNION ALL` of grouped subqueries (SQLite has no `FULL OUTER JOIN`); reflections guarded `owner_id IS NOT NULL` (column is nullable). |
| `getFactById / listFacts` | Read facts by scope, paginated, with an explicit `status` filter. **Admin reads must NOT blanket-apply `expired_at IS NULL`** — operators manage superseded/archived/pruned rows too. |
| `updateFact` | Edit `factText` (→ recompute `contentHash`, **keep `subjectKey`**), `importance`, `status`, `invalidAt`. `UNIQUE(owner_id, content_hash)` collision → typed error → **409**, never a leaked 500. |
| `deleteFact` | **Soft** delete: `status='pruned'` + stamp `expired_at`. The system's only hard delete remains retention. |
| `listReflections / getReflectionById` | Read reflections (default latest active version per scope; `includeAllVersions` expands history). |
| `updateReflectionText` | Edit reflection text **in place** — does **not** bump `version` (that stays the Reflector's machine-merge counter); recomputes `tokenEstimate`, stamps `updatedAt`. |
| `deleteReflection` | **Soft** delete: `status='archived'` (so `getReflection(scope)` returns null → stops injection). |

`insertFactsReconciled` gains an optional return `{ insertedIds, supersededIds } | void` (back-compat;
existing callers ignore it) so the MCP `memory_add` tool can echo the new fact id.

### Admin API routes `/admin/api/memory/*` (HTTP Basic, like all admin routes)

`GET /scopes` · `GET /by-key/:keyId` (→ `{accountId, projectId}`) · `GET|… /facts` (list/get/patch/delete)
· `GET|… /reflections` (list/get/patch/delete). Bodies Zod-validated (`.strict()`, fail-closed) before
the store call; **400** bad body, **404** unknown id, **409** hash collision. `accountId` query param
defaults to the composition-root account for single-account deploys.

### Admin SPA `/memory`

`+page.svelte` + `+page.ts` + `lib/api/memory.ts`, reusing the Keys page patterns: `Modal.svelte`,
the `.cards-table / .btn-* / .badge-* / .alert-*` recipes, `formatTimestamp`. A tab switcher
(**By Key** / **By Scope**) over a shared Facts table + Reflections table; edit + soft-delete modals;
status badges (`active / archived / pruned / superseded`). Nav entry added in `+layout.svelte`.

## Surface 2 — Memory MCP server

`POST /mcp`, **stateless JSON-RPC** (MCP Streamable-HTTP, non-streaming request/response), built on
`@modelcontextprotocol/sdk` `Server` + `setRequestHandler('tools/list' | 'tools/call')`. CRUD tools
need no SSE; this bridge is fully testable via Hono's `app.request()` (the SDK's Node-`req/res`
`StreamableHTTPServerTransport` is not). Tool defs live in a transport-agnostic module so a later
swap to the Web-standard transport is one file.

- **Auth:** the existing API-key `authMiddleware` (bearer → `identity.accountId` + memory defaults).
- **Gating:** new config `memory.mcp.enabled` (default **false**, fail-closed). `/mcp` is mounted
  only when enabled and a memory store exists; otherwise 404.
- **Tenant isolation (non-negotiable):** every handler derives `accountId` from `identity` only.
  Tool params may override `projectId/resourceId/threadId` but never the account; id-addressed
  tools (`get/update/delete`) re-check `owner_id = accountId` → cross-tenant id returns not-found.

### Tools (6, `type: "fact" | "reflection"` discriminator)

| Tool | Maps to |
|---|---|
| `memory_add` | fact → `buildReconciledFactBatch` (cap 1) + `insertFactsReconciled` (gets dedup + same-subject supersede for free); reflection → `upsertReflection` at high-water+1 |
| `memory_search` | `listFacts({ search })` / `listReflections` (active-only unless `includeInactive`) |
| `memory_list` | `listFacts` / `listReflections` (paginated) |
| `memory_get` | `getFactById` / `getReflectionById` (account-guarded) |
| `memory_update` | `updateFact` / `updateReflectionText` |
| `memory_delete` | `deleteFact` (soft) / `deleteReflection` (soft) |

## Decisions

- **MCP transport:** lightweight JSON-RPC bridge (most testable); migrate to Web-standard transport
  when `@modelcontextprotocol/server` 2.0 GAs.
- **Fact delete = soft (`pruned`).** The hash tombstone keeps `(owner_id, content_hash)` occupied, so
  re-adding identical text needs rewording in v1 (documented in the tool description). No resurrect.
- **Reflection edit edits text in place, no version bump.** `version` stays the Reflector's counter.
- **MCP add reuses the reconcile path** (supersede preserved) rather than a raw insert.
- **`memory.mcp.enabled` defaults false.** New port methods are optional; routes 503 if missing.

## Why this is safe (CLAUDE.md alignment)

Admin + MCP are **management / agent** surfaces, distinct from the routing hot path, so they MAY
return 4xx/5xx (the "routing never 5xx, degrade to balanced" rule is about `/v1` request handling,
untouched here). Config is fail-closed (`.strict()` schema, default-off MCP). Zod schemas remain the
single source of truth. The core memory logic stays framework-agnostic; only the gateway routes know
Hono.
