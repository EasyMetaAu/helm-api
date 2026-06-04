# 10 · Deployment (Self-Hosted / Docker)

Helm is an **open-source, self-hosted** project (MIT). There is no SaaS and
nothing to buy — anyone can deploy, modify, and run it commercially. The primary
deployment is **Docker**.

## Design principles

- **Single container, config-as-code.** One image plus one config directory boots
  the gateway; you change configuration and restart, like nginx.
- **Lightweight, self-hostable.** The default store is SQLite (a local file under
  the data volume), so there is no hard dependency on an external database.
  Postgres/Supabase is available via the same store abstraction (see [02 ·
  Architecture](02-architecture.md)).
- **No extra services required.** 0.1 needs no Redis or message queue; rate
  limiting and caches are in-process / store-backed.

## Docker

The published image is `ghcr.io/easymetaau/helm-api`. It is built on **Node 22**
(`node:22-slim`), runs as a non-root `helm` user, and exposes port `8080`.

```bash
docker run -d --name helm \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \   # lanes/policies/classifier/providers/...
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

- `/app/config` — the YAML config tree: `lanes`, `policies`, `classifier`,
  `providers`, `capabilities`, `pricing`, `auth`, `runtime`, `server`.
- `/app/data` — persisted state: SQLite database, telemetry, captured payloads,
  and the bootstrapped key file (`./data/helm-keys.json`).

## Configuration sources

Configuration comes from **files** and **environment variables**, and env vars
**win** (this is what makes containerized deployment and secret injection clean):

- `config/*.yaml` — lanes, policies, classifier, providers, capabilities,
  pricing, auth, runtime, server (see [02 · Architecture](02-architecture.md)).
- Environment variables — upstream provider credentials, the admin Basic-auth
  user/password, the store driver, and optional bind/limit overrides.
  `.env.example` covers the common ones; additional overrides include:
  - `HELM_HOST`, `HELM_PORT`, `HELM_BASE_PATH`
  - `HELM_ADMIN_USER`, `HELM_ADMIN_PASSWORD`, `HELM_ADMIN_ENABLED`
  - `HELM_RATE_LIMIT_ENABLED`, `HELM_REQUEST_TIMEOUT_MS`, `HELM_MAX_REQUEST_BYTES`
  - `HELM_STORE_DRIVER` (`sqlite` | `supabase`), `HELM_STORE_URL_ENV`
  - `HELM_KEYS_PERSIST_TO`
  - Upstream credentials such as `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`,
    `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` — each maps to a `providers.yaml`
    entry's `api_key_env`. `DEEPSEEK_API_KEY` is the primary credential and is
    required; the others are optional (their providers are skipped if absent).
    (Premium/coding lanes route through the `openai-codex` subscription — connect
    it in the admin UI, which needs `HELM_OAUTH_ENC_KEY`, not an API key here.)

Invalid configuration is rejected at startup (Zod-validated, fail-closed) — Helm
never runs in a half-broken state (Principle 2).

## Startup behavior

1. Load configuration (files + environment variables, env wins).
2. If no API key exists, **mint a root key and print it once** (see [06 · Auth,
   API Keys & Rate Limits](06-auth-and-rate-limits.md)).
3. Start the HTTP server (the API plus the admin UI when admin credentials are
   configured; see [11 · Admin UI](11-admin-ui.md)).
4. Begin serving once the health endpoint reports ready.

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
