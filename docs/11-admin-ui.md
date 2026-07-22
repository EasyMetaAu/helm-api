# 11 · Admin UI

> Status: **implemented.** A SvelteKit + Tailwind SPA (`adapter-static`),
> built into `apps/admin/build` and served by the gateway under `/admin`.

After it boots, Helm can mount a web console for operating the gateway: keys,
lanes, policies, classifier rules, OAuth subscription providers, memory, request
debugging/replay, runtime settings, and data cleanup. It is meant for **internal**
use and is gated by Admin credentials through Helm's login page. API-key holders use the separate
[self-service portal](12-self-service-portal.md), not this global surface.

## Authentication: browser session + Basic compatibility

The admin UI's authentication is **deliberately separate** from the API-key auth
used for API traffic — different credentials, a different trust boundary
(config/env vs. the KeyStore), and no RBAC (see
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md)).

Browser navigation to `/admin` without a valid session redirects to the
Gateway-rendered `/admin/login` page. A successful login creates a stateless,
HMAC-signed cookie scoped to `/admin` with `HttpOnly`, `SameSite=Strict`, and a
12-hour expiry; HTTPS requests also receive `Secure`. The cookie contains only
an expiry and signature, not the username or password. Its signing key is
derived in memory from the configured Admin credentials, so changing either
credential invalidates every existing session without a session table or extra
secret. The Admin top bar provides a logout action that clears the cookie.

Pre-emptive HTTP Basic remains accepted for scripts and headless operators.
Session-enabled failures deliberately omit `WWW-Authenticate`, so browsers do
not show the native Basic popup: HTML navigation redirects to the login page,
while `/admin/api/*` returns a plain 401. Login submissions reject a mismatched
`Origin`, compare both credentials in constant time, never log or echo the
password, and prevent external `next` redirects.

Credentials are resolved by `resolveAdminAuth`
(`apps/gateway/src/middleware/basic-auth.ts`). In the shipping composition root,
admin configuration is **environment-only**: `loadConfig()` has no top-level
`admin` schema/file path, so a YAML `admin:` block is not a supported deployment
control. (`resolveAdminAuth` retains a config argument for direct/headless callers
and tests, but `buildServer()` cannot populate it from `config/*.yaml`.)

On a new install, complete credentials do not need to exist before the process
starts. The token-protected `/setup` surface collects them and atomically writes
the resulting environment-shaped values to `data/helm-managed-env.json` with
mode `0600`; the process then switches to the full gateway without a restart.
On later boots that file is loaded before `buildServer()`, while any non-empty
external environment variable still wins. Setup itself never mounts `/admin` or
`/admin/api/*`, so there is no unauthenticated Admin interval.

```bash
# Environment form (recommended for Docker)
HELM_ADMIN_USER=admin
HELM_ADMIN_PASSWORD=change-me
HELM_ADMIN_ENABLED=true   # optional explicit toggle
```

Enable / mount rules:

- **Providing environment credentials auto-enables the admin surface.** Setting
  `HELM_ADMIN_USER` + `HELM_ADMIN_PASSWORD` is the obvious "protect admin" action,
  so it turns the surface on. In the shipping server, an explicit
  `HELM_ADMIN_ENABLED` value takes precedence over "credentials present".
- **When admin is not enabled, it is not mounted at all** — both `/admin` and
  `/admin/api/*` return 404, so the key-management and telemetry endpoints can
  never be reached unauthenticated.
- **When enabled but credentials are missing**, the gateway still boots but emits
  a single explicit warning, and every admin request fails closed (401) — never
  silently open.
- Credentials are compared in constant time and the password is never logged.
- The session/Basic gate covers both the API (`/admin/api/*`) and the SPA page +
  assets (`/admin`). The standalone login HTML is the only public Admin content.
- Run the admin UI behind HTTPS and preferably a reverse proxy / internal network.

## Internationalization

The SPA ships in seven languages, English by default
(`apps/admin/src/lib/config/languages.ts`): English (`en`), Simplified Chinese
(`zh-hans`), Traditional Chinese (`zh-hant`), Japanese (`ja`), Korean (`ko`),
Spanish (`es`), and Portuguese (`pt`). An unrecognized browser/stored language
tag falls back to `en`.

> **Screenshot provenance.** The ten images below were captured on 2026-07-05
> from v0.25.2 and are retained as historical layout examples. This chapter's
> prose was source-audited on 2026-07-16 and is the current contract; do not infer
> current labels, data windows, or version from the screenshots. Known visible
> drift includes the Keys column (`Usage (today)` now, not `Usage (24h)`) and the
> Providers subtitle (`Connect AI subscriptions` now). The repository does not
> yet have the rich deterministic seed-and-capture fixture needed to reproduce
> all ten representative views safely.

## What the admin UI can do

The SPA pages (`apps/admin/src/routes/`) are pure consumers of the gateway's
`/admin/api/*` endpoints.

### Dashboard

The landing page (`/`) gives an at-a-glance overview: request volume, success
rate, latency, throughput, and spend over a selectable preset or custom window;
day-over-day deltas; token usage over time and by model; recent routing
decisions; key-filter shortcuts; and the shared auto-refresh cadence used across
admin pages.

![Dashboard — KPIs, token usage over time, tokens by model, and recent requests](assets/screenshots/01-dashboard.png)

### Rule management

- **Keys** (`/keys`) — create, reveal, rotate, revoke, and permanently delete API
  keys; open copyable **Connect Client** snippets; and edit the full per-key cap
  set: operator-facing name, allowed lanes, custom-model permission, exact/glob
  blocked models, client-requested Fast-mode permission, rate limits (RPM/TPM),
  usage budgets (requests / tokens / spend with a budget window plus the
  over-budget behavior and degrade lane), the concurrency limit, and memory mode
  (`off` / `observe` / `inject` with project id and thread source). Backed by the
  KeyStore (`/admin/api/keys` `GET` / `POST` / `PATCH` / `DELETE`), never YAML.
  Full key reveal works only for rows with encrypted recovery material; older
  hash-only keys must be rotated before they become recoverable. Revocation is a
  soft disable. A revoked key can then be permanently deleted as
  an explicit second step (DELETE `?purge=true`); the server refuses to purge an
  active key (409 'key must be revoked before deletion'). Telemetry keeps an
  unlinked key_id reference for audit history. See [06 · Auth, API Keys & Rate
  Limits](06-auth-and-rate-limits.md). Each key also has a detail view with usage
  charts, scoped recent requests, configured caps, and a memory shortcut for the
  key's default account/project scope and direct filter links into the request
  log.
- **Lanes** (`/lanes`) — view/edit each lane's `primary + fallback[]`
  (`/admin/api/lanes` CRUD). The model combobox is populated from a read-only
  catalog of routable aliases (`/admin/api/models`). See [04 · Routing &
  Lanes](04-routing-and-lanes.md).
- **Policies** (`/policies`) — view/edit first-match policy rules
  (`task_type` / `complexity` / request constraints → forced lane and/or forced
  reasoning effort) via `/admin/api/policies`. The config schema also supports
  `allowed_lanes` whitelist policies; the current UI exposes the common
  force-lane / reasoning-effort path.
- **Classifier** (`/classifier`) — toggle eval, tune `confidence_threshold`, and
  inspect the rule dimensions/weights (`/admin/api/classifier`). See [03 ·
  Classification Cascade](03-classification.md).

Rule edits go through a runtime rule store that FIRST writes the change back to
the canonical `config/*.yaml` (comment-preserving, atomic, fail-closed) and then
re-binds the live `lanes` / `policies` / `classifier` config the router reads —
applied on the very next request, no restart, and durable across restarts. A
failed write rejects the edit with the live config unchanged, so file and memory
never diverge.

![Historical API Keys layout — current page shows per-key role, caps, rate limit, budget, memory mode, and today's usage](assets/screenshots/09-keys.png)

![Lanes — primary model plus an ordered, reorderable fallback chain per lane](assets/screenshots/04-lanes.png)

![Policies — first-match rules that force a lane or reasoning effort for matching requests](assets/screenshots/08-policies.png)

![Classifier — Layer-2 eval toggle, confidence threshold, rule dimensions, and eval limits](assets/screenshots/05-classifier.png)

### Providers (OAuth subscriptions)

- **Providers** (`/providers`) — connect and manage **OAuth subscription** backends
  (Claude Pro/Max, ChatGPT Codex, GitHub Copilot, and experimental xAI
  SuperGrok/X Premium). This surface requires
  `HELM_OAUTH_ENC_KEY` (a 32-byte token-encryption key); without it the OAuth admin
  endpoints are disabled, and the gateway refuses to start if a subscription
  provider is configured without it.
  - **Connect** runs the login flow — manual paste-the-redirect for Claude/Codex,
    device-code for Copilot and xAI.
  - **Manage** opens a per-account dialog with tabs for **Models** (curate the
    exposed set — a live allow-list, not just a display filter), **Proxy**
    (per-account HTTP/HTTPS/SOCKS5 egress), and **Schedule** (`priority`,
    `schedulable`, Fast mode where the upstream client supports it, and guarded
    auto-reset for Codex).
  - **Pooling strategy** — several accounts per provider are pooled with a global
    strategy: `balanced`, `manual_priority`, `low_risk`, or `use_expiring`.
    Strategies use sticky sessions, priority, live quota windows, usage cooldowns,
    and reset-credit soft scoring without exposing account labels as client
    models.
  - **Quota controls** — the page opens from cache-only overview reads; an explicit
    refresh is globally coordinated and serializes account pulls. It shows today's
    served traffic, live quota windows, usage-limit cooldowns, Codex reset-credit
    count, **Test** account action, local **Reset usage**, and guarded Codex
    **Reset limit**. A fresh saturated Codex weekly PULL can enter guarded
    auto-reset; ordinary page reads never consume a credit. A reset-credit
    cooldown that proves the same account already completed reset is shown as a
    successful completed state, while reservation and unrelated 429 errors remain
    errors.
  - **Hot-reload** — every change (connect, disconnect, curation, proxy, scheduling)
    re-synthesizes the live provider pool and applies on the next request, no restart.
  - **Token storage** — tokens are stored encrypted and never returned to the UI
    (proxy passwords included: a read shows only `hasPassword`).
  - **Experimental xAI OAuth** is available by default. It uses xAI's Grok CLI device-code flow and
    subscription proxy, has no published third-party OAuth contract, and is labeled
    for personal self-hosted evaluation. The Providers page follows first-party
    grok-build and pulls the consumer weekly window from
    `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the existing
    account bearer and identity. It projects only the current weekly period, fails open,
    and never infers quota from unrelated public API credits, prepaid balance, or monthly
    billing periods.

  See [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) and the
  README's OAuth subscription section.

![Providers — pooled OAuth accounts with status, proxy, curated models, live quota, priority, and schedule](assets/screenshots/06-providers.png)

### System settings

- **Settings** (`/settings`) — the runtime-mutable settings the operator can
  change without a restart (`/admin/api/settings`, validated against
  `RuntimeSettingsSchema`, fail-closed on an invalid body). A representative set:
  `default_lane`; visual-context compression (`off` / `observe` / `enabled`);
  request content mode (`capture_sessions` is the default and retains incremental
  request history plus available response snapshots; full payload and metadata-only
  remain available) and `payload_retention_days`;
  the rate-limit master switch (`rate_limit_enabled`) and system default quota
  (`rate_limit_default_rpm` / `_tpm`); the concurrency
  overflow queue (`concurrency_queue_enabled` plus `min_size` /
  `size_multiplier` / `wait_timeout_ms`); the per-OAuth-account user-message
  serial queue (its `enabled` / `delay` / `timeout`); cleanup schedule,
  retention windows, archive-before-delete, manual clean-now, database vacuum,
  and archive download; and `log_level`. See [07 · Error Model &
  Observability](07-observability.md) and [06 · Auth, API Keys & Rate
  Limits](06-auth-and-rate-limits.md).

  `RuntimeSettingsSchema` also persists
  `native_protocol_passthrough` (default `true`), but the current page has no
  dedicated editor for that field; API clients performing a full settings PUT
  must preserve it.

![System settings — payload capture & retention, rate-limit defaults, concurrency queue, and database maintenance](assets/screenshots/10-settings.png)

### Memory

- **Memory** (`/memory`) — browse the long-term memory the gateway has learned,
  by **scope** (project / resource / thread) or by **key**, then drill in to view,
  edit, or remove individual facts and per-scope reflections
  (`/admin/api/memory`). Read-only counts up front; content opens on demand. The
  same store is also reachable over MCP at `/mcp`; the page includes a **Connect
  via MCP** dialog for connector/client setup when MCP is enabled. See [13 ·
  Memory Admin & MCP](13-memory-admin-and-mcp.md) and [14 · Memory: Deep
  Recall](14-memory-deep-recall.md). The summary cards read maintained counters
  from `memory_threads`; they do not rescan the raw message/observation tables on
  each page load.

![Memory — facts and reflections grouped by scope, with counts and last-updated](assets/screenshots/07-memory.png)

### Request debugging

- **Requests** (`/requests`) — the URL-backed, paginated request list, plus a
  per-request detail page, reading the read-only
  `/admin/api/requests` endpoints. This reuses the observability surface from
  [07 · Error Model & Observability](07-observability.md): key filters, the
  decided-by legend, classification stage, matched policy, lane candidate chain,
  provider attempts, final OAuth serving account, cost, token usage, true TPS,
  throughput/timing, error, unique Helm `request_id`, and reusable client
  `trace_id`. List rows, detail links, payload lookup, and Retry are all keyed by
  `request_id`; `trace_id` is display/copy-only correlation metadata. If
  that request was captured and the row has not been pruned, the detail can load
  the full request/response bodies
  (`/admin/api/requests/:requestId/payload`) plus upstream request metadata. The
  body viewer renders the payload as a collapsible tree (or Formatted / Raw), pops
  any oversized field — a system prompt, a tool schema, a continued-session
  summary — into a fullscreen, copyable reader, and previews inline base64/remote
  images with zoom, fit-to-window, and open-in-new-tab. A consolidated **media
  overview** at the top of the page collects every image **sent** (request) and
  **generated** (response, incl. image-generation output) as clickable thumbnails,
  so pictures buried at a deep base64 leaf are visible without tree-digging. The
  detail page also exposes upstream request diffs, captured SSE/event streams, and
  retry state. When the full request body was captured, the editable **Retry**
  button lets the operator resend the body in its original protocol (OpenAI chat,
  Anthropic messages, OpenAI Responses, or Gemini) as an isolated, newly-traced
  debug run; a body that cannot be replayed returns a precise 400.

![Requests — filter by decided-by, lane, and status; every row links to its trail](assets/screenshots/02-requests.png)

![Request trail — classification, eval, matched policy, lane candidate chain, provider attempts, and cost](assets/screenshots/03-request-trail.png)

## Boundaries

- Internal operations console only — no multi-tenancy and no fine-grained RBAC.
- API-key-holder usage, owned request details, connection help, and scoped memory
  curation live in `/portal`; the portal never inherits admin visibility.
- No agent orchestration in the admin UI. Memory **content** is browsable and
  editable on the Memory page (by scope or key); the per-key memory **mode** is
  configured on the Keys page.
- Boot-time configuration can still be edited directly in `config/*.yaml` and
  picked up on restart. The admin UI hot-applies the surfaces it owns (lanes,
  policies, classifier, runtime settings, key caps, provider account settings,
  and memory content), but it is a convenience layer rather than the only entry
  point.
