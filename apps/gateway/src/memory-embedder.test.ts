import { describe, expect, it, vi } from "vitest";
import { createMemoryEmbedder } from "./memory-embedder.js";

const PROVIDERS = [
  { name: "openai", base_url: "https://api.example.com/v1", api_key_env: "EMB_KEY" },
  { name: "other", base_url: "https://other.example.com/v1" },
];

function okFetch(vectors: number[][]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }),
  })) as unknown as typeof fetch;
}

describe("createMemoryEmbedder (docs/14)", () => {
  it("returns undefined when no embedding_model is configured (vector leg off)", () => {
    expect(
      createMemoryEmbedder({ embeddingModel: undefined, providers: PROVIDERS }),
    ).toBeUndefined();
  });

  it("returns undefined when the provider has no base_url", () => {
    expect(
      createMemoryEmbedder({
        embeddingModel: "missing/model",
        providers: [{ name: "missing" }],
      }),
    ).toBeUndefined();
  });

  it("a PREFIXED model whose provider is absent returns undefined (no fallback to providers[0])", () => {
    // 'typo' is not a configured provider — must NOT silently embed against providers[0]
    // ('openai') with the wrong creds. The vector leg is disabled instead.
    expect(
      createMemoryEmbedder({ embeddingModel: "typo/bge-m3", providers: PROVIDERS }),
    ).toBeUndefined();
  });

  it("a BARE model (no prefix) uses the first provider", () => {
    const embedder = createMemoryEmbedder({ embeddingModel: "bge-m3", providers: PROVIDERS });
    expect(embedder).toBeDefined();
  });

  it("POSTs {base_url}/embeddings with the provider's api key and parses vectors in order", async () => {
    const fetchImpl = okFetch([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const embedder = createMemoryEmbedder({
      embeddingModel: "openai/bge-m3",
      providers: PROVIDERS,
      env: { EMB_KEY: "secret-key" },
      fetchImpl,
    });
    expect(embedder).toBeDefined();
    const out = await embedder?.embed(["hello", "world"]);
    expect(out?.map((v) => [...v])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: "bge-m3",
      input: ["hello", "world"],
    });
  });

  it("empty input ⇒ empty output (no request)", async () => {
    const fetchImpl = okFetch([]);
    const embedder = createMemoryEmbedder({
      embeddingModel: "openai/bge-m3",
      providers: PROVIDERS,
      env: {},
      fetchImpl,
    });
    expect(await embedder?.embed([])).toEqual([]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("rejects on a non-OK response (callers fail-open)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const embedder = createMemoryEmbedder({
      embeddingModel: "openai/bge-m3",
      providers: PROVIDERS,
      env: {},
      fetchImpl,
    });
    await expect(embedder?.embed(["x"])).rejects.toThrow();
  });
});
