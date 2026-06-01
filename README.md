<div align="center">

# Helm API

**English** · [简体中文](README.zh-CN.md)

### Route every LLM request to the right model — by config, not code.

*Think **nginx**, but for LLM traffic.* Open-source, self-hosted, MIT.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

You wired your app to one model. Then a cheaper one shipped, a provider started rate-limiting you, one request needed vision, the bill crept up — and every change meant another redeploy. **Helm API puts a thin, fast gateway in front of your providers so those decisions live in config, not code.**

Point your client at Helm and send a normal OpenAI or Anthropic request. Helm sizes up how hard it is, drops it into a **lane** (`economy` / `balanced` / `premium` …), runs it through provider adapters with automatic failover, and logs *why* every request went where it did. Your app only ever touches its `base_url` and API key — everything else is yours to tune from a config file or the built-in dashboard.

```bash
# your app, unchanged — just a new base_url + key
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="balanced", messages=[...])   # Helm picks the model
```

---

## ✨ Why Helm

- **Lanes, not a model catalog.** Callers ask for an *intent* — `economy`, `balanced`, `premium` — and never need to know which provider or model actually answered. Swap models behind a lane without touching a single client.
- **Config is the product.** Routing, lanes, policies, providers — all live in `config/*.yaml`, validated by Zod. Misconfigure something and Helm **refuses to boot** instead of misbehaving in production.
- **Nothing 5xxs on a side-quest.** If classification, eval, or the cache hiccups, the request quietly drops to the `balanced` lane and keeps going. You only get a hard error when *every* provider is truly down.
- **Fast path is deterministic.** Routing decisions are a pure, zero-network, unit-tested function. The optional small-model "second opinion" runs at `temperature: 0`, is cached, and ships **off by default** — no surprise latency or spend.
- **Keys hashed, bodies kept.** API keys are stored as SHA-256 hashes — never logged, never echoed. Full request/response bodies land in a separate, toggleable table with retention, so you can actually debug what happened.
- **Headless or hands-on.** The whole routing engine is framework-free and runs fine without a UI — but there's a polished admin dashboard when you want one.
- **Yours to run.** MIT-licensed, Docker-deployed, no SaaS, no phone-home. It's your gateway on your infra.

## 🧩 What's inside

- 🔌 **Drop-in compatible** with OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses — including SSE streaming for Chat & Messages.
- 🔁 **Speaks every dialect** via one internal representation, with SSE event mapping handled for you.
- 🧭 **Three-layer routing**: deterministic rules → optional small-model eval → `balanced` safety net.
- 🛣️ **Lane + policy engine** with first-match rules and per-org caps.
- 🪂 **Multi-provider failover** across providers, with capability filtering (JSON / tools / vision / context / streaming) and a per-model circuit breaker.
- 💾 **Bring your own store**: SQLite out of the box, Postgres/Supabase when you scale — one interface, swap freely.
- 🔒 **Auth that's on by default**: mandatory API keys, a root key minted on first boot, optional per-key RPM/TPM limits.
- 📊 **A real dashboard** (SvelteKit) for keys, lanes, policies, classifier tuning, and request debugging — HTTP Basic auth, localized in 5 languages.

## 🗺️ How a request flows

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

The routing brain lives in `packages/core` and depends on no web framework. `apps/gateway` is a thin Hono shell that also serves the dashboard.

## 🚀 Quick start

Up and running in three commands:

```bash
# 1. clone + create your env file
git clone https://github.com/EasyMetaAu/helm-api.git && cd helm-api
cp .env.example .env
#    set HELM_ADMIN_PASSWORD and at least OPENAI_API_KEY in .env

# 2. launch
docker compose up -d

# 3. grab the root API key Helm prints ONCE on first boot
docker compose logs helm | grep -i "root key"
```

That's it:

- **Gateway** → `http://localhost:8080`
- **Dashboard** → `http://localhost:8080/admin` (`HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD`)
- **Health / version** → `GET /healthz`, `GET /version`

`docker-compose.yml` mounts `./config` and `./data`, so your config and SQLite database survive restarts. Credentials are injected via env vars only — never baked into the image.

## 🔗 Calling it

Any OpenAI-compatible client works — just point it at Helm with a Helm key:

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

The `model` field takes a **lane** name, not a vendor model id:

| Endpoint | Protocol | Streaming |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | ✅ SSE |
| `POST /v1/messages` | Anthropic Messages | ✅ SSE |
| `POST /v1/responses` | OpenAI Responses | ❌ non-streaming (0.1) |

> Pass `economy`, `balanced`, `premium`, or a task lane like `coding`. Leave it off (or send something unknown) and Helm classifies the request and picks a lane for you. A Gemini adapter already lives in the core but isn't routed yet — see the [roadmap](docs/09-roadmap.md).

## ⚙️ Configuration

Everything is config-as-code in `config/*.yaml` — Zod-validated, fail-closed. The hot-reloadable ones can also be edited live from the dashboard.

| File | What it controls | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | Mandatory API key + root-key bootstrap | — |
| `runtime.yaml` | Request limits, rate-limit defaults, store driver | partial |
| `providers.yaml` | Upstream providers + model aliases (creds by env-var **name** only) | — |
| `lanes.yaml` | Lanes (primary + fallback chain, constraints) | ✅ |
| `policies.yaml` | First-match routing rules | ✅ |
| `classifier.yaml` | Layer-1 rules + Layer-2 eval | ✅ |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the model catalog | — |

Most-used env vars (full list in [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Primary provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` | Optional fallback-provider credentials |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Dashboard login |
| `HELM_PORT` / `HELM_HOST` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_RATE_LIMIT_ENABLED` | Master rate-limit switch (default off) |

Ships with lanes **economy** / **balanced** / **premium**, plus task lanes **coding** / **json** / **vision** / **tool_use**. `balanced` is the guaranteed safety net every classification can fall back to.

## 🖥️ The dashboard

At `/admin`, behind HTTP Basic auth: a live dashboard, API keys (create / revoke / per-key limits), lane and policy editors, classifier tuning, request telemetry with full decision-chain drill-down, and system settings (payload capture, retention, rate-limit switch). Localized in English (default), Simplified & Traditional Chinese, Japanese, and Korean.

## 🗂️ Project layout

```
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + serves the dashboard + /healthz, /version
│  └─ admin/     # SvelteKit + Tailwind dashboard (adapter-static SPA)
├─ packages/
│  ├─ core/      # routing · classification · providers · protocol translation · Store ports (framework-free)
│  └─ shared/    # Zod schemas + shared types (single source of truth)
├─ config/       # default lanes / policies / classifier / providers / … YAML
├─ docs/         # documentation (read 01 → 11)
└─ scripts/      # sync:catalog and other build-time tools
```

## 🛠️ Development

Needs **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm dev          # dashboard dev server
pnpm test         # Vitest unit tests
pnpm test:e2e     # Playwright end-to-end tests
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # Biome
pnpm build        # build gateway + dashboard assets
pnpm sync:catalog # refresh the generated model catalog (capabilities + pricing)
```

Built test-first (Vitest for the core, Playwright for the flows). The full spec lives in [`docs/`](docs/README.md); design decisions and trade-offs are logged in [`implementation-notes.md`](implementation-notes.md).

## 📚 Documentation

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

## 🧭 Roadmap

**0.1** ships the full routing gateway, three client protocols, multi-provider failover, the dashboard, and the observational-memory *observe* phase. Next up: a Gemini client route, streaming for `/v1/responses`, the memory *inject* phase, and richer quota controls. Details in [09 Roadmap](docs/09-roadmap.md).

## 🤝 Contributing

Issues and PRs welcome. Work on a branch and make sure CI is green before opening a PR:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## 📄 License

[MIT](LICENSE) © 2026 EasyMeta AU / 路田（上海）网络科技有限公司
