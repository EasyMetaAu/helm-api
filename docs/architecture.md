# Helm API — Architecture & Data Flow

> Visual companion to [02 Architecture](02-architecture.md). That chapter explains
> the system in prose; this one draws it — component map, request lifecycle,
> and a per-stage set of sequence, flow, and state diagrams. Everything here is
> traced to the shipping code; where a stage has its own chapter, it is linked.

Diagrams use [Mermaid](https://mermaid.js.org). GitHub renders them inline; in a
plain editor read the fenced source.

---

## 1. The shape of the system

Helm sits between your applications and every upstream LLM. Clients speak one of
four wire protocols to a single `base_url`; a declarative YAML config decides
which model actually answers; every decision is recorded.

```mermaid
flowchart TB
    subgraph clients["Clients — unchanged SDKs"]
        C1["OpenAI Chat"]
        C2["Anthropic Messages"]
        C3["OpenAI Responses"]
        C4["Google Gemini"]
    end

    subgraph gw["apps/gateway — Hono HTTP shell (thin, optional)"]
        MW["middleware: trace · auth · rate-limit · concurrency · limits"]
        AD["Protocol Adapter: native wire ⇄ IR"]
        ADMIN["/admin SPA + /admin/api · /healthz · /version · /docs"]
    end

    subgraph core["packages/core — the routing brain (no web framework)"]
        CLS["Classifier (3-layer)"]
        RT["Router: policies · lanes · caps · signals"]
        EX["Executor: capability filter · circuit breaker · fallback"]
        MEM["Memory middleware"]
        PR["Protocol transformers (IR hub)"]
    end

    subgraph up["Upstream providers"]
        SK["Static API keys — DeepSeek · ZenMux · OpenRouter"]
        OA["OAuth subscriptions — Claude · Codex · Copilot (pooled)"]
    end

    subgraph data["Storage (Store ports)"]
        DB["SQLite (default) | Postgres / Supabase"]
    end

    CFG["config/*.yaml — Zod-validated · invalid config refuses to boot"]

    clients -->|"one base_url + Helm key"| MW
    MW --> AD --> core
    CLS --> RT --> EX --> PR
    EX --> up
    core --> data
    CFG -.drives every stage.-> core
    ADMIN <-->|REST| data
    admin_user["Operator (browser)"] -->|HTTP Basic| ADMIN
```

**Reading it:** the gateway is a shell — it normalizes a request into one
*internal representation* (IR) and hands everything else to `core`. The core
never imports Hono or SvelteKit; an architecture test (`packages/core/src/arch.test.ts`)
fails the build if it ever does. That is what makes Helm runnable **headless**.

---

## 2. Module boundaries & the headless-core contract

| Package | Responsibility | Imports a web framework? |
|---|---|---|
| `packages/shared` | Zod schemas → the single source of truth for every type (`z.infer`). Defines the IR, `DecisionRecord`, error model, config schemas. | No |
| `packages/core` | Classification, routing, execution, protocol translation, memory, Store *ports*. Pure logic. | **No (enforced)** |
| `apps/gateway` | Hono: HTTP surfaces, middleware order, protocol ⇄ IR wiring, Store *adapters*, background workers. | Hono |
| `apps/admin` | SvelteKit static SPA. Talks only to `/admin/api/*`; imports **zero** core/gateway code. | SvelteKit |

The dependency arrow only ever points **inward**: `gateway → core → shared`.
The admin SPA depends on neither — it is a pure HTTP client of the admin API.

---

## 3. Request lifecycle — the master path

A single `POST /v1/chat/completions` (or any of the four faces), streaming,
end to end. Optional stages are marked; the colored notes call out each stage's
failure discipline.

```mermaid
sequenceDiagram
    autonumber
    participant Cl as Client
    participant GW as Gateway (Hono)
    participant Mem as Memory
    participant Rt as Core Router
    participant Cf as Classifier
    participant Ex as Executor + Breaker
    participant Up as Provider
    participant St as Store (writeQueue)

    Cl->>GW: HTTP request (one of 4 protocols)
    Note over GW: trace_id · body-limit · timeout
    GW->>GW: auth (sha256(key) → KeyStore) · rate-limit · concurrency
    Note right of GW: fail-closed — bad/over-limit key never reaches core
    GW->>GW: transformRequestOut → IR

    GW->>Mem: observeInbound — persist the turn
    GW->>Mem: injectIntoIR — assemble memory, append as trailing user turn
    Note right of Mem: fail-open — any error returns the IR unchanged

    GW->>Rt: routeRequest(IR)
    Rt->>Cf: classify (L1 rules → L2 eval?)
    Note right of Cf: fail-open — any throw → balanced lane
    Cf-->>Rt: task_type · complexity · decided_by
    Rt->>Rt: policies → resolveLane → caps → signals → candidate_chain

    Rt->>Ex: execute(candidate_chain)
    loop each candidate until first success
        Ex->>Ex: canAttempt? · capability filter
        alt circuit OPEN or capability skip
            Note over Ex: push skipped attempt, try next
        else allowed
            Ex->>Up: invoke (IR → native via transformRequestIn)
            alt first valid chunk arrives
                Up-->>Ex: stream/json · recordSuccess
            else failure before first chunk
                Up-->>Ex: error · recordFailure → next candidate
            end
        end
    end
    Ex-->>Rt: result (or all_providers_failed → 502)

    Rt-->>GW: ExecutionResult + DecisionRecord
    GW->>GW: transformResponseOut / SSE → client's own protocol
    GW-->>Cl: response (streamed or JSON)

    GW->>Mem: observeOutbound — persist the response
    GW->>St: DecisionRecord (redacted) + payload (verbatim, opt-in)
    Note right of St: telemetry + memory writes are batched, never block the reply
```

The two memory writes and the telemetry write run **after** the client already
has its answer — they are deferred onto a batched write queue, so observability
never adds latency to the hot path.

---

## 4. Boot — fail-closed configuration

Helm refuses to run half-configured. The whole config tree is parsed and
Zod-validated before the server binds a port.

```mermaid
flowchart TD
    A["loadConfig(): read config/*.yaml in order<br/>server · auth · providers · runtime · classifier<br/>· lanes · policies · memory · model-aliases"] --> B["applyEnvOverrides() — env wins over YAML"]
    B --> C{"HelmConfigSchema<br/>valid?"}
    C -- "no" --> X["throw ConfigError (field paths only,<br/>no secret values) → process.exit(1)"]
    C -- "yes" --> D{"store driver?"}
    D -- "sqlite (default)" --> E["open ./data/helm.db · 5 pragmas · run migrations"]
    D -- "supabase" --> F["open Postgres via HELM_STORE_URL_ENV → DSN"]
    D -- "unknown" --> X
    E --> G["loadCatalog(): generated JSON + capabilities.yaml + pricing.yaml<br/>(per-field override · re-validated · fail-closed)"]
    F --> G
    G --> H["bootstrap root key (printed once) · build provider clients<br/>· synthesize OAuth presets · circuit breaker · classify adapter"]
    H --> R(["READY — bind port, start memory worker + signal scheduler"])

    style X fill:#fee,stroke:#c33
    style R fill:#efe,stroke:#3a3
```

Optional files (`classifier`, `lanes`, `policies`, `memory`, `model-aliases`)
may be **absent** (schema defaults apply) but never **invalid** — a present file
that fails validation still aborts boot. A leftover legacy `observer:` block in
`memory.yaml` is a hard rejection (the schema is `.strict()`), not a silent drop.

---

## 5. The two failure disciplines

Everything in Helm is one of two kinds of component. This single rule explains
almost every design choice.

```mermaid
flowchart LR
    subgraph fc["FAIL-CLOSED — config & credentials"]
        direction TB
        a1["invalid YAML / missing required key"]
        a2["unknown store driver"]
        a3["OAuth preset without HELM_OAUTH_ENC_KEY"]
        a1 & a2 & a3 --> aX["refuse to start<br/>(never run half-configured)"]
    end
    subgraph fo["FAIL-OPEN — the request path"]
        direction TB
        b1["classification error"]
        b2["eval timeout"]
        b3["memory error"]
        b4["circuit-breaker fault"]
        b1 & b2 & b3 & b4 --> bX["degrade quietly to balanced / pass through · log it<br/>(client sees 5xx only when EVERY provider is down)"]
    end
    style aX fill:#fee,stroke:#c33
    style bX fill:#fff3cd,stroke:#d39e00
```

And two *fallbacks* that are deliberately never conflated, with separate
`DecisionRecord` fields so you can always tell which one fired:

- **Classification fallback** — undecided/eval-off → the `balanced` lane
  (`decided_by = fallback`).
- **Execution fallback** — a provider failed → the next model in the chain
  (`fallback_count`, counting only non-skipped attempts).

---

## 6. Classification cascade

Three layers; see [03 Classification](03-classification.md) for the rule engine.
Layer 1 is a pure function (zero network, unit-tested, always on). Layer 2 is an
optional small-model evaluation — `temperature: 0`, cached, **off by default**.
`balanced` is the fail-open sink.

```mermaid
flowchart TD
    A["IR (last user message, tools, turn count, attachments)"] --> B["Layer 1 — deterministic rules<br/>dimensions · momentum · tiers · overrides · task detect"]
    B --> C{"rules confidence<br/>≥ threshold (0.42)?"}
    C -- "yes" --> RULES["decided_by = rules"]
    C -- "no" --> D{"eval.enabled?"}
    D -- "no (shipped default)" --> FB["decided_by = fallback<br/>reason = eval_disabled"]
    D -- "yes" --> E["Layer 2 — small-model eval<br/>temp 0 · cache (sha256 of 5 canonical fields) · double timeout"]
    E --> F{"eval returned<br/>valid JSON verdict?"}
    F -- "yes" --> EVAL["decided_by = eval"]
    F -- "no (timeout / error / bad JSON)" --> FB
    RULES --> RL["resolveLane"]
    EVAL --> RL
    FB --> BAL["lane = balanced"]

    style FB fill:#fff3cd,stroke:#d39e00
    style BAL fill:#fff3cd,stroke:#d39e00
```

A high-confidence Layer-1 verdict **stops the cascade** — eval is never called,
even when enabled. The eval cache is per-process and only stores *decided*
results, so a transient upstream failure can't be amplified into a 300s outage.

---

## 7. Routing & lane resolution

How a request becomes an ordered chain of concrete model aliases. See
[04 Routing & Lanes](04-routing-and-lanes.md). The shipped config has **22 lanes**:
3 quality lanes (`economy`/`balanced`/`premium`), 4 task lanes
(`coding`/`json`/`vision`/`tool_use`), 13 vendor-family lanes that are the
rewrite targets of the model-alias compatibility shim, and 2 image-generation
lanes (`gpt-image`, `gemini-image`).

```mermaid
flowchart TD
    A["IR.requested_model"] --> I{"exact image-output model?"}
    I -- "yes" --> IMG["pin exact image model"]
    I -- "no" --> D{"explicit resolution eligible?<br/>allow_custom_model · model ≠ auto · not over-budget"}
    D -- "no" --> CL["classify (Layer 1/2)"]
    D -- "yes" --> E{"exact configured lane<br/>or deployment-known model?"}
    E -- "yes" --> P["use exact lane / model<br/>(HARD reject if outside key caps)"]
    E -- "no" --> B{"compatibility map hit?<br/>exact key, then most-specific glob"}
    B -- "lane" --> C["rewrite to lane · cap-bounded (silent clamp)"]
    B -- "auto" --> CL
    B -- "no" --> U["strict unknown-model reject<br/>(legacy headless: unchecked model)"]
    IMG --> CH
    C --> EXP["expandLaneChain"]
    P --> EXP
    CL --> POL["policy engine:<br/>first-match PIN (use_lane)<br/>+ caps accumulate across ALL matches"]
    POL --> RES["resolveLane:<br/>default/fallback → balanced<br/>else use_lane → task lane → complexity lane → balanced"]
    RES --> CAP["applyCaps: policy caps → key caps<br/>(degrade_lane forces the base when over budget)"]
    CAP --> SIG{"signal feedback on<br/>& lane degraded?"}
    SIG -- "yes" --> PROMO["promote to stronger healthy lane<br/>(only upgrades · cap-bounded)"]
    SIG -- "no" --> EXP
    PROMO --> EXP
    EXP --> CH["candidate_chain = leaf model aliases<br/>(lanes flattened recursively · dedup · cycle-safe)"]
    CH --> EX["→ Executor"]
```

Key subtleties the diagram encodes: exact configured lane/model names are checked
before compatibility mappings, and both forms require `allow_custom_model`;
mapped lanes remain clamped by policy/key `allowed_lanes`. Only the lane *pin* is first-match while
*caps* accumulate across every matching policy; and Agentic Signals can only ever
**upgrade** a degraded lane, never demote.

---

## 8. Execution — fallback chain + circuit breaker

The executor walks the candidate chain, gating each model through the breaker
and the capability filter. Provider-execution semantics are ported from the
battle-tested `llm-router` (re-implemented, not imported).

```mermaid
sequenceDiagram
    autonumber
    participant Ex as Execute adapter
    participant Br as Circuit Breaker
    participant Cap as Capability Filter
    participant Up as Provider

    loop for each candidate in chain
        Ex->>Br: canAttempt(model)
        alt OPEN
            Br-->>Ex: SKIP (circuit_open)
            Note over Ex: record skipped attempt, continue
        else CLOSED / HALF_OPEN probe
            Br-->>Ex: ALLOW / PROBE
            Ex->>Cap: checkCapability(model, req)
            alt gate fails (tools / json / vision / context …)
                Cap-->>Ex: skip + typed reason
                Note over Ex: continue to next candidate
            else ok
                Ex->>Up: invoke (connection-retry pre-first-byte · per-chunk idle watchdog)
                alt first valid chunk
                    Up-->>Ex: success → Br.recordSuccess → return
                else ":free" tier 429
                    Up-->>Ex: SKIP (free_429) — no breaker failure
                else client abort
                    Up-->>Ex: stop chain — Br.recordAbort (release probe only), NOT a provider fault
                else pre-first-chunk error
                    Up-->>Ex: Br.recordFailure → next candidate
                end
            end
        end
    end
    Note over Ex: chain exhausted → all_providers_failed (502)<br/>empty chain → lane_unavailable (503)
```

The breaker is per-process and in-memory; its state machine:

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN : consecutive failures ≥ threshold (default 5)
    OPEN --> HALF_OPEN : cooldown elapsed (default 30s)<br/>first caller takes the single probe lock
    HALF_OPEN --> CLOSED : probe success (first valid chunk)
    HALF_OPEN --> OPEN : probe failure
    note right of HALF_OPEN
        Only ONE probe in flight; all other
        callers SKIP. An abort releases the
        probe lock without changing state.
    end note
```

Two principles encoded here: **success is recorded at the first valid chunk**
(so a request that streams then dies mid-way still healed the breaker), and a
**client disconnect is never a provider fault** — it returns 499, terminates the
chain, and does not trip the breaker.

---

## 9. Protocol translation & the IR hub

Every protocol meets in the middle. There is no direct A→B path: each side maps
to/from one internal representation, so any client reaches any backend with a
consistent output shape — streaming included. See
[05 Protocol Translation](05-protocol-translation.md).

```mermaid
flowchart LR
    subgraph clientside["Client wire (in)"]
        I1["OpenAI Chat"]
        I2["Anthropic Messages"]
        I3["OpenAI Responses"]
        I4["Google Gemini"]
    end
    IR{{"IR — InternalRequest / IRResponse<br/>OpenAI-shaped skeleton · provider_raw passthrough bag<br/>· reasoning carried in two parallel shapes"}}
    subgraph provside["Provider wire (out)"]
        O1["OpenAI-compatible"]
        O2["Anthropic native"]
        O3["Gemini native"]
    end

    I1 & I2 & I3 & I4 -->|transformRequestOut| IR
    IR -->|"transformRequestIn (+ guards: cap n>1, data_loss warnings)"| O1 & O2 & O3
    O1 & O2 & O3 -->|transformResponseIn| IR
    IR -->|transformResponseOut| I1 & I2 & I3 & I4
```

Streaming is **never** raw passthrough: each direction has an explicit per-protocol
SSE state machine, with `safeEnqueue`/`safeClose` guards and usage buffered until
the terminal event. A cache hit or a non-streaming upstream is exploded into a
deterministic SSE byte stream (`synthesizeSSE`) the client can't distinguish from
a live one. Unknown upstream fields ride along losslessly in `provider_raw` and
are stripped from the client-facing body.

---

## 10. Memory middleware

On by default; opt out per key or per request (`x-memory-mode: off`). Two halves:
a synchronous **inject** on the request path, and an asynchronous **background
worker** that compresses and consolidates. See [08 Memory Middleware](08-memory-middleware.md)
and [12 Forgetting & Tiering](12-memory-forgetting-and-tiering.md).

**Request path — inject (fail-open throughout):**

```mermaid
sequenceDiagram
    autonumber
    participant GW as Gateway
    participant Ob as observeInbound
    participant As as assembleInjectedContext
    participant Br as inject-bridge
    GW->>Ob: persist user/assistant/tool turns (if mode ≠ off, thread present)
    GW->>As: load project + resource reflections + thread observations
    Note over As: window-aware dedup — drop observations whose<br/>covered turns are all still in the live window
    As->>As: budget-trim (oldest-first, or lowest-score-first if forgetting on)
    As-->>Br: memory block (or null)
    Br->>GW: append ONE trailing user turn (a system-reminder block)
    Note over Br: leading system prompt untouched, prompt cache prefix preserved
```

**Background worker — formation, consolidation, forgetting:**

```mermaid
flowchart TD
    T["worker tick (unref'd interval)"] --> K["claimPendingJobs(batch)"]
    T --> H["onTick: enqueue idle-observer + decay jobs"]
    K --> J{"job type"}
    J -- "observer" --> O["compress uncovered message segments → observation<br/>(auto-adaptive compaction · AUTO_PRIORS from catalog)"]
    J -- "reflector" --> R["merge observations → reflection (cross-thread)<br/>· optional extractFacts"]
    J -- "decay" --> D["score active observations · archive sub-threshold<br/>(gated on forgetting.enabled)"]
    O -->|"wrote new obs & has project/resource scope"| R
    D --> RB["re-enqueue affected reflections"]

    subgraph llm["summarize / merge / extractFacts"]
        S1["deterministic stubs (DEFAULT + fail-open fallback)"]
        S2["optional LLM path — config.memory.llm.enabled (default off)"]
    end
    O -.uses.-> llm
    R -.uses.-> llm
```

The summarize/merge/fact-extraction steps are injected interfaces. The default
is a deterministic concatenate/truncate; an **opt-in** LLM path
(`config.memory.llm`, default off) calls a small model and falls back to the
deterministic output on any failure. Idle-flush (baseline memory formation) runs
for everyone; only decay and retention are gated behind `forgetting.enabled`.

---

## 11. OAuth subscription pool

A provider can authenticate with an OAuth **subscription** instead of a static
key. Helm pools several accounts per provider, refreshes tokens non-interactively,
and hot-reloads every change. See [06 Auth](06-auth-and-rate-limits.md).

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant AD as Admin API
    participant TS as OAuthTokenStore (encrypted)
    participant Pool as Account Pool
    participant TM as TokenManager
    participant Up as Upstream

    Op->>AD: Connect (manual-paste code · or device-code poll)
    AD->>TS: store rotating refresh token (encrypted at rest)
    Note over Op,AD: per account: model allow-list · egress proxy · schedule — all hot-reloaded

    rect rgb(238,245,255)
    Note over Pool,Up: per request
    Pool->>Pool: select account — strategy + sticky + quota/cooldown gates
    Pool->>TM: ensure fresh access token
    TM->>TS: load token, refresh if expired (serialized across instances)
    TS-->>TM: access token
    TM-->>Pool: Bearer
    Pool->>Up: request via the account's proxy + stable device identity
    end
```

Account selection honors the provider's global strategy (`balanced`,
`manual_priority`, `low_risk`, or `use_expiring`), sticky session keys,
per-account priority, live quota windows, usage-limit cooldowns, and manual
parking. A removed model stops routing immediately (the allow-list is live, not
a display filter). An *unconnected* subscription alias referenced by a lane
**fails open** — Helm skips to the next fallback rather than erroring.

> ⚠️ Routing a Claude/ChatGPT/Copilot subscription through a third-party gateway
> may violate the provider's ToS. Opt-in, self-hosted, your responsibility.

---

## 12. Observability & storage

Every request yields a redacted `DecisionRecord`; optionally, the verbatim
request/response payloads are captured to a **separate** table for debugging and
the editable Retry button. Storage hides behind Store ports so SQLite and
Postgres are interchangeable. See [07 Observability](07-observability.md).

```mermaid
flowchart LR
    REQ["served request"] --> BD["buildDecisionRecord<br/>classifier · policy · lane · every attempt · cost · latency"]
    BD --> RD["redact() — keys matching api_key/authorization/secret/token<br/>fingerprinted; numbers pass through"]
    RD --> WQ["writeQueue (batched, 25ms flush)"]
    REQ -->|"if capture_payloads (runtime setting, default on)"| PL["request_payloads — VERBATIM, not redacted"]
    PL --> WQ
    WQ --> PORTS{{"Store ports:<br/>KeyStore · TelemetryStore · ConfigStore<br/>MemoryStore · OAuth*Store · …"}}
    PORTS --> SQ["sqlite adapter (Drizzle)"]
    PORTS --> PG["postgres adapter (Drizzle)"]
    PL -.->|"payload_retention_days (default 30)"| PRUNE["opportunistic prune"]

    ADM["Admin / requests UI"] -->|paginated query| TELE["TelemetryStore"]
```

The redacted `DecisionRecord` (no request body) is defense-in-depth: API keys
are stored only as SHA-256 hashes, and the bearer never appears in telemetry or
logs. The verbatim payload table is the one place full bodies live — guarded by
a runtime toggle and an automatic retention sweep.

---

## Where to go next

- Prose architecture & the internal request/decision shapes → [02 Architecture](02-architecture.md)
- The rule engine and eval cache → [03 Classification](03-classification.md)
- Lane/policy semantics and the model-alias shim → [04 Routing & Lanes](04-routing-and-lanes.md)
- SSE event mapping and the IR contract → [05 Protocol Translation](05-protocol-translation.md)
- Keys, caps, OAuth pooling → [06 Auth & Rate Limits](06-auth-and-rate-limits.md)
- The memory subsystem → [08](08-memory-middleware.md) · [12](12-memory-forgetting-and-tiering.md)
- Deploying it → [10 Deployment](10-deployment.md)
