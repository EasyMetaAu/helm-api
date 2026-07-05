<div align="center">

<img src="docs/assets/logo.svg" width="84" height="84" alt="Helm logo">

# Helm API

**English** · [Chinese](README.zh-CN.md)

### One control plane for LLM traffic: text, images, subscriptions, fallback, and memory.

Open-source · self-hosted · MIT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/EasyMetaAu/helm-api)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Built with Hono](https://img.shields.io/badge/gateway-Hono-ff5e00.svg)](https://hono.dev)
[![Admin: SvelteKit](https://img.shields.io/badge/admin-SvelteKit-ff3e00.svg)](https://kit.svelte.dev)

</div>

LLM apps tend to accumulate routing code in all the wrong places: fallback lists inside clients, one-off patches for provider quirks, hard-coded model names, ad hoc cost controls, and no clean way to answer "why did this request go there?"

Helm API puts that work in one place: an open-source, self-hosted **LLM routing gateway** — *nginx for the LLM world*. Your app sends normal OpenAI, Anthropic, Gemini, or image-generation requests. Helm classifies the request, picks a lane, chooses a provider account, falls back when an upstream breaks, translates protocols when needed, and records the whole decision trail. Clients usually change only `base_url` and the API key.

> **Manage traffic as configuration, not as code.**

```python
# Your app: the same OpenAI client, just a new base_url and key.
client = OpenAI(base_url="http://localhost:8080/v1", api_key="<helm-key>")
client.chat.completions.create(model="auto", messages=[...])   # Helm classifies and routes
```

Change the model behind a lane? Edit one YAML line — or click in the dashboard. Your apps never notice.

<div align="center">

[![Helm dashboard — live traffic, token usage by model, spend, and recent routing decisions](docs/assets/screenshots/01-dashboard.png)](docs/assets/screenshots/01-dashboard.png)

<sub>The dashboard — live traffic, token usage by model, spend, and the most recent routing decisions.</sub>

</div>

## Quickstart

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/), or **Node ≥ 22** + **pnpm 10** to build from source.

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

| What | Where |
|---|---|
| Gateway | `http://localhost:8080` (status landing page at `/`) |
| Dashboard | `http://localhost:8080/admin` — `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` |
| API docs | `GET /docs` (Swagger UI) · `GET /openapi.json` (OpenAPI 3.1, generated from the same Zod schemas the gateway validates with) |
| Health / version | `GET /healthz` · `GET /version` |

`docker-compose.yml` mounts `./config` and `./data` — config and database survive restarts. Credentials enter via environment variables only, never the image.

## What you get

|  | Feature | Detail |
| :---: | :--- | :--- |
| 🔀 | **Multi-protocol text routing** | OpenAI Chat, Anthropic Messages, OpenAI Responses, and Google Gemini — streaming + non-streaming. Text requests share one routing core, with native passthrough when the inbound protocol already matches the selected upstream. |
| 🖼️ | **Image generation with failover** | OpenAI Images (`/v1/images/generations`), Gemini image models on `generateContent`, and Gemini Interactions (`/v1beta/interactions`). Image requests can name an image model or image lane and fail over across providers without text classification. |
| 🧭 | **Three-layer classification** | Deterministic rules (pure, zero-network, unit-tested — always on) → optional small-model eval (`temperature: 0`, cached, off by default — needs a configured eval model) → `balanced` lane as the fail-open sink. |
| 🛣️ | **Lanes + policies** | Requests route through lanes (`economy`, `balanced`, `premium`, plus task lanes like `coding`, `json`, `vision`, `tool_use`), never raw provider names. First-match policies can force a lane, restrict allowed lanes in config, and override reasoning effort. Each lane is a primary model plus an ordered fallback chain. Opt-in Agentic Signals can promote weak ranked lanes without overriding explicit pins or key caps. |
| 🪪 | **Drop-in for fixed-model clients** | A client that hard-codes a vendor model id (Claude Code's `claude-opus-4-8`, an SDK locked to `gpt-5.5`) just works — no *400 unknown model*. A **standard key** classifies it like `auto`; a **custom-model key** can map each vendor family onto a lane via `model-aliases.yaml` (cap-bounded). |
| 🛡️ | **Resilient execution** | Circuit breaker (OPEN/HALF_OPEN + single probe), capability filter with explicit skip reasons, `:free`-tier 429 skipping, per-key concurrency queueing. Client disconnects are never counted as provider faults. |
| 🔐 | **OAuth subscriptions** | Route your Claude Pro/Max, ChatGPT Codex, and GitHub Copilot subscriptions as backends — pooled accounts, per-account model curation / egress proxy / scheduling, global pool strategies, live quota windows, and guarded Codex reset-credit recovery. *(Opt-in; read the [ToS warning](#oauth-subscription-providers-claude-promax-chatgpt-codex-github-copilot).)* |
| 🔑 | **Keys with teeth** | Mandatory auth; keys authenticate by SHA-256 hash; encrypted recovery material can be stored for admin reveal/rotation. Per key: lane whitelist, custom-model permission, RPM/TPM limits, usage budgets (degrade or reject), concurrency cap, memory mode. Rotate in place, revoke softly, then delete permanently. |
| 🧠 | **Memory middleware** | On by default: remembered context is injected before routing as a trailing turn; a background worker compresses and consolidates — compaction is **auto-adaptive and zero-config** (prices and context windows resolve from the model catalog; size / idle / context-pressure triggers). Summarize/merge default to deterministic local logic, with an **opt-in LLM path** (`config.memory.llm`, off by default). A forgetting/tiering layer (decay, reinforcement, retention) keeps it honest. Opt out per key or per request (`x-memory-mode: off`). |
| 📊 | **Total observability** | A redacted decision record per request — classifier, policy, lane, every provider attempt, latency, fallbacks, cost. Verbatim payload capture to a separate table (on by default, 30-day retention). A payload inspector reads long fields fullscreen, previews inline images, and an editable **Retry** button replays any captured request in its own protocol. |
| 🖥️ | **Admin dashboard** | SvelteKit SPA at `/admin` behind HTTP Basic when admin is enabled: overview, request debugger, key CRUD, lane/policy/classifier editors, OAuth providers, memory, and system settings. Lanes/policies/classifier write back to YAML and rebind live; keys, settings, providers, and memory persist through their stores/APIs. Five languages. |
| 💾 | **Storage** | SQLite by default (one local file). Postgres / Supabase behind the same Store-port abstraction — switch with one env var. |

**Roadmap:** Account/customer billing is intentionally out of scope. See [09 Roadmap](docs/09-roadmap.md).

## Inside the dashboard

The gateway ships a SvelteKit console at `/admin` (HTTP Basic, five languages) when admin is enabled. Everything here is live: route rules rebind on the next request, runtime settings apply without a restart, provider-pool edits rebuild the next request's pool, and key changes take effect immediately.

**Every request, fully explained.** Open any request to follow the whole trail: which layer classified it, the policy that applied, the lane's full candidate chain, each provider actually tried, and the cost split down to cached tokens.

[![Request trail — classifier verdict, lane candidate chain, provider attempts, and cost breakdown](docs/assets/screenshots/03-request-trail.png)](docs/assets/screenshots/03-request-trail.png)

**A payload inspector built for debugging.** With verbatim capture on, the same page loads the full request and response bodies as a collapsible tree (or Formatted / Raw):

- **Read anything.** Pop any oversized field — a giant system prompt, a tool schema, a continued-session summary — into a fullscreen, copyable reader instead of scrolling a wrapped cell.
- **See the multimedia.** A media overview at the top collects every image **sent** (request) and **generated** (response) as clickable thumbnails — no tree-digging — and inline base64 or remote images still render in place, with zoom, fit-to-window, and open-in-new-tab.
- **Edit and replay.** Hit **Retry**, tweak the body, and re-send it in its original protocol (OpenAI Chat, Anthropic, Responses, or Gemini) as an isolated, newly-traced debug run.

**Pool your subscriptions.** Route Claude Pro/Max, ChatGPT Codex, and GitHub Copilot logins as backends — several accounts per provider, each with its own model curation, egress proxy, priority, live quota, reset-credit controls, and a global account-usage strategy.

[![Subscription providers — pooled OAuth accounts with per-account quota, proxy, schedule, and status](docs/assets/screenshots/06-providers.png)](docs/assets/screenshots/06-providers.png)

**Routing is just config.** Each lane is a primary model plus an ordered fallback chain. Reorder or swap lane candidates in the UI or YAML; policy and key caps keep clients inside the lanes you allow.

[![Lanes editor — primary model and ordered fallback chain per lane](docs/assets/screenshots/04-lanes.png)](docs/assets/screenshots/04-lanes.png)

<details>
<summary><b>See every admin screen</b> — all 10 screenshots (click to expand)</summary>

<br>

| | |
|:--:|:--:|
| [<img src="docs/assets/screenshots/01-dashboard.png" width="420">](docs/assets/screenshots/01-dashboard.png)<br>**Dashboard** — traffic, spend, token usage, recent decisions | [<img src="docs/assets/screenshots/02-requests.png" width="420">](docs/assets/screenshots/02-requests.png)<br>**Requests** — the filterable request log |
| [<img src="docs/assets/screenshots/03-request-trail.png" width="420">](docs/assets/screenshots/03-request-trail.png)<br>**Request trail** — the full per-request decision trail | [<img src="docs/assets/screenshots/04-lanes.png" width="420">](docs/assets/screenshots/04-lanes.png)<br>**Lanes** — primary + ordered fallback chain per lane |
| [<img src="docs/assets/screenshots/05-classifier.png" width="420">](docs/assets/screenshots/05-classifier.png)<br>**Classifier** — eval toggle, threshold, rule weights | [<img src="docs/assets/screenshots/06-providers.png" width="420">](docs/assets/screenshots/06-providers.png)<br>**Providers** — pooled OAuth subscription accounts |
| [<img src="docs/assets/screenshots/07-memory.png" width="420">](docs/assets/screenshots/07-memory.png)<br>**Memory** — facts & reflections by scope or key | [<img src="docs/assets/screenshots/08-policies.png" width="420">](docs/assets/screenshots/08-policies.png)<br>**Policies** — first-match rules that force lanes or reasoning effort |
| [<img src="docs/assets/screenshots/09-keys.png" width="420">](docs/assets/screenshots/09-keys.png)<br>**API Keys** — per-key caps, limits, budgets, memory mode | [<img src="docs/assets/screenshots/10-settings.png" width="420">](docs/assets/screenshots/10-settings.png)<br>**Settings** — payload capture, rate limits, queue, DB maintenance |

Each screen is annotated in **[11 · Admin UI](docs/11-admin-ui.md)**.

</details>

## Two failure disciplines

This is the design rule everything else hangs off:

- **Config and credentials are fail-closed.** Invalid YAML, a missing required key, an unknown store driver — the gateway refuses to start. It never runs half-configured.
- **The request path is fail-open.** Classification, eval, memory, cache — any optional step that stumbles degrades quietly to the `balanced` lane and gets logged. A client sees a structured error only when *every* provider in the chain is genuinely down.

And two fallbacks that are never conflated: *classification fallback* (undecided → `balanced` lane) and *execution fallback* (provider failed → next model in the chain). Separate mechanisms, separate decision-record fields — you can always tell which one fired.

## Architecture

Text protocols, image endpoints, and optional memory tools enter one governed gateway; one framework-agnostic core does the routing work; config drives every stage. (For the same pipeline as sequence, flow, and state diagrams, see **[Architecture & Data Flow](docs/architecture.md)**.)

```text
CLIENT ── OpenAI · Anthropic · OpenAI Responses · Google Gemini · Images
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
             ├─ classify    L1 rules ─uncertain→ L2 eval (off) ─→ balanced · fail-open
             ├─ resolve     alias shim · explicit model · first-match policy
             │                  └─▶ lane → caps (+ signals) → fallback chain
             ├─ execute     capability filter → circuit breaker → provider
             │                  └── on failure: advance to next model in the chain
             └─ translate   provider-native  ⇄  IR  ⇄  client protocol (streaming SSE)
             │
             ▼
RESULT ── streamed/JSON response, in the client's own protocol
             │
             ├─▶ telemetry   redacted decision record + verbatim payload capture
             ├─▶ memory      write back the turn
             └─▶ upstream    static API keys + OAuth subscriptions (pooled · hot-reload)

config/*.yaml drives every stage · Zod-validated · invalid config refuses to boot (fail-closed)
```

The core is **headless by contract**: routing, classification, provider execution, protocol translation, and storage live in `packages/core` and import no web framework — an architecture test enforces it. Hono and SvelteKit are thin, optional shells.

```text
helm-api/
├─ apps/
│  ├─ gateway/   # Hono API + serves the dashboard + /healthz, /version
│  └─ admin/     # SvelteKit + Tailwind dashboard (static SPA)
├─ packages/
│  ├─ core/      # routing, classification, providers, protocol translation, storage ports (no framework)
│  └─ shared/    # Zod schemas + shared types (single source of truth)
├─ config/       # default lanes / policies / classifier / providers / model-aliases / … YAML
├─ docs/         # documentation (start at docs/README.md)
└─ scripts/      # sync:catalog and other build-time tools
```

## Calling the gateway

Any OpenAI-compatible client works. Point it at Helm with a Helm key:

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
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | ✅ (via `:streamGenerateContent`; auth via `x-goog-api-key`) |
| `POST /v1/images/generations` | OpenAI Images API ([image generation](#image-generation)) | — (image model/lane, any key) |
| `POST /v1beta/interactions` | Gemini Interactions API ([image generation](#image-generation)) | — (image model/lane, any key) |

**What to put in `model`:**

| Value | What Helm does |
|---|---|
| `auto` *(recommended)* | Classifies the request and routes it to the best lane. |
| any model/lane on a **standard key** | Helm still classifies and routes as if you'd sent `auto` (never a 400) — the `model` field doesn't pick the lane. But if the model you named is already in the chosen lane's chain, Helm serves *that* candidate first. |
| a pinned vendor id, e.g. `claude-opus-4-8` — **custom-model key** | The compatibility shim maps it onto a lane (`config/model-aliases.yaml`), cap-bounded by the key's lanes. |
| a lane name (`premium`) or exact alias (`deepseek/deepseek-v4-pro`) — **custom-model key** | Routes straight into that lane / model, skipping classification. |

> A standard key only ever needs `auto`. The `model` field never changes which lane is chosen — but when the named model already sits in that lane's chain, Helm promotes it to the front (so Claude Code pinning `claude-sonnet-4-6` gets Sonnet, not the lane's primary; it falls back to the rest of the chain on failure). Pinning a lane, a vendor family, or an out-of-lane model requires a **custom-model** key (`allow_custom_model`). Lanes are operator config (`lanes.yaml` + dashboard).

### Image generation

Image requests name either an exact image model or an image **lane** — see [Failover](#image-failover-across-providers) below. They skip text classification, and **any valid key** works (no `allow_custom_model` needed; cost is bounded by the key's budget / rate limit). Operator-configured models: `gpt-image-2` (OpenAI), `gemini-3.1-flash-image` / `gemini-3-pro-image` (Google "Nano Banana"). Every call is metered per image (output tokens × the model's image rate) and appears in the dashboard like any other request. Three entrypoints — match the one your SDK speaks:

**1. OpenAI Images API** — `POST /v1/images/generations` (Bearer auth), `{ "created", "data": [{ "b64_json" }], "usage" }`:

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gpt-image-2", "prompt": "a single red apple on a plain white background", "size": "1024x1024" }'
```

**2. Gemini `generateContent`** — the Gemini SDK's `generate_content` path. Name an image model and ask for image output; Helm routes it natively, so the response carries `candidates[].content.parts[].inlineData`:

```bash
curl "http://localhost:8080/v1beta/models/gemini-3.1-flash-image:generateContent" \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "contents": [{ "parts": [{ "text": "a single red apple on a plain white background" }] }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] } }'
```

**3. Gemini Interactions API** — `POST /v1beta/interactions` (the SDK's `client.interactions.create`). Response is the `steps[]` shape, with the image at `steps[].content[]` (`{ "type": "image", "data": … }`); the SDK's `interaction.output_image.data` reads it:

```bash
curl http://localhost:8080/v1beta/interactions \
  -H "x-goog-api-key: $HELM_KEY" -H "Content-Type: application/json" \
  -d '{ "model": "gemini-3.1-flash-image", "input": "a single red apple on a plain white background",
        "response_format": { "type": "image", "aspect_ratio": "1:1" } }'
```

> The OpenAI Images endpoint serves both OpenAI and Gemini image models (Helm translates Gemini to/from `generateContent`). The two Gemini-native entrypoints serve only Gemini image models. `gpt-image-2` on `/v1beta/interactions` is a 400 → use `/v1/images/generations`.

#### Image failover across providers

The same image model is often available from several providers (official upstream, ZenMux, OpenRouter…). The shipped config already groups them into image **lanes** — name the **lane** as your `model` and Helm tries the primary, then on a provider fault (timeout, 5xx, circuit-open) falls over to the next, using the **same circuit breaker** as the chat router. A deterministic client error (a 4xx invalid request — bad size, oversized image) is returned verbatim and does **not** trigger failover.

```yaml
# config/lanes.yaml — the two shipped image lanes lead with the OFFICIAL upstream,
# then fall over to the ZenMux relay. Members must be image models
# (capabilities.outputImage) and a single kind (all gpt-image-* OR all gemini-*-image).
gpt-image:                          # request `model: "gpt-image"`
  primary: openai/gpt-image-2       # OpenAI official → ZenMux relay
  fallback: [gpt-image-2]
gemini-image:                       # request `model: "gemini-image"`
  primary: google/gemini-3.1-flash-image   # Google official → ZenMux flash → pro
  fallback: [gemini-3.1-flash-image, gemini-3-pro-image]
```

Image lanes work for **any key** on the two dedicated endpoints (`/v1/images/generations`, `/v1beta/interactions`). On the Gemini `:generateContent` path, naming a lane follows the normal lane rule — it requires an `allow_custom_model` key — so for the broadest reach, point image SDKs at the dedicated endpoints.

**Other endpoints** (full interactive docs at `/docs`, raw spec at `/openapi.json`):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` · `GET /healthz` · `GET /version` | — | Landing page · readiness · build info |
| `GET /v1/models` · `GET /v1/models/{id}` | API key | Models the key can route to (lanes + `auto`; concrete aliases with capabilities & pricing for custom-model keys) |
| `GET /v1/usage/stats` | API key | Per-key usage aggregates over a requested time window |
| `POST /v1/messages/count_tokens` | API key | Anthropic-shaped token-count helper |
| `/v1/responses/*` lifecycle helpers | API key | `input_tokens`, `compact`, retrieve/delete/cancel/input-items for Responses-compatible clients |
| `POST /mcp` + OAuth discovery | API key or optional MCP OAuth | Optional memory MCP tools when `memory.mcp.enabled` is on |
| `/admin` · `/admin/api/*` | Basic auth | Dashboard + its JSON backend (mounted only when admin is enabled) |

## Configuration

Boot-time behavior lives in `config/*.yaml`, Zod-validated on load. **Invalid config stops the gateway from starting.** Lanes, policies, and classifier rules are editable live in the dashboard and write back to YAML (comments preserved, atomic). Runtime settings, keys, OAuth provider accounts, memory, and captured request data live in the store and apply without a restart through their admin APIs.

| File | Controls | Live-editable |
|---|---|---|
| `server.yaml` | Host / port / base path | — |
| `auth.yaml` | API key requirement + first-run root key | — |
| `runtime.yaml` | Request limits, rate-limit defaults, storage driver, opt-in signal feedback | partial |
| `providers.yaml` | Upstream providers + model aliases (credentials by env-var **name** only) | — |
| `lanes.yaml` | Each lane's primary model + fallback chain (quality, task, and vendor-family lanes) | ✅ persists |
| `policies.yaml` | First-match rules that force a lane, restrict allowed lanes, or force reasoning effort | ✅ persists |
| `classifier.yaml` | Built-in rules + the optional eval model | ✅ persists |
| `model-aliases.yaml` | Maps a pinned vendor model id → lane / `auto` (compatibility shim, optional) | — |
| `memory.yaml` | Forgetting/tiering knobs (on in the shipped config) · optional compaction trigger overrides (`compaction:`) · optional LLM summarizer (`llm:`, off by default). A leftover `observer:` block from older configs refuses startup | partial |
| `capabilities.yaml` / `pricing.yaml` | Manual overrides on the model catalog (incl. prompt-cache read/write prices) | — |

Most-used environment variables (env wins over YAML; full list in [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Primary provider credential (**required**) |
| `ZENMUX_API_KEY`, `OPENROUTER_API_KEY` | Optional provider credentials (provider skipped if missing) |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | Optional — official OpenAI / Google **image** providers; the shipped `gpt-image` / `gemini-image` lanes lead with these and fail over to ZenMux |
| `HELM_ADMIN_USER` / `HELM_ADMIN_PASSWORD` | Dashboard login (Basic auth) |
| `HELM_HOST` / `HELM_PORT` | Server binding (default `0.0.0.0:8080`) |
| `HELM_STORE_DRIVER` | `sqlite` (default) or `supabase` |
| `HELM_STORE_URL_ENV` | For `supabase`: the **name** of the env var holding the Postgres DSN |
| `HELM_RATE_LIMIT_ENABLED` | Turn rate limiting on (off by default) |
| `HELM_OAUTH_ENC_KEY` | 32-byte key encrypting recoverable API keys and stored OAuth tokens (**required** if any subscription provider is configured; needed for later API-key reveal) |

> **Storage.** SQLite (`better-sqlite3`, a `helm.db` file under `./data`) is the default. For Postgres/Supabase, set `HELM_STORE_DRIVER=supabase` and point `HELM_STORE_URL_ENV` at the env var holding your DSN. Unknown drivers fail closed at startup.
>
> **Credentials.** Provider keys are referenced by env-var *name* in `providers.yaml` — plaintext never enters the repo or the image.

### OAuth subscription providers (Claude Pro/Max, ChatGPT Codex, GitHub Copilot)

A provider can authenticate with an **OAuth subscription** instead of a static key: log in from the dashboard (**Providers → Connect**). Claude Pro/Max and ChatGPT Codex use an authorization-code paste; GitHub Copilot uses a device code. Helm stores the rotating refresh token **encrypted at rest** and refreshes access tokens automatically.

Set **`HELM_OAUTH_ENC_KEY`** (32 bytes: base64 or 64 hex chars) — Helm refuses to start if a subscription provider is configured without it. The same key encrypts API-key recovery material used by the admin reveal/rotate flows. Then add an `oauth: { provider: anthropic | github-copilot | openai-codex }` block to the provider (commented examples in `config/providers.yaml`; for Claude use `type: anthropic`).

Pool **several accounts per provider**. Each account (**Providers → Manage**) gets its own:

- **Models** — a live allow-list, not a display filter: a removed model stops routing immediately; an uncurated model is refused (fail-closed).
- **Proxy** — HTTP/HTTPS/SOCKS5 egress per account, used across the entire subscription flow, so co-hosted accounts exit from distinct IPs.
- **Schedule** — `priority` (lower serves first) + a `schedulable` toggle. Park an account to keep it connected but out of rotation.

The account pool also has one **global usage strategy** that applies inside every subscription provider pool:

- `balanced` — spread new sessions across accounts while preserving sticky sessions.
- `manual_priority` — follow account priority first; rotate only within the same priority.
- `low_risk` — prefer lower quota pressure in the best priority tier to reduce 429 risk.
- `use_expiring` — prefer accounts with short or weekly quota that will reset soon, and count Codex reset credits as discounted recoverable capacity.

Quota signals are soft scoring inputs: stale or missing quota falls back to the balanced behavior, while hard cooldowns and manually parked accounts are still excluded. Codex reset credits are **never spent by selection**. They are consumed only by the explicit **Reset limit** action or by the guarded auto-reset flow, and only when a weekly Codex window is saturated enough.

Everything hot-reloads — connect, disconnect, curation, proxy, scheduling — next request, no restart. Helm also mirrors each official client's identity headers and sends a **stable per-account device identity** (never rotated mid-stream) to reduce ban-correlation risk.

> ⚠️ **Terms of service.** Routing a Claude/ChatGPT/Copilot **subscription** through a third-party gateway may violate the provider's ToS and can get accounts suspended. This is an opt-in feature for self-hosted personal use — **you are responsible** for compliance with your provider agreements. When in doubt, use a normal API key (`api_key_env`).

## Development

Requires **Node ≥ 22** and **pnpm 10**.

```bash
pnpm install
pnpm dev          # admin dashboard dev server (Vite) — see note below
pnpm test         # Vitest unit tests
pnpm exec vitest run --coverage # unit coverage with source-only include/exclude + thresholds
pnpm test:e2e     # Playwright end-to-end tests
pnpm typecheck    # tsc --noEmit across the workspace
pnpm lint         # Biome
pnpm build        # build the gateway + dashboard
pnpm sync:catalog # refresh the generated model catalog (capabilities + pricing)
```

> `pnpm dev` starts only the admin SPA. The gateway has no watch script — run it built (`pnpm build` then `node apps/gateway/dist/index.js`) or via Docker.

Tests come first: Vitest for the core, Playwright for full flows. Design decisions live in [`implementation-notes.md`](implementation-notes.md). Before a PR:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```

## Documentation

Start at [`docs/README.md`](docs/README.md). For a visual tour of the pipeline, read **[Architecture & Data Flow](docs/architecture.md)**. The numbered specification, in order:

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
[13 Memory Admin & MCP](docs/13-memory-admin-and-mcp.md) ·
[14 Memory Deep Recall](docs/14-memory-deep-recall.md) ·
[Protocol Compatibility](docs/protocol-compatibility.md)

## Status

Helm API is a real, end-to-end implementation, not a scaffold. The full pipeline (config → auth → classify → route → execute with circuit-breaking and fallback → protocol translation → telemetry → memory) is wired and covered by an extensive Vitest suite plus Playwright e2e specs. The version badge above tracks the current release.

## License

[MIT](LICENSE) © 2026 EasyMeta AU
