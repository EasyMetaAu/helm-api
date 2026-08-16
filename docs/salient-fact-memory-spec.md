# Salient-Fact Memory

> Implemented design plus historical rationale, refreshed against current source
> on 2026-07-16.
>
> The feature is opt-in and default-off through
> `memory.forgetting.consolidate.eager_facts`. It combines two behaviors behind
> one switch: background raw-turn fact formation and static scope-based
> `## Known facts` injection. Schema validation requires both
> `memory.llm.enabled=true` and `memory.forgetting.enabled=true`.
>
> This document was originally a proposal after a June 2026 production incident.
> Sections explicitly labeled **historical snapshot** explain that decision; all
> unlabeled contracts below describe the current code.

## Problem

The baseline memory pipeline forms facts from observations. A short conversation
may remain below the size trigger and end before idle flush, so no observation
or reflector job exists yet. A user can say “remember that my favorite number is
42” and open another session before the baseline pipeline has produced a
cross-thread artifact.

Salient-fact memory closes that latency/formation gap without putting an LLM on
the serving path:

1. the background Observer can extract atomic facts directly from uncovered
   user turns when it decides not to compact;
2. normal `inject` can load active facts by static scope and add them to the
   trailing memory reminder.

This is separate from deep recall:

- static known-fact injection is query-independent and runs only when
  `eager_facts=true`;
- P8 `memory_recall` is query-driven FTS/vector/score retrieval exposed only as
  an MCP tool and is now implemented (see
  [14 · Memory Deep Recall](14-memory-deep-recall.md)).

## Historical production snapshot (June 2026)

The original incident was reproduced on `la.atmy.work` with project
`agentcrew-test`. At that dated snapshot:

- request `b680540b` persisted the user's “favorite number is 42” turn in
  `memory_messages`;
- a new-session request `463354fa` hydrated an older project reflection that did
  not contain the fact;
- the short source thread had no observation because it was below the 2048-token
  size trigger and was not yet idle for one hour;
- without an observation, no project/resource reflector promotion occurred;
- the only matching fact in the inspected database belonged to another project.

These ids and database observations are historical incident evidence, not a
claim about current production state. The architecture gap they demonstrated is
what this feature addresses.

## Current formation path

### Gate and composition-root wiring

`MemoryConfigSchema.superRefine()` rejects `eager_facts=true` unless:

```text
memory.llm.enabled == true
memory.forgetting.enabled == true
```

When valid, `apps/gateway/src/server.ts` wires:

- `memoryLlm.extractFactsFromMessages` into `ObserverDeps`;
- `max_facts_per_subject` into the Observer;
- `injectKnownFacts=true` and optional `maxFactsInjected` into inject.

With the flag false, neither raw eager extraction nor static fact loading runs.

### Observer decision point

`runObserverJob()` first loads a snapshot of raw messages and existing
observation coverage. It runs the normal auto-compaction policy over contiguous
uncovered segments.

```text
if a segment compacts:
  write one observation
  let the Reflector form facts from observations
else:
  attempt eager extraction from uncovered user turns
```

The eager call is skipped on a compacting run, preventing double extraction from
the same source batch.

### Extractor input and fallback

The eager path:

1. selects uncovered messages;
2. returns immediately if no uncovered `user` message exists;
3. sends **only** uncovered user messages to the raw-fact extractor;
4. retries once when the first result is empty;
5. treats a second empty result as a no-op.

Assistant and tool output are excluded rather than merely being described as
untrusted in the prompt. This prevents agent chatter/file output from becoming
user memory.

Raw eager extraction deliberately has no deterministic prose-to-fact fallback.
`createMemoryLlmRuntime().extractFactsFromMessages` calls the configured facts
model and uses `{facts: []}` when the model is disabled/unavailable, times out,
fails, returns invalid JSON, or fails schema parsing. The dual config gate keeps
the disabled-model case from becoming a silently lying setting.

The parser accepts both the documented `{facts:[...]}` envelope and a bare fact
array, normalizing the latter before Zod validation.

### Fact normalization and scope

The model returns raw `{subjectText, factText}`. Core then uses
`buildReconciledFactBatch()` to:

- trim/drop empty values;
- derive deterministic `subject_key` and `content_hash` inputs;
- apply `max_facts_per_subject` (default 8);
- stamp owner and scope;
- supply `validFrom` from the extraction run time.

The write scope carries both project and resource when both exist. If neither
exists, eager extraction is skipped; it never creates a thread-only or
account-wide fact.

Persistence calls `insertFactsReconciled.call(memoryStore, ...)`. The explicit
receiver binding is required because real store methods read `this.db`; an older
detached invocation silently failed inside the eager path's fail-open boundary.

Reconcile behavior is shared with Reflector/Admin/MCP fact creation:

- account-scoped content-hash dedup;
- same-subject temporal supersede;
- resurrection and re-scoping of archived/pruned identical facts.

### Late-message coalescing race

Open observer jobs coalesce by `(type, scope)`. A user turn arriving after a
running job's initial message snapshot could otherwise coalesce into that
already-running row and never be seen.

After marking each successful/no-op Observer run done, current code re-reads the
thread. If a user message id exists that was not in the snapshot, it enqueues one
fresh observer job carrying the same project/resource scope. Assistant-only late
messages do not trigger this follow-up. The open-job unique index still
coalesces concurrent re-enqueues.

This completion recheck fixes the running-job race without creating a permanent
“uncovered history” loop: the comparison frontier is message ids from the last
snapshot, not observation coverage.

## Current static injection path

When `injectKnownFacts=true`, `assembleInjectedContext()` calls
`listActiveFacts()` with an account guard and a usable scope:

```text
if project or resource exists:
  filter by every present project/resource field
  omit thread filter
else if thread exists:
  filter by thread
else:
  load no facts
```

It never calls `listActiveFacts({accountId})` without a narrower scope, because
omitted scope fields mean no filter and would expose unrelated facts inside the
account.

Visible facts must have:

```text
status == active
expired_at == null
```

They are placed between reflections and observations:

```text
<system-reminder>
# Persistent memory (injected by helm)
## Project knowledge
...
## Resource knowledge
...
## Known facts
- ...
## Earlier context (summarized)
...
</system-reminder>
```

Only non-empty sections are emitted.

## Fact ranking, cap, and budget

Selection is deterministic for the loaded set and supplied clock:

- with forgetting enabled: rank by the shared forgetting score, then recency;
- otherwise: rank by `validFrom` recency;
- keep at most `max_facts_injected`, or internal prior 16;
- spend the remaining allocation after project/resource reflections and before
  observations;
- emit surviving facts oldest-first (then id) so the block order is stable even
  though selection used current score.

Each fact renders as `- <factText>`. The token allocator counts these strings;
section headers and the outer reminder wrapper are outside the configured
content allocation, as documented in doc 08.

## Reinforcement and observability boundaries

Current static injection does **not** add kept fact ids to inject's
`bumpReferences()` call. Only injected observations/reflections are reinforced
there. A successful hybrid `memory_recall` tool call can reinforce facts, but
that is a separate path.

Core's `InjectResult.metadata` contains `facts_injected`. The persisted
`MemoryDecisionSchema` does not, so Admin request detail cannot currently show
that count from `DecisionRecord.memory`.

Useful eager logs include:

```text
memory.observer.eager_facts_retry
memory.observer.eager_facts_extracted
memory.observer.eager_facts_failed
memory.observer.recheck_clean
memory.observer.recheck_reenqueued
memory.observer.recheck_failed
```

Some no-op branches remain intentionally quiet: missing optional deps, no
uncovered user message, a second empty extraction, or an empty normalized batch.
Operators cannot infer “the eager path never ran” solely from the absence of an
`eager_facts_extracted` line.

## Cost behavior

The eager extractor runs in a background Observer job, never in the synchronous
model-serving path. Cost controls are structural:

- open observer jobs coalesce by scope;
- only uncovered user turns are sent;
- assistant/tool-only batches make no call;
- compacting runs skip eager extraction;
- an empty first result causes at most one retry;
- content-hash dedup makes repeated writes idempotent;
- the completion recheck enqueues only for a genuinely late user message.

There is no persistent eager-scan watermark, so an uncovered short thread can be
re-mined by later observer runs. Dedup prevents duplicate rows but does not make
the repeated model call free.

The core exposes memory cost sinks, but the current gateway wires them to
no-ops. Exact eager fact cost is therefore not persisted as a dedicated memory
bucket. If the memory LLM uses Helm's self-HTTP client, its call may appear as an
ordinary gateway request.

## Config

`config/memory.yaml` has no outer `memory:` wrapper:

```yaml
llm:
  enabled: true
  model: economy
  # facts_model: provider/cheap-fact-model

forgetting:
  enabled: true
  consolidate:
    eager_facts: true
    max_facts_per_subject: 8
    # max_facts_injected: 12
```

Actual defaults:

- `eager_facts`: false;
- `max_facts_injected`: omitted, so internal prior 16;
- checked-in `config/memory.yaml`: `eager_facts` remains omitted;
- new API keys: `memory_mode=off`, so enabling this config alone still does not
  activate memory traffic for those keys.

`max_facts_injected` must be a positive integer. `eager_facts` under a disabled
LLM or disabled forgetting master refuses startup.

## No schema migration

The feature reuses the existing `memory_facts` table and the existing observer
job type. It added no table/column/job enum member.

It does not add a persistent extraction watermark. A future watermark would
need an explicit schema migration and clear replay semantics.

## Current limitations and follow-ups

- No persistent raw-fact scan watermark.
- No deterministic fallback for raw prose fact extraction.
- Empty/no-user/missing-dependency no-op branches are not all logged distinctly.
- Static injected facts are not reinforced.
- `facts_injected` is not persisted in `DecisionRecord.memory`.
- Static scope loading can become noisy at high fact volume; it is not
  query-relevant retrieval.
- Salience relies on the facts prompt plus score/cap; there is no independent
  deterministic preference-only filter.
- Manual/Admin facts participate in the same static scope load when active.

## Verification map

Formation behavior and the late-message recheck are covered in
`packages/core/src/memory/observer.test.ts`. Static injection, scope isolation,
ordering, cap, and fail-open behavior are covered in
`packages/core/src/memory/inject.test.ts`. Config cross-gates are covered in
`packages/shared/src/config/memory-schema.test.ts`. Reconcile semantics are
covered by `forgetting/facts.test.ts` and both adapters' memory-fact tests.

## Research influence

The original design compared volume-gated summarization, eager per-turn
extraction (Mem0/LangMem/Graphiti/Cognee), and agent self-editing
(Letta/MemGPT). Helm adopted eager extraction only on its background Observer
path: this preserves a transparent gateway, keeps model serving fail-open, and
reuses the existing deterministic storage reconciliation.
