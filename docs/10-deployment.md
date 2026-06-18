# 10 · Deployment (Self-Hosted / Docker)

Helm is an **open-source, self-hosted** project (MIT). There is no SaaS and
nothing to buy — anyone can deploy, modify, and run it commercially. The primary
deployment is **Docker**.

## Design principles

- **Single container, config-as-code.** One image plus one config directory boots
  the gateway; you change configuration and restart, like nginx.
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
  -v "$(pwd)/config:/app/config" \   # config tree (see Configuration sources)
  -v "$(pwd)/data:/app/data" \       # telemetry, keys, sqlite — persisted
  -e HELM_ADMIN_USER=admin \         # admin UI Basic auth (see 11)
  -e HELM_ADMIN_PASSWORD=change-me \
  -e DEEPSEEK_API_KEY=sk-... \       # primary provider credential (required)
  ghcr.io/easymetaau/helm-api:latest
```

The image bakes the default `config/*.yaml` so it boots standalone on first run.
That is safe because `providers.yaml` references credentials by **env-var name
only**, never a plaintext key (Principle 7). Operators override the defaults by
mounting their own directory at `/app/config`.

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

## Volumes

- `/app/config` — the YAML config tree (see [Configuration sources](#configuration-sources)).
- `/app/data` — persisted state (the directory named by `HELM_DATA_DIR`, default
  `./data`): the SQLite database `helm.db`, telemetry, captured payloads, and the
  bootstrapped key file (`./data/helm-keys.json`).

## Configuration sources

Configuration comes from **files** and **environment variables**, and env vars
**win** (this is what makes containerized deployment and secret injection clean):

- `config/*.yaml` — `lanes`, `policies`, `classifier`, `providers`,
  `capabilities`, `pricing`, `auth`, `runtime`, `server`, `memory` (see
  [02 · Architecture](02-architecture.md)). This is the single config tree
  mounted at `/app/config`.
- Environment variables — the common ones are in `.env.example`:
  - `HELM_HOST`, `HELM_PORT`, `HELM_BASE_PATH`
  - `HELM_ADMIN_USER`, `HELM_ADMIN_PASSWORD`, `HELM_ADMIN_ENABLED`
  - `HELM_RATE_LIMIT_ENABLED`, `HELM_REQUEST_TIMEOUT_MS`, `HELM_MAX_REQUEST_BYTES`
  - `HELM_SIGNAL_FEEDBACK_ENABLED` — opt into Agentic Signals feedback for ranked
    lane promotion (disabled by default; detailed thresholds live in
    `config/runtime.yaml`).
  - `HELM_STORE_DRIVER` (`sqlite` | `supabase`), `HELM_STORE_URL_ENV`
  - `HELM_DATA_DIR` (data directory, default `./data`), `HELM_KEYS_PERSIST_TO`
  - `HELM_OAUTH_ENC_KEY` — a 32-byte key used to encrypt stored OAuth
    subscription tokens. **Mandatory whenever any OAuth subscription provider is
    connected**: the gateway refuses to start if one is configured without it,
    and the admin OAuth surface stays disabled until it is set.
  - Background-worker toggles: `HELM_SIGNALS_DISABLED=1` stops the signal
    scheduler and `HELM_MEMORY_WORKER_DISABLED=1` stops the memory worker (both
    run by default); `HELM_MEMORY_WORKER_INTERVAL_MS` tunes the memory worker
    tick (default `60000`).
  - Anthropic preset OAuth execution uses `transport_profile: auto` by default,
    which routes final provider execution through the optional Chrome-like
    TLS/JA3 transport (`wreq-js`) instead of undici. Set
    `transport_profile: default` on that provider to force the normal undici path.
    This does not affect token refresh/model discovery. Optional tuning:
    `HELM_TLS_BROWSER_PROFILE`, `HELM_TLS_OS_PROFILE`,
    `HELM_TLS_TRANSPORT_TIMEOUT_MS`.
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
2. If no API key exists, **mint a root key and print it once** (see [06 · Auth,
   API Keys & Rate Limits](06-auth-and-rate-limits.md)).
3. Start the HTTP server (the API plus the admin UI when admin credentials are
   configured; see [11 · Admin UI](11-admin-ui.md)).
4. Start the two background workers — the **signal scheduler** and the **memory
   worker** — unless disabled by their env vars (above). Each timer is unref'd
   and fail-open. Signal collection itself is off-request-path; routing reads the
   aggregated rows only when `runtime.signal_feedback.enabled` is on.
5. Begin serving once the health endpoint reports ready.

## Health & version

- `GET /healthz` — unauthenticated readiness probe. Returns `200` when ready,
  `503` when degraded (fail-closed: a probe failure reports not-ready, never a
  hang or 500). The container `HEALTHCHECK` hits this endpoint.
- `GET /version` — unauthenticated build info (`version`, `gitSha`, `builtAt`),
  injected at build time via the `HELM_VERSION` / `HELM_GIT_SHA` / `HELM_BUILT_AT`
  Docker build-args (CI fills them from the package version, commit, and a UTC
  stamp; for a local `build: .` see the commented `args` in `docker-compose.yml`).
  Defaults to `unknown` when unset. No config or credentials are exposed.

## Upgrading

Pull the new image → recreate the container → verify `/healthz` and `/version`.
Keep the mounted `config/` and `data/` directories; they are not overwritten.

> Note: telemetry and captured payloads persist on the `data` volume across
> redeploys. When debugging, filter the request log by the container's start time
> so rows written by an older image are not mistaken for current behavior.
