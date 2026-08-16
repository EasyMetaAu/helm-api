# 12 · Memory: Forgetting, Tiering, and Facts

> Current implementation reference, verified against the source on 2026-07-16.
>
> P0–P8 are implemented. P8 is the query-driven fact engine behind the optional
> MCP `memory_recall` tool; it is not part of normal prompt injection. The static
> `## Known facts` inject section is a separate opt-in feature described in
> [Salient-Fact Memory](salient-fact-memory-spec.md).
>
> `MemoryConfigSchema` defaults `forgetting.enabled` to `false`, while the
> checked-in `config/memory.yaml` explicitly sets it to `true`. This switch does
> **not** enable memory traffic: new API keys still default `memory_mode` to
> `off`, and MCP defaults off independently.

## Scope of this chapter

This chapter extends the baseline pipeline in
[08 · Memory Middleware](08-memory-middleware.md) with:

- explicit short/mid/long storage tiers;
- deterministic decay and reinforcement;
- active/archived/pruned visibility;
- atomic facts with idempotent dedup and temporal supersede;
- retention behavior;
- hybrid fact recall.

It does not replace observe, inject, the Observer, or the Reflector.

## Code map

| Contract | Current source |
|---|---|
| Pure forgetting score | `packages/core/src/memory/forgetting/score.ts` |
| Decay trigger | `packages/core/src/memory/decay-trigger.ts` |
| Decay job | `packages/core/src/memory/forgetting/decay.ts` |
| Retention | `packages/core/src/memory/forgetting/retention.ts` |
| Inject trim + reinforcement | `packages/core/src/memory/inject.ts` |
| Fact normalization/reconciliation input | `packages/core/src/memory/forgetting/facts.ts` |
| Reflector fact formation | `packages/core/src/memory/reflector.ts` |
| Raw-turn eager fact formation | `packages/core/src/memory/observer.ts` |
| LLM + deterministic fallbacks | `apps/gateway/src/memory-llm.ts` |
| Hybrid recall + embeddings | `packages/core/src/memory/recall/`, store adapters, and `apps/gateway/src/memory-embedder.ts` |
| Config source of truth | `packages/shared/src/config/memory-schema.ts` |
| Row schemas | `packages/shared/src/memory/schema.ts` |

## Tier model as implemented

The tier is implied by the table; there is no separate tier column.

| Tier | Artifact | Scope | Serving behavior |
|---|---|---|---|
| Short | `memory_messages` | thread | Audit and formation source. Stored rows are not re-injected; the client's live conversation is the active short-term window. |
| Mid | `memory_observations` | thread | Time-anchored compressed ranges. Active rows may be injected after live-window dedup and budget selection. |
| Long | `memory_reflections` | project/resource/thread | Automatic inject reads exact project and resource reflections. Thread reflections can be managed directly but are not an automatic inject slot. |
| Long | `memory_facts` | project/resource/thread | Atomic, deduplicated, supersedable facts. Used by optional static known-fact injection and MCP search/recall. |

The normal formation chain is:

```text
raw messages
  -> Observer compaction
  -> thread observation
  -> project/resource Reflector promotion
  -> stable reflection + optional facts
```

The eager-fact option adds a second formation path for short, non-compacting
threads:

```text
uncovered user raw turns
  -> background Observer fact extraction
  -> project/resource fact; skip when neither parent exists
```

No transition deletes raw messages. Separate cleanup settings may archive/prune
raw history, but compaction and forgetting do not delete it as part of tier
promotion.

## Master-switch boundaries

`memory.forgetting.enabled` currently gates:

- inject-time forgetting-score ordering for observations and static facts;
- fire-and-forget reference bumps for injected observations/reflections;
- decay candidate creation and decay job execution;
- retention of archived observations and expired facts;
- fact extraction from observations in the Reflector;
- reflection archival when a forgetting-enabled rebuild has no active
  observations.

It does **not** gate:

- raw observe/inject persistence;
- Observer compaction or Reflector merging;
- idle-flush memory formation;
- admin management reads/writes;
- `memory_recall`'s own `facts_retrieval.enabled` switch;
- MCP mounting;
- previously stored fact visibility in management surfaces.

`eager_facts=true` is cross-validated to require both
`forgetting.enabled=true` and `llm.enabled=true`, so that combined feature cannot
run outside the master forgetting lifecycle.

## Deterministic forgetting score

The TypeScript source of truth is:

```text
score(now) = recency(now) * (importance_weight + access_bonus)

recency(now) = 0.5 ^ (age_seconds / half_life_s)
age_seconds = max(0, now - effective_referenced_at)
effective_referenced_at = referenced_at ?? fallback_timestamp
importance_weight = clamp(importance, importance_floor, importance_ceil)
access_bonus = access_weight * log1p(reference_count)
```

The access bonus is inside the recency product. A frequently used memory still
decays toward zero once it stops being referenced; the bonus does not create a
permanent floor.

Fallback timestamps are tier-specific:

| Row | Fallback when `referenced_at` is null |
|---|---|
| observation | `observed_at` |
| reflection | `updated_at` |
| fact | `created_at` |

`now` is caller-supplied, so the TypeScript function is pure. Decay candidate
queries reproduce the same formula in SQLite/Postgres SQL, then TypeScript
rechecks each returned candidate to avoid archiving on a floating-point edge.

`reference_count` and `referenced_at` are state. Curve parameters are config,
not columns, so changing the curve requires no migration.

## Visibility and lifecycle states

The shared status enum is:

```text
active | archived | pruned
```

The meaning differs slightly by artifact:

- **Observation `active`**: content can feed inject/Reflector/fact formation.
- **Observation `archived`**: decay-hidden; excluded from content reads.
- **Observation `pruned`**: retention tombstone. Text becomes `[pruned]` and
  tags are cleared, but the row and `source_message_range` remain as coverage.
- **Reflection `active`**: visible to exact-scope inject and merge.
- **Reflection `archived`**: hidden from normal reads. Automatic forgetting
  archives but never hard-deletes reflections.
- **Fact `active` with `expired_at IS NULL`**: live fact.
- **Fact `active` with `expired_at IS NOT NULL`**: derived management status
  `superseded`.
- **Fact `archived` / `pruned`**: hidden from active reads.

Normal content reads use active/unexpired predicates. Coverage reads are
different: archived/pruned observations still cover their original raw range so
old turns are not summarized again or resurrected into an injected observation.

## Reinforcement

After inject selection, core defers one account-guarded bump for the exact
observation/reflection ids that survived:

```text
reference_count += 1
referenced_at = now
```

Invocation is deferred with `setImmediate`, and both synchronous throws and
promise rejections are swallowed and logged. It is never awaited on the serving
path.

Current boundaries matter:

- static facts emitted in `## Known facts` are **not** included in this inject
  bump;
- facts returned by a successful hybrid `memory_recall` call are bumped
  fire-and-forget;
- the LIKE degradation path for `memory_recall` returns before that bump.

Thus fact reinforcement exists for successful deep recall, not for static fact
injection or degraded substring search.

## Decay sweep

The worker interval calls `maybeEnqueueDecayJobs()`. For each account with active
observations, it enqueues one account-scoped decay job when either:

- at least `trigger_observations` new active observations exist since the last
  decay job; or
- `trigger_interval_s` has elapsed (an account never swept is due on this time
  gate).

Open jobs coalesce by `(type, scope)`. `runDecayJob()` rechecks
`forgetting.enabled` at execution time so a persisted job cannot archive rows
after an operator disables the feature.

The sweep:

1. asks the adapter for below-threshold active observation candidates using the
   SQL score predicate;
2. re-scores in TypeScript;
3. archives ids in chunks of 50;
4. stops at `max_iterations`, `max_wallclock_s`, or
   `max_consecutive_errors`;
5. in the same database transaction, enqueues coalesced reflector rebuilds for
   the exact project/resource scopes whose observations were archived; a
   parentless historical observation is archived without a rebuild.

The scan itself is bounded at `max_iterations * 50`. Failures over-retain and
log; they do not affect an in-flight model request.

## Reflection rebuild after forgetting

A reflection is derived from active observations. Archiving observations
without rebuilding would keep forgotten text in the long tier.

Each archive batch derives its affected scopes from the archived observation
rows and persists the reflector jobs atomically. It never scans or materializes
all scopes for an account, so a 513th scope cannot starve behind a fixed first
page. The same transaction immediately archives current reflections for every
affected project/resource target and fences any running stale Reflector before
queuing its successor. A Reflector publishes reconciled facts, its reflection
action, and job completion in one job-status-fenced transaction. The Reflector
always filters to active/unexpired observations:

- if observations remain, it merges the reduced set;
- if none remain and forgetting is enabled, it archives all reflection versions
  for that exact scope;
- later rebuilding uses `MAX(version)` across every status and writes high-water
  + 1, so the version never resets after archive/revival.

## Fact formation and reconciliation

### Observation facts

The Reflector extracts facts when all of these are true:

- `forgetting.enabled`;
- an extractor is wired;
- the adapter implements `insertFactsReconciled`;
- active observation text reaches `consolidate.trigger_tokens`.

The LLM output must cite a supplied observation id. Invalid citations fall back
to deterministic extraction. Deterministic subject keys use the first tag or a
leading-word slug; content hashes are always derived in code.

### Raw eager facts

`consolidate.eager_facts=true` mines uncovered user turns only on an Observer run
that does not compact. It retries an empty LLM result once and has no
deterministic raw-prose fallback. Details and known limitations are in
[Salient-Fact Memory](salient-fact-memory-spec.md).

### Reconcile semantics

`insertFactsReconciled()` is transactional in both adapters.

1. `content_hash = sha256(normalized fact text)` supplies idempotency.
2. The unique boundary is `(owner_id, content_hash)`, so identical text is
   deduplicated across all scopes of one account, but not across accounts.
3. A new live fact supersedes older live facts with the same `subject_key` and
   older `valid_from`. Each non-null scope column on the new fact narrows the
   update; null columns impose no constraint.
4. Supersede stamps the old row's `expired_at=now` and
   `invalid_at=new.valid_from`; it never deletes the old fact.
5. Re-ingesting an identical archived/pruned fact resurrects it and updates its
   scope to the new ingest scope, then applies same-subject supersede.
6. Re-ingesting an identical already-live fact is a no-op.

`enable_llm_supersede` remains `z.literal(false)`. Setting it to true refuses
startup because cross-subject contradiction detection is not implemented.

## Retention and deletion

The interval worker calls `pruneRetainedMemory()` when forgetting is enabled.
It computes strict age cutoffs and delegates to the active adapter:

- archived observations older than `archived_days` are **tombstoned**, not
  deleted: `status='pruned'`, text `[pruned]`, tags null;
- facts with `expired_at` older than `facts_expired_days` are hard-deleted;
- reflections are untouched by automatic retention;
- raw messages are untouched by this forgetting retention function.

Raw-message cleanup is a separate runtime retention control. It may prune only
rows at or behind a thread's durable Observer frontier and in bounded batches;
age alone never authorizes deleting uncovered raw turns.

Method/result names still use `observationsDeleted`, but that count represents
observation rows changed to tombstones in the real adapters.

Operator deletion is a separate contract:

- admin/MCP fact delete soft-prunes the fact;
- reflection delete is two-stage: active becomes archived; deleting an already
  archived reflection hard-purges archived versions of that scope.

The latter is explicit operator action. The automatic forgetting pipeline never
hard-deletes a reflection.

## Hybrid fact retrieval (P8)

P8 is implemented by `MemoryStore.searchFacts()` and exposed through
`memory_recall`. It is described in detail in
[14 · Memory Deep Recall](14-memory-deep-recall.md).

Current high-level behavior:

- active/unexpired account-and-scope facts only;
- FTS/substring and optional vector candidate generation;
- forgetting score over the candidate union;
- Reciprocal Rank Fusion with `k=60`;
- optional query embedding;
- fail-open MCP degradation to ordinary substring search.

It does not search observations/reflections and does not run during normal
`inject`.

## Schema and migration history

The forgetting/fact schema originally landed in SQLite migration **v18** and
Postgres migration **v17**. Those version numbers identify this feature's
migrations; they are not the current ledger heads. As of this source snapshot,
the SQLite ledger ends at **v39** and the Postgres ledger at **v38**.

Core deltas were:

```text
memory_observations
  + reference_count, importance, status, archived_at, expired_at

memory_reflections
  + owner_id, referenced_at, reference_count, status

memory_facts (new at the time)
  owner_id, project_id, resource_id, thread_id,
  subject_key, fact_text, content_hash,
  importance, reference_count, referenced_at,
  valid_from, invalid_at, expired_at, status,
  source_observation_range, created_at, updated_at
```

Hybrid-recall embedding/FTS columns arrived later in SQLite v28 / Postgres v27.
See doc 14 for their exact current behavior.

All fact predicates include `owner_id`. Facts cannot rely on a thread join for
tenant isolation because project/resource facts can have null `thread_id`.

## Config surface

`config/memory.yaml` is mounted directly under `config.memory`; its top level is
`forgetting:`, not `memory:`. The schema uses snake_case keys and strict objects.

```yaml
forgetting:
  enabled: true
  facts_retrieval:
    enabled: true
    # top_k: 10
  score:
    half_life_s: 86400
    importance_floor: 0.1
    importance_ceil: 1.0
    access_weight: 0.15
  inject:
    drop_order: score             # score | oldest
  decay:
    archive_threshold: 0.05
    trigger_observations: 50
    trigger_interval_s: 3600
  consolidate:
    trigger_tokens: 1024
    max_facts_per_subject: 8
    enable_llm_supersede: false   # true is rejected
    # eager_facts: false          # omitted in shipped file; schema default false
    # max_facts_injected: 16      # optional override; 16 is internal prior
  retention:
    archived_days: 30
    facts_expired_days: 90
  sweep:
    max_iterations: 200
    max_wallclock_s: 900
    max_consecutive_errors: 5
```

Schema defaults are the values above except `forgetting.enabled=false`; the
checked-in file explicitly turns it on. `facts_retrieval.enabled=true` affects
only the `memory_recall` tool, which remains unreachable unless MCP itself is
enabled.

The inject allocation budget is not in this block. It uses
`HELM_MEMORY_INJECT_TOKEN_BUDGET` (default `4000`).

## Current gaps and deliberate deferrals

- LLM contradiction discovery beyond deterministic same-subject supersede is
  not implemented.
- Static known-fact injection does not reinforce fact ids and does not persist a
  `facts_injected` count in `DecisionRecord.memory`.
- Raw eager extraction has no persistent scan watermark; content-hash dedup,
  uncovered ranges, job coalescing, and completion rechecks provide the current
  bounds.
- Half-life is global rather than per tier/scope.
- Hybrid retrieval searches facts only and begins from text/vector candidates;
  forgetting score does not make every fact a candidate by itself.
- There is no graph or multi-hop temporal traversal.
- Procedural/skill memory belongs to the client agent layer, not this gateway.

## Verification map

- score: `packages/core/src/memory/forgetting/score.test.ts`
- decay/retention: `packages/core/src/memory/forgetting/*.test.ts`
- inject behavior: `packages/core/src/memory/inject-forgetting.test.ts` and
  `inject.test.ts`
- fact reconciliation: `packages/core/src/memory/forgetting/facts.test.ts`,
  `reflector-facts.test.ts`, and both adapters' `memory-facts.test.ts`
- adapter parity: SQLite/Postgres `memory-decay-sweep.test.ts`,
  `memory-retention.test.ts`, and `memory-bump-references.test.ts`
- hybrid retrieval: adapter `memory-search.test.ts`, recall RRF tests, and MCP
  route tests.

## Design references

The original design drew deterministic primitives from Ebbinghaus-style
recency, Generative Agents, Graphiti, Mem0, Cognee, MemoryScope, Memobase,
Letta/MemGPT, Tencent Agent Memory, and MemOS. These are design influences, not
runtime dependencies; no reference implementation is imported.
