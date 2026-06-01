# 06 · Auth, API Keys & Rate Limits

> Status: **implemented (0.1)**. Mandatory API-key auth, root-key bootstrap, and
> per-key rate limits all ship in the gateway.

Helm never allows anonymous access. Every request to the API surface
(`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) must carry a valid
API key. The admin UI is a separate surface with its own HTTP Basic credentials
(see [11 · Admin UI](11-admin-ui.md)).

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
  `role`, the per-key caps, and the per-key rate-limit override. Downstream
  middleware reads this instead of touching the store again.

Per **Principle 7**, the plaintext key lives only in the `Authorization` header.
It is never logged, never echoed in a response, and never written to telemetry
or the captured payload tables. Logs reference a key by `key_id` or `keyPrefix`
only.

```yaml
# config/auth.yaml
require_api_key: true
bootstrap:
  generate_if_missing: true            # on first start with no keys, mint a root key
  persist_to: ./data/helm-keys.json    # written to the mounted ./data volume
  print_once: true                     # plaintext printed to the boot log exactly once
```

## Root-key bootstrap

On first start, if the `KeyStore` contains **no** keys, the gateway mints a
single `role=root` key (`bootstrapRootKey` in
`packages/core/src/auth/bootstrap.ts`):

- Only the sha256 **hash** and the display **prefix** are persisted — never the
  plaintext.
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
  max_lane: string | null,        // cap routing at this lane
  allowed_lanes: string[] | null, // allow-list of lanes
  allow_custom_model: boolean,    // may the client pin a model directly?
  disabled: boolean,
  rate_limit_rpm: number | null,  // per-key override; null = inherit default
  rate_limit_tpm: number | null,  // 0 = explicitly unlimited
}
```

- **Hashed storage only.** The store port's `CreateKeyInput` has no plaintext
  field, so the persistence layer is structurally unable to store a plaintext
  key. The plaintext of a freshly minted key is returned to the admin caller
  exactly once and then discarded.
- **Per-key caps.** `max_lane`, `allowed_lanes`, and `allow_custom_model`
  constrain how a key may route (resolved into `AuthIdentity.caps`).
- **Rotation & revocation never mutate in place.** `KeyStore.disable` is a soft
  revoke (`disabled = true`); rotate by minting a new key and disabling the old
  one. `updateRateLimit` is a partial PATCH that touches only the rate-limit
  columns, never role/caps.

## Rate limits & quotas

A "nginx for LLM" needs per-key rate limiting, but it must not become
out-of-the-box friction. Helm ships lightweight per-key limiting (token-bucket
RPM/TPM) that is **disabled by default**. Full quota/billing/credit accounting is
on the [roadmap](09-roadmap.md), not in 0.1.

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
  overrides: {}           # yaml per-key overrides, keyed by key_id (config-only fallback)
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

## Admin authentication is separate

API-key auth (this chapter) governs API traffic. The admin UI is gated by HTTP
Basic credentials from config/env — a different header, a different credential
source, and no RBAC. The two never cross: the API path never consults the admin
credentials, and the admin path never consults the KeyStore. See [11 · Admin
UI](11-admin-ui.md).
