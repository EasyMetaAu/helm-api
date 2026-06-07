# 11 · Admin UI

> Status: **implemented.** A SvelteKit + Tailwind SPA (`adapter-static`),
> built into `apps/admin/build` and served by the gateway under `/admin`.

After it boots, Helm ships a web console for basic rule management and request
debugging. It is meant for **internal** use and is gated by HTTP Basic
credentials.

## Authentication: HTTP Basic

The admin UI's authentication is **deliberately separate** from the API-key auth
used for API traffic — a different header (Basic vs. Bearer), a different
credential source (config/env vs. the KeyStore), and no RBAC (see
[06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md)).

Credentials are resolved by `resolveAdminAuth`
(`apps/gateway/src/middleware/basic-auth.ts`), with environment variables taking
priority over config:

```yaml
# config/auth.yaml — optional admin block (env overrides take priority)
admin:
  enabled: true
  username: admin       # or HELM_ADMIN_USER
  password: change-me   # or HELM_ADMIN_PASSWORD
```

```bash
# Environment form (recommended for Docker)
HELM_ADMIN_USER=admin
HELM_ADMIN_PASSWORD=change-me
HELM_ADMIN_ENABLED=true   # optional explicit toggle
```

Enable / mount rules:

- **Configuring credentials auto-enables the admin surface.** Setting
  `HELM_ADMIN_USER` + `HELM_ADMIN_PASSWORD` is the obvious "protect admin" action,
  so it turns the surface on. Precedence: an explicit env flag
  (`HELM_ADMIN_ENABLED`) > an explicit config flag (`admin.enabled`) > "credentials
  present".
- **When admin is not enabled, it is not mounted at all** — both `/admin` and
  `/admin/api/*` return 404, so the key-management and telemetry endpoints can
  never be reached unauthenticated.
- **When enabled but credentials are missing**, the gateway still boots but emits
  a single explicit warning, and every admin request fails closed (401) — never
  silently open.
- Credentials are compared in constant time and the password is never logged.
- The Basic gate covers both the API (`/admin/api/*`) and the SPA page + assets
  (`/admin`). Run the admin UI behind a reverse proxy / on an internal network.

## Internationalization

The SPA ships in five languages, English by default
(`apps/admin/src/lib/config/languages.ts`): English (`en`), Simplified Chinese
(`zh-hans`), Traditional Chinese (`zh-hant`), Japanese (`ja`), and Korean (`ko`).
An unrecognized browser/stored language tag falls back to `en`.

## What the admin UI can do

The SPA pages (`apps/admin/src/routes/`) are pure consumers of the gateway's
`/admin/api/*` endpoints.

### Dashboard

The landing page (`/`) gives an at-a-glance overview.

### Rule management

- **Keys** (`/keys`) — create and revoke API keys and edit the full per-key cap
  set: allowed lanes, custom-model permission, rate limits (RPM/TPM), usage
  budgets (requests / tokens / spend with a budget window plus the over-budget
  behavior and degrade lane), the concurrency limit, and the memory mode
  (`off` / `observe` / `inject` with project id and thread source). Backed by the
  KeyStore (`/admin/api/keys` `GET` / `POST` / `PATCH` / `DELETE`), never YAML.
  The plaintext of a freshly minted key is returned exactly once (Principle 7);
  revocation is a soft disable. A revoked key can then be permanently deleted as
  an explicit second step (DELETE `?purge=true`); the server refuses to purge an
  active key (409 'key must be revoked before deletion'). Telemetry keeps an
  unlinked key_id reference for audit history. See [06 · Auth, API Keys & Rate
  Limits](06-auth-and-rate-limits.md).
- **Lanes** (`/lanes`) — view/edit each lane's `primary + fallback[]`
  (`/admin/api/lanes` CRUD). The model combobox is populated from a read-only
  catalog of routable aliases (`/admin/api/models`). See [04 · Routing &
  Lanes](04-routing-and-lanes.md).
- **Policies** (`/policies`) — view/edit the policy matching rules
  (`task_type` / `complexity` / `user` / `org` → lane) via `/admin/api/policies`.
- **Classifier** (`/classifier`) — toggle eval, tune `confidence_threshold`, and
  inspect the rule dimensions/weights (`/admin/api/classifier`). See [03 ·
  Classification Cascade](03-classification.md).

Rule edits go through a runtime rule store that FIRST writes the change back to
the canonical `config/*.yaml` (comment-preserving, atomic, fail-closed) and then
re-binds the live `lanes` / `policies` / `classifier` config the router reads —
applied on the very next request, no restart, and durable across restarts. A
failed write rejects the edit with the live config unchanged, so file and memory
never diverge.

### Providers (OAuth subscriptions)

- **Providers** (`/providers`) — connect and manage **OAuth subscription** backends
  (Claude Pro/Max, ChatGPT Codex, GitHub Copilot). This surface requires
  `HELM_OAUTH_ENC_KEY` (a 32-byte token-encryption key); without it the OAuth admin
  endpoints are disabled, and the gateway refuses to start if a subscription
  provider is configured without it.
  - **Connect** runs the login flow — manual paste-the-redirect for Claude/Codex,
    device-code for Copilot.
  - **Manage** opens a per-account dialog with three tabs: **Models** (curate the
    exposed set — a live allow-list, not just a display filter), **Proxy**
    (per-account HTTP/HTTPS/SOCKS5 egress), and **Schedule** (`priority` plus a
    `schedulable` toggle).
  - **Pooling** — several accounts per provider are pooled (priority asc, then LRU).
  - **Hot-reload** — every change (connect, disconnect, curation, proxy, scheduling)
    re-synthesizes the live provider pool and applies on the next request, no restart.
  - **Token storage** — tokens are stored encrypted and never returned to the UI
    (proxy passwords included: a read shows only `hasPassword`).

  See [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md) and the
  README's OAuth subscription section.

### System settings

- **Settings** (`/settings`) — the runtime-mutable settings the operator can
  change without a restart (`/admin/api/settings`, validated against
  `RuntimeSettingsSchema`, fail-closed on an invalid body). A representative set:
  `capture_payloads` (default on) and `payload_retention_days`; the rate-limit
  master switch (`rate_limit_enabled`) and system default quota
  (`rate_limit_default_rpm` / `_tpm`); the concurrency overflow queue
  (`concurrency_queue_enabled` plus `min_size` / `size_multiplier` /
  `wait_timeout_ms`); the per-OAuth-account user-message serial queue (its
  `enabled` / `delay` / `timeout`); and `log_level`. See [07 · Error Model &
  Observability](07-observability.md) and [06 · Auth, API Keys & Rate
  Limits](06-auth-and-rate-limits.md).

### Request debugging

- **Requests** (`/requests`) — the request list, plus a per-request detail page
  (`/requests/[traceId]`), reading the read-only `/admin/api/requests` endpoints.
  This reuses the observability surface from [07 · Error Model &
  Observability](07-observability.md): classification stage, matched policy, lane
  candidate chain, provider attempts, cost, error, and `trace_id`. When
  `capture_payloads` is on, the detail can load the full captured request/response
  bodies (`/admin/api/requests/:traceId/payload`). When the full request body was
  captured and is an OpenAI-chat request (a `messages` array), the detail page
  offers an editable **Retry** button that re-sends the (optionally edited) body
  as an isolated, newly-traced debug re-run via the server replay endpoint.

## Boundaries

- Basic rule management and request inspection only — no multi-tenancy and no
  fine-grained RBAC.
- No memory-content browsing or agent orchestration in the admin UI (the per-key
  memory **mode** is configurable on the Keys page).
- Complex configuration can still be edited directly in `config/*.yaml` and
  reloaded — the admin UI is a convenience layer, not the only entry point.
