import { describe, expect, it } from "vitest";
import { loadBundledCodexModels } from "./codex-bundled-models.js";

describe("loadBundledCodexModels", () => {
  it("loads the complete Codex CLI bundled catalog", () => {
    const models = loadBundledCodexModels();

    expect(models.map((model) => model.slug)).toEqual(
      expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    );
    expect(models.find((model) => model.slug === "gpt-5.6-sol")).toMatchObject({
      use_responses_lite: true,
      prefer_websockets: true,
      multi_agent_version: "v2",
    });
  });
});
