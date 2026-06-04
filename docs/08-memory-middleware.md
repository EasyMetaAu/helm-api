# 08 · Memory Middleware

> Status (0.1): the **observe** phase is **implemented and wired** into the
> gateway request path; the **inject** phase is **on the roadmap** (see
> [09 · Roadmap](09-roadmap.md)). This chapter describes the design and marks the
> true state of each part.
>
> What is live: the four memory headers are parsed at the gateway boundary
> (`apps/gateway/src/routes/memory-scope.ts`), the resolved scope/mode is threaded
> through, and `observeInbound` / `observeOutbound`
> (`packages/core/src/memory/observe.ts`) are called from the OpenAI Chat route
> (`chat.ts`) and from the shared protocol pipeline
> (`messages-pipeline.ts`), which backs the Anthropic, OpenAI-Responses, and
> Gemini surfaces (`messages.ts`, `responses.ts`, `gemini.ts`). In `observe`/
> `inject` mode the gateway persists raw request/response/tool messages into the
> `memory_*` tables.
>
> What is **not** wired yet: the **inject** phase. `assembleInjectedContext`
> exists, is unit-tested, and is exported from `@helm/core`, but it is **not
> called from any gateway route**. So today `inject` mode behaves like `observe`
> (it persists but does not hydrate); `memory_hydrated` is always `false` and the
> inject-phase counters stay at their null/zero defaults. The background Observer /
> Reflector jobs are also roadmap.

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
  write-back. **Roadmap.** Today `inject` is accepted and persists like `observe`,
  but the inject phase is not invoked, so nothing is hydrated.

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
