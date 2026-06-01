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

**The problem.** Your app is hard-wired to one model. The day you want a cheaper model for easy requests, a stronger one for hard requests, or an automatic backup when a provider goes down, you have to change code and redeploy.

**What Helm does.** Helm sits between your app and the model providers. Your app sends a normal OpenAI or Anthropic request to Helm; Helm decides which model should handle it, calls that provider (and switches to a backup if it fails), and records every decision. Your app only ever sets its `base_url` and API key — all the routing lives in a config file you control.

You don't pick the model. Your app sends `model: "auto"`, and Helm sorts the request into a **lane** — a tier like `economy`, `balanced`, or `premium`. You decide in config how each lane maps to a real model, so you can change models, costs, and fallbacks without touching your app. (Need a specific model for one call? A key with the right permission can name it directly — see [Calling the gateway](#calling-the-gateway).)

```python
# Your app: the same OpenAI client, just a new base_url and key.
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm classifies and routes
```

---

## Why teams use it

- **Change models without changing code.** Point a lane at a different model in a config file — your apps never notice.
- **It won't fail by accident.** If an optional step has trouble (classification, scoring, cache), the request quietly falls back to the `balanced` lane. You only get an error when every provider is genuinely down.
- **Safe by default.** Invalid config refuses to start. API keys are stored only as hashes. Rate limiting and the optional scoring model are off until you turn them on.
- **Every decision is visible.** Each request records the lane it took, the model that answered, why, and what it cost — all browsable in the dashboard.
- **Runs on your own infrastructure.** MIT-licensed and deployed with Docker. No SaaS, and no data leaves your servers.

## What it does

- Accepts **OpenAI Chat Completions**, **Anthropic Messages**, and **OpenAI Responses** requests — with streaming for the first two.
- Translates between protocols, so one client can reach many different backends.
- Picks a lane with fast built-in rules (plus an optional small model for a second opinion — off by default).
- Falls back across providers automatically, checking each candidate's capabilities (JSON, tools, vision, context size) and skipping ones that are failing.
- Stores everything in SQLite by default, or Postgres/Supabase when you grow.
- Comes with a web dashboard for keys, lanes, policies, and request debugging — in 5 languages.

## How a request flows

```
        ┌──────────────────────────── Helm API gateway (Hono) ───────────────────────────┐
        │                                                                                  │
client ─┤  /v1/chat/completions ─┐                                                         │
(OpenAI/ │  /v1/messages ─────────┼─▶ auth ─▶ rate limit ─▶ classify ─▶ route ─▶ execute ──┼─▶ upstream
 Anthropic) /v1/responses ────────┘     │         │            │          │         │       │   providers
        │                               │         │            │          │         │       │  (openai-crs,
        │   /admin (SPA, HTTP Basic) ───┘   per-key RPM/TPM   pick a     apply     try, then │   zenmux,
        │   /admin/api/*                                       lane     policies  fall back  │   openrouter…)
        │   /healthz  /version                                                               │
        │                                                                                    │
        └──────────────────────────── Store (SQLite default · Postgres optional) ───────────┘
              keys · decision logs · request payloads · rate-limit counters · memory
```

The routing logic lives in `packages/core` and depends on no web framework. `apps/gateway` is a thin Hono layer that also serves the dashboard.

## Quick start

Three commands to a running gateway:

```bash
# 1. Clone and create your env file
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    In .env, set HELM_ADMIN_PASSWORD and at least OPENAI_API_KEY

# 2. Start it
docker compose up -d

# 3. Copy the root API key — it is printed once, on first boot
docker compose logs helm | grep -i "root key"
```

- **Gateway** → `http://localhost:8080`
- **Dashboard** → `http://localhost:8080/admin` (log in with `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`)
- **Health / version** → `GET /healthz`, `GET /version`

`docker-compose.yml` mounts `./config` and `./data`, so your config and database survive restarts. Credentials are passed in as environment variables only — never built into the image.

## Calling the gateway

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

Three endpoints, all authenticated with a Helm API key:

| Endpoint | Protocol | Streaming |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ |
| `POST /v1/messages` | Anthropic Messages | ✅ |
| `POST /v1/responses` | OpenAI Responses | ❌ not yet (0.1) |

**What to put in the `model` field:**

| Value | What Helm does |
|---|---|
| `auto` *(recommended)* | Classifies the request and routes it to the best lane automatically. |
| a model alias, e.g. `openai-crs/gpt-5.5` | Uses exactly that model and skips routing — only for API keys granted custom-model permission. |

> With a standard key the routing is automatic no matter what you send, so just use `auto`. The lanes themselves (`economy`, `balanced`, `premium`, `coding`, …) are configured by the operator in `lanes.yaml` and the dashboard — Helm assigns each request to one; clients don't choose a lane per call. A Gemini adapter exists in the core but isn't routed yet — see the [roadmap](docs/09-roadmap.md).

### Seeing how a request was routed

Every `/v1/chat/completions` response carries headers that explain the decision — quick debugging without opening the dashboard:

| Header | Meaning |
|---|---|
| `x-helm-lane` | The lane the request landed in |
| `x-helm-final-model` | The model alias that actually answered |
| `x-helm-provider-model` | The upstream model id sent on the wire |
| `x-helm-decided-by` | How the lane was chosen (`rules`, `eval`, `fallback`, …) |
| `x-helm-fallback-reason` | Why it fell back, when it did |

When rate limiting is on, responses also include `x-ratelimit-limit`, `x-ratelimit-remaining`, and `x-ratelimit-reset` (plus `retry-after` on a 429).

## Configuration

Everything is configured in `config/*.yaml`. Files are validated on load, and invalid config stops the gateway from starting. The lanes, policies, and classifier can also be edited live in the dashboard.

| File | What it controls | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | API key requirement + first-run root key | — |
| `runtime.yaml` | Request limits, rate-limit defaults, storage driver | partial |
| `providers.yaml` | Upstream providers + model aliases (credentials by env-var **name** only) | — |
| `lanes.yaml` | Lanes — each lane's main model and its backup chain | ✅ |
| `policies.yaml` | Rules that pick or cap the lane | ✅ |
| `classifier.yaml` | The built-in rules and the optional scoring model | ✅ |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the model catalog | — |

Most-used environment variables (full list in [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Main provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` | Backup provider credentials (optional) |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Dashboard login |
| `HELM_PORT` / `HELM_HOST` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | Turn rate limiting on (off by default) |

Helm ships with the lanes **economy**, **balanced**, and **premium**, plus task lanes **coding**, **json**, **vision**, and **tool_use**. `balanced` is the lane every request can safely fall back to.

## The dashboard

At `/admin`, behind a username/password (HTTP Basic): a live overview, API keys (create, revoke, set per-key limits), lane and policy editors, classifier settings, and a request log you can drill into to see exactly how each request was routed. Available in English (default), Simplified and Traditional Chinese, Japanese, and Korean.

## Project layout

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

## Development

Requires **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm dev          # dashboard dev server
pnpm test         # Vitest unit tests
pnpm test:e2e     # Playwright end-to-end tests
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # Biome
pnpm build        # build the gateway + dashboard
pnpm sync:catalog # refresh the generated model catalog (capabilities + pricing)
```

Tests come first (Vitest for the core, Playwright for full flows). The full spec is in [`docs/`](docs/README.md), and design decisions are logged in [`implementation-notes.md`](implementation-notes.md).

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

## Roadmap

**0.1** includes the full routing gateway, three client protocols, multi-provider fallback, the dashboard, and the first half of the memory feature (observe). Coming next: a Gemini route, streaming for `/v1/responses`, the second half of memory (inject), and finer-grained quotas. See [09 Roadmap](docs/09-roadmap.md).

## Contributing

Issues and pull requests are welcome. Work on a branch, and make sure the checks pass before opening a PR:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## License

[MIT](LICENSE) © 2026 EasyMeta AU
