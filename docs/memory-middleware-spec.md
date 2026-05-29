# Helm API Memory Middleware Specification

## Positioning

Memory is not part of the MVP routing core. Memory is an optional middleware that gives requests enough context before classification and execution.

```text
Memory helps the request be understood.
Router decides the lane.
Provider executes.
Logs explain what happened.
```

## Source issue

This spec is based on llm-router issue #362: Memory Gateway / Observational Memory.

Issue: https://github.com/EasyMetaAu/llm-router/issues/362

## Core idea

Use a gateway-level memory layer inspired by Mastra Observational Memory:

- Client passes stable IDs such as `x-thread-id`, `x-resource-id`, and `x-project-id`.
- Gateway stores raw messages and tool results.
- Background Observer compresses old raw history into dated observations.
- Background Reflector merges observations into stable reflections.
- Provider context is assembled from reflection, observations, recent raw messages, and the current message.

This is not dynamic RAG in the MVP direction. The target is a stable, cache-friendly context prefix.

## Request headers

```http
x-thread-id: current conversation or task thread
x-resource-id: current document, asset, issue, or workspace object
x-project-id: project-level memory scope
x-memory-mode: off | observe | inject
```

Default:

```text
x-memory-mode = off
```

Modes:

- `off`: no memory read/write; current routing behavior.
- `observe`: record messages and tool outputs, but do not inject memory.
- `inject`: load memory context, assemble prompt, and enqueue writeback.

## Pipeline

```text
Request comes in
  -> save raw message if observe/inject
  -> if inject:
       load reflection + active observations
       assemble stable context
  -> classifier uses current message + short memory context
  -> route + provider execute
  -> save response/tool result
  -> enqueue observer job
  -> observer compresses raw history into observations
  -> reflector periodically merges observations into reflection
```

## Context assembly order

```text
system prompt
+ project reflection
+ resource reflection
+ thread observations
+ recent raw messages
+ current user message
```

Rules:

- Reflection should be stable and slow-changing.
- Recent raw messages must remain available to avoid compression loss.
- Observation text should include time anchors.
- Memory injection should stay within a token budget.
- If memory loading fails, the main request should continue without memory and log the failure.

## Storage model

Minimum tables:

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

`source_message_range` is mandatory so compressed memories can be audited against original messages.

## Router integration

Classifier may use:

- Current message.
- Recent raw turns.
- Short memory summary.
- Tool/request metadata.

Router output remains:

```text
task_type
complexity
constraints
lane
```

Memory must not directly rewrite lane rules. For example, user entitlement routing belongs in Policy Engine, not Memory.

## Debug UI fields

Add request-level memory metadata:

```text
memory_mode
thread_id
resource_id
project_id
memory_hydrated
reflection_version
observation_count
memory_tokens_injected
observer_job_id
memory_writeback_status
```

Request detail may show memory metadata by default. Full memory content should require explicit permission and should be audited.

## Cost accounting

Separate token/cost buckets:

- Actor request tokens.
- Actor response tokens.
- Memory hydrate tokens.
- Observer tokens.
- Reflector tokens.

Memory maintenance must be visible in cost reports and should not be hidden inside provider execution cost.

## Phase plan

### Phase 1: Memory-ready

- Accept memory headers.
- Persist raw messages in observe mode.
- Show memory metadata in request logs.
- Do not inject memory yet.

### Phase 2: Observational Memory MVP

- Implement Observer: raw messages -> observations.
- Implement Reflector: observations -> reflection.
- Implement context assembly for inject mode.
- Run on explicit `x-memory-mode=inject` only.

### Phase 3: Project memory

- Project/resource/thread scope hierarchy.
- Structured facts and asset graph.
- Creative/project workspace support.

## Non-goals

- No full RAG product in the router core.
- No per-turn dynamic retrieval by default.
- No cross-project memory sharing.
- No global user profile in the first version.
- No synchronous Observer in the main request path.
- No agent orchestration in Memory Middleware.
