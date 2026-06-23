import type { Embedder, MemoryStore, ScoreConfig } from "@helm/core";

// docs/13 — dependencies for the Memory MCP server (mirrors the admin/route DI
// pattern). The composition root (server.ts) wires store.memory + the same
// chars/4 token estimator the rest of memory uses. Only mounted when
// config.memory.mcp.enabled AND the store implements the management surface.
export interface McpDeps {
  memoryStore: MemoryStore;
  now: () => Date;
  estimateTokens: (text: string) => number;
  // Server version reported in the MCP `initialize` handshake (serverInfo.version).
  serverVersion?: string;
  log?: (line: string) => void;
  // docs/14 — hybrid recall (memory_recall). embedder OPTIONAL (absent ⇒ FTS+score).
  // scoreConfig = memory.forgetting.score; recall = memory.forgetting.facts_retrieval.
  embedder?: Embedder;
  scoreConfig: ScoreConfig;
  recall: { enabled: boolean; topK: number };
}
