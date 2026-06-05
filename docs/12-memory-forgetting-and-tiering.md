# 12 · Memory: Forgetting & Tiering

> Status: **P0–P7 implemented and tested** (the deterministic forgetting layer);
> **P8 (hybrid fact retrieval) is deferred** (needs embedding infra), and the real
> LLM summarize/merge/extract behind the Observer/Reflector interfaces stays a
> deterministic MVP stub (docs/08). It **extends**
> [08 · Memory Middleware](08-memory-middleware.md) — it does not replace it. The
> observe / Observer / Reflector / inject pipeline described in 08 stays exactly as
> built; this chapter adds a **forgetting strategy** and an explicit **short / mid /
> long-term tier model** on top of it. Everything here is gated behind a single
> config switch (`memory.forgetting.enabled`, default `false`), so the layer is
> **inert** until enabled — the system behaves byte-for-byte like today when the
> flag is off.

## Why this exists

Recall and accumulation are the easy, conventional half of memory: store
everything, search it back. The hard, valuable half is **forgetting** — most of
what a thread says stops mattering as time passes. A memory layer that only grows
becomes a junk drawer: noisier retrieval, bigger prompts, higher cost, worse
routing context.

So memory must do two more things the current pipeline does not:

1. **Tier it.** Not all memory is equal. Recent raw turns, compressed
   observations, and stable reflections live at different timescales and deserve
   different treatment. We make those tiers explicit: **short / mid / long**.
2. **Forget it.** A memory's value decays with time unless it keeps being used.
   We score every tiered memory deterministically, let unused memories fade and
   archive, and let used memories reinforce — the
   [Ebbinghaus forgetting curve](https://en.wikipedia.org/wiki/Forgetting_curve)
   plus spaced-repetition reinforcement, made into a pure function.
3. **Treat time as structure, not metadata.** LLMs are natively bad at time, and
   pure semantic retrieval happily resurrects a stale high-similarity fact as if
   it were still true — "the corrected fact keeps coming back". So temporality is
   a **structural dimension** of this design, not a column we sort by: every
   memory ages through the score, every fact carries bi-temporal validity
   (`valid_from` / `invalid_at` / `expired_at`), and supersede-on-contradiction is
   **not optional**. (Tencent's Agent Memory engine articulates the same rule:
   "时序不是 metadata，而是 Memory OS 的结构维度" — see Prior art below.)

This stays true to the core principles: **deterministic-first** (the score is a
pure, unit-testable function — no LLM, no network), **fail-open** (any forgetting
step that errors degrades to "keep the memory" and logs, never a 5xx), and
**config-as-code** (the whole curve is tuned from `memory.yaml`, fail-closed on
bad config).

## What already exists (the floor we build on)

From [08](08-memory-middleware.md), live in `packages/core/src/memory/`:

```text
memory_messages       raw turns, verbatim            (observe.ts)
   │  Observer (runObserverJob, async, temp-0) compresses OLD raw → one observation
   ▼
memory_observations   dated, ranged, taggable        (observer.ts)
   │  Reflector (runReflectorJob, async) merges a scope's observations → one reflection
   ▼
memory_reflections    stable, VERSIONED, slow-changing (reflector.ts)

inject (assembleInjectedContext): system → project_reflection → resource_reflection
        → thread_observations → recent_raw → current   (under a token budget)
```

The current budget trimmer drops **oldest observations first** and never trims
`recent_raw` / `current`. `memory_observations` already carries a `referenced_at`
column that nothing writes to yet. Both facts are load-bearing below.

## The tier model

We do **not** introduce new databases or a separate "tier" column. A memory's
tier is implied by **which table it lives in**. Movement between tiers is a write
to the next table plus a soft-invalidate of the source — never a cross-store copy.

| Tier | Cognitive analog | Our artifact (table) | Lifespan | In context by default? |
|------|------------------|----------------------|----------|------------------------|
| **Short** | working memory (RAM) | `memory_messages` recent window (`recent_raw`) | seconds–minutes | **Yes** — always injected, **never trimmed** (spec invariant) |
| **Mid** | episodic memory (warm cache) | `memory_observations` | hours–days | one budget slot away; weakest dropped first |
| **Long** | semantic memory (cold store) | `memory_reflections` **+ new `memory_facts`** | weeks–permanent | reflections injected; facts feed reflections |

The mapping is deliberate and complete: **`recent_raw` = short, `observations` =
mid, `reflections` + `facts` = long.** The only new table is `memory_facts`, the
deduplicated, supersedable atomic-fact layer that reflections gesture at today but
do not store discretely.

Promotion is the existing pipeline, read as tier transitions:

```text
short ──Observer (compress)──▶ mid ──Reflector (merge + extract facts)──▶ long
  ▲                                                                         │
  └──────────────── inject (retrieve top-scored back into context) ◀────────┘
```

## The forgetting score

One pure function, identical in SQL and TypeScript, `temperature`-free, no
network, unit-testable. It fuses three **deterministic** primitives mined from the
reference projects: Ebbinghaus exponential recency decay (Generative Agents /
Graphiti), importance as a decay brake (Generative Agents), and access
reinforcement via a frequency term (Cognee / MemoryScope).

```text
score(now) = recency(now) × importance_weight + access_bonus

recency(now)      = 0.5 ^ (age_seconds / half_life_seconds)
age_seconds       = max(0, now − last_referenced_at)
last_referenced_at = coalesce(referenced_at, fallback_ts)   // NEVER null — see below
importance_weight = clamp(importance, importance_floor, importance_ceil)
access_bonus      = access_weight × log1p(reference_count)
```

**`last_referenced_at` is never null.** `referenced_at` starts null (a memory that
has never been re-injected) and is only written by the reinforcement hook. The
score therefore reads it through a **per-tier coalesce fallback** so a fresh or
legacy row can never produce a `NULL` / `NaN` score or be wrongly archived:

| Tier | `fallback_ts` when `referenced_at` is null |
|------|--------------------------------------------|
| observations (mid) | `observed_at` |
| reflections (long) | `updated_at` |
| facts (long) | `created_at` |

The fallback is part of the pure score function (a `coalesce` in SQL, `??` in TS)
and is unit-tested against null-`referenced_at` legacy rows. The migration does
**not** need to backfill `referenced_at`; the coalesce makes a null mean "never
reinforced, age from when it was created", which is exactly correct.

Design rationale:

- **`0.5 ^ (age / half_life)`** is the Ebbinghaus curve `R = e^(−t/S)`
  re-parameterised to a half-life, so `t½ = half_life_seconds`. No `e` / `ln`
  needed — trivially correct in SQLite (`pow(0.5, age/hl)`) and TS (`Math.pow`).
  Recency is the **multiplicative** core, so a stale memory decays toward 0
  regardless of how important it once was.
- **Importance is a multiplier with a floor**, not an addend. `importance_floor >
  0` is the **decay brake**: a vital memory decays slower in effective rank and
  never reaches exactly 0, so it is forgotten **last**.
- **`access_bonus` is additive and uses `log1p`** so the 50th recall does not
  dominate the 5th — reinforcement with diminishing returns. Added *after* the
  recency × importance product so a frequently-used-but-old memory floats back up
  without overpowering a fresh, high-importance one.
- **Reinforcement-on-access updates `last_referenced_at`**, which resets `age` →
  recency jumps back to ~1.0. That is the spaced-repetition effect (each review
  extends retention) achieved by touching one timestamp — no separate stability
  column in v1.

Columns the score reads (all on the tiered rows):

| Column | Type | Meaning |
|--------|------|---------|
| `referenced_at` | epoch ms \| null | last time injected/used — **already exists** on `memory_observations`. Null = never reinforced; the score coalesces to the per-tier `fallback_ts` above |
| `reference_count` | int | times injected/used (the frequency term) |
| `importance` | real [0,1] | salience; the Observer resolves it (explicit summarizer rating, else `priority/10`) and persists it, default 0.5 |
| `status` | text | `active` \| `archived` (decay soft-invalidate) \| `pruned` (retention tombstone: text freed, coverage kept) |
| `expired_at` | epoch ms \| null | supersede stamp; set when a newer fact invalidates this one |

`half_life`, `importance_floor` / `ceil`, and `access_weight` are **config, not
columns** — retuning the curve is a config edit, not a migration, and the score
stays reproducible from `(coalesce(referenced_at, fallback_ts), reference_count,
importance)` + config alone. Read queries filter
`WHERE owner_id = :accountId AND status='active' AND expired_at IS NULL` and order
by `score` — that single predicate makes "forgotten" rows invisible without
deleting them, **and keeps every read account-scoped** (see "Tenant isolation"
below; the existing memory reads already filter `memory_threads.owner_id =
accountId`).

## Eviction, demotion, promotion

All of this runs **off the hot path**, in a new background sweep job
(`memory_jobs.type='decay'`), triggered on the buffer-flush pattern — *N new
observations accumulated* **or** *interval elapsed* — never per request. The hot
path only does reinforcement (see below).

**The one hot-path change — inject-time trim.** Today the budget trimmer drops
observations **oldest-first**. Change only the **drop order** to
**lowest-`score`-first**. Invariants are preserved exactly: `recent_raw` and
`current` are still never trimmed; only the observation drop comparator changes
from `observedAt` asc to `score` asc. Fail-open: if score computation throws, fall
back to the existing oldest-first path.

**The sweep job — deterministic passes, in order** (every pass is scoped to one
`owner_id` / `accountId`; the sweep iterates accounts, never crosses them):

1. **Demote mid → archived (soft-invalidate).**
   `UPDATE memory_observations SET status='archived', archived_at=now WHERE
   status='active' AND score(now) < decay.archive_threshold` — over rows whose
   thread is owned by the swept account. Never deleted (audit-friendly). Archived
   rows stop being injected and stop counting toward the budget.
2. **Promote mid → long (consolidate to facts).** When a scope's active-observation
   token sum crosses `consolidate.trigger_tokens`, the existing **Reflector** runs
   and *additionally* extracts discrete `memory_facts`, each stamped with the
   account's `owner_id` and a `content_hash = sha256(normalized_text)` for
   idempotent ingest. Existing reflection behaviour (versioned, bump-on-change) is
   unchanged; facts are a new sibling output.
3. **Supersede within long (dedup + contradiction).** On fact insert: if
   `(owner_id, content_hash)` matches an existing row → skip (idempotent). If a new
   fact targets the same `(owner_id, subject_key)` (optionally narrowed by
   project/resource/thread) with a newer `valid_from` → stamp the old row
   `expired_at = now` (a pure datetime UPDATE, no LLM). Reads filter
   `owner_id = :accountId AND expired_at IS NULL`. LLM-found contradictions are
   gated behind `consolidate.enable_llm_supersede` (**off by default**; on
   uncertainty, supersede nothing).
4. **Retention (rare, age-only).** Two different operations, because observations
   carry a second identity that facts do not — their `sourceMessageRange` is the
   **coverage marker** inject/observer use to know a raw turn is already
   compressed:
   - **Observations are TOMBSTONED, not deleted** —
     `UPDATE memory_observations SET status='pruned', observation_text='[pruned]',
     tags=NULL WHERE status='archived' AND archived_at < now −
     retention.archived_days`. The bulky text is freed, but the row +
     `sourceMessageRange` are KEPT so coverage survives. A hard `DELETE` here would
     orphan that coverage and resurrect the raw turns into the prefix /
     re-compression (Codex review fix).
   - **Facts are hard-deleted** —
     `DELETE FROM memory_facts WHERE expired_at IS NOT NULL AND expired_at < now −
     retention.facts_expired_days`. Facts have no coverage role, so this is the one
     true `DELETE`. Mirrors the existing `payload_retention_days` cleanup.
   Reflections are **never** deleted.

**Decay never destroys; it hides.** Even retention only *tombstones* observations
(content freed, coverage kept); the single hard delete is aged-out superseded
facts.

**Reflections are a derived cache — decay must rebuild them.** A reflection is
built from a scope's *active* observations, so archiving observations leaves the
already-written reflection stale (it still holds the forgotten content, and inject
keeps emitting it). So pass 1, after it archives rows, **enqueues one Reflector
rebuild per active-reflection scope of the account** (`listActiveReflectionScopes`
→ `enqueueJob('reflector')`, deduped by the open-job index, fully fail-open). The
rebuild re-merges the now-reduced active set and the forgotten content drops out.
When a scope's active set is now **empty**, the Reflector cannot write an empty
reflection (`reflectionText` is `min(1)`), so it **archives** the existing
reflection instead (`archiveReflections`); `getReflection` filters to
`status='active'`, so an archived reflection stops being injected. Without this,
forgetting only cleared the *input* side (observations) and leaked through the
*output* side (reflections).

Content vs coverage reads (the rule the above depends on): `archived` and `pruned`
rows are invisible to **content** reads (the Reflector's merge + fact extraction,
inject's observation layer — all filter `status='active'`), but still returned by
**coverage** reads (inject's recent-raw dedup + the Observer's idempotency check)
so a forgotten observation keeps suppressing its raw turns. A decayed observation
therefore never re-enters a reflection or a fact (Codex review fix).

## Access reinforcement (the loop closer)

The injector already knows exactly which observations / reflections survived the
budget trim and were actually injected. After the prefix is assembled —
**fire-and-forget, never on the synchronous critical path** — enqueue one batched
write:

```sql
UPDATE memory_observations
   SET reference_count = reference_count + 1, referenced_at = :now
 WHERE id IN (:injectedIds)
   AND thread_id IN (SELECT id FROM memory_threads WHERE owner_id = :accountId);
-- and the analogous memory_reflections update (owner_id = :accountId)
```

The `accountId` guard makes reinforcement tenant-safe even though the injected ids
already came from an account-scoped read — defence in depth, matching the existing
read predicates.

Because `referenced_at` already exists on `memory_observations`, observations need
**zero new plumbing** to start reinforcing — only `reference_count` is new.
Fail-open: wrapped in try/catch that only logs; a reinforcement failure leaves the
counters stale (the score just uses the old value) and never affects the response,
which is never awaited on this write.

Effect: an injected memory's `referenced_at` jumps to now → its `recency` resets
to ~1.0 → it survives the next sweep's `archive_threshold` and the next inject's
score-trim. Memories that stop being injected stop being reinforced, decay, and
quietly archive. **That is the whole forgetting loop, closed by touching two
columns.**

## Fact retrieval (P8 — hybrid, deterministic fusion)

v1 (P0–P7) injects facts only via the Reflector (facts feed reflections; nothing
is searched per turn — the stable-prefix rule). Once the fact store has real
volume, scope+score selection alone will under-recall, so **P8** adds hybrid
retrieval over `memory_facts`, aligned with where the field has converged
(Tencent Agent Memory and MemOS both ship sqlite-local hybrid search):

- **Three deterministic signals**, each producing a ranked list per query:
  vector similarity (`sqlite-vec` / `pgvector`, dialect sealed in the adapter),
  full-text (`FTS5` / `tsvector`), and the forgetting **score** itself (so decayed
  facts rank low in retrieval too — retrieval and forgetting share one notion of
  "alive").
- **Fusion is RRF** (`k=60`): rank-based, scale-free, no tuned weights, trivially
  unit-testable — deliberately *not* a learned/hidden fusion like Mem0's.
- **Same invariants**: account-scoped reads (`owner_id = :accountId AND
  expired_at IS NULL`), fail-open (empty or failed recall → request proceeds with
  the v1 prefix), and retrieval results get the same reinforcement bump.
- Gated behind its own flag (`forgetting.facts_retrieval.enabled`, default off);
  schema impact is one nullable `embedding` column on `memory_facts`.

## Schema deltas

### Tenant isolation (read this before the DDL)

Memory in Helm is **already account-scoped**: every `memory_threads` row carries
`owner_id` (= the request's `accountId`, derived from the authenticated key), and
every existing memory read filters on it — `listMessages` /`listObservations` /
`getReflection` all gate on `memory_threads.owner_id = :accountId` (see
`packages/core/src/store/sqlite/memory-store.ts`). `project_id` / `resource_id` /
`thread_id` are **scopes within an account**, never a tenant boundary on their own
(clients pick those IDs and could collide across accounts).

Therefore the new `memory_facts` table **must carry `owner_id` itself** (it has no
guaranteed `memory_threads` parent — a project/resource-level fact may have a null
`thread_id`), and **every fact read, dedup, and supersede predicate must include
`owner_id`**. The `content_hash` dedup index is **account-scoped**
(`UNIQUE(owner_id, content_hash)`), not global — otherwise two accounts asserting
the same fact text would collide. The new `status` columns on observations /
reflections do not change their isolation: those reads already join through
`memory_threads.owner_id`.

### Migration

All additive, all nullable-or-defaulted, so existing rows and existing tests are
untouched. This lands as the **next free inline migration version in
`packages/core/src/store/sqlite/migrate.ts`** — always current max + 1
(**version 18** as of this writing: v17 was taken by issue #97's per-key memory
defaults). The `000N_*.sql` files are legacy and stop at `0004`, so do **not**
add a conflicting `000N_*.sql`. The Postgres adapter gets the same DDL, dialect
differences sealed inside the adapter per CLAUDE.md.

```sql
-- memory_observations: forgetting columns (referenced_at already exists → reused)
ALTER TABLE memory_observations ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_observations ADD COLUMN importance      REAL    NOT NULL DEFAULT 0.5;
ALTER TABLE memory_observations ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active'; -- active | archived
ALTER TABLE memory_observations ADD COLUMN archived_at     INTEGER;
ALTER TABLE memory_observations ADD COLUMN expired_at      INTEGER;

-- memory_reflections: reference tracking + visibility only (reflections are slow-changing)
ALTER TABLE memory_reflections ADD COLUMN referenced_at   INTEGER;
ALTER TABLE memory_reflections ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_reflections ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active';

-- NEW: memory_facts — deduplicated, supersedable atomic-fact layer (long tier).
-- owner_id is the tenant boundary (= accountId); project/resource/thread are
-- in-account scopes and may be null (a fact can be project- or resource-level).
CREATE TABLE IF NOT EXISTS memory_facts (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT    NOT NULL,        -- accountId — the tenant boundary (mirrors memory_threads.owner_id)
  project_id    TEXT,
  resource_id   TEXT,
  thread_id     TEXT,
  subject_key   TEXT    NOT NULL,        -- normalized topic key for same-subject supersede
  fact_text     TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,        -- sha256(normalized_text) — idempotent ingest
  importance    REAL    NOT NULL DEFAULT 0.5,
  reference_count INTEGER NOT NULL DEFAULT 0,
  referenced_at INTEGER,                 -- last_referenced_at (null → score coalesces to created_at)
  valid_from    INTEGER NOT NULL,        -- fact became true (bi-temporal: valid_at)
  invalid_at    INTEGER,                 -- fact became false
  expired_at    INTEGER,                 -- system learned it was superseded
  status        TEXT    NOT NULL DEFAULT 'active',
  source_observation_range TEXT,         -- audit trail back to observations
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- Dedup is ACCOUNT-SCOPED, never global — two accounts may assert the same fact text.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_hash    ON memory_facts (owner_id, content_hash);
CREATE INDEX        IF NOT EXISTS idx_memory_facts_subject ON memory_facts (owner_id, project_id, resource_id, thread_id, subject_key);
CREATE INDEX        IF NOT EXISTS idx_memory_facts_active  ON memory_facts (owner_id, status, expired_at);
```

Per the schema-first rule, the Zod source of truth in
`packages/shared/src/memory/schema.ts` is extended in lockstep: new
optional-with-default fields on `ObservationSchema` / `ReflectionSchema` (so
`ObservationSchema.parse(oldRow)` still passes — the regression guard), plus a new
`FactSchema` / `MemoryFactInputSchema` carrying `ownerId` (a required `accountId`
on the input, never client-supplied). Types come from `z.infer`. The `MemoryStore`
read methods for facts take `{ accountId, … }` exactly like the existing
`listObservations` / `getReflection` signatures.

## Config surface

The `forgetting` block lives in `config/memory.yaml`. Fail-closed on bad config
(Zod, `.strict()`), fail-open at runtime. **Off by default** — with `enabled: false`
the system behaves identically to today.

**File layout note:** `config/memory.yaml` is a **flat** file whose top-level key is
`forgetting:` — there is **no** `memory:` wrapper. The loader mounts the whole file
under the `memory` config key (like `lanes.yaml` → `config.lanes`), so the resulting
config tree is `config.memory.forgetting.*` even though the file itself starts at
`forgetting:`. Copy the snippet below verbatim; a `memory:` wrapper would fail strict
validation (`memory.memory.forgetting`).

```yaml
# config/memory.yaml — copy as-is (top-level is `forgetting:`, no `memory:` wrapper)
forgetting:
  enabled: false                 # master switch — off = today's behaviour exactly
  score:
    half_life_s: 86400           # 1 day; recency = 0.5 ^ (age / half_life)
    importance_floor: 0.1        # decay brake: vital memories never hit 0
    importance_ceil: 1.0
    access_weight: 0.15          # access_bonus = access_weight × log1p(reference_count)
  inject:
    drop_order: score            # score | oldest  (oldest = legacy fallback)
  decay:
    archive_threshold: 0.05      # score below this → soft-archive (mid tier)
    trigger_observations: 50     # buffer-flush gate: run sweep after N new observations
    trigger_interval_s: 3600     # …or this long elapsed, whichever first
  consolidate:
    trigger_tokens: 1024         # mid→long: extract facts when active-obs tokens exceed this
    max_facts_per_subject: 8     # hard cap regardless of LLM output
    enable_llm_supersede: false  # LLM-found contradictions — OFF by default (fail-safe)
  retention:
    archived_days: 30            # tombstone archived observations older than this (rare, audit)
    facts_expired_days: 90       # hard-delete expired facts older than this
  sweep:
    max_iterations: 200          # background-worker bounds (also caps the scorable scan)
    max_wallclock_s: 900
    max_consecutive_errors: 5    # back off, do not loop forever
```

Zod sketch (single source of truth; types via `z.infer`). **Keys are snake_case to
match the YAML** and every object is `.strict()` — exactly the repo convention
(`packages/shared/src/config/schema.ts`). This is load-bearing for fail-closed
config-as-code: with camelCase keys, an operator's `half_life_s` / `drop_order`
would be silently stripped and the default would win; with snake_case keys an
unknown/misspelled key instead **throws at startup** (refuses to boot), and a real
`half_life_s: 3600` actually takes effect. A test asserts a non-default YAML value
round-trips, and an unknown key fails to parse.

```ts
const ScoreSchema = z.object({
  half_life_s:      z.number().positive().default(86400),
  importance_floor: z.number().min(0).max(1).default(0.1),
  importance_ceil:  z.number().min(0).max(1).default(1.0),
  access_weight:    z.number().min(0).default(0.15),
}).strict().refine(s => s.importance_floor <= s.importance_ceil, "importance_floor ≤ importance_ceil");

export const ForgettingSchema = z.object({
  enabled: z.boolean().default(false),
  score:   ScoreSchema.default({}),
  inject:  z.object({ drop_order: z.enum(["score", "oldest"]).default("score") }).strict().default({}),
  decay:   z.object({
    archive_threshold:    z.number().min(0).max(1).default(0.05),
    trigger_observations: z.number().int().positive().default(50),
    trigger_interval_s:   z.number().int().positive().default(3600),
  }).strict().default({}),
  consolidate: z.object({
    trigger_tokens:       z.number().int().positive().default(1024),
    max_facts_per_subject: z.number().int().positive().default(8),
    enable_llm_supersede: z.boolean().default(false),
  }).strict().default({}),
  retention: z.object({
    archived_days:      z.number().int().positive().default(30),
    facts_expired_days: z.number().int().positive().default(90),
  }).strict().default({}),
  sweep: z.object({
    max_iterations:         z.number().int().positive().default(200),
    max_wallclock_s:        z.number().int().positive().default(900),
    max_consecutive_errors: z.number().int().positive().default(5),
  }).strict().default({}),
}).strict();
export type ForgettingConfig = z.infer<typeof ForgettingSchema>;
```

## What we borrow, and from where

The design distils the open-source field down to its **deterministic** primitives
and rejects the parts that conflict with a self-hosted, single-store, low-latency
gateway.

| Borrowed | Source project | Why |
|----------|----------------|-----|
| Ebbinghaus recency decay + reinforcement-on-access | Generative Agents (Park et al.) | Deterministic, unit-testable; the maths core of forgetting |
| **Soft-invalidate via `expired_at`, never delete** | **Graphiti** | Audit-friendly + fail-open (on error, over-retain rather than lose data) |
| **`content_hash` idempotent dedup** | **Mem0** | One pure-function column kills memory bloat from repeated facts |
| Frequency / EWMA access reinforcement | Cognee, MemoryScope | Branch-free, SQL-computable promotion of used memories |
| `buffer → flush` trigger for consolidation | Memobase | Cheap deterministic gate; never runs per request |
| Token-threshold eviction + recursive summary (concept) | Letta / MemGPT | Validates the off-hot-path, budget-driven eviction shape |
| **Rejected:** graph DB (Neo4j), LLM on the hot path, hidden fusion weights | Graphiti / Mem0 / Letta | Break the Drizzle single-store, determinism, and latency constraints |

## Phased rollout (TDD: red → green → refactor)

Existing suites (`observe.test.ts`, `observer.test.ts`, `reflector.test.ts`,
`inject.test.ts`, `memory-schema.test.ts`, the route memory tests) must stay green
at **every** phase. The lever: `forgetting.enabled: false` is the default and is
behaviour-identical to today. Every phase is independently shippable and gated.

| Phase | Adds | Key tests |
|-------|------|-----------|
| **P0** | Pure score fn `memory/forgetting/score.ts`, incl. the `coalesce(referenced_at, fallback_ts)` rule | `age==half_life → recency==0.5`; `age==0 → recency==1`; **null `referenced_at` legacy row → score uses `fallback_ts`, never NaN**; importance floor keeps a stale-but-vital row > 0; `log1p` reinforcement monotonic + diminishing; float determinism pinned to 6 dp. No existing file touched. |
| **P1** | `ForgettingSchema` (snake_case + `.strict()`) + `memory.yaml` loader | valid config infers; a non-default `half_life_s` round-trips and takes effect; an **unknown/misspelled key fails-closed (throws)**; `importance_floor > importance_ceil` fails-closed; missing block → all defaults (`enabled:false`). |
| **P2** | Next free inline migration (**v18** as of writing, in `migrate.ts`, not a `000N_*.sql`) + Zod schema deltas + `memory_facts` (with `owner_id`) | old rows still parse (regression guard); defaults backfill (`status='active'`, `reference_count=0`); **a null-`referenced_at` legacy observation scores via fallback**; a fact write requires `owner_id` and dedups only within that account (two accounts, same `content_hash` → both stored). |
| **P3** | Reinforcement hook `bumpReferences({accountId, ids})` (gated) | bumps only when enabled; a throwing `bumpReferences` does not change returned `messages` (fail-open); only rows of the request's `accountId` are bumped. With flag off, `inject.ts` byte-identical. |
| **P4** | Score-driven inject trim (gated) | under `score`, a high-`reference_count` old observation outlives a never-referenced newer one; comparator throw → oldest-first fallback. Legacy `oldest` path unchanged. |
| **P5** | Extend `MemoryJobTypeSchema` with `decay` + scheduler dispatch + `runDecayJob` sweep (gated, off hot path) | **`MemoryJobTypeSchema.parse('decay')` succeeds and the scheduler routes it to `runDecayJob` (not the reflector fall-through at `scheduler.ts`)**; `decay` job dedupe/enqueue works; archives only sub-threshold active rows of one account; never `recent_raw`; idempotent re-run; bounded loop (iterations / wallclock / consecutive-errors). |
| **P6** | Fact extraction + supersede (gated, deterministic only). Reflector reads **active observations only** (archived/pruned never feed a fact); a deterministic extractor is wired in `server.ts` so the pipeline is live when enabled (pg insert+supersede in one transaction) | identical fact within an account → idempotent skip (`UNIQUE(owner_id, content_hash)`); newer same-`(owner_id, subject_key)` fact → old `expired_at` stamped; reads filter `owner_id = :accountId AND expired_at IS NULL`; an **archived/pruned observation is excluded from the merge + extraction**. Reflector versioning tests unchanged. |
| **P7** | Retention (rare): observations **tombstoned** (`status='pruned'`, text freed, coverage kept); facts **hard-deleted** | tombstone keeps the row + `sourceMessageRange` visible to coverage reads (raw stays covered after prune); facts are the only `DELETE`; never touches `active` or recently-aged rows. |
| **P8** | Hybrid fact retrieval (gated, own flag) — sqlite-vec/pgvector + FTS5 + forgetting-score, fused with RRF(k=60) | RRF fusion is order-stable and scale-free on a fixture; a superseded/archived fact never surfaces; empty/failed recall → request proceeds with the v1 prefix (fail-open); retrieved facts get the reinforcement bump. |

## Open questions (track in implementation-notes.md)

- **True Ebbinghaus stability `S`.** v1 resets recency via `referenced_at`
  (spaced-repetition-by-touch). If we later want stability *growth* (each access
  flattens the curve, not just resets it), add a `stability` real column and grow
  it on access. Deferred — not needed for the forgetting loop.
- **`subject_key` derivation** for fact supersede is the one fuzzy bit:
  deterministic normalization (lowercased tag + entity slug) vs LLM-assigned. v1:
  deterministic from tags; gate the LLM version behind `enable_llm_supersede`.
- **Per-scope half-life.** Config is currently global. If project memories should
  decay slower than thread memories, `half_life_s` can become a per-tier map.
  Easy follow-up; kept flat for v1.
- **Procedural / skill memory.** Tencent Agent Memory and MemOS both formalize
  "successful interaction histories → reusable executable skill units" as a
  first-class memory kind, arguing plain RAG retrieves *information* but not
  *procedures*. We deliberately ship facts/episodes only: for a routing gateway,
  skills belong to the client's agent loop, not the pipe. Revisit **only if**
  Helm grows agent-platform ambitions; if so, skills would be a fourth long-tier
  table under the same score/supersede regime, not a new architecture.

## Non-goals (this chapter)

- No graph database, no multi-hop traversal — a flat `memory_facts` table with
  bi-temporal columns is enough; revisit only if proven necessary.
- No LLM on the request hot path for any forgetting step.
- No hard delete as the forgetting mechanism — decay archives, retention deletes.
- No cross-project memory sharing or global user profile (unchanged from
  [08](08-memory-middleware.md) non-goals).

## Prior art (2025–2026 industry alignment)

A second survey pass over the memory systems open-sourced by ByteDance, Tencent,
and MemTensor confirms this design's direction — and marks where we deliberately
diverge.

| System | What it validates in this design | Where we deliberately differ |
|--------|----------------------------------|------------------------------|
| **Tencent — TencentDB Agent Memory** (closest relative) | "Temporality is a structural dimension of the Memory OS, not metadata" — the stale-fact-resurrection problem our bi-temporal supersede + decay solve; layered write→tier→recall→governance pipeline (= our short/mid/long); sqlite-vec local hybrid search (= our P8); role/permission/privacy isolation (= our `owner_id` scoping) | It exposes write/update/delete as **LLM-callable tools** so the model manages its own memory. We keep the hot path LLM-free and the write path deterministic — more controllable and testable, less flexible. |
| **ByteDance — M3-Agent** (`bytedance-seed/m3-agent`) | The **memory–control dual-thread split**: a background process continuously encodes inputs into structured memory while the reasoning path only retrieves — exactly our observe/Observer (background) vs inject (read) separation | Its multimodal entity graphs (faces, voiceprints, GNN entity linking) are agent-product scope, not gateway scope. Text-only here. |
| **ByteDance — DeerFlow 2.0** | Long-term memory in a vector store + session persistence as table stakes for agent frameworks | Nothing novel to borrow beyond what P8 already covers. |
| **MemTensor — MemOS** (often misattributed to ByteDance) | "Memory is **managed system state, not an index**" (= our versioned reflections / stable prefix); FTS5+vector hybrid local search; their measured ~35% token savings support the stable-prefix cost argument | Its self-evolving skill memory and memory-scheduling OS layer exceed a gateway's mandate (see Open questions). |

Net: the field independently converged on background-encode/foreground-retrieve,
tiered consolidation, temporal supersede, and local hybrid search. This design
adopts those, and stays more conservative than all four on one axis: **no LLM in
the write/maintenance loop by default** — determinism and fail-open over
flexibility.

## References

Reference implementations cloned for study (not vendored, not imported):
Mem0, Graphiti, Letta/MemGPT, Cognee, Memobase, LangMem, A-Mem, MemoryScope.
Industry systems surveyed (2025–2026): TencentDB Agent Memory, ByteDance
M3-Agent (arXiv:2508.09736) & DeerFlow 2.0, MemTensor MemOS.
Literature: Ebbinghaus forgetting curve; Stanford *Generative Agents* retrieval
score (recency · importance · relevance, exponential recency decay); MemGPT
virtual-context paging.
