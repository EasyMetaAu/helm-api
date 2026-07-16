# 14 · Memory Deep Recall

> Current implementation reference, verified against the source on 2026-07-16.
>
> Hybrid fact retrieval (P8) and the MCP `memory_recall` tool are implemented in
> both SQLite and Postgres adapters. Deep recall is an MCP capability only; it
> does not run during ordinary `x-memory-mode: inject` prompt assembly.

Builds on [12 · Forgetting and Tiering](12-memory-forgetting-and-tiering.md) and
[13 · Memory Admin and MCP](13-memory-admin-and-mcp.md).

## Problem and boundary

`memory_search` is a management-style exact substring search. Deep recall needs
better ranking for an agent asking what was discussed or decided about a topic.

The retrieval unit is an active `memory_facts` row. Deep recall does not search:

- raw messages;
- observations;
- reflection text;
- request payloads.

Every read is guarded by `owner_id=accountId`, optional project/resource/thread
scope, `status='active'`, and `expired_at IS NULL`.

## Current retrieval algorithm

`MemoryStore.searchFacts()` over-fetches up to
`max(limit * 5, 50)` candidates per signal and returns at most `limit` facts.

### Candidate signals

1. **Text signal**
   - SQLite: FTS5 external-content table with `trigram`, ordered by BM25.
   - Postgres: `to_tsvector('simple', fact_text)` with
     `websearch_to_tsquery('simple', query)`, ordered by `ts_rank`.
2. **Exact substring fallback**
   - used only when the full-text leg returns no ids;
   - SQLite uses `LIKE`; Postgres uses `ILIKE`;
   - this preserves short literals such as two-character CJK queries that a
     trigram/tsvector query cannot represent well.
3. **Optional vector signal**
   - SQLite: sqlite-vec `vec0` KNN when the extension loaded and a query vector
     was supplied;
   - Postgres: pgvector cosine distance (`<=>`) over non-null embeddings;
   - both current paths are exact/sequential-style searches; Postgres does not
     create an HNSW index in the recall migration.
4. **Forgetting-score signal**
   - computed over the **union of text/vector candidates**, using the fact's
     `created_at` as fallback timestamp;
   - it does not independently scan every live fact into the candidate set.

That last boundary is important: a fact matching neither text nor vector is not
recalled merely because it has a high forgetting score.

### Fusion

The adapter calls `reciprocalRankFusion()` with the ranked text, vector, and
candidate-score id lists:

```text
RRF(id) = sum(1 / (60 + one_based_rank_in_signal))
```

`RRF_K=60` is a code constant. Empty legs contribute nothing. Equal fused scores
are broken by fact id ascending, so output is deterministic for identical input
lists.

## SQLite implementation

Feature DDL landed in SQLite migration **v28**. The current SQLite migration
ledger ends at **v39**; v28 is the feature's historical migration number, not
the current head.

v28 adds:

```sql
ALTER TABLE memory_facts ADD COLUMN embedding BLOB;
ALTER TABLE memory_facts ADD COLUMN embedding_model TEXT;
ALTER TABLE memory_facts ADD COLUMN embedding_dim INTEGER;

CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
  fact_text,
  content='memory_facts',
  content_rowid='rowid',
  tokenize='trigram'
);
```

It rebuilds the FTS index for existing rows and installs insert/delete/update
triggers. The external-content design keeps fact text in `memory_facts`; FTS
stores the index rather than a second authoritative text copy.

`sqlite-vec` is loaded fail-open when a runtime connection opens. Failure to
load it does not fail startup; `$vecLoaded=false` leaves FTS + forgetting score
available.

The `memory_facts_vec` `vec0` table is not created by the migration because its
`FLOAT[dim]` width is runtime config. The store creates it lazily on embedding
write. A dimension change observed by the same store instance drops and
recreates that virtual table before new writes. There is no operator-facing
reindex command; dimension/model changes rely on background re-embedding.

## Postgres implementation

Feature DDL landed in Postgres migration **v27**. The current Postgres migration
ledger ends at **v38**.

v27 executes:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memory_facts ADD COLUMN embedding vector;
ALTER TABLE memory_facts ADD COLUMN embedding_model text;
ALTER TABLE memory_facts ADD COLUMN embedding_dim integer;
CREATE INDEX IF NOT EXISTS idx_memory_facts_fts
  ON memory_facts USING gin (to_tsvector('simple', fact_text));
```

The vector column is intentionally undimensioned and queried with a sequential
distance order. The current migration does not create an HNSW/IVFFlat vector
index.

Unlike SQLite's optional extension load, Postgres migration is fail-closed:
`CREATE EXTENSION vector` must succeed. Supabase/PGlite test targets provide
pgvector; a self-hosted Postgres role/server that cannot create/load the
extension must be prepared before Helm starts.

PGlite tests explicitly register `@electric-sql/pglite/vector` before running
the Postgres migration ledger.

## Embedder contract and gateway implementation

Core defines only:

```ts
interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

The gateway implementation in `apps/gateway/src/memory-embedder.ts` sends a
direct OpenAI-compatible request:

```http
POST <configured-provider.base_url>/embeddings
Content-Type: application/json
Authorization: Bearer <provider env credential, when configured>

{"model":"<provider model>","input":["..."]}
```

There is no Helm `/v1/embeddings` route and this call does not use the memory
LLM self-HTTP Chat Completions path.

Model resolution is intentionally narrow:

- `provider/model` resolves only to the configured provider with that exact
  name and sends `model` after the slash;
- a prefixed model with an unknown provider disables the embedder rather than
  sending private memory text to a different provider;
- a bare model uses the first configured provider;
- lane expansion is not implemented by this direct embedder. Use an actual
  provider/model embedding id rather than a routing lane.

Requests use `memory.llm.timeout_ms` (default 30 seconds) through
`AbortSignal.timeout`.

## Background embedding jobs

`MemoryJobTypeSchema` includes `embedding`. The gateway installs
`runEmbeddingJob` only when all of these exist:

- a resolvable `embedding_model`;
- `embedding_dimensions`;
- the active store's optional embedding methods.

After every Observer or Reflector job, the worker best-effort enqueues one
account-scoped embedding job when embedding dispatch is installed. Open-job
dedup coalesces repeated enqueues.

One embedding job:

1. lists up to 64 active facts whose vector is null or whose stored
   model/dimension differs from config;
2. embeds their fact text as a batch;
3. drops missing/wrong-width model outputs;
4. writes vector + model + dimension with an account guard;
5. marks the job done;
6. if the read was a full batch and at least one valid vector was written,
   enqueues another account job to continue draining.

A job error is marked `failed` and is not reclaimed as the same job. A later
Observer/Reflector completion can enqueue fresh embedding work. Facts remain
searchable through FTS/substrings while vectors are absent.

Manual Admin/MCP fact creation does not itself enqueue an embedding job. Fact
text edits clear the stored vector (and SQLite vec row) to avoid stale semantic
ranking, but also wait for a later Observer/Reflector embedding enqueue. This
means text recall is immediate while vector recall can lag after manual changes.

## Config surface

The current strict Zod fields are:

```yaml
llm:
  # Other memory LLM settings omitted here.
  embedding_model: provider/multilingual-embedding-model
  embedding_dimensions: 1024

forgetting:
  facts_retrieval:
    enabled: true
    top_k: 10

mcp:
  enabled: false
```

Behavior:

- `facts_retrieval.enabled` defaults true and gates only hybrid
  `memory_recall`; false forces the tool to ordinary substring search with
  `degraded:true`;
- `top_k` defaults 10 and is used when the tool call omits `limit`;
- `embedding_model` absent means no query/background vector embedding;
- background embedding requires both model and dimensions;
- the schema currently does **not** cross-validate that model and dimensions are
  supplied together. A model without dimensions can create a query embedder but
  no background population job; dimensions without a model do nothing;
- MCP itself remains default-off, so the default-on retrieval gate has no public
  effect until MCP is enabled.

RRF `k`, signal weights, FTS tokenizer, candidate over-fetch, and embedding batch
size are code constants rather than config knobs.

## `memory_recall` tool contract

Input:

```text
memory_recall({
  query: string,
  limit?: 1..50,
  projectId?: string,
  resourceId?: string,
  threadId?: string
})
```

The account always comes from the MCP identity. Omitted project defaults to the
key's effective project (`memory_project_id ?? key_id`). Omitted limit uses
`facts_retrieval.top_k`.

Call sequence:

1. attempt one query embedding when an embedder is wired;
2. on query-embedding error, omit the vector leg and continue;
3. call `searchFacts` when the gate and adapter method are available;
4. on a whole-search throw, or when disabled/unsupported, call ordinary
   `listFacts({search: query, status:'active'})` and return `degraded:true`;
5. after successful hybrid retrieval, fire-and-forget a fact reference bump.

The degraded LIKE result is a successful MCP tool result, not a 5xx or
`isError`. It does not receive the hybrid path's fact reference bump.

## Failure boundaries

| Failure | Current result |
|---|---|
| Query embedding request fails/times out | Vector leg omitted; text + score continue. |
| SQLite sqlite-vec unavailable or KNN errors | Vector leg omitted; FTS + score continue. |
| Postgres vector query errors | Vector leg omitted inside the adapter; text + score continue. |
| Whole adapter search throws | MCP falls back to substring search and marks `degraded:true`. |
| Background embed call/write fails | Job marked failed; fact remains text-searchable. |
| Model returns wrong vector width | That item is not written; a no-progress full batch is not immediately re-enqueued, preventing a tight loop. |
| Postgres pgvector extension cannot migrate | Startup/migration fails closed. |

The last row is deliberately different from request-path fail-open behavior:
invalid/unavailable required Postgres storage infrastructure is a boot-time
configuration problem, not a serving-path recall miss.

## Current limitations

- Facts only; no observation/reflection/raw-history retrieval.
- No cross-encoder reranker.
- No raw-history drill-down tool from fact citations.
- No vector ANN index in Postgres; current vector order is sequential.
- Score ranks the text/vector candidate union rather than independently
  retrieving high-score facts.
- No manual “re-embed now” Admin/MCP operation.
- No model/dimension pair cross-validation in config.
- No temporal knowledge graph or multi-hop recall.

## Verification map

- RRF: `packages/core/src/memory/recall/rrf.test.ts`
- embedding jobs: `packages/core/src/memory/recall/embedding-job.test.ts`
- gateway embedder: `apps/gateway/src/memory-embedder.test.ts`
- SQLite/PG retrieval: respective `memory-search.test.ts`
- SQLite migration/FTS sync: `packages/core/src/store/sqlite/memory-schema.test.ts`
- Postgres migration/extension path: Postgres migration and memory-search tests
- MCP recall, degradation, scope isolation, and reinforcement:
  `apps/gateway/src/routes/mcp/mcp.test.ts` and `tools.test.ts`.
