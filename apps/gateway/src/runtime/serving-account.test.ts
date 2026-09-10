import type { DecisionRecord } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  markServingAccount,
  servedByAccount,
  stampServingAccount,
  withServingAccountCapture,
} from "./serving-account.js";

const ACCT = { providerId: "anthropic", account: "default" };

describe("withServingAccountCapture + markServingAccount (ALS bridge)", () => {
  it("captures the account marked by onSelect inside the run scope", async () => {
    const { result, servingAccount } = await withServingAccountCapture(async () => {
      // Simulates the pool's onSelect firing deep inside routeRequest/execute.
      markServingAccount("anthropic", "default");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(servingAccount).toEqual({ providerId: "anthropic", account: "default" });
  });

  it("captures null when nothing marks an account (configured / non-OAuth provider)", async () => {
    const { result, servingAccount } = await withServingAccountCapture(async () => 42);
    expect(result).toBe(42);
    expect(servingAccount).toBeNull();
  });

  it("markServingAccount outside a run scope is a no-op (never throws)", () => {
    // No active ALS store (e.g. a unit test / non-OAuth path) — fail-open.
    expect(() => markServingAccount("anthropic", "default")).not.toThrow();
  });
});

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

describe("stampServingAccount", () => {
  function decision(
    modelAlias: string | null = "anthropic/claude-opus-4-8",
    attempts: Array<{ alias: string; skipped: boolean }> = [],
  ): DecisionRecord {
    return {
      final: { model_alias: modelAlias },
      provider_attempts: attempts,
      serving_account: null,
    } as unknown as DecisionRecord;
  }

  it("stamps the final subscription account only when the served alias belongs to it", () => {
    const d = decision();
    stampServingAccount(d, ACCT);
    expect(d.serving_account).toEqual({ provider_id: "anthropic", account: "default" });
  });

  it("clears stale selections after fallback to another provider", () => {
    const d = decision("openai/gpt-5");
    stampServingAccount(d, ACCT);
    expect(d.serving_account).toBeNull();
  });

  it("stamps the final attempted subscription account when every provider fails", () => {
    const d = decision(null, [{ alias: "anthropic/claude-opus-4-8", skipped: false }]);
    stampServingAccount(d, ACCT);
    expect(d.serving_account).toEqual({ provider_id: "anthropic", account: "default" });
  });

  it("does not stamp an account when a later provider was attempted or every candidate skipped", () => {
    const laterProvider = decision(null, [
      { alias: "anthropic/claude-opus-4-8", skipped: false },
      { alias: "openai/gpt-5", skipped: false },
    ]);
    stampServingAccount(laterProvider, ACCT);
    expect(laterProvider.serving_account).toBeNull();

    const skipped = decision(null, [{ alias: "anthropic/claude-opus-4-8", skipped: true }]);
    stampServingAccount(skipped, ACCT);
    expect(skipped.serving_account).toBeNull();
  });
});
