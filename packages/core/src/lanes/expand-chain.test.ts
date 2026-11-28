import { describe, expect, it } from "vitest";
import { expandLaneChain, lanePriorityMembers } from "./expand-chain.js";
import { LanesConfigSchema } from "./schema.js";

describe("lane priority membership", () => {
  it("takes only direct aliases without changing nested expansion", () => {
    const lanes = LanesConfigSchema.parse({
      sonnet: {
        shared_account_priority: true,
        primary: "anthropic/sonnet",
        fallback: ["keys/sonnet", "kimi", "balanced"],
      },
      kimi: { primary: "kimi-primary", fallback: ["nested/tail", "balanced"] },
      "kimi-primary": { primary: "kimi/k3.1-pro[1m]", fallback: ["primary/fallback"] },
      balanced: { primary: "gpt-sol", fallback: ["sonnet"] },
      "gpt-sol": { primary: "openai-codex/gpt-6.2-sol", fallback: [] },
    });
    expect(lanePriorityMembers("sonnet", lanes)).toEqual(["anthropic/sonnet", "keys/sonnet"]);
    expect(expandLaneChain("sonnet", lanes)).toEqual([
      "anthropic/sonnet",
      "keys/sonnet",
      "kimi/k3.1-pro[1m]",
      "primary/fallback",
      "nested/tail",
      "openai-codex/gpt-6.2-sol",
    ]);
  });
  it("deduplicates direct aliases and ignores lane references including cycles", () => {
    const lanes = LanesConfigSchema.parse({
      a: {
        shared_account_priority: true,
        primary: "b",
        fallback: ["keys/x", "keys/x", "c", "bare-model"],
      },
      b: { primary: "a" },
      c: { primary: "keys/x" },
    });
    expect(lanePriorityMembers("a", lanes)).toEqual(["keys/x"]);
  });
  it.each([
    undefined,
    false,
  ])("leaves legacy lanes without group metadata (%s)", (shared_account_priority) => {
    const lanes = LanesConfigSchema.parse({ a: { primary: "keys/x", shared_account_priority } });
    expect(lanePriorityMembers("a", lanes)).toEqual([]);
  });
});
