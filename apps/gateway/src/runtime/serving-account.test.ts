import { describe, expect, it } from "vitest";
import { servedByAccount } from "./serving-account.js";

const ACCT = { providerId: "anthropic", account: "default" };

describe("servedByAccount", () => {
  it("attributes only when the served alias belongs to the marked account's provider", () => {
    // The synthesized OAuth pool serves `<providerId>/<model>` aliases.
    expect(servedByAccount(ACCT, "anthropic/claude-opus-4")).toBe(true);
  });

  it("drops a STALE account after fallback to a different provider", () => {
    // OAuth attempt marked anthropic, but a configured/non-OAuth provider served.
    expect(servedByAccount(ACCT, "zenmux/auto")).toBe(false);
    // Or a DIFFERENT OAuth provider served (cross-provider fallback).
    expect(servedByAccount(ACCT, "openai-codex/gpt-5.5")).toBe(false);
  });

  it("does not attribute on an errored / unknown final (null alias) or no account", () => {
    expect(servedByAccount(ACCT, null)).toBe(false);
    expect(servedByAccount(null, "anthropic/claude-opus-4")).toBe(false);
  });

  it("requires the slash boundary (no prefix-substring false positives)", () => {
    expect(servedByAccount(ACCT, "anthropic-mirror/x")).toBe(false);
  });
});
