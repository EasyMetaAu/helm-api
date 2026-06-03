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

Helm API is an open-source, self-hosted **LLM routing gateway** — think of it as **"nginx for the LLM world."** Your app sends a normal OpenAI or Anthropic request to Helm; a single declarative YAML config decides which model should handle it, calls that provider (switching to a backup if it fails), translates protocols as needed, and records every decision. Clients always see one standard interface and output shape, and only ever set their `base_url` and API key — all the routing lives in config you control.

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
- **Fail-open by design.** If an optional step has trouble (classification, scoring, cache), the request quietly degrades to the `balanced` lane instead of erroring. You only get a structured error when *every* provider is genuinely down.
- **Safe by default.** Invalid config refuses to start (fail-closed). API keys are stored only as SHA-256 hashes — plaintext never touches logs or telemetry. Rate limiting and the optional scoring model are off until you turn them on.
- **Decisions are observable.** Each request persists a redacted decision record — the lane it took, the model that answered, why, fallbacks, and cost — browsable in the dashboard. Full request/response payloads are captured to a separate local store (on by default, with retention) for debugging.
- **Runs on your own infrastructure.** MIT-licensed and deployed with Docker. No SaaS, no multi-tenant cloud — nothing leaves your servers.

## Key concepts

- **Lanes** — Requests route through configurable *lanes* (tiers like `economy`, `balanced`, `premium`, or task lanes like `coding`, `json`, `vision`), not raw provider names. You decide in config how each lane maps to a primary model plus a fallback chain. Provider aliases are an internal supply-chain detail, never the client-facing surface.
- **Classification cascade** — A three-layer cascade picks the lane: **(1)** deterministic rules (a pure, zero-network, unit-tested function — always on); **(2)** an optional small-model "second opinion" eval (`temperature: 0`, cached, **off by default**); **(3)** fall back to the `balanced` lane if nothing decides.
- **Protocol translation** — Inbound OpenAI / Anthropic requests are normalized to one internal representation, so a single client can reach many different backends and get a consistent output shape (including streaming SSE).
- **Fail-open routing** — Auxiliary failures degrade gracefully; only "all providers failed" surfaces an error. Note the two *distinct* fallback mechanisms: **classification fallback** (→ `balanced` lane) and **execution fallback** (→ the next model in the chain). They are tracked under separate fields and never conflated.
- **Config-as-code** — Behavior lives in `config/*.yaml`, Zod-validated at startup. An invalid file fails closed and the gateway refuses to boot.
- **Headless core** — The entire routing brain (classification, routing, provider execution, protocol translation, storage) lives in `packages/core` and imports no web framework. The Hono gateway and SvelteKit admin UI are thin layers on top.

## Status

Helm API is **0.2** and early-stage, but it is a real implementation, not a scaffold — the full pipeline (config → auth → classify → route → execute with circuit-breaking and fallback → protocol translation → telemetry) is wired end-to-end and backed by an extensive Vitest unit suite plus Playwright e2e specs. See [Features](#features) for exactly what ships today versus what is roadmap-only.

## Features

**Shipped:**

- **Four client protocols** — `POST /v1/chat/completions` (OpenAI Chat), `POST /v1/messages` (Anthropic Messages), and `POST /v1/responses` (OpenAI Responses) — all streaming + non-streaming — plus `POST /v1beta/models/{model}:generateContent` (Google Gemini, non-streaming).
- **Cross-protocol translation** — normalize to one internal IR; consistent output shape across backends, with SSE streaming on the chat, messages, and responses surfaces.
- **Three-layer classification** — deterministic rules always on; optional small-model eval (off by default) for uncertain cases; `balanced`-lane fallback.
- **Lane + policy routing** — first-match policies that pin, cap, or restrict lanes; default lanes shipped: `economy`, `balanced`, `premium`, plus task lanes `coding`, `json`, `vision`, `tool_use`. (`balanced` is the required, always-available fallback lane.)
- **Provider execution with fallback** — primary + fallback chains across OpenAI-compatible upstreams, with a circuit breaker (OPEN/HALF_OPEN), a capability filter (skip candidates lacking JSON / tools / vision / context size with an explicit reason), and `:free`-tier 429 skipping. Client disconnects are treated as non-provider faults.
- **Mandatory API-key auth** — keys stored as SHA-256 hashes only; a root key is generated and printed once on first boot. Per-key caps (an `allowed_lanes` whitelist and custom-model permission) and optional per-key RPM/TPM rate limits.
- **OAuth subscription providers** — route your Claude Pro/Max, ChatGPT Codex, and GitHub Copilot **subscriptions** as backends: log in from the dashboard, pool several accounts per provider, and curate models / set an egress proxy / set scheduling per account — all of which **hot-reload** (no restart). See [the section below](#oauth-subscription-providers-claude-promax-chatgpt-codex-github-copilot). *(Opt-in; may violate provider ToS — read the warning.)*
- **Observability** — a redacted decision record per request (classifier, policy, lane, provider attempts, latency, fallback count, cost breakdown) plus optional verbatim payload capture to a dedicated store, aged out by retention.
- **Admin dashboard** — a SvelteKit + Tailwind SPA served at `/admin` behind HTTP Basic: live overview, API-key CRUD with per-key limits, lane and policy editors, classifier settings, and a drill-down request log. Available in 5 languages (English default, Simplified & Traditional Chinese, Japanese, Korean). Edits re-bind the live config and apply on the next request — no restart.
- **Storage** — SQLite by default (local file); Postgres / Supabase optional, via a shared Store-port abstraction.

**Roadmap / not yet wired:**

- **Memory middleware** — the observe (write) phase is wired; the inject (read-back-into-prompt) and reflector phases exist in core but are not yet reachable in the running gateway.
- Finer-grained quotas / billing are future work.

See [09 Roadmap](docs/09-roadmap.md) for details.

## Architecture

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + serves the dashboard + /healthz, /version
│  └─ admin/     # SvelteKit + Tailwind dashboard (static SPA)
├─ packages/
│  ├─ core/      # routing, classification, providers, protocol translation, storage ports (no framework)
│  └─ shared/    # Zod schemas + shared types (single source of truth)
├─ config/       # default lanes / policies / classifier / providers / … YAML
├─ docs/         # documentation (read 01 → 11)
└─ scripts/      # sync:catalog and other build-time tools
```

A request flows: **auth → rate limit → classify → route → execute (with fallback)**, then telemetry is recorded. The routing logic in `packages/core` depends on no web framework — an architecture test enforces that core and shared never import Hono or Svelte — so the brain can run headless. `apps/gateway` is a thin Hono layer that also serves the dashboard.

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

- **Gateway** → `http://localhost:8080`
- **Dashboard** → `http://localhost:8080/admin` (log in with `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`)
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
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ❌ non-streaming |

**What to put in the `model` field:**

| Value | What Helm does |
|---|---|
| `auto` *(recommended)* | Classifies the request and routes it to the best lane automatically. |
| a model alias, e.g. `openai-codex/gpt-5.5` | Uses exactly that model and skips routing — only for keys granted custom-model permission. |

> With a standard key, routing is automatic no matter what you send — just use `auto`. Lanes are configured by the operator in `lanes.yaml` and the dashboard; clients don't choose a lane per call.

## Configuration

Everything is configured in `config/*.yaml`. Files are Zod-validated on load, and **invalid config stops the gateway from starting (fail-closed)**. Lanes, policies, and the classifier can also be edited live in the dashboard and apply on the next request.

| File | What it controls | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | API key requirement + first-run root key | — |
| `runtime.yaml` | Request limits, rate-limit defaults, storage driver | partial |
| `providers.yaml` | Upstream providers + model aliases (credentials by env-var **name** only) | — |
| `lanes.yaml` | Lanes — each lane's primary model and its fallback chain | ✅ |
| `policies.yaml` | First-match rules that pick or cap the lane | ✅ |
| `classifier.yaml` | The built-in rules and the optional eval model | ✅ |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the model catalog | — |

Most-used environment variables (env wins over YAML; full list in [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Primary provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | Optional provider credentials (provider is skipped if missing) |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Dashboard login (Basic auth) |
| `HELM_HOST` / `HELM_PORT` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_STORE_URL_ENV` | For `supabase`: the **name** of the env var holding the Postgres DSN |
| `HELM_RATE_LIMIT_ENABLED` | Turn rate limiting on (off by default) |

> **Storage.** SQLite (`better-sqlite3`, a local file under `./data`) is the default. For Postgres/Supabase, set `HELM_STORE_DRIVER=supabase` and point `HELM_STORE_URL_ENV` at the env var that holds your DSN. An unknown driver fails closed at startup.
>
> **Credentials.** Provider keys are referenced by env-var *name* in `providers.yaml` — never written as plaintext into the repo or image.

### OAuth subscription providers (Claude Pro/Max, ChatGPT Codex, GitHub Copilot)

Instead of a static API key, a provider can authenticate with an **OAuth subscription** you log into from the dashboard (**Providers → Connect**). Claude Pro/Max and ChatGPT Codex use a browser login + paste-the-redirect-URL step; GitHub Copilot uses a device code. Helm stores the (rotating) refresh token **encrypted at rest** and refreshes the short-lived access token automatically.

To enable it, set **`HELM_OAUTH_ENC_KEY`** to a 32-byte key (base64, or 64 hex chars) — Helm uses it to encrypt stored tokens and **refuses to start** if a subscription provider is configured without it. Configure the provider with an `oauth: { provider: anthropic | github-copilot | openai-codex }` block (see the commented examples in `config/providers.yaml`); for Claude use `type: anthropic`.

You can connect **several accounts of one provider** and Helm pools them. Each account, via **Providers → Manage**, has its own:

- **Models** — curate exactly which models that account exposes to your lanes. The curated list is authoritative: a model you remove stops routing immediately, and an uncurated model is refused (fail-closed) — so curation is a live allow-list, not just a display filter.
- **Proxy** — route that account's upstream traffic through an HTTP/HTTPS/SOCKS5 proxy so it egresses from a distinct IP (avoids ban-correlation when accounts share a host).
- **Schedule** — a `priority` (lower = served first) and a `schedulable` toggle. Helm picks the lowest-priority account, round-robin (least-recently-used) within an equal priority; parking an account keeps it connected but out of rotation.

**Everything here hot-reloads.** Connecting, disconnecting, curation, proxy, and scheduling changes **apply on the next request — no restart.** And to look like a first-party client, Helm mirrors the official client's identity headers and sends a **stable, per-account device identity** (it never rotates mid-stream), reducing ban-correlation risk.

> ⚠️ **Terms of service.** Routing a Claude/ChatGPT/Copilot **subscription** through a third-party gateway may violate the provider's terms of service, which can be grounds for account suspension. This is an opt-in feature for self-hosted, personal use — **you are responsible** for ensuring your usage complies with your provider agreements. When in doubt, use a normal API key (`api_key_env`) instead.

## The dashboard

At `/admin`, behind HTTP Basic auth: a live overview, API keys (create, revoke, set per-key limits), lane and policy editors, classifier settings, and a request log you can drill into to see how each request was routed. Available in English (default), Simplified and Traditional Chinese, Japanese, and Korean. The dashboard mounts **only when** `HELM_ADMIN_USER` and `HELM_ADMIN_PASSWORD` are set; otherwise `/admin` and `/admin/api/*` return `404`.

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
[11 Admin UI](docs/11-admin-ui.md)

## License

[MIT](LICENSE) © 2026 EasyMeta AU
