# 06 · Auth, API Keys & Rate Limits

> Status: **implemented**. Mandatory API-key auth, root-key bootstrap, and
> per-key rate limits all ship in the gateway.

Helm never allows anonymous access. Every request to the API surface
(`/v1/chat/completions`, `/v1/messages`, `/v1/responses`,
`/v1beta/models/...:generateContent`, `/v1/images/generations`,
`/v1beta/interactions`) must carry a valid API key. The admin UI is a separate surface with its own HTTP Basic
credentials (see [11 · Admin UI](11-admin-ui.md)).

## Authentication

Auth is enforced by a Hono middleware (`apps/gateway/src/middleware/auth.ts`)
registered **before** rate limiting and classification, so an unauthenticated
request is short-circuited before it can cost anything.

- The key is read from `Authorization: Bearer <key>` (preferred) or from the
  `x-api-key` header. It is treated as case-sensitive and is never trimmed or
  lowercased before hashing.
- The plaintext key is hashed with sha256 and looked up via
  `KeyStore.getByHash`. A missing, unknown, or `disabled` key yields a
  structured `auth_error` (HTTP 401); see [07 · Error Model &
  Observability](07-observability.md).
- On success, an `AuthIdentity` is attached to the request context: `keyId`,
  `keyPrefix` (display prefix only — **never** the plaintext key), `accountId`,
  `role`, and the per-key caps (`AuthIdentity.caps`, including the rate-limit
  override). Downstream middleware reads this instead of touching the store
  again.

The native-protocol faces authenticate **inside the handler** rather than at the
shared middleware, so they can emit their own error envelopes: `/v1/messages`,
`/v1/responses`, and `/v1beta/*` each run the same key lookup but shape a 401 in
their native protocol shape. The Anthropic face accepts either `x-api-key` or
`Authorization: Bearer`.

`/v1/images/generations` is likewise a self-authenticating route: it runs the
same key lookup using `Authorization: Bearer` (like the OpenAI Chat face). It
does **not** require `allow_custom_model` — a standard key can call it even
though it names an exact image model or image lane.

`/v1beta/interactions` (the Gemini Interactions image-generation surface)
self-authenticates the same way, but using `x-goog-api-key` (the Gemini SDK
default) with `Authorization: Bearer` as a fallback. Like the other image
surfaces it can name an image model or image lane and does **not** require
`allow_custom_model` — any key can call it.

Per **Principle 7**, the plaintext key lives in the `Authorization` header and,
when encrypted recovery is configured, in the authenticated admin create/reveal/
rotate response. It is never logged and never written to telemetry or the
captured payload tables. Logs reference a key by `key_id` or `keyPrefix` only.

```yaml
# config/auth.yaml
require_api_key: true
bootstrap:
  generate_if_missing: true            # on first start with no keys, mint a root key
  print_once: true                     # plaintext printed to the boot log exactly once
```

## Root-key bootstrap

On first start, if the `KeyStore` contains **no** keys, the gateway mints a
single `role=root` key (`bootstrapRootKey` in
`packages/core/src/auth/bootstrap.ts`):

- Only the sha256 **hash** and the display **prefix** are persisted for bootstrap
  keys — never the plaintext.
- The plaintext is printed to the boot log **exactly once** for the operator to
  capture. It is not recoverable afterward.
- The check is idempotent: if any key already exists, bootstrap does nothing
  across restarts.
- A store read failure aborts startup (fail-closed) — Helm never degrades to
  anonymous access.

The root key is meant for bootstrap and admin tasks; mint scoped `user` keys for
production traffic rather than using the root key directly.

## Key management

Keys are managed through the KeyStore port (`packages/core/src/store/ports.ts`),
backed by either the SQLite or the Postgres adapter, and surfaced in the admin UI
(see [11 · Admin UI](11-admin-ui.md)).

The stored record (`ApiKeyRecord`, single source of truth in
`packages/shared/src/key/schema.ts`):

```ts
{
  key_id: string,
  hash: string,             // sha256(plaintext) hex — never the plaintext
  prefix: string,           // e.g. helm_live_ab12 — display/debug only
  account_id: string,
  role: "root" | "user",
  allowed_lanes: string[] | null,   // allow-list of lanes (empty/null = any lane)
  allow_custom_model: boolean,      // may the client pin a model OR lane directly?
  disabled: boolean,

  // Rate limit (null = inherit system default; 0 = explicitly unlimited)
  rate_limit_rpm: number | null,
  rate_limit_tpm: number | null,

  // Usage budgets (null = no cap for that dimension)
  budget_requests: number | null,
  budget_tokens: number | null,
  budget_spend_usd: number | null,
  budget_window_seconds: number | null,        // null = system default (~30 days)
  over_budget_behavior: "degrade" | "reject",  // default "degrade"
  degrade_lane: string | null,                 // null = economy

  // Concurrency (issue #93) — null = unlimited; enforced only when
  // concurrency_queue_enabled is on
  concurrency_limit: number | null,

  // Per-key memory defaults (issue #97) — x-memory-* headers override these
  memory_mode: "off" | "observe" | "inject",   // new keys mint "inject"; root key forced "off"; legacy rows parse-default "off"
  memory_project_id: string | null,
  memory_thread_source: "header" | "auto",     // new keys mint "auto"; root key forced "header"; legacy rows parse-default "header"
}
```

All of these are resolved at auth time onto `AuthIdentity.caps` and threaded
through the request — downstream code reads the caps, never the store.

- **Hash-auth + encrypted recovery.** The store port's `CreateKeyInput` has no
  plaintext field, so the persistence layer is structurally unable to store a raw
  key. It may store `secret_enc`, an AES-GCM ciphertext encrypted with
  `HELM_OAUTH_ENC_KEY`, for admin-only reveal. Existing rows without `secret_enc`
  remain unrecoverable until rotated.
- **Per-key caps.** `allowed_lanes` and `allow_custom_model` constrain how a key
  may route. `allow_custom_model` lets the `model` field name a concrete model
  alias or a lane (docs/04); an explicit lane is still bounded by `allowed_lanes`
  and a violation is a 400, not a silent downgrade. (A per-key `max_lane` ceiling
  was retired — lanes are parallel, not a strict hierarchy, so the whitelist
  subsumes it; see implementation-notes.md.)
- **Rotation preserves history.** `KeyStore.rotateKey` replaces only `hash`,
  `prefix`, and optional `secret_enc` on the same `key_id`; name, account, role,
  caps, usage, and telemetry history stay attached to that key. `KeyStore.disable`
  is a soft revoke (`disabled = true`). `KeyStore.updateKey` is a partial PATCH
  that writes only the per-key cap columns present in the patch (rate limits,
  allowed lanes, custom-model flag, budgets, concurrency, memory defaults),
  leaving omitted columns untouched; it never mutates `role` or account identity.
- **Permanent deletion is an explicit second step.** An already-**revoked** key
  may be physically removed via `KeyStore.deleteKey` (admin:
  `DELETE /admin/api/keys/:id?purge=true`). The route gates it server-side: an
  **active** key cannot be purged (`409`) — it must be revoked first, so the
  soft-revoke audit step is never skipped and an active key is never silently
  wiped. Deletion is safe for observability: telemetry/payload rows reference
  `api_key_id` as an unlinked column (no FK to `api_keys`), so past decisions keep
  their (now-dangling) key reference for audit even after the key row is gone.

## Rate limits & quotas

A "nginx for LLM" needs per-key rate limiting, but it must not become
out-of-the-box friction. Helm ships lightweight per-key limiting (token-bucket
RPM/TPM) that is **disabled by default**, plus per-key **usage budgets** (see
below). Helm meters **per API key** — there is no account/customer billing
subject or credit ledger (out of scope; see the [roadmap](09-roadmap.md)).

The limiter lives in core (`packages/core/src/ratelimit/`), behind a store-backed
token bucket; the gateway middleware
(`apps/gateway/src/middleware/rate-limit.ts`) is glue only. Position is a
contract: **after** auth (it needs the resolved `key_id`) and **before**
classify/route (so it cuts off cost before classification or eval).

### Configuration & precedence

The master switch and the system default quota are **runtime-mutable** via the
admin "System Settings" page (`rate_limit_enabled`, `rate_limit_default_rpm`,
`rate_limit_default_tpm` in `RuntimeSettingsSchema`), seeded at boot from
`config/runtime.yaml`:

```yaml
# config/runtime.yaml
rate_limit:
  enabled: false          # master switch (default OFF). Env: HELM_RATE_LIMIT_ENABLED
  default:
    rpm: 0                 # 0 = unlimited
    tpm: 0
  overrides: {}            # yaml per-key overrides, keyed by key_id (config-only fallback)
```

Quota resolution per dimension (`resolveQuota` in `ratelimit/limiter.ts`):

1. If the request carries a **per-key override** (resolved by auth from the key's
   DB record), that is authoritative: each dimension resolves
   `override.<dim> ?? system_default.<dim>`. A `null` dimension means "inherit the
   system default" — it deliberately does **not** fall back to a yaml
   `overrides[key_id]` entry, so clearing a key's limit in the admin UI truly
   returns it to the fleet default. `0` is a real value (explicitly unlimited),
   not "inherit".
2. If **no** per-key override is carried (e.g. a config-only / headless caller),
   fall back to `config.overrides[key_id]`, then to `config.default`.

### Behavior

- When the master switch is off, or both dimensions resolve to `0` (unlimited),
  the limiter returns "allowed" and **never touches the store** — a zero-overhead
  fast path with no `x-ratelimit-*` headers.
- When active, both buckets must admit the request. RPM is debited first
  (1 request = 1 token); only if RPM admits is the TPM bucket charged the
  pre-classification token estimate. Either shortfall rejects.
- A successful metered request emits `x-ratelimit-limit`, `x-ratelimit-remaining`,
  and `x-ratelimit-reset` describing the **tighter** of the two dimensions.
- A rejected request returns HTTP 429 `rate_limited` (with `limited_by` =
  `rpm`/`tpm`, a `retry-after` header, and the rate-limit headers).
- The bucket store is **fail-closed**: a read/write failure propagates and the
  request is rejected — it never silently degrades to "unlimited".
- Counters persist in the store, so they survive restarts.

## Per-key usage budgets

Rate limits cap the *rate* of traffic; **usage budgets** cap *cumulative
consumption* per key over a rolling window, to control cost. Each key may set any
subset of three optional caps (null = no cap for that dimension):

- `budget_requests` — request count,
- `budget_tokens` — total tokens,
- `budget_spend_usd` — spend in USD,

over a `budget_window_seconds` rolling window (null = a system default, ~30 days).
Budgets reuse the same token-bucket as rate limits (`packages/core/src/budget/`,
backed by the `usage_budget_buckets` store table) — just with a **configurable
window** instead of the fixed 60s, and continuous refill (no hard reset).

The distinguishing behavior is **what happens when a key is over budget**, chosen
per key via `over_budget_behavior`:

- **`degrade`** (default) — the request is **forced onto the cheaper
  `degrade_lane`** (default `economy`), then served normally, so cost is bounded
  **without interrupting service**. This is a *forced lane selection*, not a rank
  ceiling, so it works even when the target is a task lane (`coding`, `json`, …).
  The forced lane is
  still clamped to the key's `allowed_lanes`, and explicit-model/lane passthrough
  is **suppressed** while degrading — a degrading key cannot bypass the cap by
  naming an expensive model or lane.
- **`reject`** — a hard `429 rate_limited` (message `usage budget exceeded`),
  before classify/route.

Enforcement runs in two phases, split by failure mode:

- **Pre-route check** is a pure balance sign check (no per-request cost estimate):
  a discrete dimension (requests/tokens) is over when it can't afford one more
  unit (`remaining < 1`); spend is over at `remaining <= 0`. It is **fail-CLOSED**
  — a store-read error propagates (→ 5xx), never a silent pass. A key with no caps
  is a zero-touch fast path (no store read).
- **Post-served settle** debits the **actual** served usage (1 request + measured
  tokens + the decision's settled `total_usd`, never recomputed; unmeasured cost
  settles 0). It is **fail-OPEN** — a settle failure is logged, never 5xx's a
  served request. Because settle is post-served, a single in-flight request may
  push a bucket slightly negative (a soft cap); subsequent requests are then over
  budget.

Budgets are enforced on **all four protocol faces** (OpenAI `/v1/chat`, Anthropic
`/v1/messages`, OpenAI `/v1/responses`, Gemini `:generateContent`). The
self-authenticating faces share one routing pipeline, so the check + settle (and
the streamed-cost backfill that makes the spend dimension correct on the streaming
path) live there once. Budgets and rate limits **also** apply to the
image-generation surfaces — `/v1/images/generations`, the Gemini
`:generateContent` image models, and `/v1beta/interactions`; image cost is metered
per image (output tokens × the model's image rate). All budget config is editable
per key in the admin API Keys page and applies on the next request (no restart).

## OAuth subscription quotas and reset credits

Per-key rate limits and budgets above are Helm-owned controls. OAuth subscription
quotas are different: they describe the upstream account's remaining subscription
capacity, are stored per provider/account, and are used for account-pool
availability and scoring (see [04 · Routing & Lanes](04-routing-and-lanes.md)).
They never grant a client more API-key budget.

Quota collection is intentionally fail-open:

- Codex quota windows are captured from `x-codex-*` response headers on served
  requests and from the provider usage endpoint used by the Providers page.
- Anthropic quota windows are pulled from the provider usage endpoint.
- Missing, stale, or failed quota reads render as unknown in the UI and make
  quota-aware strategies fall back toward the balanced behavior.

When a quota window is saturated and carries a future reset time, Helm parks that
OAuth account until the reset timestamp and persists the cooldown in
`oauth_quota.usage_limited_until_ms`, so a pool rebuild or restart keeps routing
around it. A generic account-wide 429 without a precise window applies a shorter
probe cooldown. The Providers page **Reset usage** action only clears Helm's local
cooldown/snapshot for a Codex account so it can rejoin the pool; it does not spend
an upstream reset credit.

Codex reset credits are separate. The Providers page **Reset limit** action
spends one upstream Codex rate-limit reset credit through the official consume
endpoint and is fail-closed: if the consume call fails, the operator sees an
error. Helm guards the mutation:

- manual **Reset limit** is allowed only when a weekly Codex window is at least
  90% used;
- auto-reset runs only for accounts that opted in, only after the weekly window is
  saturated, and through a shared-account guard so sibling Helm labels for the
  same ChatGPT login cannot double-spend the same credit;
- reset credits may influence the `use_expiring` strategy as discounted virtual
  capacity, but **selection never consumes them**.

## Admin authentication is separate

API-key auth (this chapter) governs API traffic. The admin UI is gated by HTTP
Basic credentials from config/env — a different header, a different credential
source, and no RBAC. The two never cross: the API path never consults the admin
credentials, and the admin path never consults the KeyStore. See [11 · Admin
UI](11-admin-ui.md).
