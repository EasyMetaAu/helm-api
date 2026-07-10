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

  it("prefers GPT-5.6 tier-specific aliases over the broad GPT catch-all", () => {
    const map = {
      "gpt-5*": "premium",
      "gpt-5.6-*": "gpt-5.6",
      "gpt-5.6-luna-*": "gpt-5.6-luna",
    };
    expect(resolveModelAlias("gpt-5.6-luna-20260710", map)).toBe("gpt-5.6-luna");
    expect(resolveModelAlias("gpt-5.6-preview", map)).toBe("gpt-5.6");
  });

  it("a keyword-wrapped glob with more literals wins (flash-lite beats flash), order-independent", () => {
    // `gemini-*flash-lite*` (17 literals) is more specific than `gemini-*flash*` (12),
    // so a flash-lite id routes to the cheap tier while full-flash falls to the flash lane.
    const map = { "gemini-*flash-lite*": "economy", "gemini-*flash*": "gemini-flash" };
    const reversed = { "gemini-*flash*": "gemini-flash", "gemini-*flash-lite*": "economy" };
    expect(resolveModelAlias("gemini-3.1-flash-lite", map)).toBe("economy");
    expect(resolveModelAlias("gemini-3.1-flash-lite", reversed)).toBe("economy");
    // A future version id matches the same wildcard with no config change.
    expect(resolveModelAlias("gemini-4-flash-lite-preview", map)).toBe("economy");
    // Full flash (no "lite") is not captured by the flash-lite glob.
    expect(resolveModelAlias("gemini-3.5-flash", map)).toBe("gemini-flash");
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
