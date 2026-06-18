# Salient-Fact Memory · Design Proposal

> **Status: PROPOSAL — for review, not yet implemented.** This is a design spec
> (like `native-passthrough-fidelity-spec.md`), not a description of shipping
> behaviour. It extends the memory layer ([08 · Memory Middleware](08-memory-middleware.md))
> and the facts tier ([12 · Memory: Forgetting & Tiering](12-memory-forgetting-and-tiering.md)).
> It is the formation+injection layer **below** the deferred P8 hybrid retrieval —
> and, unlike P8, it needs **no embedding infrastructure**.

## TL;DR

When a user states a durable preference in a short turn — *"my favorite number is
42, remember it"* — Helm does not recall it in a later session. This is **not a
bug**; it is a structural consequence of two facts about today's design:

1. **Fact formation is chained to history compaction.** Facts are produced only by
   the Reflector, which fires only after the Observer compacts raw history into an
   observation — and compaction only triggers at `segment_min_tokens` (2048) or a
   1h idle flush. A short throwaway chat crosses neither, so it produces **zero
   observations → zero reflector runs → zero facts**.
2. **Facts are never injected.** `inject` reads project/resource **reflections** +
   thread **observations** only. The `memory_facts` table is never read on the
   request path (P8, the per-turn fact retrieval, is deferred pending embeddings).

This proposal **decouples fact formation from compaction** (extract atomic facts
from raw turns in the background Observer, regardless of whether a compaction
happened) and **injects scope-filtered facts deterministically** (a stable
`## Known facts` section selected by scope + forgetting-score — *not* per-query
retrieval). Both changes reuse the existing `memory_facts` schema, supersede/dedup
path, and LLM runtime. No migration. Gated off by default behind one new opt-in
flag.

---

## 1. The problem, with production evidence

Reproduced on `la.atmy.work` (pi-coding-agent / "Mimi" client, project
`agentcrew-test`), verified against the live SQLite DB:

| Step | Request | Thread | Result |
|---|---|---|---|
| User: "我喜欢的数字是42,你记住" | `b680540b` 14:08:38 | `019edb0b…` | stored as raw `memory_messages` |
| User opens new session, expects recall | `463354fa` 14:09:48 | `019edb10…` | `memory_hydrated:true`, but the injected reflection is the stale v2 ("greeted by Mimi"), **no 42** |

What the DB showed:

- The "42" turn **is** in `memory_messages` (thread `019edb0b`, msg #5/#6).
- **No observation** was ever written for that thread (8 short messages, far under
  `segment_min_tokens=2048`; observer ran ~32s after the last message, far under
  the 1h idle flush → `chooseAutoCompaction` returned `shouldCompact:false`).
- Because no observation was written, the Reflector was **never enqueued**
  (`scheduler.ts:99` gate: `result.observationId !== null`). The `agentcrew-test`
  project reflection is frozen at v2 (13:19, pre-42).
- The only `memory_facts` row matching "42" is under a **different** project
  (`lukin-personal`, left over from earlier debugging) and would not be injected
  anyway (facts are not read on inject).

So three independent layers all fail the same short-turn fact: it never becomes an
observation, never a reflection, and facts are not injected. The user's instinct —
*"I literally told it what I like and it formed no memory"* — is correct.

## 2. Why this happens (today's code)

| Stage | Code | Behaviour |
|---|---|---|
| Compaction trigger | `compaction-policy.ts:43,46` | `segmentMinTokens=2048`, `idleFlushS=3600`. Short threads never compact. |
| Observer | `observer.ts:249-261` | No compactable segment → early `return {observationId:null}`. The raw "42" turn is left as-is. |
| Reflector promotion | `scheduler.ts:99-102` | Reflector enqueued only when `observationId !== null` **and** scope has project/resource. |
| Fact extraction | `reflector.ts:300-333` | Facts are extracted **from observations**, inside the Reflector, gated additionally by `consolidate.trigger_tokens=1024`. |
| Inject load | `inject.ts:164-197` (`loadMemory`) | Reads `getReflection` (project/resource) + `listObservations` (thread). **Never** `listActiveFacts`. |
| Inject non-goal | `docs/08:483` | "No per-turn dynamic retrieval by default." `docs/12:330`: facts inject only via the Reflector; P8 (per-turn search) deferred. |

**Root cause in one line:** Helm treats *all* memory formation as **summarization
of accumulated history**. It has no path for **"this single turn contains a durable
fact, capture it now."**

## 3. How other systems handle this (research)

From the eight memory projects cloned under `../memory-research/` (see
[research-notes.md](research-notes.md)), three formation paradigms emerge:

| Paradigm | Projects | Formation trigger | Short "I like 42" captured? | Fits a gateway? |
|---|---|---|---|---|
| **① Volume-gated summarization** | **Helm (today)**, letta (auto path), memobase (pre-flush), a-mem | Accumulate to a token / message threshold, then compress | ❌ never forms | — |
| **② Eager per-turn extraction** | **mem0**, langmem, graphiti, cognee | LLM fact/entity extraction on *each* message (or message pair) | ✅ one `add()` → stored, recallable cross-session | ✅ **best fit** |
| **③ Agent self-editing** | letta / MemGPT (intended) | The model calls a memory tool (`core_memory_append`) | ✅ but needs model cooperation | ❌ Helm is a transparent gateway; it cannot make the upstream model call tools |

**mem0 is the reference for ②.** Each `add()` runs a fact-extraction prompt that
pulls "memorable information" (explicitly including user preferences), then an
ADD/UPDATE/DELETE reconciliation against existing memories. A single statement
becomes a durable, user-scoped fact immediately. mem0 decouples *fact formation*
from *history compaction* — exactly the seam Helm is missing.

Helm should adopt ② on its **background** path (never synchronous — Helm's
"no synchronous Observer on the request path" non-goal stands), storing into the
`memory_facts` tier it already has.

## 4. Design goals & non-goal reconciliation

This proposal is deliberately scoped to honour every existing memory non-goal
(`docs/08:480-487`):

| Non-goal | How this proposal stays inside it |
|---|---|
| No per-turn dynamic retrieval by default | Facts are injected by **static scope load** (`listActiveFacts({accountId, projectId})`), the *same shape* as reflections — **not** a per-query semantic/embedding search. The injected set is query-independent. |
| No global user profile | Facts stay **account + project/resource scoped** (the existing `memory_facts` columns + owner isolation). No cross-project sharing is introduced. |
| No synchronous Observer on the request path | Extraction runs in the background `runObserverJob`, off the request path. The request path is unchanged. |
| Cache-friendly, stable prefix | The fact section lands in the **already-trailing, already-uncached** `<system-reminder>` block (`docs/08:194-204`); it changes only when the fact set changes (slow), so prompt caching is unaffected — identical to how reflections behave. |

## 5. The design

Two precise, additive changes. Both reuse existing machinery.

### Change A — Eager fact formation (decoupled from compaction)

In `runObserverJob` (`observer.ts`), **before** the compaction decision's early
returns, run a fact-extraction pass over the thread's **new (uncovered) raw
messages**, gated by the LLM runtime. This is independent of whether a compaction
observation is written.

```text
runObserverJob(job):
  load all messages + existing observations            (unchanged)
  newRawTurns = messages after fact_scan_high_watermark        (only new content)

  ── existing compaction decision (unchanged) ──
  if shouldCompact:
    # COALESCED: one LLM call emits BOTH the observation summary AND facts
    { observationText, facts } = await summarizeAndExtract({ messages, now })
    appendObservation(observationText)                 (unchanged)
  else:
    # short thread that never compacts — the only path that adds a NEW call,
    # and ONLY when there is genuinely new user-authored content to mine
    facts = hasNewUserTurn(newRawTurns)
              ? await extractFactsFromMessages({ messages: newRawTurns, existingFacts, now })
              : []                                     # skip — no LLM call

  ── NEW: persist facts (when memory.llm.enabled && eager_facts) ──
  insertFactsReconciled(scope, facts)   # existing supersede/dedup; ADD vs UPDATE vs NOOP
  advance fact_scan_high_watermark
```

Key points:

- **Minimal new extractor; same output + same persistence.** Today `extractFacts`
  consumes `observations` (`reflector.ts:79`, `memory-llm.ts:318`) and returns RAW
  `{subjectText, factText}` — the Reflector then derives `subject_key` +
  `content_hash` itself via pure helpers, so **supersede/dedup never depend on the
  LLM** (`reflector.ts:288-296`). Change A only swaps the *input* (raw messages
  instead of observations); the **output contract and the persistence call are
  reused verbatim**: facts land through the same `MemoryStore.insertFactsReconciled`
  (the ADD/UPDATE-via-supersede reconciliation) with the same key derivation and the
  same `max_facts_per_subject` cap. The deterministic stub stays the fallback; the
  real path is `memory.llm` with `facts_model`.
- **Scope from the thread.** The Observer job is `{accountId, threadId}`; resolve
  `project_id` / `resource_id` from the `memory_threads` row so facts are written
  at the cross-thread scope (project), which is what makes them recallable in a new
  thread.
- **Idempotency.** A `fact_scan` high-watermark per thread (analogous to
  observation coverage) prevents re-scanning the same turns every writeback;
  `content_hash` dedup is the backstop.
- **Cost.** Bills the existing Reflector/“facts” cost bucket (`docs/08:398-407`).
  Bounded — see §5.3.
- **Fail-open.** An extractor throw is swallowed + logged; the observation and the
  request are unaffected (same contract as `extractFacts` today, `reflector.ts:303`).

This means the 8-message "42" thread now yields a fact
`subject="favorite number" → "42"` under `(default, agentcrew-test)`, even though
it never compacts.

### 5.3 Cost & LLM-call amplification

The naive form — "extract on every turn" — would roughly **double** background
memory LLM **calls**. That concern is real; this design keeps it bounded with four
levers, three of which are *exact* (not heuristic):

| Lever | Kind | Effect |
|---|---|---|
| **Job-dedup batching** | exact | The observer job already carries a `uniq_memory_jobs_open_type_scope` lock (`migrate` / `memory_jobs`): bursts of N requests on a thread collapse to **one** worker run. Extraction is per-tick-per-thread, **not per-message**. |
| **No-new-user-content skip** | exact | If no new **user-authored** turn exists past the fact-scan watermark, skip the call entirely. Tool-result-only / assistant-only batches (the bulk of agent tool roundtrips) cost **zero** extra calls. |
| **Coalesce on compaction** | exact | When a compaction happens, the summarizer already reads the messages — emit observation **and** facts in **one** JSON call. No second call on the compaction path; this also *replaces* the Reflector's separate observation→fact call. |
| **Trivial-turn skip** | heuristic (conservative) | Optionally skip sub-N-char acks ("ok", "继续"). Errs toward running when unsure. |

The dollar impact is far smaller than the call-count impact, because the extractor
is a **nano `facts_model`** with tiny I/O (just the new turns in, ≤~100 tokens of
facts JSON out) versus the actor's full model on the full conversation:

| Workload | New-user-turn skip rate | Net extra **calls** / actor turn | Net extra **cost** |
|---|---|---|---|
| Coding agent (Claude Code / Codex) | ~95% (tool roundtrips) | ≈ 1.05× | negligible |
| Personal chat (the "42" case) | ~70–85% | ≈ 1.1–1.2× | low single-digit % |

So: a standalone extractor call happens **only** for a short thread that both
(a) never compacts and (b) contains genuinely new user-authored content — exactly
the "42" case the feature exists to fix — and it is a cheap nano call. mem0 pays a
per-`add()` call unconditionally; Helm does strictly less by reusing its existing
job-dedup + a separate cheap `facts_model`.

### Change B — Deterministic scope-filtered fact injection

In `inject.ts` `loadMemory` (`:164`), also load the scope's active facts and emit a
new block section.

```text
loadMemory(scope):
  projectReflection   = getReflection(project)        (unchanged)
  resourceReflection  = getReflection(resource)       (unchanged)
  observations        = listObservations(thread)      (unchanged)
  ── NEW ──
  facts = listActiveFacts({ accountId, projectId, resourceId })   ← already exists
          (sqlite/postgres memory-store, e.g. sqlite:820)
```

Assembled into the existing trailing `<system-reminder>` block as a new section
between reflections and observations:

```text
<system-reminder>
# Persistent memory (injected by helm)
## Project knowledge        ← project reflection
## Resource knowledge       ← resource reflection
## Known facts              ← NEW: scope-filtered atomic facts, top-K by score
- Favorite number: 42
## Earlier context (summarized)
<thread observations>
</system-reminder>
```

Selection rules (all deterministic, no embeddings):

- **Scope-static, not query-dynamic.** Load all active facts for
  `owner + project (+ resource)`; this is the *same* load shape as reflections, so
  it does **not** constitute "per-turn dynamic retrieval".
- **Ordering / cap.** Sort by the existing forgetting **score** (so decayed facts
  rank low, consistent with `inject`'s observation trim) and keep the top-K within
  the inject token budget. Priority within the block: **reflections > facts >
  observations** (facts are precise + durable; sacrifice them only after
  reflections, before noisy observations). Optional `max_injected` cap.
- **Reinforcement.** Injected fact ids get the same fire-and-forget
  `bumpReferences` reinforcement that observations/reflections already get
  (`inject.ts:458-505`), so used facts survive decay.
- **Fail-open.** A facts-load throw is caught by the existing `loadMemory`
  fail-open boundary (`inject.ts:246-271`) → degrades to no-memory, never a 5xx.

### Why this is NOT P8 (and needs no embeddings)

P8 (`docs/12:328`) is **per-query hybrid retrieval** (vector + FTS + score fused by
RRF) for when fact volume is so high that scope+score under-recalls. This proposal
is the **prerequisite layer**: make facts *form* eagerly and *inject* by static
scope+score. It needs no `embedding` column, no `sqlite-vec`/`FTS5`. P8 later
layers on top, swapping the "top-K by score" selector for hybrid retrieval when
volume demands it. Shipping this does not block or conflict with P8.

## 6. Config surface

One new opt-in flag, fail-closed via `.strict()`, defaulted off — so existing
deployments do not silently change behaviour. It sits under the existing
`forgetting.consolidate` block where facts already live (`memory-schema.ts:81-88`):

```yaml
# config/memory.yaml
llm:
  enabled: true                 # REQUIRED — eager extraction needs the model
forgetting:
  enabled: true
  consolidate:
    eager_facts: true           # NEW (default false): extract facts from raw
                                 #   turns in the Observer (Change A) AND inject a
                                 #   `## Known facts` section (Change B)
    # max_facts_injected: 12    # NEW optional (no default → internal prior):
                                 #   top-K cap on injected facts. Omitted = prior.
```

Rationale (consistent with CLAUDE.md principle 2, "no lying knobs"):

- `eager_facts` does exactly one observable thing and gates both halves together
  (forming facts nobody injects, or injecting facts that never form, would each be
  half a feature). A single switch keeps the behaviour coherent.
- `max_facts_injected` follows the `CompactionOverrides` pattern
  (`memory-schema.ts:120-136`): plain `.optional()`, **no default**, so a written
  value is the only thing that ever takes effect; omitted ⇒ the internal prior.
- Hard-gated by `memory.llm.enabled` (a `superRefine` like the existing
  `model`-required check, `memory-schema.ts:168-176`): `eager_facts:true` with
  `llm.enabled:false` should **refuse startup** rather than silently no-op (the
  deterministic raw-message extractor is too weak to be the real path).

No new top-level `config.memory` block; `MemoryConfigSchema` is unchanged in shape.

## 7. Schema & storage

**No migration.** `memory_facts` already exists with everything needed
(`docs/08:351-354`): `owner_id`, `project_id`, `resource_id`, `thread_id`,
`subject_key`, `content_hash`, `fact_text`, `importance`, `reference_count`,
`referenced_at`, bi-temporal `valid_from` / `invalid_at` / `expired_at`, `status`.
The only state addition is a per-thread **fact-scan high-watermark** (idempotency
for Change A); it can ride `memory_threads` as a nullable column (additive,
defaulted null — pre-feature rows scan from the start once, then advance).

Tenant isolation is already correct: `memory_facts` carries its own `owner_id` and
every read/dedup/supersede predicate includes it (`docs/12:361-368`).

## 8. Test plan (TDD red list)

Core, framework-agnostic (Vitest), written red-first per CLAUDE.md:

**Formation (Change A, `observer.test.ts` / new `fact-extract.test.ts`):**
1. Short thread under `segment_min_tokens` with an explicit preference → extractor
   called on raw new turns → fact persisted **even though `observationId` is null**.
2. Extraction runs regardless of the compaction decision (size / idle / none).
3. Facts written at **project** scope resolved from the thread row (not thread-only).
4. Dedup: same fact text twice → one row (`content_hash`).
5. Supersede: contradicting fact ("favorite number is 7") → old `expired`, new
   `active` (exercise the existing supersede via the raw path).
6. High-watermark: a second writeback over the same turns does **not** re-extract.
7. Fail-open: extractor throws → observation + job status unaffected.
8. Gating: `eager_facts:false` (or `llm.enabled:false`) → no extraction (byte-identical to today).

**Cost levers (Change A, §5.3):**
8a. No-new-user-content skip: a batch of only tool-result / assistant turns past the
    watermark → **no** extraction call is made.
8b. Coalesce on compaction: when `shouldCompact`, facts come from the **single**
    summarize-and-extract call (assert the standalone extractor is **not** called).

**Injection (Change B, `inject.test.ts`):**
9. `loadMemory` loads scope facts and emits a `## Known facts` section.
10. **Cross-thread**: a fact formed on thread A is injected on thread B (same
    project) — the exact failing scenario from §1.
11. Ranking: facts under reflections, above observations; trimmed by score under
    budget pressure.
12. No facts in scope / feature off → section absent (deterministic, no empty header).
13. Stable block: identical (scope, fact set) → byte-identical block (cache stability).
14. Injected fact ids get reinforcement bumped (fire-and-forget, not awaited).

**Config (`memory-schema.test.ts`):**
15. `eager_facts:true` + `llm.enabled:false` → config **refuses to load** (fail-closed).
16. `max_facts_injected` omitted → internal prior; set → takes effect; unknown key → throws.

## 9. Rollout & relation to existing layers

- **Default off.** Repo `config/memory.yaml` keeps `eager_facts` unset → no change
  for fresh deploys until an operator opts in (and enables `memory.llm`).
- **Box (`la.atmy.work`).** Already runs `llm.enabled:true` + `forgetting.enabled:true`;
  enabling `eager_facts:true` would activate both halves and fix the "42" case.
  Deploy via the standard pull + `up -d`; `config/memory.yaml` is operator-owned
  (never overwritten by deploy).
- **Reflector path retained.** The Reflector's observation→fact extraction stays as
  a consolidation backstop; eager raw→fact becomes the primary, earlier source.
  Both feed the same `memory_facts` table through the same supersede, so they
  converge rather than conflict.
- **P8 later.** When fact volume outgrows scope+score selection, P8 swaps the
  injection selector for hybrid retrieval (`forgetting.facts_retrieval.enabled`),
  reusing the facts this proposal forms.

## 10. Open questions for review

1. ~~**Extraction cadence.**~~ **Resolved (§5.3):** reuse the Observer (no new job
   type); batched by the existing open-job lock, coalesced into the summarize call on
   compaction, and skipped when there is no new user-authored content — so the
   per-turn call amplification is ~1.05–1.2× on real workloads, not 2×.
2. **Scope of injected facts.** Project (+ resource) only, or also same-thread
   facts? Proposed: mirror reflections (project + resource), since thread facts
   overlap the live window and observations.
3. **`max_facts_injected` prior.** Suggest an internal prior of ~10–15 facts or a
   token sub-budget fraction; settle empirically after the unit pass.
4. **Salience filter.** Extract *all* atomic facts (mem0 style) vs. only
   high-importance/preference-like facts? Over-extraction pollutes the block (the
   `lukin-personal` debug-noise pollution observed in production is the cautionary
   case). Proposed: rely on the `facts_model` prompt to emit `importance`, and let
   the score-ranked top-K + decay keep low-value facts out of the prompt.
