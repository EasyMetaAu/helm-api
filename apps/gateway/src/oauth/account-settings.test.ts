import { createSqliteDb, SqliteConfigStore } from "@helm/core";
import { describe, expect, it } from "vitest";
import { getAccountSettings, loadAccountSettings, setAccountSettings } from "./account-settings.js";

const KEY = Buffer.alloc(32, 7);

function makeConfig(): SqliteConfigStore {
  return new SqliteConfigStore(createSqliteDb(":memory:"));
}

describe("account-settings", () => {
  it("returns {} when nothing is stored (fail-open)", async () => {
    const config = makeConfig();
    expect(await loadAccountSettings(config, KEY)).toEqual({});
    expect(getAccountSettings({}, "anthropic", "default")).toEqual({});
  });

  it("round-trips an ENCRYPTED map (composite key is opaque)", async () => {
    const config = makeConfig();
    // Write via the setter so the test never depends on the internal separator.
    await setAccountSettings(config, KEY, "anthropic", "default", {
      enabledModels: ["claude-opus-4-6"],
      priority: 10,
    });
    // Stored blob is ciphertext, not plaintext model ids.
    const blob = await config.get("oauth.account_settings");
    expect(blob).toContain("v1:");
    expect(blob).not.toContain("claude-opus-4-6");
    // Decrypts back to the same per-account settings.
    const map = await loadAccountSettings(config, KEY);
    expect(getAccountSettings(map, "anthropic", "default")).toEqual({
      enabledModels: ["claude-opus-4-6"],
      priority: 10,
    });
    // A different account is independent.
    expect(getAccountSettings(map, "anthropic", "other")).toEqual({});
  });

  it("fails open to {} on a corrupt/undecryptable blob", async () => {
    const config = makeConfig();
    await config.set("oauth.account_settings", "not-a-valid-cipher-blob");
    expect(await loadAccountSettings(config, KEY)).toEqual({});
  });

  it("setAccountSettings MERGES a partial patch and preserves other accounts", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "anthropic", "work", { priority: 5 });
    await setAccountSettings(config, KEY, "github-copilot", "default", {
      enabledModels: ["gpt-4o"],
    });
    // Patch the first account again — priority preserved, enabledModels added.
    await setAccountSettings(config, KEY, "anthropic", "work", {
      enabledModels: ["claude-opus-4-6"],
    });
    const map = await loadAccountSettings(config, KEY);
    expect(getAccountSettings(map, "anthropic", "work")).toEqual({
      priority: 5,
      enabledModels: ["claude-opus-4-6"],
    });
    // The unrelated account is untouched.
    expect(getAccountSettings(map, "github-copilot", "default")).toEqual({
      enabledModels: ["gpt-4o"],
    });
  });
});
