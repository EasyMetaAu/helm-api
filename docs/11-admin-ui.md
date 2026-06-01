# 11 · Admin UI

> Status: **implemented (0.1).** A SvelteKit + Tailwind SPA (`adapter-static`),
> built into `apps/admin/build` and served by the gateway under `/admin`.

After it boots, Helm ships a web console for basic rule management and request
debugging. It is meant for **internal** use and is gated by HTTP Basic
credentials.

## Authentication: HTTP Basic

The admin UI's authentication is **deliberately separate** from the API-key auth
used for API traffic (see [06 · Auth, API Keys & Rate Limits](06-auth-and-rate-limits.md)):
a different header (Basic vs. Bearer), a different credential source (config/env
vs. the KeyStore), and no RBAC. The admin path never consults the KeyStore, and
API traffic never consults these credentials.

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

- **Keys** (`/keys`) — create and revoke API keys and set per-key rate limits.
  Backed by the KeyStore (`/admin/api/keys` `GET` / `POST` / `PATCH` / `DELETE`),
  never YAML. The plaintext of a freshly minted key is returned exactly once
  (Principle 7); revocation is a soft disable. See [06 · Auth, API Keys & Rate
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

Rule edits go through a runtime rule store that re-binds the live `lanes` /
`policies` / `classifier` config the router reads — applied on the very next
request, no restart. Changes are persisted, keeping "config-as-code".

### System settings

- **Settings** (`/settings`) — the runtime-mutable settings the operator can
  change without a restart (`/admin/api/settings`, validated against
  `RuntimeSettingsSchema`, fail-closed on an invalid body): `capture_payloads`
  (default on), `payload_retention_days`, the rate-limit master switch
  (`rate_limit_enabled`) and system default quota
  (`rate_limit_default_rpm`/`_tpm`), and `log_level`. See [07 · Error Model &
  Observability](07-observability.md) and [06 · Auth, API Keys & Rate
  Limits](06-auth-and-rate-limits.md).

### Request debugging

- **Requests** (`/requests`) — the request list, plus a per-request detail page
  (`/requests/[traceId]`), reading the read-only `/admin/api/requests` endpoints.
  This reuses the observability surface from [07 · Error Model &
  Observability](07-observability.md): classification stage, matched policy, lane
  candidate chain, provider attempts, cost, error, and `trace_id`. When
  `capture_payloads` is on, the detail can load the full captured request/response
  bodies (`/admin/api/requests/:traceId/payload`).

## Boundaries (0.1)

- Basic rule management and request inspection only — no multi-tenancy and no
  fine-grained RBAC.
- No Memory / agent orchestration in the admin UI.
- Complex configuration can still be edited directly in `config/*.yaml` and
  reloaded — the admin UI is a convenience layer, not the only entry point.
