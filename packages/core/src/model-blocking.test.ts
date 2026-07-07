import { describe, expect, it } from "vitest";
import { createBlockedModelMatcher } from "./model-blocking.js";

describe("createBlockedModelMatcher", () => {
  it("matches exact model ids case-insensitively", () => {
    const matcher = createBlockedModelMatcher(["GPT-4O"]);

    expect(matcher?.matches("gpt-4o")).toBe(true);
    expect(matcher?.matches("Gpt-4o")).toBe(true);
    expect(matcher?.matches("gpt-4o-mini")).toBe(false);
  });

  it("supports glob wildcards for blocking model families", () => {
    const matcher = createBlockedModelMatcher(["anthropic/*", "claude-?-sonnet"]);

    expect(matcher?.matches("ANTHROPIC/claude-opus-4-8")).toBe(true);
    expect(matcher?.matches("claude-3-sonnet")).toBe(true);
    expect(matcher?.matches("claude-3-5-sonnet")).toBe(false);
    expect(matcher?.matches("openai/gpt-4o")).toBe(false);
  });

  it("treats regex metacharacters as literals", () => {
    const matcher = createBlockedModelMatcher(["gpt-5.5*"]);

    expect(matcher?.matches("gpt-5.5-mini")).toBe(true);
    expect(matcher?.matches("gpt-555-mini")).toBe(false);
  });

  it("ignores blank entries", () => {
    expect(createBlockedModelMatcher([" ", "\n"])).toBeNull();
  });
});
