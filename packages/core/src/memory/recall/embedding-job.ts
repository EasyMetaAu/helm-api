import type { ReflectionScope } from "@helm/shared";
import type { MemoryStore } from "../../store/ports.js";
import type { Embedder } from "./embedder.js";

// docs/14 — the background embedding job: fill memory_facts.embedding (+ the sqlite-vec
// vec0 index) for facts that lack a vector, so hybrid recall's vector leg has data.
// Account-scoped, ONE batch per run (re-enqueued by the next observer/reflector fact
// write while any remain). Mirrors runDecayJob: try/catch + updateJobStatus(done|
// failed), fully fail-open — a failure leaves facts vector-less (still FTS+score
// findable) and is retried on the next enqueue.

export interface EmbeddingJob {
  readonly jobId: string;
  readonly scope: ReflectionScope; // account-scoped (scope.accountId)
}

export interface EmbeddingJobDeps {
  memoryStore: MemoryStore;
  embedder: Embedder;
  model: string; // memory.llm.embedding_model (stamped on the row + checked for re-embed)
  dim: number; // memory.llm.embedding_dimensions (the vec0 width)
  batchSize: number;
  log: (line: string, meta?: object) => void;
}

export async function runEmbeddingJob(job: EmbeddingJob, deps: EmbeddingJobDeps): Promise<void> {
  const accountId = job.scope.accountId;
  try {
    const list = deps.memoryStore.listFactsNeedingEmbedding;
    const sink = deps.memoryStore.setFactEmbeddings;
    if (list === undefined || sink === undefined) {
      await deps.memoryStore.updateJobStatus(job.jobId, "failed", "embedding: store lacks methods");
      return;
    }
    const facts = await list.call(deps.memoryStore, {
      accountId,
      model: deps.model,
      dim: deps.dim,
      limit: deps.batchSize,
    });
    if (facts.length === 0) {
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      return;
    }
    const vectors = await deps.embedder.embed(facts.map((f) => f.factText));
    // Pair each fact with its vector, dropping any whose embedding is missing or the
    // wrong width (defensive: a misconfigured model must never poison the vec0 index).
    const items = facts
      .map((f, i) => ({ factId: f.id, embedding: vectors[i], dim: deps.dim, model: deps.model }))
      .filter(
        (it): it is { factId: string; embedding: Float32Array; dim: number; model: string } =>
          it.embedding !== undefined && it.embedding.length === deps.dim,
      );
    if (items.length > 0) await sink.call(deps.memoryStore, { accountId, items });
    await deps.memoryStore.updateJobStatus(job.jobId, "done");
    deps.log("memory.embedding.done", { account_id: accountId, embedded: items.length });
    // A FULL batch likely leaves more unembedded facts (common right after enabling
    // embeddings or changing models on an existing store). Re-enqueue so the worker
    // keeps draining instead of waiting for an unrelated future fact write. GATED on
    // items.length > 0 (progress made) so a batch of only un-embeddable rows — e.g. a
    // dim mismatch the embedder can't satisfy — can't spin forever; the row is now in
    // a 'done' state so the open-job unique index admits the fresh pending row.
    if (facts.length >= deps.batchSize && items.length > 0) {
      try {
        await deps.memoryStore.enqueueJob({ type: "embedding", scope: { accountId } });
      } catch {
        // best-effort — the next fact write re-enqueues.
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.memoryStore.updateJobStatus(job.jobId, "failed", message);
    deps.log("memory.embedding.failed", { account_id: accountId, error: message });
  }
}
