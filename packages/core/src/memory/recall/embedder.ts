// The embedding port (docs/14). CORE stays framework-agnostic: it declares the
// interface; the background embedding job + memory_recall depend on it, and the
// gateway composition root injects the concrete impl (an OpenAI-compatible
// POST /v1/embeddings call against memory.llm.embedding_model). Tests inject a
// deterministic fake.
//
// `embed` takes a batch and returns one Float32Array per input, IN ORDER, each of the
// model's fixed dimensionality. A failure must REJECT — callers fail-open: a query
// embed failure drops the vector leg (recall = FTS+score), a background embed failure
// leaves the fact vector-less (still FTS+score findable) and is retried. Empty input
// ⇒ empty output (no call).
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}
