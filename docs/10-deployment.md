# 10 · Deployment (Self-Hosted / Docker)

Helm is an **open-source, self-hosted** project (MIT). There is no SaaS and
nothing to buy — anyone can deploy, modify, and run it commercially. The primary
deployment is **Docker**.

## Design principles

- **Single container, config-as-code.** One image plus one config directory boots
  the gateway. Boot-only provider/server/store/catalog changes need a restart;
  admin-owned lanes, policies, classifier rules, runtime settings, keys, memory,
  and OAuth-account settings apply live through their documented stores/APIs.
- **Lightweight, self-hostable.** The default store is SQLite (`helm.db`, a local
  file under the data volume), so there is no hard dependency on an external
  database. Postgres/Supabase is available via the same store abstraction (see
  [02 · Architecture](02-architecture.md)).
- **No extra services required.** Helm needs no Redis or message queue; rate
  limiting, caches, and the background workers are in-process / store-backed.

## Docker

The published image is `ghcr.io/easymetaau/helm-api`. It is built on **Node 22**
(`node:22-slim`), runs as a non-root `helm` user, and exposes port `8080`.

```bash
docker volume create helm-data
docker run -d --name helm \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  -v helm-data:/app/data \
  ghcr.io/easymetaau/helm-api:latest
```

Then run `docker logs helm` and open the complete
`http://localhost:8080/setup#token=...` URL it prints. The browser consumes the
protected fragment automatically; there is no token field. Supplying complete `HELM_ADMIN_*` credentials
skips the browser wizard for an automated/headless deployment; static provider
keys are optional because subscription providers can be connected later.

The image bakes the default `config/*.yaml` so it boots standalone on first run.
That is safe because `providers.yaml` references credentials by **env-var name
only**, never a plaintext key (Principle 7). Operators override the defaults by
mounting their own directory at `/app/config`. The built admin and portal SPAs are
also copied into the runtime image at `apps/admin/build` and `apps/portal/build`.

### docker-compose

A `docker-compose.yml` is provided. The shortest first install is:

```bash
./scripts/quickstart.sh
```

It creates a private `.env` containing only the port and current UID/GID, starts
Compose, and waits for setup readiness. Open the complete printed `/setup#token=...`
URL, choose the Admin credentials, and either test a static provider
key or continue to a subscription-only install. Existing `.env` files are never
overwritten. `./scripts/quickstart.sh --cli` retains a terminal/automation path.

Compose defaults to the published image, mounts config and data, and injects an
optional `.env`. No credential is required for the guarded setup mode:

```yaml
services:
  helm:
    image: ${HELM_IMAGE:-ghcr.io/easymetaau/helm-api:latest}
    # build: .
    container_name: helm
    env_file:
      - path: .env
        required: false
    user: "${HELM_UID:-10001}:${HELM_GID:-10001}"
    ports:
      - "${HELM_PORT:-8080}:${HELM_PORT:-8080}"
    volumes:
      - ./config:/app/config
      - ./data:/app/data
    environment:
      HELM_ADMIN_USER: ${HELM_ADMIN_USER:-}
      HELM_ADMIN_PASSWORD: ${HELM_ADMIN_PASSWORD:-}
      HELM_PORT: ${HELM_PORT:-8080}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
    restart: unless-stopped
```

The checked-in Compose file uses `.env` both for interpolation and as `env_file`,
so every documented optional provider/runtime setting reaches the container.
`HELM_PORT` controls the published port, gateway bind, and health probes together.
On Linux, `HELM_UID` / `HELM_GID` let the non-root process write `./data` without
`sudo` or world-writable permissions; the initializer fills the exact current
values. The `10001:10001` fallback preserves the image user for existing installs.

### First-run security and persistence

When Admin credentials are absent, Helm exposes only `/setup`, `/healthz`, and
`/version`; inference, Admin, Portal, docs, and key-management routes remain
unmounted. Setup requires a random 256-bit token written to
`data/helm-setup-token` with mode `0600`. The operator log and quickstart output
embed it in the `/setup#token=...` URL; the browser sends it only in protected
setup API headers, so beginners never see a separate token field and the first
public visitor still cannot claim the installation.

On completion Helm atomically writes the chosen Admin credentials, a generated
OAuth encryption key, and tested static provider keys to
`data/helm-managed-env.json` (`0600`), deletes the setup token, and switches the
same process to the full Gateway. External non-empty environment variables take
precedence over this file. It is deliberately equivalent to a private `.env`
inside the persistent data volume: protect the volume and backups; storing an
encryption key beside ciphertext would not protect against full-volume theft.

## Volumes

- `/app/config` — the YAML config tree (see [Configuration sources](#configuration-sources)).
- `/app/data` — persisted state (the directory named by `HELM_DATA_DIR`, default
  `./data`): the SQLite database `helm.db`, telemetry, captured payloads, and the
  bootstrap recovery file (`./data/helm-keys.json`). That historical filename
  contains the freshly minted **plaintext root key**, written once with mode
  `0600`; move it into a secret manager or remove it after first boot.

## Configuration sources

Configuration comes from **files** and **environment variables**, and env vars
**win** (this is what makes containerized deployment and secret injection clean):

- Boot config files loaded into the validated Helm config tree:
  `server.yaml`, `auth.yaml`, `providers.yaml`, `runtime.yaml`, and optional
  `classifier.yaml`, `lanes.yaml`, `policies.yaml`, `memory.yaml`, and
  `model-aliases.yaml` (see [02 · Architecture](02-architecture.md)). This is the
  config tree mounted at `/app/config`.
- Catalog override files: `capabilities.yaml` and `pricing.yaml`. They are read
  by the runtime model catalog loader, not by the top-level `loadConfig()` merge,
  and override the checked-in generated catalog (`pnpm sync:catalog` output).
- Environment variables — the common ones are in `.env.example`:
  - `HELM_HOST`, `HELM_PORT`. `HELM_BASE_PATH` is parsed and validated, but the
    current gateway still mounts routes at `/`; keep it `/` until route-prefix
    mounting is implemented.
  - `HELM_UID`, `HELM_GID` are Compose-only Linux bind-mount ownership controls;
    they do not enter the validated gateway config.
  - `HELM_ADMIN_USER`, `HELM_ADMIN_PASSWORD`, `HELM_ADMIN_ENABLED`. These are the
    shipping server's admin controls; there is currently no loaded admin YAML path.
  - `HELM_REQUIRE_API_KEY` must remain `true`; `false` is rejected at config load
    because anonymous inference is not supported. `HELM_RATE_LIMIT_ENABLED`,
    `HELM_REQUEST_TIMEOUT_MS`, `HELM_MAX_REQUEST_BYTES`,
    `HELM_SSE_HEARTBEAT_MS`
  - `HELM_SIGNAL_FEEDBACK_ENABLED` — opt into Agentic Signals feedback for ranked
    lane promotion (disabled by default; detailed thresholds live in
    `config/runtime.yaml`).
  - `HELM_STORE_DRIVER` (`sqlite` | `supabase`), `HELM_STORE_URL_ENV`
  - `HELM_DATA_DIR` (data directory, default `./data`), `HELM_KEYS_PERSIST_TO`,
    `HELM_ARCHIVE_DIR` (cleanup archive output, default under the data dir)
  - `HELM_OAUTH_ENC_KEY` — a 32-byte key used to encrypt recoverable API keys and
    stored OAuth subscription tokens. It enables the OAuth admin/pool runtime; a
    statically configured preset-OAuth provider fails startup when the key is
    absent. Without the key, existing encrypted accounts cannot be loaded and the
    OAuth admin operations are unavailable. API keys minted or rotated without it
    still authenticate, but cannot be revealed later. The optional MCP OAuth shim
    also derives its signing key from this env var and fails startup when
    `memory.mcp.oauth.enabled` is true without it.
  - Memory LLM overrides: `HELM_MEMORY_LLM_ENABLED`, `HELM_MEMORY_LLM_MODEL`,
    `HELM_MEMORY_LLM_OBSERVATION_MODEL`, `HELM_MEMORY_LLM_REFLECTION_MODEL`,
    `HELM_MEMORY_LLM_FACTS_MODEL`, `HELM_MEMORY_LLM_TIMEOUT_MS`,
    `HELM_MEMORY_LLM_TEMPERATURE`, and per-task max-token envs
    (`HELM_MEMORY_LLM_OBSERVATION_MAX_TOKENS`,
    `HELM_MEMORY_LLM_REFLECTION_MAX_TOKENS`,
    `HELM_MEMORY_LLM_FACTS_MAX_TOKENS`). MCP itself is enabled in
    `config/memory.yaml` (`memory.mcp.enabled`, with optional
    `memory.mcp.oauth.*`), not by an env override.
  - Background-worker toggles: `HELM_SIGNALS_DISABLED=1` stops the signal
    scheduler and `HELM_MEMORY_WORKER_DISABLED=1` stops the memory worker (both
    run by default); `HELM_MEMORY_WORKER_INTERVAL_MS` tunes the memory worker
    tick (default `60000`). Memory catch-up can be tuned with
    `HELM_MEMORY_WORKER_BATCH_SIZE`, `HELM_MEMORY_WORKER_MAX_BATCHES_PER_DRAIN`,
    `HELM_MEMORY_WORKER_MAX_DRAIN_MS`, `HELM_MEMORY_WORKER_COALESCE_MS`, and
    `HELM_MEMORY_WORKER_CONCURRENCY` (default `3`, capped at `8` to avoid a
    background LLM fan-out spike on small self-hosted machines). Cleanup can be
    disabled wholesale with `HELM_CLEANUP_DISABLED=1`.
  - Write/runtime safety knobs: `HELM_AUTH_CACHE_TTL_MS`,
    `HELM_WRITE_QUEUE_FLUSH_MS`, `HELM_WRITE_QUEUE_MAX_DEPTH`,
    `HELM_MEMORY_INJECT_TOKEN_BUDGET`, and `HELM_SHUTDOWN_DRAIN_MS`.
  - HTTP egress tuning: `HELM_UNDICI_KEEPALIVE_MS`,
    `HELM_UNDICI_KEEPALIVE_MAX_MS`, and `HELM_UNDICI_CONNECTIONS`.
  - Anthropic preset OAuth execution uses `transport_profile: auto` by default,
    which routes final provider execution through the optional Chrome-like
    TLS/JA3 transport (`wreq-js`) instead of undici. Set
    `transport_profile: default` on that provider to force the normal undici path.
    This does not affect token refresh/model discovery. Optional tuning:
    `HELM_TLS_BROWSER_PROFILE`, `HELM_TLS_OS_PROFILE`,
    `HELM_TLS_TRANSPORT_TIMEOUT_MS`.
  - Subscription-client compatibility overrides:
    `HELM_OPENAI_CODEX_CLIENT_VERSION` and `HELM_XAI_GROK_CLIENT_VERSION` must be
    semantic versions and should normally stay unset so the checked-in, tested
    defaults are used. They are emergency recovery controls for an upstream
    minimum-version change, not routine tuning. `HELM_OAUTH_CALLBACK_HOST`
    changes the local callback helper host (default `127.0.0.1`).
  - Upstream credentials such as `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`,
    `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` — each maps to a `providers.yaml`
    entry's `api_key_env`. Every static key is optional; an absent provider is
    skipped and may be added later. With no usable provider, Helm stays healthy
    and returns `503 lane_unavailable` for inference. Premium/coding lanes can
    instead route through the `openai-codex` subscription — connect it in Admin →
    Providers (the wizard generates `HELM_OAUTH_ENC_KEY`).

Invalid configuration is rejected at startup (Zod-validated, fail-closed) — Helm
never runs in a half-broken state (Principle 2).

## Run from source

Use Node 22+ and the pinned pnpm 10 release:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` serves the built gateway, Admin, and Portal and loads `.env` with
Node's native `--env-file-if-exists` flag. With no complete Admin credentials it
opens the same `/setup` flow as Docker. `pnpm dev` starts only the Admin Vite
server and is not a complete Helm runtime. For automation, pre-populate `.env`
from `.env.example`; a provider key is still optional.

## Startup behavior

1. Load configuration, then load `data/helm-managed-env.json` for values not
   already supplied by the external environment.
2. If Admin credentials are absent, start the token-protected setup-only surface.
   Completing setup atomically persists its state and switches the same process
   to the full server. An explicit `HELM_ADMIN_ENABLED=false` or
   `HELM_SETUP_DISABLED=1` preserves headless operation.
3. If no API key exists, **mint a root key, write the configured `0600` recovery
   file, and print the key once** (see [06 · Auth, API Keys & Rate
   Limits](06-auth-and-rate-limits.md)).
4. Mint a dedicated in-process internal key for memory/eval self-calls (fail-open
   to the direct/deterministic path if that mint fails).
5. Start the HTTP server: inference/compatibility routes, the unconditional
   self-service portal, optional Memory MCP, and the admin UI only when admin
   credentials/config enable it. See [Self-Service Portal](12-self-service-portal.md)
   and [11 · Admin UI](11-admin-ui.md).
6. Start the signal scheduler, memory worker, scheduled cleanup runner, and
   deferred write queue unless their controls disable them. Timers are unref'd and
   background failures are logged rather than turned into request failures.
7. Begin serving once the health endpoint reports ready.

## Health & version

- `GET /healthz` — unauthenticated process readiness probe. The current production
  wiring reports the booted store as `ok`; it is not a live SQL query or an
  upstream-provider check. Handler failures become `503`. The container
  `HEALTHCHECK` hits this endpoint, so combine it with logs, restart count, and
  business-route checks for incident diagnosis.
- `GET /version` — unauthenticated build info (`version`, `gitSha`, `builtAt`),
  injected at build time via the `HELM_VERSION` / `HELM_GIT_SHA` / `HELM_BUILT_AT`
  Docker build-args (CI fills them from the package version, commit, and a UTC
  stamp; for a local `build: .` see the commented `args` in `docker-compose.yml`).
  Defaults to `unknown` when unset. No config or credentials are exposed.

## Upgrading

Pull the new image → recreate the container → verify `/healthz` and `/version`.
Keep the mounted `config/` and `data/` directories; they are not overwritten.

The Memory project-scope migration (SQLite v40 / Postgres v39) is a stop-the-old-
version upgrade boundary. Stop every older gateway replica before the first new
replica runs migrations, then start only the upgraded version. A mixed-version
rolling upgrade is unsupported: an old process can recreate legacy thread ids
after the one-time migration ledger has advanced. Take a database backup first.
The migration deliberately quarantines account-only parents and archives/expires
all potentially derived long-tier rows for each affected owner; it does not guess
which new key project should inherit mixed history. Current project-scoped Memory
therefore starts clean. Operators can inspect the quarantined history, but should
restore content only after establishing its provenance. Missing owners, target-id
collisions, invalid foreign keys, and other partial failures roll back and abort
startup; Postgres runs each version on one reserved transaction connection under
a transaction-scoped advisory lock.

> Note: telemetry and captured payloads persist on the `data` volume across
> redeploys. When debugging, filter the request log by the container's start time
> so rows written by an older image are not mistaken for current behavior.

## Publishing

The pull-request workflow is loaded from the default branch with
`pull_request_target`, then explicitly checks out and validates the PR merge ref on
disposable GitHub-hosted Ubuntu runners. PR code therefore cannot rewrite the
workflow or reach the persistent runner pool; only trusted pushes to `main` use
the labelled self-hosted runners. Jobs that execute repository code have read-only
permissions and do not retain checkout credentials. A separate checkout-free job
is the only job allowed to publish the immutable PR-head checks `PR / verify`,
`PR / e2e`, and `PR / docker`.

The privileged publish workflow starts from a successful, completed `CI` run for
a `main` push—not from the push itself—and checks out that run's exact `head_sha`.
Non-push `workflow_run` events use run-scoped concurrency groups, so a skipped PR
completion cannot displace a legitimate `main` publisher waiting in the privileged
writer group.
All external Actions are pinned to audited 40-character commit SHAs, and repository
settings enforce SHA pinning. `main` requires a pull request, the three `PR / …`
checks above, and resolved review conversations; the rule also applies to
administrators and disallows force-pushes and branch deletion.

Every verified commit that is still the current `main` when publishing begins
first gets one authoritative image tag:
`ghcr.io/easymetaau/helm-api:sha-<full-40-character-SHA>`. The workflow checks
GHCR before building. If the tag already exists, a rerun pulls it and verifies
its full revision, version, deterministic commit-time build metadata, runtime
environment, and registry digest; it never rebuilds or overwrites that tag. A
first build uses the commit timestamp for `HELM_BUILT_AT` and
`SOURCE_DATE_EPOCH`. This makes Helm's build identity deterministic, although the
mutable upstream base image and package repositories mean the Docker build is
not claimed to be generally reproducible after external dependencies change.

Semver and `latest` are promoted by retagging the resolved immutable digest—not
by rebuilding. A complete existing `v<version>` tag and GitHub Release must retain
a matching semver image: legacy releases may prove their commit with the former
short runtime SHA, while releases made by this workflow must match the full-SHA
immutable digest. Tag/Release disagreement, missing artifacts, or conflicting
metadata fails closed. If a prior run pushed semver but stopped before creating
the Release, a later run may finish it only after proving that the image's full
SHA is an ancestor of current `main`, contains the same `package.json` version,
has exact deterministic metadata, and matches its full-SHA immutable digest.

Publish jobs are serialized in this order: immutable image → semver image →
GitHub Release → `latest`. Remote `main` is checked before semver and before
`latest`. Once semver promotion has begun, the run completes the matching Release
even if `main` advances, so it cannot intentionally leave a version image without
its Release; it then refuses to promote stale `latest`. Normal release work is
therefore: review the merged scope, bump `package.json`, merge to `main`, wait for
all CI jobs, then wait for Publish image before pulling on the remote host.

These checks deliberately narrow, but cannot make atomic, the boundary between a
GitHub branch update and a GHCR tag write: `main` can move immediately after any
check, and Docker push offers no cross-system compare-and-swap. Treat the full-SHA
tag/digest as the authoritative deployment and rollback reference. A later
verified publish converges `latest`; automation that requires exact release
identity should never resolve `latest` at deployment time.
