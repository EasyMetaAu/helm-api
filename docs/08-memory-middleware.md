# 08 · Memory Middleware

> Status (0.5): **observe AND inject are implemented and wired end-to-end**
> (issue #36 / PR #41), including the background Observer / Reflector worker that
> drains the `memory_jobs` queue. The four memory headers are parsed at the
> gateway boundary (`apps/gateway/src/routes/memory-scope.ts`) and serve all four
> client surfaces (OpenAI Chat, Anthropic Messages, OpenAI Responses, Gemini).
> On `inject`, the gateway assembles the docs/08 context prefix and full-replaces
> the request messages BEFORE classification/execution; an observer write-back
> job is enqueued off the request path; the worker compresses raw → observations
> → reflections.
>
> Issue #97 adds **zero-client-change adoption**: per-key memory defaults stored
> on the API key plus a thread-signal fallback chain, so clients limited to
> static headers (Claude Code, Codex) — or none at all — still get memory. See
> "Zero-client-change adoption" below.
>
> Still deferred: a real LLM summarize/merge behind the deterministic interface,
> and a `config.memory` subtree (the inject token budget rides
> `HELM_MEMORY_INJECT_TOKEN_BUDGET`).

## Positioning

Memory is not part of the routing core. It is an optional middleware that gives a
request enough context to be understood before classification and execution.

```text
Memory helps the request be understood.
Router decides the lane.
Provider executes.
Logs explain what happened.
```

Memory must never rewrite lane rules. For example, an entitlement-based route
belongs to the Policy Engine, not to memory.

## Origin

The design follows llm-router issue #362 (Memory Gateway / Observational Memory)
and is inspired by Mastra's Observational Memory:
<https://github.com/EasyMetaAu/llm-router/issues/362>.

## Core idea

A gateway-level memory layer inspired by Mastra Observational Memory:

- The client passes stable IDs such as `x-thread-id`, `x-resource-id`, and
  `x-project-id`.
- The gateway stores raw messages and tool results.
- A background Observer compresses old raw history into dated observations.
- A background Reflector merges observations into stable reflections.
- The provider context is assembled from reflections, observations, recent raw
  messages, and the current message.

This is deliberately not dynamic RAG. The goal is a stable, cache-friendly context
prefix.

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
- `observe` — record messages and tool outputs, but do not inject memory.
  **Implemented and wired.**
- `inject` — load memory context, assemble the prompt, and enqueue the
  write-back. **Implemented and wired** on all four surfaces.

## Zero-client-change adoption (issue #97)

Many agent clients can only send **static** headers (Claude Code via
`ANTHROPIC_CUSTOM_HEADERS`, Codex via `model_providers.*.http_headers`) — and a
dynamic per-conversation `x-thread-id` is impossible for them. Two server-side
mechanisms close that gap; both are **inert unless explicitly configured on the
API key** (an unconfigured key behaves exactly as before):

### 1. Per-key memory defaults

Stored on the API key (admin UI → key dialog → "Memory defaults"):

```text
memory_mode:          off | observe | inject     (default off)
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
# Optional: override the key defaults per machine
http_headers = { "x-project-id" = "my-project" }
```

**Claude Code** — thread derives from `metadata.user_id` (stable per session):

```bash
export ANTHROPIC_BASE_URL="https://helm.example.com"
export ANTHROPIC_AUTH_TOKEN="helm_live_..."
# Optional: override the key defaults
export ANTHROPIC_CUSTOM_HEADERS="x-project-id: my-project"
```

**OpenClaw** — static headers via provider `request.headers`; thread derives
from `prompt_cache_key` (OpenAI path) or `metadata.user_id` (Anthropic path).
Note OpenClaw also ships its own local vector memory — gateway memory is the
cross-agent shared layer; avoid running both injectors on the same context.

**Anything else** (e.g. Hermes-agent): configure the key with
`memory_mode: inject` + `memory_thread_source: auto` and point the client at
helm — if it sends any of the chain's signals, memory just works. Clients that
send none can pass `x-session-key` (a single static-ish header) or wait for the
conversation-fingerprint fallback (deferred follow-up).

Caveats:

- `prompt_cache_key` is reused as a conversation anchor — semantically aligned
  (same conversation ⇒ same key) but an implicit contract worth knowing.
- OpenClaw rotates its sessionId on compaction: the thread restarts, but
  project/resource reflections carry across (the layering absorbs it).

## Pipeline (target design)

```text
Request comes in
  -> save raw message if observe/inject        # implemented (observeInbound)
  -> if inject:                                 # roadmap
       load reflection + active observations
       assemble stable context
  -> classifier uses current message + short memory context
  -> route + provider execute
  -> save response/tool result                  # implemented (observeOutbound)
  -> enqueue observer job                       # roadmap
  -> observer compresses raw history into observations   # roadmap
  -> reflector periodically merges observations into reflection  # roadmap
```

Persistence is **fail-open** (Principle 3): a memory store failure degrades to
"continue without memory" plus a logged failure — never a 5xx.

## Context assembly order (inject phase, roadmap)

```text
system prompt
+ project reflection
+ resource reflection
+ thread observations
+ recent raw messages
+ current user message
```

Rules:

- Reflections should be stable and slow-changing.
- Recent raw messages must be retained so compression cannot lose information.
- Observation text should carry a time anchor.
- Injected memory must stay within a token budget.
- If memory loading fails, the main request continues without memory and the
  failure is recorded.

## Storage model

Minimal table set (see `MemoryStore` in `packages/core/src/store/ports.ts`):

```text
memory_threads
  id, project_id, resource_id, owner_id, created_at, updated_at

memory_messages
  id, thread_id, role, content, token_estimate, created_at

memory_observations
  id, thread_id, source_message_range, observation_text,
  observed_at, referenced_at, priority, tags

memory_reflections
  id, project_id, resource_id, thread_id, reflection_text,
  version, token_estimate, updated_at

memory_jobs
  id, type, scope_id, status, error, created_at, updated_at
```

`source_message_range` is required so compressed memory can be audited against the
original raw messages. The `observe` path uses `ensureThread` + `appendMessage`
today; the read/compress/reflect methods back the roadmap Observer/Reflector.

## Routing integration

The classifier may use the current message, recent raw turns, a short memory
summary, and tool/request metadata. The routing output is unchanged
(`task_type` / `complexity` / `constraints` / `lane`). Memory must not directly
rewrite lane rules.

## Debug UI fields

Request-level memory metadata (`MemoryMeta`):

```text
memory_mode
thread_id
resource_id
project_id
memory_hydrated            # always false until the inject phase ships
reflection_version
observation_count
memory_tokens_injected
observer_job_id
memory_writeback_status
```

The request detail may show memory metadata by default. Full memory **content**
requires explicit authorization and is audited (see [07 · Error Model &
Observability](07-observability.md)).

## Cost accounting (roadmap)

Memory maintenance gets its own token/cost buckets so it is visible in cost
reports and not hidden inside provider execution cost: actor request tokens, actor
response tokens, memory hydrate tokens, Observer tokens, Reflector tokens.

## Phases

### Phase 1 — Memory-ready · implemented

- Accept the memory headers.
- Persist raw messages in `observe` mode.
- Surface memory metadata in the request log.
- Do not inject memory yet.

### Phase 2 — Observational Memory MVP · roadmap

- Implement the Observer: raw messages → observations.
- Implement the Reflector: observations → reflections.
- Implement inject-phase context assembly (call `assembleInjectedContext`).
- Run only when `x-memory-mode=inject` is explicitly set.

### Phase 3 — Project memory · roadmap

- Project / resource / thread scope hierarchy.
- Structured facts and an asset graph.
- Creative / project workspace support.

## Non-goals

- No full RAG product inside the routing core.
- No per-turn dynamic retrieval by default.
- No cross-project memory sharing.
- No global user profile in the first version.
- No synchronous Observer on the main request path.
- No agent orchestration inside the memory middleware.
