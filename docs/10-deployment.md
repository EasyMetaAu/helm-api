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
docker run -d --name helm \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  -e HELM_ADMIN_USER=admin \
  -e HELM_ADMIN_PASSWORD=change-me \
  -e DEEPSEEK_API_KEY=sk-... \
  ghcr.io/easymetaau/helm-api:latest
```

The image bakes the default `config/*.yaml` so it boots standalone on first run.
That is safe because `providers.yaml` references credentials by **env-var name
only**, never a plaintext key (Principle 7). Operators override the defaults by
mounting their own directory at `/app/config`. The built admin and portal SPAs are
also copied into the runtime image at `apps/admin/build` and `apps/portal/build`.

### docker-compose

A `docker-compose.yml` is provided. It defaults to the published image (uncomment
the `build:` block for local builds), mounts the two volumes, and injects credentials from
a `.env` file. `HELM_ADMIN_PASSWORD` and `DEEPSEEK_API_KEY` are required (compose
fails fast if they are unset):

```yaml
services:
  helm:
    image: ghcr.io/easymetaau/helm-api:latest
    # build: .
    container_name: helm
    ports:
      - "8080:8080"
    volumes:
      - ./config:/app/config
      - ./data:/app/data
    environment:
      HELM_ADMIN_USER: ${HELM_ADMIN_USER:-admin}
      HELM_ADMIN_PASSWORD: ${HELM_ADMIN_PASSWORD:?set HELM_ADMIN_PASSWORD in .env}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY in .env}
    restart: unless-stopped
```

Compose's project `.env` file is used for **variable interpolation**; it does not
automatically pass every entry into the container. The checked-in compose file
forwards only the variables shown in its `environment:` block (admin credentials,
the required DeepSeek credential, the OAuth encryption key, and the optional xAI
client-version override). To use optional providers or runtime overrides from
`.env.example`, add those names to `environment:` or use an explicit `env_file:` /
`docker run --env-file` deployment. The gateway itself does not load `.env`.

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
    entry's `api_key_env`. `DEEPSEEK_API_KEY` is required (the primary
    credential); the others are optional (their providers are skipped if absent).
    Premium/coding lanes can instead route through the `openai-codex`
    subscription — connect it in the admin UI (which needs `HELM_OAUTH_ENC_KEY`,
    above), not an API key here.

Invalid configuration is rejected at startup (Zod-validated, fail-closed) — Helm
never runs in a half-broken state (Principle 2).

## Startup behavior

1. Load configuration (files + environment variables, env wins).
2. If no API key exists, **mint a root key, write the configured `0600` recovery
   file, and print the key once** (see [06 · Auth, API Keys & Rate
   Limits](06-auth-and-rate-limits.md)).
3. Mint a dedicated in-process internal key for memory/eval self-calls (fail-open
   to the direct/deterministic path if that mint fails).
4. Start the HTTP server: inference/compatibility routes, the unconditional
   self-service portal, optional Memory MCP, and the admin UI only when admin
   credentials/config enable it. See [Self-Service Portal](12-self-service-portal.md)
   and [11 · Admin UI](11-admin-ui.md).
5. Start the signal scheduler, memory worker, scheduled cleanup runner, and
   deferred write queue unless their controls disable them. Timers are unref'd and
   background failures are logged rather than turned into request failures.
6. Begin serving once the health endpoint reports ready.

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
