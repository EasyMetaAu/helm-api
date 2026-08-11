import {
  type Embedder,
  type ResponseWorkAdmission,
  readUpstreamJsonWithinBudget,
} from "@helm/core";

// docs/14 — the embedding port impl for hybrid recall's vector leg. helm has no
// /v1/embeddings route and ProviderClient has no embeddings method, so this is a thin
// OpenAI-compatible client that POSTs `{base_url}/embeddings` directly against the
// provider that owns `memory.llm.embedding_model` ("provider/model"). Self-hosted TEI,
// OpenAI, Cohere-compat, etc. all expose this shape. The vector leg is OPTIONAL: with
// no embedding_model (or no resolvable provider/base_url) this returns undefined and
// recall runs FTS+score. Keys come from the provider's api_key_env (never plaintext in
// config), matching the rest of helm's credential handling.

interface EmbedderProvider {
  readonly name: string;
  readonly base_url?: string;
  readonly api_key_env?: string;
}

interface OpenAiEmbeddingsResponse {
  data: Array<{ embedding: number[] }>;
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export function createMemoryEmbedder(deps: {
  embeddingModel: string | undefined;
  providers: readonly EmbedderProvider[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  responseWorkAdmission?: ResponseWorkAdmission;
  // Bounds every embeddings request so a stalled endpoint can't hang memory_recall
  // (it fails open to FTS+score) or wedge an embedding worker. Defaults to 30s.
  timeoutMs?: number;
}): Embedder | undefined {
  const model = deps.embeddingModel;
  if (model === undefined) return undefined;

  // "provider/model" → provider name + upstream model id. A PREFIXED model resolves
  // STRICTLY to that provider: a typo'd or removed prefix must NOT fall back to
  // providers[0] (that would send private memory text to the wrong upstream with the
  // wrong model/creds — Codex review). A BARE model (no slash) uses the first provider,
  // mirroring the memory-LLM convention.
  const slash = model.indexOf("/");
  const hasPrefix = slash > 0;
  const providerModel = hasPrefix ? model.slice(slash + 1) : model;
  const provider = hasPrefix
    ? deps.providers.find((p) => p.name === model.slice(0, slash))
    : deps.providers[0];
  if (provider?.base_url === undefined) return undefined; // unresolvable → vector leg off

  const baseUrl = provider.base_url.replace(/\/+$/, "");
  const env = deps.env ?? process.env;
  const apiKey = provider.api_key_env !== undefined ? env[provider.api_key_env] : undefined;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const res = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: providerModel, input: texts }),
        // A bounded timeout so the OPTIONAL vector leg can never block a tool call or
        // stick an embedding worker on one job (callers fail open on reject).
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`embeddings request failed: ${res.status}`);
      const json = await readUpstreamJsonWithinBudget<OpenAiEmbeddingsResponse>(
        res,
        deps.responseWorkAdmission,
      );
      // Preserve input order (OpenAI returns data in request order); be defensive.
      return json.data.map((d) => Float32Array.from(d.embedding));
    },
  };
}
