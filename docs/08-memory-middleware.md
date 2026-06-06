# 08 · Memory Middleware

> Status: **implemented, opt-in.** `observe` and `inject` are both wired
> end-to-end across the OpenAI Chat, Anthropic Messages, and OpenAI Responses
> surfaces (Gemini is not wired), together with a process-wide background
> `MemoryWorker` that drains the `memory_jobs` queue (observer / reflector /
> decay jobs). The four memory headers are parsed at the gateway boundary
> (`apps/gateway/src/routes/memory-scope.ts`); mode normalization and
> owner-scoping live in core (`packages/core/src/memory/observe.ts`).
>
> The only genuinely deferred piece is the **real LLM summarize/merge**: the
> Observer, Reflector, and fact-extraction summarizers are currently
> **deterministic non-LLM stubs** (concatenate / truncate) behind an injected
> interface. Swapping in an LLM is a drop-in replacement.
>
> The forgetting & tiering layer ([12 · Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md))
> has also shipped, gated behind `config.memory.forgetting.enabled` whose schema
> default is `false`. With forgetting off, runtime is byte-identical to before.

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

Default: `x-memory-mode = off`. Mode normalization is centralized in core's
`resolveMemoryMode`; an absent, illegal, or wrong-case value falls back safely to
`off`. An empty `x-thread-id` yields `null` (never a fabricated thread id), and
`observe` self-gates to a no-op when there is no thread scope.

Modes:

- `off` — no memory read/write; routing behavior is unchanged. Zero DB touch.
- `observe` — record request messages, response messages, and tool outputs;
  enqueue an observer write-back job. Does not inject memory or change routing.
- `inject` — synchronously load + assemble the memory context, **full-replace**
  the request message array BEFORE classification/execution, then also write back
  (same persistence + enqueue as `observe`).

## End-to-end flow

```text
Request comes in
  -> observeInbound: persist raw request messages        (observe | inject)
  -> if inject: assembleInjectedContext + injectIntoIR
       load reflections + active observations + recent raw
       full-replace the message array within the token budget
  -> classifier uses the (possibly injected) message context
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

### Context assembly order (inject phase — live)

```text
system prompt
+ project reflection
+ resource reflection
+ thread observations
+ recent raw messages (RECENT_KEEP = 2 kept uncompressed)
+ current user message
```

Rules:

- Reflections are stable and slow-changing (the Reflector only bumps the version
  when the merged text actually changes).
- The most recent `RECENT_KEEP = 2` raw turns are kept uncompressed so
  compression can never lose information; turns already covered by an
  observation's source range are not re-injected (no duplication).
- Observation text carries a time anchor.
- Injected memory stays within a token budget — `HELM_MEMORY_INJECT_TOKEN_BUDGET`
  (default `4000`), counting injected memory layers only (the system prompt and
  current message are excluded).
- The plain-text inject path applies only to plain message turns. Tool-call,
  multipart, `developer`, and `tool` turns keep their original messages (no
  full-replace) but still enqueue the observer write-back.

## Background worker

The `MemoryWorker` is started process-wide by default. It claims pending
`memory_jobs` in batches and dispatches each to `runObserverJob`,
`runReflectorJob`, or `runDecayJob` by `type`.

```text
HELM_MEMORY_WORKER_DISABLED      set to "1" to disable the worker entirely
HELM_MEMORY_WORKER_INTERVAL_MS   tick interval (default 60000)
batchSize                        jobs claimed per tick (10)
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
memory_thread_source: header | auto              (default header)
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
  reference_count, importance, status (active | archived), archived_at, expired_at

memory_reflections
  id, project_id, resource_id, thread_id, reflection_text, version,
  token_estimate, updated_at,
  referenced_at, reference_count, status

memory_facts
  id, owner_id, subject_key, content_hash, content,
  valid_from, invalid_at, expired_at, status

memory_jobs
  id, type (observer | reflector | decay), scope_id, status, error,
  created_at, updated_at
```

`source_message_range` is required so compressed memory can be audited against the
original raw messages. The forgetting-score columns on observations / reflections
and the `memory_facts` table back the docs/12 layer; with `forgetting.enabled`
false every row stays `status='active'` / `expired_at=null`, so those columns are
inert.

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
The buckets and sinks exist today; the Observer bucket is currently a no-op sink
(deterministic stub), and full memory-maintenance cost reporting is deferred
until the LLM summarizer lands.

## Phases

### Phase 1 — Memory-ready · implemented

- Accept the memory headers and persist raw messages in `observe`.
- Surface memory metadata in the request log.

### Phase 2 — Observational Memory MVP · implemented

- Observer (`runObserverJob`): raw messages → observations.
- Reflector (`runReflectorJob`): observations → reflections.
- Inject-phase context assembly (`assembleInjectedContext` + `injectIntoIR`),
  wired into the chat / messages / responses surfaces and the background worker.
- The summarize/merge steps are deterministic stubs pending an LLM.

### Phase 3 — Project memory · implemented

- Project / resource / thread scope hierarchy.
- Structured facts (`memory_facts`) and scope aggregation.

### Phase 4 — Forgetting & tiering · implemented (opt-in)

- Short / mid / long-term tiers mapped onto recent_raw / observations /
  reflections + facts.
- A deterministic forgetting score (Ebbinghaus recency decay × importance +
  access reinforcement) driving score-based inject trimming, an off-hot-path
  decay sweep, soft-archive, and bi-temporal supersede.
- See [12 · Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md).
  Gated behind `config.memory.forgetting.enabled` (schema default `false`).

## Non-goals

- No full RAG product inside the routing core.
- No per-turn dynamic retrieval by default.
- No cross-project memory sharing.
- No global user profile.
- No synchronous Observer on the main request path.
- No agent orchestration inside the memory middleware.
