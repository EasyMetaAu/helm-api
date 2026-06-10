import { describe, expect, it } from "vitest";
import { resolveModelAlias, validateModelAliasTargets } from "./model-alias.js";

describe("resolveModelAlias", () => {
  it("returns null when no map is configured", () => {
    expect(resolveModelAlias("claude-opus-4-8", undefined)).toBeNull();
    expect(resolveModelAlias("claude-opus-4-8", {})).toBeNull();
  });

  it("resolves an exact match", () => {
    expect(resolveModelAlias("claude-opus-4-8", { "claude-opus-4-8": "premium" })).toBe("premium");
  });

  it("resolves a single-* glob match", () => {
    expect(resolveModelAlias("claude-sonnet-4-6", { "claude-sonnet-*": "balanced" })).toBe(
      "balanced",
    );
    // `*` also matches a trailing date suffix Claude Code appends.
    expect(resolveModelAlias("claude-opus-4-8-20260115", { "claude-opus-*": "premium" })).toBe(
      "premium",
    );
  });

  it("an exact key wins over a matching glob", () => {
    const map = { "claude-*": "balanced", "claude-opus-4-8": "premium" };
    expect(resolveModelAlias("claude-opus-4-8", map)).toBe("premium");
  });

  it("prefers the glob with the most literal characters, regardless of declaration order", () => {
    const general = { "claude-*": "balanced", "claude-opus-*": "premium" };
    const reversed = { "claude-opus-*": "premium", "claude-*": "balanced" };
    expect(resolveModelAlias("claude-opus-4-8", general)).toBe("premium");
    expect(resolveModelAlias("claude-opus-4-8", reversed)).toBe("premium");
    // A non-opus claude id still falls to the general catch-all.
    expect(resolveModelAlias("claude-haiku-4-5", general)).toBe("balanced");
  });

  it("returns null when nothing matches", () => {
    expect(resolveModelAlias("gpt-5.5", { "claude-*": "balanced" })).toBeNull();
  });

  it("is case-sensitive (no lowercasing, mirroring the eval-cache-key convention)", () => {
    expect(resolveModelAlias("Claude-Opus", { "claude-*": "balanced" })).toBeNull();
  });

  it("can map a virtual name onto the auto sentinel", () => {
    expect(resolveModelAlias("claude-opus-4-8", { "claude-*": "auto" })).toBe("auto");
  });

  it("treats regex metacharacters in the model name literally", () => {
    // The model is matched as a literal string; `.` in the id is not a wildcard.
    expect(resolveModelAlias("gpt-5.5", { "gpt-5.5": "premium" })).toBe("premium");
    expect(resolveModelAlias("gpt-5x5", { "gpt-5.5": "premium" })).toBeNull();
  });
});

describe("validateModelAliasTargets", () => {
  const lanes = ["economy", "balanced", "premium"];

  it("returns no errors when every target is a known lane or auto", () => {
    const map = { "claude-opus-*": "premium", "claude-*": "balanced", legacy: "auto" };
    expect(validateModelAliasTargets(map, lanes)).toEqual([]);
  });

  it("returns no errors for an absent map", () => {
    expect(validateModelAliasTargets(undefined, lanes)).toEqual([]);
  });

  it("flags a target that is neither a known lane nor auto", () => {
    const errors = validateModelAliasTargets({ "claude-*": "ultra" }, lanes);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("claude-*");
    expect(errors[0]).toContain("ultra");
  });
});
