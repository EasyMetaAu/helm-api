# 14 — Memory Deep Recall (Hybrid Fact Retrieval + `memory_recall` MCP tool)

> Status: proposed → in implementation.
> Builds on [08 — memory middleware](08-memory-middleware.md),
> [12 — memory forgetting & tiering](12-memory-forgetting-and-tiering.md) (this **implements its deferred P8**),
> [13 — memory admin & MCP](13-memory-admin-and-mcp.md) (this **adds a 7th MCP tool**).

## Problem

`docs/13` shipped six MCP CRUD tools over the long tier (`memory_facts` + `memory_reflections`).
Its `memory_search` is a **substring `LIKE` over `fact_text`** (plus an O(n) JS `includes()` scan of
reflections). That is the *wrong* retrieval for an external agent asking **"what did we discuss /
decide about X"**:

- `LIKE '%成本%'` can never match a fact stored as "cost" — **no cross-lingual recall** (helm usage is
  bilingual zh+en).
- substring match has **no relevance ranking** — every hit is equal; a decayed/superseded fact ranks
  the same as a fresh, central one.
- it ignores the rich ranking signals the fact store already carries (`importance`, `referenceCount`,
  `referencedAt`, bi-temporal `validFrom/invalidAt/expiredAt`).

An MCP consumer now needs **deep history recall**: query-driven, relevance-ranked retrieval over the
distilled memory the small model (`memory.llm` → Observer/Reflector) already produces.

## Solution — implement P8 (hybrid fact retrieval) and expose it as `memory_recall`

`docs/12` already specified the engine and **deferred it** ("needs embedding infra"). This doc builds
exactly that engine and wires one new MCP tool over it. **Nothing about the architecture is new — we
are building helm's own deferred P8.**

- **Retrieval unit = `memory_facts`** (the distilled, cross-session, bi-temporal long tier). Facts carry
  `owner_id` + full scope, so retrieval needs no thread join. Reflections (one rolled-up blob per scope)
  and the raw/observation tiers stay **out of scope** for search, consistent with `docs/13` — they are
  not retrieval units. Complete drill-down to raw history is reachable later via a fact's
  `sourceObservationRange` → observation `sourceMessageRange` chain; it is **not** the primary search
  surface.
- **Three deterministic signals**, each a ranked list per query, fused by **RRF (k=60)**:
  1. **vector** similarity — `sqlite-vec` (SQLite) / `pgvector` (Postgres), dialect sealed in the adapter;
  2. **full-text** — `FTS5` with the **`trigram` tokenizer** (SQLite) / `tsvector` (Postgres);
  3. **forgetting score** — the existing `recency × importance + access_bonus` (so a decayed fact ranks
     low in retrieval too; retrieval and forgetting share one notion of "alive").
- **Bilingual story**: the **multilingual embedding** bridges meaning across zh↔en (the thing keyword
  cannot do); the **trigram FTS** catches literals/identifiers in both scripts (the thing vectors blur —
  `unicode61` does **not** segment CJK, so a whole Chinese run collapses to one token; trigram indexes
  3-char windows and works for CJK + Latin without a segmenter); RRF fuses so neither failure mode
  dominates.
- **Same invariants as P8**: account-scoped reads (`owner_id = :accountId AND expired_at IS NULL`),
  **fail-open** (empty/failed recall → caller still gets a result; a degraded leg never 5xxs), and
  **retrieval results get the reinforcement bump** (recalled facts are "used" → `referenceCount += 1`,
  `referencedAt = now`).

### Why RRF and not weighted-sum

RRF is **rank-based, scale-free, no tuned weights**, order-stable and trivially unit-testable on a
fixture — deliberately *not* a learned/hidden fusion (Mem0). BM25 (unbounded, negative) and cosine
(0–1) live on incompatible scales; RRF consumes ranks, so no normalization is needed.

```
RRF(fact) = Σ_signal  1 / (k + rank_signal(fact)),   k = 60
```

A fact present in only one signal's list contributes one term and is naturally penalized vs a
consensus hit. `k` is a code constant, not config.

## Embedding pipeline

The small model that distills is already wired (`apps/gateway/src/memory-llm.ts` → `chatCompletion`
on a loopback self-HTTP client). Embeddings are the one **net-new** call.

- **Core stays framework-agnostic**: core defines an injected `Embedder` port
  (`embed(texts: string[]): Promise<Float32Array[]>`); the gateway composition root provides the impl
  (an OpenAI-compatible `POST /v1/embeddings` call against the configured model). Tests inject a
  deterministic fake embedder.
- **Off the hot path**: facts are embedded in the **background**. `insertFactsReconciled` already returns
  `{ insertedIds, supersededIds, resurrectedIds }` — exactly the rows needing (or losing) an embedding.
  Embedding runs via a new `"embedding"` memory job (`MemoryJobTypeSchema`), drained by the existing
  worker, so it survives restarts and batches. The request path is never blocked; the only synchronous
  embed is **one query embedding** inside a `memory_recall` call (fail-open to FTS+score if it errors).
- **Config** (`memory.llm`, strict): `embedding_model` (OpenAI-compatible model id / lane; optional —
  **absent ⇒ vector leg disabled**, recall degrades to FTS+score), `embedding_dimensions` (must match
  the model; pins the column width). Default multilingual pick: **bge-m3 (1024-d)** self-hosted via an
  OpenAI-compatible server (e.g. HF TEI); fallback Qwen3-Embedding-0.6B or a managed API. The model is a
  config value, never hardcoded.
- **Versioning**: store `embedding_model` + `embedding_dim` alongside the vector. On a model/dim change,
  re-embed lazily in the background (`WHERE embedding_model != :current`). Never mix vectors from two
  models in one index — cosine across models is meaningless.

## `MemoryStore` port — new method

Optional `?` (additive; existing fakes stay valid). **NOT** added to `REQUIRED_METHODS` /
`MemoryAdminStore` (that gate is shared by the admin route and would fail-close the whole `/mcp` mount
for any adapter lacking it); the `memory_recall` handler **null-checks** `ctx.store.searchFacts` and
degrades to today's `listFacts({ search })` LIKE when absent.

```ts
// Hybrid relevance retrieval over memory_facts (docs/14 / P8). Account-guarded,
// active-only. Vector leg used only when queryEmbedding is provided AND the adapter
// has an embedding column populated; otherwise FTS+score. Order is the contract;
// per-engine scores (bm25 vs ts_rank) are NOT comparable across dialects and are
// internal. FAIL-OPEN at the call site.
searchFacts?(input: {
  accountId: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  queryText: string;                 // raw user keywords (adapter sanitizes to FTS dialect)
  queryEmbedding?: Float32Array;      // absent ⇒ skip the vector leg
  limit: number;                      // top_k after fusion
  now: Date;                          // for the forgetting-score signal
  scoreConfig: ScoreConfig;           // reuse memory.forgetting.score curve
}): Promise<Fact[]>;                  // RRF-ranked, best first
```

`bumpReferences` gains optional `factIds` (back-compat — existing callers pass `[]`) so recalled facts
get the reinforcement bump alongside observations/reflections.

## Schema & migrations

Dialect differences stay inside the adapters; core calls only the port.

### SQLite — migration **v28** (`packages/core/src/store/sqlite/migrate.ts`; current max = 27)

1. `ALTER TABLE memory_facts ADD COLUMN embedding BLOB` (nullable) + `embedding_model TEXT`
   + `embedding_dim INTEGER`.
2. **FTS5 trigram** external-content table over `fact_text` (index only, no text copy) + AI/AD/AU sync
   triggers, `'rebuild'` to backfill existing rows:
   ```sql
   CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
     fact_text, content='memory_facts', content_rowid='rowid', tokenize='trigram');
   INSERT INTO memory_facts_fts(memory_facts_fts) VALUES('rebuild');
   -- + AFTER INSERT/DELETE/UPDATE triggers keeping the index in sync
   ```
3. **sqlite-vec** `vec0` virtual table keyed by `memory_facts.rowid` (only created/queried when the
   extension loads — see load hook below):
   ```sql
   CREATE VIRTUAL TABLE memory_facts_vec USING vec0(
     fact_rowid INTEGER PRIMARY KEY, embedding FLOAT[<dim>]);
   ```
4. `PRAGMA auto_vacuum = INCREMENTAL` discipline (the repo had a free-page bloat incident; deletes from
   the fact tier + vec churn must not leak pages).

`db.exec(m.sql)` runs the whole block at once (multi-statement OK). **`loadExtension` is not called
anywhere today** — add a sqlite-vec load hook adjacent to `applyPragmas`, on **both** connection
openers (`runMigrations` and `createSqliteDb`). If the extension fails to load (missing binary), log and
**continue without the vector leg** (FTS+score still works) — never crash boot.

### Postgres — migration **v27** (`packages/core/src/store/postgres/migrate.ts`; current max = 26)

1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. `ALTER TABLE memory_facts ADD COLUMN embedding vector(<dim>)` (or `halfvec` for half the index) +
   `embedding_model TEXT` + `embedding_dim INTEGER`.
3. `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` and
   `CREATE INDEX ... USING gin (to_tsvector('simple', fact_text))` — `'simple'` config so CJK isn't
   English-stemmed; query via `websearch_to_tsquery` (tolerates arbitrary input).

> **Landmine:** the pg migration runner `splitStatements()` splits on every `;`. Keep all DDL
> semicolon-terminated only (no `;` inside string literals / `WITH (...)`). One statement per `;`.
> PGlite 0.4.6 (tests) bundles pgvector via `@electric-sql/pglite/vector` — thread the `vector`
> extension into the PGlite constructor so the contract tests cover the pg vector path in-process.

## MCP tool — `memory_recall`

Added to the `TOOLS` table in `apps/gateway/src/routes/mcp/tools.ts`.

```
memory_recall(query, projectId?, resourceId?, threadId?, limit?)
```

- `query`: `z.string().min(1)`; `limit`: `1..50`, default 10; scope via the existing `scopeFields` +
  `scopeInput` (project defaults to the key's `defaultProjectId`; **account always from
  `ctx.accountId`, never args**).
- Handler: embed the query (via injected embedder; on failure → `queryEmbedding` omitted), call
  `ctx.store.searchFacts?.(...)`; if the method is absent, **degrade** to `listFacts({ search: query })`.
  Fire the reinforcement bump (fire-and-forget) for the returned fact ids. Return `factView(...)` rows +
  rank order via `ok(...)`.
- Description (drives tool selection): *"Deep relevance search over remembered facts — what was
  discussed/decided about a topic, across sessions. Ranks by meaning (cross-lingual) + keywords +
  recency. Use this for recall; use memory_search for exact substring lookup, memory_list to browse."*

## Config surface (fail-closed, fewest knobs)

Reuse `docs/12`'s gate name; add the embedding fields to the existing `llm` block. All `.strict()`.

```ts
// memory.forgetting.facts_retrieval (docs/12 P8) — master gate for hybrid recall.
facts_retrieval: z.object({
  enabled: z.boolean().default(true),           // ON: FTS+score; false ⇒ memory_recall = LIKE
  top_k: z.number().int().positive().default(10),
}).strict().prefault({}),

// memory.llm additions
embedding_model: z.string().min(1).optional(),        // absent ⇒ vector leg off (FTS+score only)
embedding_dimensions: z.number().int().positive().optional(),
```

- `facts_retrieval.enabled` is **ON by default** (FTS+score, no embedding required) — keyword + recency
  recall, CJK-capable via trigram. Its blast radius is tiny: it ONLY gates the `memory_recall` MCP tool
  (the inject path is untouched) and the tool is fully fail-open, so on-by-default is safe. Configuring
  `embedding_model` additionally lights up the vector leg → full cross-lingual hybrid. Set `enabled:false`
  to force the legacy substring-LIKE behaviour.
- No exposed RRF `k`, no per-signal weights, no tokenizer knob — code constants (no lying knobs).
- `.strict()` ⇒ a typo'd key refuses startup; add the unknown-key tests per `memory-schema.test.ts`.

## Fail-open (the hard rule)

- Query embed fails → omit `queryEmbedding` → FTS+score recall.
- Vector leg errors (extension absent / dim mismatch) → adapter returns FTS+score results.
- Whole `searchFacts` throws → handler catches → degrade to `listFacts({ search })` LIKE.
- Background embedding job fails → logged, fact simply has no vector yet (FTS+score still finds it);
  retried by the worker. **No path 5xxs the request or the tool call.**

## TDD plan (red → green)

| # | File | Red assertion |
|---|---|---|
| 1 | `packages/shared/src/config/memory-schema.test.ts` | `facts_retrieval` defaults backfill; unknown key throws; `embedding_model`/`embedding_dimensions` parse; absent ⇒ undefined. |
| 2 | `packages/shared/src/memory/jobs.test.ts` | `MemoryJobTypeSchema` accepts `"embedding"`; unknown type throws. |
| 3 | `packages/core/src/store/sqlite/memory-search.test.ts` | `searchFacts` over `:memory:`: FTS-only path returns matching facts ranked; **CJK** query `编程语言` matches a fact via trigram; `owner_id` isolation (cross-tenant id → empty); superseded/expired fact never returned. |
| 4 | same | vector leg with a **fake embedding** (deterministic): a semantically-near fact outranks a keyword-only hit; RRF order stable on a fixture. |
| 5 | `packages/core/src/store/store-contract.test.ts` | parity: `searchFacts` on sqlite + PGlite (pgvector + tsvector) return the same match set / relative order on a fixed corpus. |
| 6 | `packages/core/src/store/sqlite/memory-schema.test.ts` | migration v28: `memory_facts_fts` exists + stays in sync on insert/update/delete; backfill via `'rebuild'`; `embedding` column present. |
| 7 | `packages/core/src/store/postgres/migrate.test.ts` | migration v27: GIN + HNSW indexes created; `splitStatements` doesn't choke; idempotent re-run. |
| 8 | `apps/gateway/src/routes/mcp/mcp.test.ts` | `memory_recall`: account from identity not args; scope defaults to key project; **fail-open** (throwing `searchFacts` → degrades to LIKE, no isError 500); reinforcement bump fired; `facts_retrieval.enabled:false` ⇒ degrades. |
| 9 | `packages/core/src/memory/embedding.test.ts` | the background embedding job embeds `insertedIds`, writes `embedding`+`embedding_model`+`embedding_dim`; re-embeds on model change; fail-open on embedder error. |

Write #3 (CJK) and #8 (fail-open) first — the two highest-risk decisions (tokenizer choice,
degradation path).

## Out of scope (deferred, noted so they're not silently dropped)

- Searching **observations / reflections** (only `memory_facts` indexed in this pass).
- **Cross-encoder reranker** (`bge-reranker-v2-m3`) — gated config, default off, future.
- **Raw-history drill-down** tool (resolve `sourceObservationRange` → raw turns).
- A temporal **knowledge graph** (docs/12 "ceiling"; not built).
