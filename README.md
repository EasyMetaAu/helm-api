<div align="center">

# Helm API

**English** · [简体中文](README.zh-CN.md)

### One gateway in front of all your LLM providers — pick models by config, not code.

Open-source · self-hosted · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

Helm API is an open-source, self-hosted **LLM routing gateway** — think of it as **"nginx for the LLM world."** Your app sends a normal OpenAI, Anthropic, or Gemini request to Helm; a single declarative YAML config decides which model should handle it, calls that provider (switching to a backup if it fails), translates protocols as needed, and records every decision. Clients always see one standard interface and output shape, and only ever set their `base_url` and API key — all the routing lives in config you control.

> **Manage traffic as configuration, not as code.**

```python
# Your app: the same OpenAI client, just a new base_url and key.
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm classifies and routes
```

---

## Why Helm

AI app developers don't want to manage hundreds of models, per-provider quirks, fallback behavior, cost trade-offs, and routing decisions inside every client. They want **one API that is cheap enough, reliable enough, sensible by default, and debuggable when something goes wrong.** Helm gives you that:

- **Change models without changing code.** Point a lane at a different model in a config file — your apps never notice.
- **Two failure disciplines, applied deliberately.** Configuration and credentials are **fail-closed** — invalid config or a missing required key refuses to start, never runs half-configured. The request path is **fail-open** — any optional step that stumbles (classification, scoring, memory, cache) quietly degrades to the `balanced` lane; you only get a structured error when *every* provider is genuinely down.
- **Safe by default.** API keys are stored only as SHA-256 hashes — plaintext never touches logs or telemetry. Rate limiting, usage budgets, the optional scoring model, and memory are all off until you turn them on.
- **Every decision is observable.** Each request persists a redacted decision record — the lane it took, the model that answered, why, fallbacks, and cost — browsable in the dashboard. Full request/response payloads are captured to a separate local table (on by default, 30-day retention) for debugging and audit.
- **Runs on your own infrastructure.** MIT-licensed, deployed with Docker. No SaaS, no multi-tenant cloud — nothing leaves your servers.

## Key concepts

- **Lanes** — Requests route through configurable *lanes* (quality/cost tiers `economy`, `balanced`, `premium`, or task lanes `coding`, `json`, `vision`, `tool_use`), never raw provider names. You decide in config how each lane maps to a primary model plus a fallback chain. Provider aliases are an internal supply-chain detail, never the client-facing surface.
- **Classification cascade** — Three layers pick the lane: **(1)** deterministic rules (a pure, zero-network, unit-tested scorer — always on); **(2)** an optional small-model "second opinion" eval (`temperature: 0`, cached, **on by default** in the shipped config; the schema default stays off as a fail-safe), consulted only when the rules are uncertain; **(3)** the `balanced` lane as the fail-open sink.
- **Two fallbacks, never conflated** — *Classification fallback* degrades an undecided request to the `balanced` lane; *execution fallback* swaps to the next model in the chain when a provider fails. They live in separate decision-record fields so you can always tell which one fired.
- **Protocol translation** — Four inbound protocols normalize to one OpenAI-Chat-shaped internal representation (IR), so a single client reaches many backends and gets a consistent output shape — streaming SSE included.
- **Config-as-code** — Behavior lives in `config/*.yaml`, Zod-validated at startup; an invalid file fails closed and the gateway refuses to boot.
- **Headless core** — The entire routing brain (classification, routing, provider execution, protocol translation, storage) lives in `packages/core` and imports no web framework — an architecture test enforces it. The Hono gateway and SvelteKit dashboard are thin, optional layers on top.

## Architecture

Four client protocols enter one stable interface; one framework-agnostic core does the work; everything is driven by config and recorded on the way out.

```text
CLIENT ── OpenAI · Anthropic · OpenAI Responses · Google Gemini
          one base_url + one Helm key · send model:"auto"
             │
             ▼
GATEWAY   apps/gateway (Hono) · thin HTTP shell — also serves /admin SPA + /docs
             │   normalize any protocol  ──▶  one InternalRequest (IR)
             ▼
CORE      packages/core · the routing brain (imports no web framework)
             │
             ├─ auth        resolve sha256 key, load per-key caps        · fail-closed
             ├─ gate        rate limit (off) · usage budget (off)        · fail-closed
             ├─ memory      inject remembered context (on by default)    · fail-open
             ├─ classify    L1 rules ─uncertain→ L2 eval (on) ─→ balanced · fail-open
             ├─ resolve     first-match policy → lane → caps → fallback chain
             ├─ execute     capability filter → circuit breaker → provider
             │                  └── on failure: advance to next model in the chain
             └─ translate   provider-native  ⇄  IR  ⇄  client protocol (streaming SSE)
             │
             ▼
RESULT ── streamed/JSON response, in the client's own protocol
             │
             ├─▶ telemetry   redacted decision record + verbatim payload capture
             ├─▶ memory      write back the turn (opt-in)
             └─▶ upstream    static API keys + OAuth subscriptions (pooled · hot-reload)

config/*.yaml drives every stage · Zod-validated · invalid config refuses to boot (fail-closed)
```

```text
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + serves the dashboard + /healthz, /version
│  └─ admin/     # SvelteKit + Tailwind dashboard (static SPA)
├─ packages/
│  ├─ core/      # routing, classification, providers, protocol translation, storage ports (no framework)
│  └─ shared/    # Zod schemas + shared types (single source of truth)
├─ config/       # default lanes / policies / classifier / providers / … YAML
├─ docs/         # documentation (read 01 → 12)
└─ scripts/      # sync:catalog and other build-time tools
```

## Status

Helm API is at **0.6** and is a real, end-to-end implementation — not a scaffold. The full pipeline (config → auth → classify → route → execute with circuit-breaking and fallback → protocol translation → telemetry) is wired and backed by an extensive Vitest unit suite plus Playwright e2e specs. See [Features](#features) for exactly what ships today versus what is roadmap-only.

## Features

**Shipped:**

- **Four client protocols** — `POST /v1/chat/completions` (OpenAI Chat), `POST /v1/messages` (Anthropic Messages), `POST /v1/responses` (OpenAI Responses), and `POST /v1beta/models/{model}:generateContent` (Google Gemini) — all streaming + non-streaming. (Gemini streaming is the `:streamGenerateContent?alt=sse` operation; the Gemini surface authenticates with `x-goog-api-key`.)
- **Cross-protocol translation** — normalize to one OpenAI-Chat-shaped IR; consistent output across backends with SSE on all four surfaces. Aligned to litellm's field coverage: sampling knobs, usage detail (reasoning / cache / per-modality), a unified reasoning/thinking bridge, full multimodal I/O, and both-ways `finish_reason` maps. Unmappable knobs degrade observably (e.g. Anthropic caps `n>1` and warns on `logprobs`/`modalities`) rather than erroring — see the [Protocol Compatibility](docs/protocol-compatibility.md) matrix.
- **Three-layer classification** — deterministic rules always on; optional small-model eval (on by default in the shipped config; schema default off) for uncertain cases; `balanced`-lane fail-open sink.
- **Lane + policy routing** — first-match policies that pin or cap lanes; shipped lanes `economy`, `balanced`, `premium` plus task lanes `coding`, `json`, `vision`, `tool_use` (`balanced` is the required, always-available fallback terminal).
- **Provider execution with fallback** — primary + fallback chains across OpenAI-compatible upstreams, with a circuit breaker (OPEN/HALF_OPEN + single-probe), a capability filter (skip candidates lacking JSON / tools / vision / a modality / context size / streaming, with an explicit reason), and `:free`-tier 429 skipping. Client disconnects are treated as non-provider faults.
- **OAuth subscription providers** — route your Claude Pro/Max, ChatGPT Codex, and GitHub Copilot **subscriptions** as backends: log in from the dashboard, pool several accounts per provider, and curate models / set an egress proxy / set scheduling per account — all of which **hot-reload**. See [the section below](#oauth-subscription-providers-claude-promax-chatgpt-codex-github-copilot). *(Opt-in; may violate provider ToS — read the warning.)*
- **Mandatory API-key auth + per-key caps** — keys stored as SHA-256 hashes only; a root key is generated and printed once on first boot. Each key carries an `allowed_lanes` whitelist, custom-model permission, optional RPM/TPM rate limits, usage budgets (requests/tokens/spend, with degrade-or-reject), a concurrency limit, and a memory mode.
- **Memory middleware (on by default)** — `inject` (the default) reads remembered context back into the prompt before routing; `observe` writes the turn only. Overridable per request via the `x-memory-mode` header (including `off`). A background worker compresses (observer) and consolidates (reflector) memory; the forgetting/tiering layer (decay, retention, fact extraction), gated behind `config.memory.forgetting.enabled`, is now on by default. Summarization is a deterministic stub today — the LLM path is roadmap.
- **Observability** — a redacted decision record per request (classifier, policy, lane, provider attempts, latency, fallback count, cost breakdown, memory counts) plus optional verbatim payload capture to a dedicated table, aged out by retention.
- **Admin dashboard** — a SvelteKit + Tailwind SPA served at `/admin` behind HTTP Basic: live overview, API-key CRUD with per-key caps, lane/policy editors, classifier and system settings, and a drill-down request log. Five languages (English, Simplified & Traditional Chinese, Japanese, Korean). Edits re-bind the live config and apply on the next request — no restart.
- **Storage** — SQLite by default (local file); Postgres / Supabase optional, via a shared Store-port abstraction.

**Roadmap:**

- **LLM-backed memory** — observer/reflector summarization and fact extraction are deterministic stubs today; the real small-model path is future work.
- Finer-grained quotas / account-level billing.

See [09 Roadmap](docs/09-roadmap.md) for details.

## Quickstart

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) (for the quickest start), or **Node ≥ 22** and **pnpm 10** to build from source.

```bash
# 1. Clone and create your env file
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    In .env, set HELM_ADMIN_PASSWORD and at least DEEPSEEK_API_KEY

# 2. Start it
docker compose up -d

# 3. Copy the root API key — generated and printed once on first boot
docker compose logs helm | grep -i "root API key"
```

- **Gateway** → `http://localhost:8080` (a status landing page lives at `/`)
- **Dashboard** → `http://localhost:8080/admin` (log in with `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`)
- **API docs** → `GET /docs` (interactive Swagger UI) · `GET /openapi.json` (OpenAPI 3.1, generated from the same Zod schemas the gateway validates against)
- **Health / version** → `GET /healthz`, `GET /version`

`docker-compose.yml` mounts `./config` and `./data`, so your config and database survive restarts. Credentials are passed in as environment variables only — never built into the image.

### Calling the gateway

Any OpenAI-compatible client works. Point it at Helm and use a Helm API key:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $HELM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Explain consistent hashing in two sentences."}],
    "stream": true
  }'
```

| Endpoint | Protocol | Streaming |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ |
| `POST /v1/messages` | Anthropic Messages | ✅ |
| `POST /v1/responses` | OpenAI Responses | ✅ |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ✅ (via `:streamGenerateContent?alt=sse`) |

**What to put in the `model` field:**

| Value | What Helm does |
|---|---|
| `auto` *(recommended)* | Classifies the request and routes it to the best lane automatically. |
| a model alias, e.g. `deepseek/deepseek-v4-pro` | Uses exactly that model and skips routing — only for keys granted custom-model permission. |

> With a standard key, routing is automatic no matter what you send — just use `auto`. Lanes are configured by the operator in `lanes.yaml` and the dashboard; clients don't choose a lane per call.

### API surface

Every endpoint is documented interactively at **`/docs`**, with the raw spec at **`/openapi.json`**.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` | — | Status landing page |
| `GET /healthz` · `GET /version` | — | Readiness probe · build info |
| `GET /docs` · `GET /openapi.json` | — | Interactive docs · OpenAPI 3.1 spec |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | List models the key can route to (lanes + `auto`; concrete aliases with capabilities & pricing for custom-model keys) |
| `POST /v1/chat/completions` | API key | OpenAI Chat Completions |
| `POST /v1/messages` | API key | Anthropic Messages |
| `POST /v1/responses` | API key | OpenAI Responses |
| `POST /v1beta/models/{model}:generateContent` | API key | Google Gemini |
| `/admin` · `/admin/api/*` | Basic auth | Dashboard + its JSON backend (mounted only when admin credentials are set) |

## Configuration

Everything is configured in `config/*.yaml`. Files are Zod-validated on load, and **invalid config stops the gateway from starting (fail-closed)**. Lanes, policies, the classifier, and system settings can also be edited live in the dashboard and apply on the next request.

| File | What it controls | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | API key requirement + first-run root key | — |
| `runtime.yaml` | Request limits, rate-limit defaults, storage driver | partial |
| `providers.yaml` | Upstream providers + model aliases (credentials by env-var **name** only) | — |
| `lanes.yaml` | Lanes — each lane's primary model and its fallback chain | ✅ |
| `policies.yaml` | First-match rules that pick or cap the lane | ✅ |
| `classifier.yaml` | The built-in rules and the optional eval model | ✅ |
| `memory.yaml` | Memory forgetting/tiering knobs (the whole layer is on by default) | ✅ |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the model catalog | — |

Most-used environment variables (env wins over YAML; full list in [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Primary provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` | Optional provider credentials (provider is skipped if missing) |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Dashboard login (Basic auth) |
| `HELM_HOST` / `HELM_PORT` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_STORE_URL_ENV` | For `supabase`: the **name** of the env var holding the Postgres DSN |
| `HELM_RATE_LIMIT_ENABLED` | Turn rate limiting on (off by default) |
| `HELM_OAUTH_ENC_KEY` | 32-byte key to encrypt stored OAuth tokens (**required** if any subscription provider is configured) |

> **Storage.** SQLite (`better-sqlite3`, a `helm.db` file under `./data`) is the default. For Postgres/Supabase, set `HELM_STORE_DRIVER=supabase` and point `HELM_STORE_URL_ENV` at the env var that holds your DSN. An unknown driver fails closed at startup.
>
> **Credentials.** Provider keys are referenced by env-var *name* in `providers.yaml` — never written as plaintext into the repo or image.

### OAuth subscription providers (Claude Pro/Max, ChatGPT Codex, GitHub Copilot)

Instead of a static API key, a provider can authenticate with an **OAuth subscription** you log into from the dashboard (**Providers → Connect**). Claude Pro/Max and ChatGPT Codex use a manual authorization-code paste; GitHub Copilot uses a device code. Helm stores the (rotating) refresh token **encrypted at rest** and refreshes the short-lived access token automatically.

To enable it, set **`HELM_OAUTH_ENC_KEY`** to a 32-byte key (base64, or 64 hex chars) — Helm uses it to encrypt stored tokens and **refuses to start** if a subscription provider is configured without it. Configure the provider with an `oauth: { provider: anthropic | github-copilot | openai-codex }` block (see the commented examples in `config/providers.yaml`); for Claude use `type: anthropic`.

You can connect **several accounts of one provider** and Helm pools them. Each account, via **Providers → Manage**, has its own:

- **Models** — curate exactly which models that account exposes to your lanes. The curated list is authoritative: a model you remove stops routing immediately, and an uncurated model is refused (fail-closed) — a live allow-list, not just a display filter.
- **Proxy** — route that account's upstream traffic through an HTTP/HTTPS/SOCKS5 proxy so it egresses from a distinct IP (avoids ban-correlation when accounts share a host).
- **Schedule** — a `priority` (lower = served first) and a `schedulable` toggle. Helm picks the lowest-priority account, round-robin (least-recently-used) within an equal priority; parking an account keeps it connected but out of rotation.

**Everything here hot-reloads** — connecting, disconnecting, curation, proxy, and scheduling changes apply on the next request, no restart. And to look like a first-party client, Helm mirrors the official client's identity headers and sends a **stable, per-account device identity** (it never rotates mid-stream), reducing ban-correlation risk.

> ⚠️ **Terms of service.** Routing a Claude/ChatGPT/Copilot **subscription** through a third-party gateway may violate the provider's terms of service, which can be grounds for account suspension. This is an opt-in feature for self-hosted, personal use — **you are responsible** for ensuring your usage complies with your provider agreements. When in doubt, use a normal API key (`api_key_env`) instead.

## The dashboard

At `/admin`, behind HTTP Basic auth: a live overview, API-key management (create, revoke, set per-key caps), lane/policy editors, classifier and system settings, and a request log you can drill into to see how each request was routed. The dashboard mounts **only when** admin credentials are set; otherwise `/admin` and `/admin/api/*` return `404`. See [11 Admin UI](docs/11-admin-ui.md).

## Development

Requires **Node ≥ 22** and **pnpm 10**.

```bash
pnpm install
pnpm dev          # admin dashboard dev server (Vite) — see note below
pnpm test         # Vitest unit tests
pnpm test:e2e     # Playwright end-to-end tests
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # Biome
pnpm build        # build the gateway + dashboard
pnpm sync:catalog # refresh the generated model catalog (capabilities + pricing)
```

> `pnpm dev` starts only the admin SPA. There is no watch script for the gateway; run it built (`pnpm build` then `node apps/gateway/dist/index.js`) or via Docker.

Tests come first (Vitest for the core, Playwright for full flows). Design decisions are logged in [`implementation-notes.md`](implementation-notes.md). Before opening a PR, make sure all checks pass:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## Documentation

Read in order, starting at [`docs/README.md`](docs/README.md):

[01 Overview](docs/01-overview.md) ·
[02 Architecture](docs/02-architecture.md) ·
[03 Classification](docs/03-classification.md) ·
[04 Routing & Lanes](docs/04-routing-and-lanes.md) ·
[05 Protocol Translation](docs/05-protocol-translation.md) ·
[06 Auth & Rate Limits](docs/06-auth-and-rate-limits.md) ·
[07 Observability](docs/07-observability.md) ·
[08 Memory Middleware](docs/08-memory-middleware.md) ·
[09 Roadmap](docs/09-roadmap.md) ·
[10 Deployment](docs/10-deployment.md) ·
[11 Admin UI](docs/11-admin-ui.md) ·
[12 Memory Forgetting & Tiering](docs/12-memory-forgetting-and-tiering.md) ·
[Protocol Compatibility](docs/protocol-compatibility.md)

## License

[MIT](LICENSE) © 2026 EasyMeta AU
