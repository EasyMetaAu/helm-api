import { type ModelAliasMap, parseLanesConfig } from "@helm/core";
import { describe, expect, it } from "vitest";
import { resolveCodexCompactModel } from "./codex-compact.js";

const lanes = parseLanesConfig({
  balanced: {
    primary: "openai-codex/gpt-5.6-terra",
    fallback: ["openai/gpt-5.6-terra"],
  },
  "gpt-5.6": {
    primary: "openai-codex/gpt-5.6-sol",
    fallback: ["openai/gpt-5.6-sol"],
  },
  "gpt-5.6-luna": {
    primary: "openai-codex/gpt-5.6-luna",
    fallback: ["economy"],
  },
  economy: {
    primary: "openai/gpt-5.6-luna",
    fallback: [],
  },
});

const modelAliases: ModelAliasMap = {
  "gpt-5.6-sol-*": "gpt-5.6",
};

const oauthAliases = new Set([
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
]);

describe("resolveCodexCompactModel", () => {
  it("resolves a Codex CLI model lane to the subscribed provider slug", () => {
    expect(
      resolveCodexCompactModel({
        requestedModel: "gpt-5.6",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
      }),
    ).toBe("gpt-5.6-sol");
  });

  it("applies versioned model aliases before resolving the lane", () => {
    expect(
      resolveCodexCompactModel({
        requestedModel: "gpt-5.6-sol-20260710",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
      }),
    ).toBe("gpt-5.6-sol");
  });

  it("accepts an exposed provider-prefixed alias and strips the provider prefix", () => {
    expect(
      resolveCodexCompactModel({
        requestedModel: "openai-codex/gpt-5.6-luna",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
      }),
    ).toBe("gpt-5.6-luna");
  });

  it("rejects unavailable, blocked, forbidden-lane, and non-custom requests", () => {
    expect(
      resolveCodexCompactModel({
        requestedModel: "openai-codex/gpt-5.6-luna",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: false,
      }),
    ).toBeNull();
    expect(
      resolveCodexCompactModel({
        requestedModel: "balanced",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
        allowedLanes: ["gpt-5.6"],
      }),
    ).toBeNull();
    expect(
      resolveCodexCompactModel({
        requestedModel: "gpt-5.6-luna",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
        blockedModels: ["openai-codex/gpt-5.6-luna"],
      }),
    ).toBeNull();
    expect(
      resolveCodexCompactModel({
        requestedModel: "gpt-5.6-luna",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
        blockedModels: ["gpt-5.6-luna"],
      }),
    ).toBeNull();
    expect(
      resolveCodexCompactModel({
        requestedModel: "gpt-not-entitled",
        lanes,
        modelAliases,
        oauthAliases,
        allowCustomModel: true,
      }),
    ).toBeNull();
  });
});
