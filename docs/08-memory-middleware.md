# 08 · Memory Middleware

> Status: **implemented; on by default.** `observe` and `inject` are both wired
> end-to-end across the OpenAI Chat, Anthropic Messages, OpenAI Responses, and
> Gemini generateContent surfaces, together with a process-wide background
> `MemoryWorker` that drains the `memory_jobs` queue (observer / reflector /
> decay jobs). The four memory headers are parsed at the gateway boundary
> (`apps/gateway/src/routes/memory-scope.ts`); mode normalization and
> owner-scoping live in core (`packages/core/src/memory/observe.ts`).
>
> **LLM-backed summarize / merge / fact-extraction has also shipped** and is
> wired into the Observer and Reflector (`createMemoryLlmRuntime` in
> `apps/gateway/src/memory-llm.ts`), gated behind `config.memory.llm.enabled`
> (Zod schema default `false`). When enabled, the background jobs call a real
> model via `client.chatCompletion` with `response_format: json_object` and
> parse strict JSON. The **deterministic concatenate / truncate path is the
> default** — and the fail-open fallback whenever the LLM is disabled, the model
> is unavailable, or a call / parse / timeout fails. See "`config.memory.llm`"
> below.
>
> The forgetting & tiering layer ([12 · Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md))
> has also shipped, gated behind `config.memory.forgetting.enabled`. Although the
> Zod schema default is `false`, the shipped `config/memory.yaml` sets
> `forgetting.enabled: true`, so the default deployment runs with forgetting **ON**
> (decay sweeps, reinforcement, fact extraction). Set it to `false` for the legacy
> byte-identical-to-before behavior.

## Positioning

Memory is not part of the routing core. It is an optional middleware that gives a
request enough context to be understood before classification and execution. It
never rewrites lane rules — an entitlement-based route belongs to the Policy
Engine, not to memory.

```text
Memory helps the request be understood.
Router decides the lane.
Provider executes.
Logs explain what happened.
```

The design follows llm-router issue #362 (Memory Gateway / Observational Memory)
and is inspired by Mastra's Observational Memory:
<https://github.com/EasyMetaAu/llm-router/issues/362>. The client passes stable
IDs (`x-thread-id`, `x-resource-id`, `x-project-id`); the gateway stores raw
messages and tool results; a background Observer compresses old raw history into
dated observations; a background Reflector merges observations into stable
reflections; on `inject`, the provider context is assembled from reflections,
observations, recent raw messages, and the current message. This is deliberately
not dynamic RAG — the goal is a stable, cache-friendly context prefix.

## Request headers

```http
x-thread-id:   the current conversation or task thread
x-resource-id: the current document, asset, issue, or workspace object
x-project-id:  the project-level memory scope
x-memory-mode: off | observe | inject
```

Default mode: an absent `x-memory-mode` resolves to the API key's stored default;
keys created through the app default to `inject` (memory on), and the
no-key-config path also falls back to `inject`. Only a present-but-illegal or
wrong-case header value normalizes to `off` (centralized in core's
`resolveMemoryMode` — a typo must never silently inherit a more permissive mode).
An empty `x-thread-id` yields `null` (never a fabricated thread id), and
`observe` self-gates to a no-op when there is no thread scope.

Modes:

- `off` — no memory read/write; routing behavior is unchanged. Zero DB touch.
- `observe` — record request messages, response messages, and tool outputs;
  enqueue an observer write-back job. Does not inject memory or change routing.
- `inject` — synchronously load + assemble memory into **one text block** and
  **append** it as a trailing **`<system-reminder>`** turn AFTER the request's
  conversation, BEFORE classification/execution (additive — the client's live
  conversation AND its cached prompt prefix are kept verbatim), then also write
  back (same persistence + enqueue as `observe`). This is a **TRAILING-REMINDER**
  model, not a full-replace and not a system-prefix edit: see "Inject is additive
  (trailing-reminder model)" below.

## End-to-end flow

```text
Request comes in
  -> observeInbound: persist raw request messages        (observe | inject)
  -> if inject: assembleInjectedContext + injectIntoIR
       load reflections + active observations (+ thread raw rows for dedup)
       assemble ONE memory text block within the token budget
       APPEND it as a trailing <system-reminder> turn; the conversation (and the
         client's cached system prefix) is kept verbatim
  -> classifier uses the (memory-augmented) message context
  -> route + provider execute
  -> observeOutbound: persist response + tool results     (observe | inject)
  -> enqueue observer write-back job
  ── background MemoryWorker (off the request path) ──
  -> runObserverJob:  raw history -> dated observation
  -> runReflectorJob: observations -> stable reflection
  -> runDecayJob:     forgetting sweep (only when forgetting.enabled)
```

Persistence is **fail-open** (Principle 3): a memory store failure degrades to
"continue without memory" plus a logged failure — never a 5xx. On `inject`, any
load/assembly failure falls back to the minimal context (system + current
message), marks the decision `degraded: true`, and still attempts the write-back
enqueue.

### Inject is additive (trailing-reminder model)

`inject` does **not** rewrite or replace the request, and does **not** edit the
system prefix. It assembles memory into **one text block** and **appends** it as a
trailing `<system-reminder>` turn AFTER the conversation; the client's live
conversation — `messages` / `input`, including `tool_calls`, tool results, and
multimodal (image) content — **and** the system-level field (`system` /
`instructions`) are kept **verbatim**. This is the #217 Phase 4 trailing-reminder
model. (It superseded the original full-replace compaction and the short-lived
system-prefix cut — see the cache rationale below.)

The memory block is a single deterministic text section, wrapped in a
`<system-reminder>` envelope so the model reads it as injected operator context
rather than as the user speaking (the same framing Claude Code uses internally —
no model-gated beta required):

```text
<system-reminder>
# Persistent memory (injected by helm)
## Project knowledge      <- project reflection (if any)
## Resource knowledge     <- resource reflection (if any)
## Earlier context (summarized)
<thread observations, time-anchored, window-deduped>
</system-reminder>
```

Only sections with content are emitted (a project-only memory yields just the
header + Project knowledge). The wrapped block is appended **after the cached
prefix** as the last turn:

- **Translate path** (`injectIntoIR`, core): the block is appended as one trailing
  `{ role: "user" }` IR message. The leading system message (and any client
  `cache_control` on it) and every other IR message are kept by reference, in
  order. The input array is never mutated.
- **Native passthrough path** (`native-memory-inject.ts`, gateway): the same
  block is appended as a trailing turn on the protocol-native conversation field —
  Anthropic `messages` (one trailing `{ role:"user" }` turn) and Responses `input`
  (array → trailing `{ role:"user" }` item; string → trailing text). `system` /
  `instructions` (and every existing turn) are forwarded byte-faithfully — the
  cached prefix is never touched. `wrapMemoryReminder` (core) is the single
  `<system-reminder>` envelope both paths share. See "Native passthrough" below.

Rules:

- **Works for every turn type.** Because inject is additive and never touches the
  live turns, there is **no plain-text gate** — tool-using, multipart/image,
  `developer`, and `tool` turns inject exactly like plain text turns. (The legacy
  D7 `isPlainTextTurn` skip that existed only to protect full-replace from
  destroying structure is **removed**.)
- **Window-aware dedup.** The current request's `messages` are the client's live
  window. Project/resource reflections are **always** injected (cross-thread
  recall the client never re-sends). A thread **observation is injected only when
  at least one of its covered turns is missing from the live window** — i.e. the
  client has dropped (compacted) it and helm recalls the summary. An observation
  whose covered turns are **all** still in the window is **skipped** (the client
  re-sends them verbatim — injecting the summary too would duplicate). The window
  fingerprint is `sha256Hex(serializeContent(content))`, byte-identical to how
  storage hashes `memory_messages.content`, so a live turn matches its persisted
  hash. An observation whose source range cannot be resolved against the loaded
  raw rows is **kept** (never silently drop recall on a missing audit row). With
  no window (e.g. a caller that supplies none) nothing is deduped.
- Reflections are stable and slow-changing (the Reflector only bumps the version
  when the merged text actually changes).
- Observation text carries a time anchor.
- The block stays within a token budget — `HELM_MEMORY_INJECT_TOKEN_BUDGET`
  (default `4000`), counting injected memory only (the host system prompt and the
  live conversation are excluded). Under budget pressure reflections are kept and
  observations are trimmed first (oldest-first, or lowest-forgetting-score first
  when `forgetting.enabled` with `dropOrder: "score"`).
- **Compaction (Observer side) is not configurable** — there is no
  `memory.observer` block (a leftover one fails startup). The Observer's
  auto-adaptive write-back policy (size / idle / context-pressure triggers,
  catalog-resolved economics) is unchanged; it governs how raw history becomes
  observations in the background. Inject only *reads* those observations — it no
  longer compacts the live request.

### Tradeoff: live-conversation compaction is dropped

The trailing-reminder model intentionally gives up the old behavior of shrinking
the client's live message array in place. **Helm no longer compacts the request
the client sends** — the client owns its own context window; helm contributes
**long-term recall** (cross-thread reflections + summaries of turns the client
has dropped) as an additive trailing turn. This is what makes inject safe for
tool/multimodal/native-passthrough turns (no structure can be lost) at the cost
of helm no longer trimming an over-long live window for the client.

**Prompt cache is preserved.** Anthropic/Responses prompt caching is a strict
prefix match (`tools → system → messages`); any byte change in the prefix
invalidates everything after it. Appending memory as the **last** turn — after the
client's cached prefix — leaves `tools` / `system` (and their `cache_control`
breakpoints) and the entire conversation history byte-identical, so the upstream
cache still hits; only the small trailing reminder turn is uncached. This is why
the placement is trailing rather than a system prefix: the memory block is itself
**window-variable** (the window-dedup set changes as the client's window slides),
so it could never settle inside a cached prefix — prepending it would bust the
cache every memory-mode turn. Sessions on `x-memory-mode: off` remain
byte-identical to no-memory and keep full caching.

### Native passthrough

When native protocol passthrough (issue #217) forwards the client's verbatim
native body upstream (Anthropic ↔ Anthropic, Responses ↔ Responses), inject is
**no longer a blocker**. Because the memory block is appended as a trailing turn
and the cached prefix is forwarded byte-faithfully, the native request stays
self-consistent: `appendMemoryToAnthropicBody` / `appendMemoryToResponsesBody`
append the `<system-reminder>` turn to `messages` / `input`, and `system` /
`instructions` (plus every existing turn) pass through unchanged — so passthrough
keeps the upstream prompt cache. `canUseNativePassthrough` therefore dropped its
`memory_mode === "inject"` disable — passthrough fires **with** memory. (Before
the trailing-reminder model, full-replace rewrote the message array, so
passthrough had to be disabled whenever inject ran.)

## Background worker

The `MemoryWorker` is started process-wide by default. It claims pending
`memory_jobs` in batches and dispatches each to `runObserverJob`,
`runReflectorJob`, or `runDecayJob` by `type`.

```text
HELM_MEMORY_WORKER_DISABLED      set to "1" to disable the worker entirely
HELM_MEMORY_WORKER_INTERVAL_MS   tick interval (default 60000)
HELM_MEMORY_WORKER_BATCH_SIZE    jobs claimed per batch (default 50)
HELM_MEMORY_WORKER_CONCURRENCY   simultaneous jobs per claimed batch (default 3, capped at 8)
HELM_MEMORY_WORKER_MAX_BATCHES_PER_DRAIN
                                  consecutive batches per drain (default 10)
HELM_MEMORY_WORKER_MAX_DRAIN_MS  wall-clock guard between batches (default 30000)
HELM_MEMORY_WORKER_COALESCE_MS   request-driven wake debounce (default 8000)
```

`decay` jobs are only ever enqueued when `forgetting.enabled`, so a build with
forgetting off simply never produces them.

## Zero-client-change adoption

Many agent clients can only send **static** headers (Claude Code via
`ANTHROPIC_CUSTOM_HEADERS`, Codex via `model_providers.*.http_headers`) — and a
dynamic per-conversation `x-thread-id` is impossible for them. Two server-side
mechanisms close that gap; both are **inert unless explicitly configured on the
API key** (an unconfigured key behaves exactly as before).

### 1. Per-key memory defaults

Stored on the API key (admin UI → key dialog → "Memory defaults"):

```text
memory_mode:          off | observe | inject     (default inject — new keys)
memory_project_id:    <string> | null            (default null)
memory_thread_source: header | auto              (default auto — new keys)
```

Explicit `x-memory-*` request headers always override the key defaults —
including `x-memory-mode: off` disabling memory for a default-inject key, and an
ILLEGAL header value normalizing to `off` (never falling back to the key's
inject).

### 2. Thread-signal fallback chain (`memory_thread_source: auto`)

When the key opts in and no `x-thread-id` header is present, the thread anchor
is derived from signals the client ALREADY sends, in fixed priority order:

```text
x-thread-id (explicit header — always wins)
  → body metadata.thread_id / conversation_id
  → x-session-key header (helm's session-momentum key)
  → prompt_cache_key       (OpenAI Chat + Responses body — OpenClaw, Codex)
  → metadata.user_id       (Anthropic body — Claude Code, OpenClaw)
```

The derived thread is owner-scoped exactly like an explicit one (account-prefixed
storage id — cross-account identical signals never collide). The chain link that
produced the thread is recorded as `DecisionRecord.memory.thread_source`.

### Client recipes

**Codex** (`~/.codex/config.toml`) — thread derives from `prompt_cache_key`:

```toml
[model_providers.helm]
name = "Helm"
base_url = "https://helm.example.com/v1"
env_key = "HELM_API_KEY"
wire_api = "responses"
http_headers = { "x-project-id" = "my-project" }  # optional, overrides key defaults
```

**Claude Code** — thread derives from `metadata.user_id` (stable per session):

```bash
export ANTHROPIC_BASE_URL="https://helm.example.com"
export ANTHROPIC_AUTH_TOKEN="helm_live_..."
export ANTHROPIC_CUSTOM_HEADERS="x-project-id: my-project"  # optional
```

**Gemini native REST / SDKs** — Helm exposes the native Gemini surface, not the
OpenAI-compatible Gemini shim. Use the bare origin plus `/v1beta/models/...`;
auth is `x-goog-api-key` (Gemini SDK / REST default), with `Authorization: Bearer`
as a Helm fallback:

```bash
curl "https://helm.example.com/v1beta/models/auto:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: helm_live_..." \
  -d '{"contents":[{"parts":[{"text":"Hello from Helm"}]}]}'
```

Streaming uses the Gemini SSE endpoint:

```text
POST /v1beta/models/auto:streamGenerateContent?alt=sse
```

**OpenClaw** — static headers via provider `request.headers`; thread derives from
`prompt_cache_key` (OpenAI path) or `metadata.user_id` (Anthropic path). OpenClaw
also ships its own local vector memory — gateway memory is the cross-agent shared
layer; avoid running both injectors on the same context.

**Anything else** — configure the key with `memory_mode: inject` +
`memory_thread_source: auto`; if the client sends any chain signal, memory just
works. Clients that send none can pass `x-session-key` (a single static header).

Caveats:

- `prompt_cache_key` is reused as a conversation anchor — semantically aligned
  (same conversation ⇒ same key) but an implicit contract worth knowing.
- OpenClaw rotates its sessionId on compaction: the thread restarts, but
  project/resource reflections carry across (the layering absorbs it).

## Storage model

See `MemoryStore` in `packages/core/src/store/ports.ts`:

```text
memory_threads
  id, project_id, resource_id, owner_id, created_at, updated_at

memory_messages
  id, thread_id, role, content, token_estimate, created_at

memory_observations
  id, thread_id, source_message_range, observation_text, observed_at,
  referenced_at, priority, tags,
  reference_count, importance, status (active | archived | pruned), archived_at, expired_at

memory_reflections
  id, owner_id, project_id, resource_id, thread_id, reflection_text, version,
  token_estimate, updated_at,
  referenced_at, reference_count, status

memory_facts
  id, owner_id, project_id, resource_id, thread_id, subject_key,
  content_hash, fact_text, importance, reference_count, referenced_at,
  source_observation_range, valid_from, invalid_at, expired_at, status

memory_jobs
  id, type (observer | reflector | decay), scope_id, status, error,
  created_at, updated_at
```

`source_message_range` is required so compressed memory can be audited against the
original raw messages. The shared `MemoryStatusSchema` enum — `active | archived |
pruned` — backs observations, reflections, and facts alike. `pruned` is the
retention **tombstone**: the row's text is freed (e.g. `observation_text` blanked to
`[pruned]`) but the row itself **and** its `source_message_range` are kept, so the
pruned observation still marks its raw messages as covered (audit + window-dedup
stay intact). The forgetting-score columns on observations / reflections and the
`memory_facts` table back the docs/12 layer; with `forgetting.enabled` false every
row stays `status='active'` / `expired_at=null`, so those columns are inert.

## Routing integration

The classifier may use the current message, recent raw turns, a short memory
summary, and tool/request metadata. The routing output is unchanged
(`task_type` / `complexity` / `constraints` / `lane`). Memory must not directly
rewrite lane rules.

## Debug UI fields

`DecisionRecord` carries a `memory` block — counts and ids only, never memory
content:

```text
memory_hydrated            # true when any layer was injected
reflection_version
observation_count
memory_tokens_injected
observer_job_id
memory_writeback_status    # queued | skipped | failed
degraded
thread_source              # which fallback-chain link produced the thread
```

The request detail may show this metadata by default. Full memory **content**
requires explicit authorization and is audited (see [07 · Error Model &
Observability](07-observability.md)).

## Cost accounting

Memory maintenance has its own token/cost buckets so it is visible in cost
reports and not hidden inside provider execution cost: actor request tokens,
actor response tokens, memory hydrate tokens, Observer tokens, Reflector tokens.
The buckets and sinks are real: when the LLM path runs (`config.memory.llm.enabled`)
the Observer and Reflector buckets bill the measured tokens of the summarize /
merge / fact-extraction calls. Under the default deterministic-stub path those
buckets are a no-op sink — the concatenate / truncate work spends no model
tokens.

## `config.memory.llm`

LLM-backed memory formation is **opt-in**. The `llm:` block (validated by
`MemoryLlmSchema`, `.strict()` — unknown keys refuse startup) controls **only** the
background Observer / Reflector summarize / merge / fact-extraction calls; the
request-path observe / inject stays synchronous and deterministic. With
`enabled: false` (the default) the deterministic concatenate / truncate stubs run,
and they also remain the **fail-open fallback** at runtime — an unavailable model,
invalid JSON, or a timeout degrades that one job to the deterministic output (never
a 5xx).

```yaml
# config/memory.yaml
llm:
  enabled: false                          # opt-in master switch (default false)
  model: deepseek/deepseek-v4-flash       # base model for all memory LLM tasks
                                          #   (required when enabled: true)
  # Optional per-task overrides (each falls back to `model`):
  # observation_model: openai/gpt-4.1-mini   # raw messages → observation (Observer)
  # reflection_model:  openai/gpt-4.1-mini   # observations → reflection (Reflector)
  # facts_model:       openai/gpt-4.1-nano   # observations → atomic facts
  timeout_ms: 30000                       # per-call abort budget (default 30000)
  temperature: 0                          # default 0 (deterministic)
  max_tokens:                             # per-task output caps
    observation: 800
    reflection: 1200
    facts: 1000
```

Calls go through `client.chatCompletion` with `response_format: json_object` and
the result is parsed against a strict Zod schema; anything that does not parse
falls back to the deterministic path.

## Phases

### Phase 1 — Memory-ready · implemented

- Accept the memory headers and persist raw messages in `observe`.
- Surface memory metadata in the request log.

### Phase 2 — Observational Memory MVP · implemented

- Observer (`runObserverJob`): raw messages → observations.
- Reflector (`runReflectorJob`): observations → reflections.
- Inject-phase context assembly (`assembleInjectedContext` + `injectIntoIR`),
  wired into the chat / messages / responses surfaces and the background worker.
  Inject is now the **additive TRAILING-REMINDER model** (#217 Phase 4): a memory
  block appended as a trailing `<system-reminder>` turn after a verbatim live
  conversation — works for tool / multimodal / native-passthrough turns, with
  window-aware dedup, and preserves the upstream prompt cache (the cached prefix is
  never touched). See "Inject is additive (trailing-reminder model)" above.
- The summarize / merge / fact-extraction steps default to deterministic stubs,
  with an opt-in LLM-backed path behind `config.memory.llm.enabled` (see
  "`config.memory.llm`").

### Phase 3 — Project memory · implemented

- Project / resource / thread scope hierarchy.
- Structured facts (`memory_facts`) and scope aggregation.

### Phase 4 — Forgetting & tiering · implemented (on by default in the shipped config)

- Short / mid / long-term tiers mapped onto recent_raw / observations /
  reflections + facts.
- A deterministic forgetting score (Ebbinghaus recency decay × importance +
  access reinforcement) driving score-based inject trimming, an off-hot-path
  decay sweep, soft-archive, and bi-temporal supersede.
- See [12 · Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md).
  Gated behind `config.memory.forgetting.enabled` (Zod schema default `false`, but
  the shipped `config/memory.yaml` sets it `true` — on by default).

## Non-goals

- No full RAG product inside the routing core.
- No per-turn dynamic retrieval by default.
- No cross-project memory sharing.
- No global user profile.
- No synchronous Observer on the main request path.
- No agent orchestration inside the memory middleware.
