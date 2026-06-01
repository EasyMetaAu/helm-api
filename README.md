<div align="center">

# Helm API

**English** · [简体中文](README.zh-CN.md)

> An open-source, self-hosted LLM routing gateway — *nginx for the LLM world*.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

Helm API sits in front of your LLM providers and decides — by **configuration, not code** — where each request should go. It accepts standard AI API requests (OpenAI Chat Completions, Anthropic Messages, OpenAI Responses), classifies each one by task type and complexity using deterministic rules (optionally backed by a small-model evaluation that is **off by default**), routes it to a configurable **lane**, executes it through provider adapters with **automatic fallback** and a **circuit breaker**, and records full, debuggable telemetry for every decision.

Your clients only change their `base_url` and API key. Everything else — model selection, cost/quality tradeoffs, provider failover, protocol translation — happens inside Helm.

---

## Why Helm?

- **Lanes, not a model marketplace.** Clients pick an intent (`economy` / `balanced` / `premium`); provider aliases are an internal supply-chain detail.
- **Config as code.** Behavior is driven by `config/*.yaml` + environment variables, validated with Zod. Invalid config **fails closed** (the gateway refuses to boot) — it never runs in a broken state.
- **Fail-open routing.** If classification, eval, or cache fails, the request degrades to the `balanced` lane and is logged — it never returns a 5xx for an auxiliary failure. Only "all providers failed" produces a structured error.
- **Deterministic first.** Layer-1 routing is a pure, zero-network, unit-tested function. The optional Layer-2 eval runs at `temperature: 0`, is cached, and is disabled by default.
- **Secrets safe, bodies observable.** API keys are stored as SHA-256 hashes only — never in logs, telemetry, or payload tables. Full request/response bodies are captured to a separate table (toggleable, with retention) for debugging and audit.
- **Headless-capable core.** The routing/classification/execution/translation/storage core is framework-agnostic and runs without the admin UI.
- **MIT-licensed & self-hosted.** Deploy with Docker, run it entirely in-house. No SaaS, no phone-home.

## Features

- **Drop-in compatibility** with the OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses APIs, including SSE streaming (Chat & Messages).
- **Cross-protocol translation** through a unified internal representation, with careful SSE event mapping.
- **Three-layer classification cascade**: deterministic rules → optional small-model eval → `balanced` fallback.
- **Lane-based routing** with first-match policies and per-org caps.
- **Multi-provider execution** with cross-provider fallback chains, capability filtering (JSON / tools / vision / context / streaming), and a per-model circuit breaker.
- **Pluggable storage**: SQLite by default, Postgres/Supabase optional, behind a single Store port interface.
- **Mandatory API-key auth**, root-key bootstrap on first run, and optional per-key rate limits (RPM/TPM).
- **Built-in admin UI** (SvelteKit SPA) for keys, lanes, policies, classifier tuning, request debugging, and system settings — protected by HTTP Basic auth, localized in 5 languages.

## Architecture

```
        ┌──────────────────────────── Helm API gateway (Hono) ───────────────────────────┐
        │                                                                                  │
client ─┤  /v1/chat/completions ─┐                                                         │
(OpenAI/ │  /v1/messages ─────────┼─▶ auth ─▶ rate limit ─▶ classify ─▶ route ─▶ execute ──┼─▶ upstream
 Anthropic) /v1/responses ────────┘     │         │            │          │         │       │   providers
        │                               │         │            │          │         │       │  (openai-crs,
        │   /admin (SPA, HTTP Basic) ───┘   per-key RPM/TPM   3-layer    lane +    provider  │   zenmux,
        │   /admin/api/*                                      cascade   policies   fallback  │   openrouter…)
        │   /healthz  /version                                                    + breaker  │
        │                                                                                    │
        └──────────────────────────── Store (SQLite default · Postgres optional) ───────────┘
              keys · decision telemetry · request payloads · rate-limit buckets · memory
```

The core (`packages/core`) holds all routing/classification/provider/translation/storage logic and depends on no web framework. The gateway (`apps/gateway`) is a thin Hono layer that also serves the admin SPA.

## Quick start (Docker)

```bash
# 1. Get the config and an env file
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    edit .env — set HELM_ADMIN_PASSWORD and at least OPENAI_API_KEY

# 2. Run it
docker compose up -d

# 3. On first boot Helm prints a root API key ONCE — copy it from the logs
docker compose logs helm | grep -i "root key"
```

- Gateway: `http://localhost:8080`
- Admin UI: `http://localhost:8080/admin` (log in with `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`)
- Health / version: `GET /healthz`, `GET /version`

`docker-compose.yml` mounts `./config` and `./data` as volumes, so your configuration and SQLite database persist across restarts. Credentials are injected via environment variables only — never baked into the image.

## Using the gateway

Point any OpenAI-compatible client at Helm and use a Helm API key:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $HELM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "balanced",
    "messages": [{"role": "user", "content": "Explain consistent hashing in two sentences."}],
    "stream": true
  }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="<your-helm-key>")
client.chat.completions.create(
    model="balanced",                       # or economy / premium / a task lane
    messages=[{"role": "user", "content": "Hello"}],
)
```

| Endpoint | Protocol | Streaming |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ SSE |
| `POST /v1/messages` | Anthropic Messages | ✅ SSE |
| `POST /v1/responses` | OpenAI Responses | ❌ non-streaming (0.1) |

> The `model` field accepts a **lane** name (`economy`, `balanced`, `premium`, or a task lane such as `coding`). If omitted or unknown, Helm classifies the request and picks a lane for you. A Gemini adapter exists in the core but is not yet exposed as a route — see the [Roadmap](docs/09-roadmap.md).

## Configuration

Everything is config-as-code in `config/*.yaml` (validated by Zod; invalid config fails closed). Hot-reloadable files can also be edited live in the admin UI.

| File | Purpose | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | Mandatory API key + root-key bootstrap | — |
| `runtime.yaml` | Request limits, rate-limit defaults, store driver | partial |
| `providers.yaml` | Upstream providers + model aliases (credentials by env-var **name** only) | — |
| `lanes.yaml` | Lane definitions (primary + fallback chain, constraints) | ✅ |
| `policies.yaml` | First-match routing policies | ✅ |
| `classifier.yaml` | Layer-1 rules + Layer-2 eval settings | ✅ |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the generated model catalog | — |

Key environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Primary provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` | Optional fallback-provider credentials |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Admin UI HTTP Basic credentials |
| `HELM_PORT` / `HELM_HOST` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | Master rate-limit switch (default off) |

Default lanes: **economy** / **balanced** / **premium**, plus task lanes **coding** / **json** / **vision** / **tool_use**. `balanced` is the required classification-fallback terminal.

## Admin UI

Served at `/admin` behind HTTP Basic auth. Pages: dashboard, API keys (create / revoke / per-key limits), lanes, policies, classifier tuning, request telemetry (list + decision-chain detail), and system settings (payload capture, retention, rate-limit switch). Localized in English (default), Simplified/Traditional Chinese, Japanese, and Korean.

## Project layout

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + serves the admin SPA + /healthz, /version
│  └─ admin/     # SvelteKit + Tailwind admin UI (adapter-static SPA)
├─ packages/
│  ├─ core/      # routing · classification · providers · protocol translation · Store ports (framework-agnostic)
│  └─ shared/    # Zod schemas + shared types (single source of truth)
├─ config/       # default lanes / policies / classifier / providers / … YAML
├─ docs/         # documentation (read 01 → 11)
└─ scripts/      # sync:catalog and other build-time tools
```

## Development

Requires **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm dev          # admin UI dev server
pnpm test         # Vitest unit tests
pnpm test:e2e     # Playwright end-to-end tests
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # Biome
pnpm build        # build gateway + admin static assets
pnpm sync:catalog # refresh the generated model catalog (capabilities + pricing)
```

The codebase is developed test-first (Vitest for the core, Playwright for end-to-end flows). See [`docs/`](docs/README.md) for the full specification and [`implementation-notes.md`](implementation-notes.md) for design decisions and trade-offs.

## Documentation

Read the docs in order — start at [`docs/README.md`](docs/README.md):

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

## Roadmap

0.1 ships the full routing gateway, three client protocols, multi-provider fallback, the admin UI, and the observational-memory **observe** phase. Planned next: a Gemini client route, streaming for `/v1/responses`, the memory **inject** phase, and richer quota/rate-limit controls. See [09 Roadmap](docs/09-roadmap.md).

## Contributing

Issues and pull requests are welcome. Please develop on a branch and ensure CI is green (`pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`) before opening a PR.

## License

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
