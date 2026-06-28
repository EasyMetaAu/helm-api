import { describe, expect, it } from "vitest";
import { promoteRequestedModel } from "./promote-requested-model.js";

// The real `coding` lane chain from production request 1a4adea9 — the client
// asked for `claude-sonnet-4-6` but was served `openai-codex/gpt-5.5` (idx0).
const CHAIN = [
  "openai-codex/gpt-5.5",
  "anthropic/claude-opus-4-8",
  "zenmux-anthropic/claude-opus-4.8",
  "zenmux/gpt-5.5",
  "anthropic/claude-sonnet-4-6",
  "deepseek/deepseek-v4-pro",
  "openrouter/deepseek-v4-pro",
  "zenmux-anthropic/claude-sonnet-4.6",
  "zenmux/auto",
  "openrouter/auto",
];

describe("promoteRequestedModel", () => {
  it("promotes the earliest matching candidate to the front, preserving the rest", () => {
    // `claude-sonnet-4-6` matches anthropic (idx4) AND zenmux dotted (idx7);
    // earliest wins, so the direct-Anthropic alias leads and idx7 stays put.
    expect(promoteRequestedModel(CHAIN, "claude-sonnet-4-6")).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.5",
      "anthropic/claude-opus-4-8",
      "zenmux-anthropic/claude-opus-4.8",
      "zenmux/gpt-5.5",
      "deepseek/deepseek-v4-pro",
      "openrouter/deepseek-v4-pro",
      "zenmux-anthropic/claude-sonnet-4.6",
      "zenmux/auto",
      "openrouter/auto",
    ]);
  });

  it("keeps the result a permutation (no add/drop) of the input", () => {
    const out = promoteRequestedModel(CHAIN, "claude-sonnet-4-6");
    expect([...out].sort()).toEqual([...CHAIN].sort());
  });

  it("picks the earliest when multiple providers share the id", () => {
    const chain = ["x/m0", "a/m1", "b/m2", "c/m1"];
    expect(promoteRequestedModel(chain, "m1")).toEqual(["a/m1", "x/m0", "b/m2", "c/m1"]);
  });

  it("returns the same reference when no candidate matches", () => {
    expect(promoteRequestedModel(CHAIN, "gpt-4o")).toBe(CHAIN);
  });

  it("returns the same reference when the match is already at the front", () => {
    // gpt-5.5 -> gpt-5-5 matches openai-codex/gpt-5.5 at idx0 (also covers
    // dot-normalization on the requested side without a false promotion).
    expect(promoteRequestedModel(CHAIN, "gpt-5.5")).toBe(CHAIN);
  });

  it("is a no-op for auto in any casing/whitespace", () => {
    expect(promoteRequestedModel(CHAIN, "auto")).toBe(CHAIN);
    expect(promoteRequestedModel(CHAIN, "AUTO")).toBe(CHAIN);
    expect(promoteRequestedModel(CHAIN, "  auto  ")).toBe(CHAIN);
  });

  it("is a no-op for an empty requested model", () => {
    expect(promoteRequestedModel(CHAIN, "")).toBe(CHAIN);
  });

  it("is a no-op when the request is a lane name not present as a segment", () => {
    expect(promoteRequestedModel(CHAIN, "balanced")).toBe(CHAIN);
  });

  it("matches a bare alias with no provider slash", () => {
    const chain = ["x/m0", "cheap_model", "y/m1"];
    expect(promoteRequestedModel(chain, "cheap_model")).toEqual(["cheap_model", "x/m0", "y/m1"]);
  });

  it("matches official dashes against a dotted chain alias", () => {
    const chain = ["x/m0", "zenmux-anthropic/claude-sonnet-4.6"];
    expect(promoteRequestedModel(chain, "claude-sonnet-4-6")).toEqual([
      "zenmux-anthropic/claude-sonnet-4.6",
      "x/m0",
    ]);
  });

  it("matches a dotted request against a dashed chain alias (symmetric)", () => {
    const chain = ["x/m0", "anthropic/claude-sonnet-4-6"];
    expect(promoteRequestedModel(chain, "claude-sonnet-4.6")).toEqual([
      "anthropic/claude-sonnet-4-6",
      "x/m0",
    ]);
  });

  it("tolerates casing and surrounding whitespace in the request", () => {
    const chain = ["x/m0", "anthropic/claude-sonnet-4-6"];
    expect(promoteRequestedModel(chain, "  Claude-Sonnet-4-6  ")).toEqual([
      "anthropic/claude-sonnet-4-6",
      "x/m0",
    ]);
  });

  it("prefers the official dashed alias over a dotted one when both match", () => {
    const chain = ["x/m0", "anthropic/claude-sonnet-4-6", "zenmux-anthropic/claude-sonnet-4.6"];
    expect(promoteRequestedModel(chain, "claude-sonnet-4-6")).toEqual([
      "anthropic/claude-sonnet-4-6",
      "x/m0",
      "zenmux-anthropic/claude-sonnet-4.6",
    ]);
  });

  it("returns the same reference for a single-element chain already matching", () => {
    const chain = ["a/m1"];
    expect(promoteRequestedModel(chain, "m1")).toBe(chain);
  });
});
