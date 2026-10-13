import type { ClientId, ModelsList } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { filterModelsForClient, isModelVisibleForClient } from "./models-list.js";

const aliases = [
  "relay/fast",
  "anthropic/claude-sonnet-4.6",
  "xai/grok-4.5",
  "deepseek/deepseek-v4-pro",
  "relay/gpt-fake",
];
const names = new Map([
  ["relay/fast", "openai/gpt-6.1-sol"],
  ["relay/gpt-fake", "anthropic/claude-opus-5"],
]);
const list: ModelsList = {
  object: "list",
  data: [
    ...["balanced", "auto"].map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "helm",
      type: "lane" as const,
    })),
    ...aliases.map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "relay",
      type: "model" as const,
    })),
  ],
};

describe("client model discovery", () => {
  it.each<[ClientId, string[]]>([
    ["codex_app", ["relay/fast"]],
    ["codex_cli", ["relay/fast"]],
    ["claude_cli", ["anthropic/claude-sonnet-4.6", "relay/gpt-fake"]],
    ["claude_desktop", ["anthropic/claude-sonnet-4.6", "relay/gpt-fake"]],
    ["grok_cli", ["xai/grok-4.5"]],
  ])("filters %s by wire model family and retains lane fallback abstractions", (client, expected) => {
    const before = JSON.stringify(list);
    expect(filterModelsForClient(list, client, names).data.map((m) => m.id)).toEqual([
      "balanced",
      "auto",
      ...expected,
    ]);
    expect(JSON.stringify(list)).toBe(before);
  });
  it("preserves unrestricted discovery and hides unknown families for restricted clients", () => {
    expect(filterModelsForClient(list, undefined, names)).toBe(list);
    expect(filterModelsForClient(list, null, names).data.map((m) => m.id)).toEqual([
      "balanced",
      "auto",
    ]);
    expect(isModelVisibleForClient("openai/o3", "codex_cli")).toBe(true);
    expect(isModelVisibleForClient("codex-mini-latest", "codex_cli")).toBe(true);
    expect(isModelVisibleForClient("not-gpt-6", "codex_cli")).toBe(false);
    expect(isModelVisibleForClient("unknown", "claude_cli")).toBe(false);
  });
});
