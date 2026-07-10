import { describe, expect, it } from "vitest";
import {
  MAX_OPENAI_CODEX_CLIENT_VERSION_LENGTH,
  normalizeOpenAICodexClientVersion,
} from "./codex-client-version.js";

describe("normalizeOpenAICodexClientVersion", () => {
  it("matches Codex CLI by reducing prerelease and build versions to x.y.z", () => {
    expect(normalizeOpenAICodexClientVersion("0.145.0-alpha.4")).toBe("0.145.0");
    expect(normalizeOpenAICodexClientVersion("0.145.0-alpha.4+desktop.7")).toBe("0.145.0");
    expect(normalizeOpenAICodexClientVersion(" 0.145.0 ")).toBe("0.145.0");
  });

  it("fails closed for malformed, non-semver, and oversized values", () => {
    for (const value of [
      "",
      "latest",
      "0.145",
      "v0.145.0",
      "00.145.0",
      "0.145.0-alpha..4",
      "0.145.0-",
      `0.145.0-${"a".repeat(MAX_OPENAI_CODEX_CLIENT_VERSION_LENGTH)}`,
    ]) {
      expect(normalizeOpenAICodexClientVersion(value)).toBeNull();
    }
  });
});
