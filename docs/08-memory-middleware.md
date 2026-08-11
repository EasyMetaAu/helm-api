# 08 · Memory Middleware

> Current implementation reference, verified against the source on 2026-07-16.
>
> Memory is implemented across OpenAI Chat Completions, Anthropic Messages,
> OpenAI Responses, and Gemini `generateContent` / `streamGenerateContent`.
> It is **opt-in per API key**: newly minted user keys store
> `memory_mode='off'`, the bootstrap root key is also forced to `off`, and an
> authenticated request without `x-memory-mode` uses that stored value. The
> shipped `config/memory.yaml` enables the forgetting machinery, but that does
> not turn memory on for a key whose request mode is `off`.
>
> The code, not the older phase plan, is authoritative. The current inject model
> is an additive trailing reminder; it does not replace or compact the live
> client conversation.

## Purpose and architectural boundary

Memory is optional request middleware. It gives classification and execution
durable context, but it does not choose a lane, mutate policy, or import a web
framework into core.

```text
gateway boundary resolves identity + memory scope
  -> core memory middleware may observe or hydrate context
  -> classifier and router make the normal routing decision
  -> provider executes
  -> gateway records the response for future memory formation
```

The framework-independent implementation lives under
`packages/core/src/memory/`. Hono adapters, protocol-native body handling, model
clients, and composition-root wiring live under `apps/gateway/src/`.

Memory is fail-open on the serving path: a memory read, assembly, persistence,
or enqueue failure is logged and the model request continues without that
memory effect. Configuration remains fail-closed through the strict Zod schemas
in `packages/shared/src/config/memory-schema.ts`.

## Activation, headers, and key defaults

The request boundary accepts:

```http
x-memory-mode: off | observe | inject
x-thread-id:   client conversation/task id
x-resource-id: document, issue, asset, or workspace object id
x-project-id:  project-level scope
```

Resolution is centralized in
`apps/gateway/src/routes/memory-scope.ts`:

1. A present, non-empty `x-memory-mode` wins. An unknown or wrong-case value
   normalizes to `off`.
2. Otherwise, authenticated traffic uses the API key's stored `memory_mode`.
3. `resolveMemoryScope()` has a bare fallback of `inject` only when no key
   defaults are supplied. Normal authenticated routes always supply the stored
   key defaults, so this fallback is not the new-key production default.
4. A present `x-project-id` wins. Otherwise the key uses its effective project:
   `memory_project_id ?? key_id`. The fallback to `key_id` isolates keys by
   default; setting the same explicit `memory_project_id` on several keys opts
   them into a shared project pool inside the same account.
5. A present `x-thread-id` wins. A present but empty `x-thread-id` deliberately
   resolves to no thread and suppresses automatic thread derivation for that
   request.

New user keys are minted with:

```text
memory_mode:          off
memory_project_id:    null       # effective project becomes this key's key_id
memory_thread_source: auto
```

Legacy schema parsing defaults `memory_thread_source` to `header`, while the
SQLite and Postgres keystores mint new keys with `auto`. When `auto` is stored
and `x-thread-id` is absent, the resolver uses this fixed chain:

```text
body metadata.thread_id / conversation_id
  -> x-session-key
  -> prompt_cache_key                    # OpenAI Chat / Responses
  -> metadata.user_id                    # Anthropic
```

The chosen source is stored as `DecisionRecord.memory.thread_source`. Client
thread ids are converted to a versioned physical id that includes the account
and the **effective project** (`memory_project_id ?? key_id`). Therefore two
default-isolated keys cannot collide even when they belong to the same account
and reuse the same client thread id. Keys in the same account that explicitly
select the same project still resolve to the same physical thread and share
Memory by contract.

SQLite migration v40 and Postgres migration v39 treat all pre-migration
account-only history as **unattributable**, rather than guessing which key/project
owned it. Every historical parent moves into an internal `v2:q:p:*` quarantine;
its project/resource labels are cleared, while messages and observations follow
the parent. All facts and reflections for an affected owner—including
project/resource-only rows with no thread id—are de-scoped into a separate
`v2:q:r:*` namespace. Reflections are archived; facts are archived and stamped
invalid/expired, so none of this mixed history can be injected into a current
project. Pending/running jobs that could consume it are failed. Malformed job
scopes are rewritten to a valid synthetic quarantine scope so operational stats
cannot be poisoned by invalid JSON.

The quarantine ids are internal audit/storage values, not client thread ids.
Management responses decode trusted rows for display, but request and MCP input
always remains opaque. The migration ledger makes a second run a no-op; a missing
owner, target-id collision, foreign-key violation, or other partial failure rolls
back the whole migration and refuses startup. Historical content remains
inspectable to operators, but restoring it requires a deliberate provenance
review—it is never reassigned automatically.

## Mode contracts

| Mode | Memory reads | Request/response writes | Observer enqueue |
|---|---:|---:|---:|
| `off` | none | none | none |
| `observe` | none on the request path | raw user/assistant/tool turns | one coalesced observer job after outbound persistence |
| `inject` | reflections, optional facts, thread observations, and raw rows needed for dedup | same raw turns as `observe` | one best-effort observer write-back job when a thread exists |

`observe` remains write-only on the request path. After outbound persistence it
best-effort enqueues the same coalesced observer job used by `inject`, then wakes
the worker. The interval idle-flush scan remains a restart/failure backstop.

`inject` loads memory before persisting the current inbound turn. This prevents
same-turn self-injection. The normal lifecycle is:

```text
authenticate key and resolve memory scope/defaults
  -> inject only: load + assemble memory and enqueue observer write-back
  -> queue the original inbound user/assistant/tool messages for persistence
  -> classify, route, and execute with the augmented request
  -> queue the reconstructed assistant/tool output for persistence
  -> after outbound persistence, debounce-wake the memory worker
```

The production composition root uses the deferred FIFO write queue for raw
memory writes. Inbound is queued before outbound, and the worker wake is delayed
until outbound settles so a normal turn is persisted in order.

## Injection contract: additive trailing reminder

`assembleInjectedContext()` returns one text block. `injectIntoIR()` wraps it in
`<system-reminder>` and appends one final user-role turn. It does not mutate the
input array, system/developer instructions, tool calls, tool results, images, or
the protocol-native cached prefix.

```text
<system-reminder>
# Persistent memory (injected by helm)
## Project knowledge
<active exact-scope project reflection>

## Resource knowledge
<active exact-scope resource reflection>

## Known facts
- <active fact>                 # only when eager_facts is enabled

## Earlier context (summarized)
<active thread observations>
</system-reminder>
```

Only non-empty sections are emitted. There is no thread-reflection slot in the
automatic inject path: it reads exact project and resource reflections plus
thread observations. A thread-only reflection can exist through direct
management calls, but the automatic worker does not promote thread-only
observer jobs to a reflector and inject does not load that reflection.

### Stored raw rows are not re-injected

The live conversation remains the short-term context. Stored
`memory_messages` are loaded during inject only to map an observation's
`source_message_range` back to content hashes for window-aware deduplication.
They are not appended as a second `recent_raw` section.

An observation is skipped when every raw occurrence it covers is still present
in the client's live window. Occurrence counts matter: one live `yes` does not
cover two historical `yes` turns. If a source range cannot be resolved, the
observation is retained rather than silently losing recall.

### Selection and budget order

`HELM_MEMORY_INJECT_TOKEN_BUDGET` controls the allocation budget; invalid or
non-positive values fall back to `4000`.

Current allocation order is:

1. project reflection, if its full text fits;
2. resource reflection, if its full text fits after the project allocation;
3. known facts, when enabled;
4. observations.

Reflections are all-or-nothing; the assembler does not truncate their text.
Facts are ranked by forgetting score when forgetting is enabled, otherwise by
recency, capped by `max_facts_injected` or the internal prior `16`, then emitted
oldest-first for stable output. Observations are kept by newest-first priority
under the legacy policy or highest forgetting score when score trimming is on,
then emitted oldest-first.

The configured budget is applied to section **content** estimates. The final
`memory_tokens_injected` estimate also includes section headers, and the
upstream request additionally includes the `<system-reminder>` wrapper.
Therefore the current implementation is a close allocation bound, not a strict
wire-token ceiling. A reflection drop caused by the allocation budget emits
`memory.inject.budget_overflow`.

### Native passthrough

The same wrapped block is appended without rewriting the existing native body:

| Native protocol | Appended field |
|---|---|
| Anthropic Messages | trailing user message in `messages` |
| OpenAI Responses | trailing input item, or appended text for string `input` |
| Gemini | trailing user content in `contents` |

`system`, `instructions`, existing turns, tools, and cache-control metadata stay
unchanged. Native passthrough is therefore compatible with `inject`; memory no
longer forces translation mode.

## Memory formation

### Raw observation

`observeInbound()` / `observeOutbound()` persist only `user`, `assistant`, and
`tool` roles. System and developer messages are execution policy and are not
long-term memory inputs. Multipart content is stored as JSON text.

Raw ingestion currently deduplicates on
`(thread_id, message_index, role, content_hash)`, where `content_hash` is the
SHA-256 of the serialized content. Batch append is used by the real adapters to
avoid one synchronous SQLite commit per message. `message_index` is local to one
request transcript and is not a durable thread sequence; Observer ordering and
cursors therefore use the server-owned `(created_at, id)` tuple.

The outbound path also best-effort stamps the actually served model alias on the
thread. The Observer uses that alias to resolve catalog pricing and context
limits for auto-compaction.

### Observer

`runObserverJob()` reads the oldest rows after the durable thread frontier. One
page is bounded to 512 rows, 1 MiB of decoded input, and 64K estimated tokens. A
single larger row is replaced by a small role + SHA-256 placeholder so progress
does not stall. The observation insert and frontier compare-and-swap commit in
one transaction; a stale worker cannot create a duplicate range. Remaining rows
enqueue a successor job, so a 50K-message thread drains page by page.
It has three compaction triggers:

- uncovered segment size (internal default `2048` tokens);
- runtime context pressure (default `0.8` of the served model's context);
- idleness (default `3600` seconds), which folds a quiet uncovered segment
  without keeping a recent suffix.

Optional overrides live in `memory.compaction`. The policy derives the keep
boundary from catalog pricing, the served model, existing active observations,
and measured prior retention. Raw source rows are never deleted by compaction.
Optional raw cleanup may delete only rows at or behind the durable Observer
frontier; uncovered rows always remain.

The gateway summarizer remembers user-authored content only. With
`memory.llm.enabled=false`, it uses deterministic concatenate/truncate behavior
and the `[no user content]` coverage sentinel. With the LLM enabled, strict JSON
output is parsed; model, timeout, request, or parse failures use the deterministic
fallback.

When `forgetting.consolidate.eager_facts=true`, a no-compaction observer run also
mines uncovered user turns for facts. This raw-fact path has no deterministic
extractor: an unavailable/invalid LLM result becomes an empty fact list, is
retried once when empty, and remains fail-open. See
[Salient-Fact Memory](salient-fact-memory-spec.md).

### Reflector and facts

After an Observer writes an observation, the worker promotes a reflector job
only when project or resource scope exists. The target is project first, else
resource. The Reflector aggregates active observations across all threads in
that target scope. Each rebuild reads at most the newest 512 active/unexpired
observations and increments the version only when text changes. Forgetting
rebuilds from that bounded active set without feeding the old reflection back to
the model. Reconciled facts, the reflection write/archive action, and job
completion publish in one fenced transaction, so an in-flight stale Reflector
cannot resurrect archived text.

When forgetting is enabled and the active-observation token sum reaches
`consolidate.trigger_tokens`, the Reflector also extracts facts. Observation
fact extraction has a deterministic fallback and validates LLM citations against
the supplied observation ids before accepting them.

## Background worker and jobs

`MemoryJobTypeSchema` currently contains four types:

```text
observer | reflector | decay | embedding
```

Open `(type, scope)` jobs coalesce. Claiming is atomic; a `running` job whose
`updated_at` is at least five minutes old is reclaimable after a worker crash.
SQLite uses one update/returning claim and Postgres adds `FOR UPDATE SKIP LOCKED`.

Gateway worker controls:

```text
HELM_MEMORY_WORKER_DISABLED=1            disable the worker
HELM_MEMORY_WORKER_INTERVAL_MS=60000     interval + housekeeping cadence
HELM_MEMORY_WORKER_BATCH_SIZE=50         jobs per claim
HELM_MEMORY_WORKER_CONCURRENCY=3         concurrent lanes, capped at 8
HELM_MEMORY_WORKER_MAX_BATCHES_PER_DRAIN=10
HELM_MEMORY_WORKER_MAX_DRAIN_MS=30000
HELM_MEMORY_WORKER_COALESCE_MS=8000      trailing-edge request wake debounce
```

A request-driven wake drains jobs only. The interval tick additionally:

- evaluates decay candidates;
- runs memory retention;
- scans for idle threads with uncovered history and enqueues observer jobs.

Embedding dispatch is installed only when an embedding model resolves and both
`embedding_model` and `embedding_dimensions` are configured. See
[14 · Memory Deep Recall](14-memory-deep-recall.md).

## Configuration

`config/memory.yaml` is loaded directly as `config.memory`; there is no outer
`memory:` wrapper in that file. Every object is strict, so unknown keys refuse
startup.

Current top-level blocks:

| Block | Schema default | Shipped file |
|---|---|---|
| `compaction` | internal priors when omitted | omitted/commented examples |
| `llm.enabled` | `false` | omitted/commented example |
| `forgetting.enabled` | `false` | explicitly `true` |
| `mcp.enabled` | `false` | omitted |

Important distinction: `forgetting.enabled=true` turns on decay, retention,
reflection fact formation, score trimming, and inject reinforcement for memory
rows that exist. It does not override an API key's `memory_mode`, and it does not
enable MCP.

When `llm.enabled=true` and no base `model` is supplied, the schema transforms it
to `economy`. Per-task `observation_model`, `reflection_model`, and `facts_model`
override the base. Runtime failures are fail-open. `eager_facts=true` is a stricter
combination: schema validation requires both `llm.enabled=true` and
`forgetting.enabled=true`.

## Storage model

Both SQLite and Postgres implement the same `MemoryStore` port. Relevant current
columns are:

```text
memory_threads
  id, owner_id, project_id, resource_id, last_served_model,
  message_count, last_message_at, observation_count, last_observation_at,
  observer_frontier_at, observer_frontier_id,
  created_at, updated_at

memory_messages
  id, thread_id, message_index, role, content, content_hash,
  token_estimate, created_at

memory_observations
  id, thread_id, source_message_range, observation_text, observed_at,
  priority, tags, importance, reference_count, referenced_at,
  status (active | archived | pruned), archived_at, expired_at

memory_reflections
  id, owner_id, project_id, resource_id, thread_id, reflection_text,
  version, token_estimate, reference_count, referenced_at, status, updated_at

memory_facts
  id, owner_id, project_id, resource_id, thread_id, subject_key,
  fact_text, content_hash, importance, reference_count, referenced_at,
  valid_from, invalid_at, expired_at, status, source_observation_range,
  embedding, embedding_model, embedding_dim, created_at, updated_at

memory_jobs
  id, type, scope_id, status (pending | running | done | failed),
  error, created_at, updated_at
```

`source_message_range` remains after observation pruning for audit; the durable
thread frontier prevents covered raw rows from being observed again after raw
cleanup. `memory_facts.owner_id` is its direct tenant boundary because a
project/resource fact need not have a thread parent. Reflection `owner_id` is
nullable for legacy schema compatibility; current account-scoped reads reject
legacy null-owner rows.

The frontier migration first reconciles denormalized thread counters. Legacy
raw rows keep a null frontier and drain through the same bounded
`(created_at,id)` pages as new traffic; migration never makes uncovered content
cleanup-eligible. Existing derived observations remain, so the bounded backfill
may temporarily overlap an older summary whose original request-local ordering
cannot be reconstructed exactly. This deliberately prefers over-retention to
silent loss.

## Observability and accounting

When inject runs and reaches the assembler, `DecisionRecord.memory` stores:

```text
memory_hydrated
reflection_version
observation_count
memory_tokens_injected
observer_job_id
memory_writeback_status     # queued | skipped | failed
degraded
thread_source
```

It intentionally contains no memory text. `facts_injected` exists in the core
assembler result but is not currently part of `MemoryDecisionSchema` and is not
persisted in the decision record.

Core exposes separate `hydrate`, `observer`, and `reflector` cost-sink callbacks,
but the current gateway composition root wires those callbacks to no-ops. Thus
dedicated memory-maintenance token/cost buckets are **not yet persisted**.
`memory_tokens_injected` is persisted, and LLM memory calls routed through the
gateway's self-HTTP client can appear as ordinary gateway requests, but that is
not the same as a complete memory cost ledger.

The Admin Memory page and its operational stats are documented in
[13 · Memory Admin and MCP](13-memory-admin-and-mcp.md).

## Current limitations and non-goals

- No synchronous Observer/Reflector on the model-serving path.
- No server-side compaction of the client's live message array; the client owns
  its active context window.
- No account-global profile or cross-account sharing.
- No automatic cross-project sharing; sharing requires keys to use the same
  explicit project id.
- Static known-fact injection is opt-in and query-independent. Query-driven
  hybrid fact retrieval exists only through the `memory_recall` MCP tool.
- No dedicated persisted memory-maintenance cost ledger yet.
- Full raw/observation content is not exposed by the Memory management UI or MCP
  tools; those surfaces manage facts and reflections.

## Verification map

High-signal current tests include:

- `apps/gateway/src/routes/*memory.test.ts` and `chat.inject.test.ts`;
- `apps/gateway/src/routes/native-memory-inject.test.ts`;
- `packages/core/src/memory/observe.test.ts`, `inject.test.ts`,
  `inject-bridge.test.ts`, `observer.test.ts`, `reflector.test.ts`,
  `scheduler.test.ts`, and `idle-flush.test.ts`;
- SQLite/Postgres memory store contract tests under
  `packages/core/src/store/{sqlite,postgres}/`.
