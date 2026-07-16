import { type ConfigStore, createSqliteDb, encryptSecret, SqliteConfigStore } from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  type AccountSettings,
  clearAccountCredentialFailure,
  clearAccountDiscoveredModels,
  getAccountSettings,
  loadAccountSettings,
  loadGlobalOAuthSettings,
  markAccountCredentialFailure,
  resolveAccountModelsMode,
  saveAccountDiscoveredModels,
  saveAccountXaiDiscoveredModels,
  setAccountSettings,
  setGlobalOAuthSettings,
} from "./account-settings.js";

const KEY = Buffer.alloc(32, 7);

function makeConfig(): SqliteConfigStore {
  return new SqliteConfigStore(createSqliteDb(":memory:"));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class DelayedFirstSetConfig implements ConfigStore {
  private readonly values = new Map<string, string>();
  private setCalls = 0;
  readonly firstSet = deferred();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.setCalls += 1;
    if (this.setCalls === 1) await this.firstSet.promise;
    this.values.set(key, value);
  }
}

describe("account-settings", () => {
  const xaiModel = {
    id: "display-grok",
    model: "wire-grok",
    apiBackend: "responses" as const,
    contextWindow: 500_000,
    maxRetries: 0,
    hidden: false,
    supportedInApi: true,
    supportsReasoningEffort: false,
    reasoningEfforts: [],
  };

  it("returns {} when nothing is stored (fail-open)", async () => {
    const config = makeConfig();
    expect(await loadAccountSettings(config, KEY)).toEqual({});
    expect(getAccountSettings({}, "anthropic", "default")).toEqual({});
  });

  it("fails open when an automatic discovery snapshot cannot be persisted", async () => {
    const config: ConfigStore = {
      get: async () => null,
      set: async () => {
        throw new Error("database unavailable");
      },
    };

    await expect(
      saveAccountDiscoveredModels(config, KEY, "anthropic", "default", ["claude-fable-5"]),
    ).resolves.toBe(false);
  });

  it.each([
    ["the settings read throws", async () => Promise.reject(new Error("database unavailable"))],
    ["the ciphertext is invalid", async () => "not-encrypted"],
    ["the decrypted JSON has the wrong shape", async () => encryptSecret("[]", KEY)],
  ])("does not overwrite account settings when %s", async (_label, get) => {
    let writes = 0;
    const config: ConfigStore = {
      get,
      set: async () => {
        writes += 1;
      },
    };

    await expect(
      saveAccountDiscoveredModels(config, KEY, "anthropic", "default", ["claude-fable-5"]),
    ).resolves.toBe(false);
    expect(writes).toBe(0);
  });

  it("preserves a legacy Codex enabledModels allowlist as manual mode", () => {
    expect(
      resolveAccountModelsMode("openai-codex", {
        enabledModels: ["gpt-5.5"],
      }),
    ).toBe("manual");
    expect(
      resolveAccountModelsMode("openai-codex", {
        modelsMode: "manual",
        enabledModels: ["gpt-5.5"],
      }),
    ).toBe("manual");
    expect(resolveAccountModelsMode("openai-codex", {})).toBe("auto");
  });

  it("preserves legacy manual curation semantics for non-Codex providers", () => {
    expect(
      resolveAccountModelsMode("anthropic", {
        enabledModels: ["claude-opus-4-6"],
      }),
    ).toBe("manual");
    expect(resolveAccountModelsMode("anthropic", {})).toBe("auto");
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

  it("persists an encrypted structured xAI LKG and clears stale ids on authoritative empty", async () => {
    const config = makeConfig();

    await expect(saveAccountXaiDiscoveredModels(config, KEY, "heavy", [xaiModel])).resolves.toBe(
      true,
    );
    const encrypted = await config.get("oauth.account_settings");
    expect(encrypted).toContain("v1:");
    expect(encrypted).not.toContain("wire-grok");
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "xai", "heavy"),
    ).toMatchObject({
      discoveredModels: ["display-grok"],
      xaiDiscoveredModels: [xaiModel],
    });

    await expect(saveAccountXaiDiscoveredModels(config, KEY, "heavy", [])).resolves.toBe(true);
    expect(getAccountSettings(await loadAccountSettings(config, KEY), "xai", "heavy")).toEqual({
      xaiDiscoveredModels: [],
    });
  });

  it("revalidates structured xAI LKG rows at read time and drops invalid entries", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "xai", "heavy", {
      xaiDiscoveredModels: [
        xaiModel,
        { ...xaiModel, id: "invalid-zero", model: "invalid-zero", contextWindow: 0 },
      ],
    } as unknown as AccountSettings);

    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "xai", "heavy")
        .xaiDiscoveredModels,
    ).toEqual([xaiModel]);
  });

  it("clears both string and structured model snapshots before credential replacement", async () => {
    const config = makeConfig();
    await saveAccountXaiDiscoveredModels(config, KEY, "heavy", [xaiModel]);

    await expect(clearAccountDiscoveredModels(config, KEY, "xai", "heavy")).resolves.toBe(true);

    expect(getAccountSettings(await loadAccountSettings(config, KEY), "xai", "heavy")).toEqual({});
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

  it("round-trips the Codex autoReset flag and merges it independently", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "openai-codex", "default", { autoReset: true });
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "default"),
    ).toEqual({
      autoReset: true,
    });
    // Toggling autoReset preserves an existing priority.
    await setAccountSettings(config, KEY, "openai-codex", "default", { priority: 7 });
    await setAccountSettings(config, KEY, "openai-codex", "default", { autoReset: false });
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "default"),
    ).toEqual({
      priority: 7,
      autoReset: false,
    });
  });

  it("round-trips the per-account fastMode flag and merges it independently", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "anthropic", "work", { fastMode: true });
    expect(getAccountSettings(await loadAccountSettings(config, KEY), "anthropic", "work")).toEqual(
      { fastMode: true },
    );

    await setAccountSettings(config, KEY, "anthropic", "work", { priority: 7 });
    await setAccountSettings(config, KEY, "anthropic", "work", { fastMode: false });
    expect(getAccountSettings(await loadAccountSettings(config, KEY), "anthropic", "work")).toEqual(
      {
        priority: 7,
        fastMode: false,
      },
    );
  });

  it("marks a credential failure as unhealthy and auto-parks only when not already manually parked", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "openai-codex", "default", { priority: 7 });

    await markAccountCredentialFailure(config, KEY, "openai-codex", "default", {
      at: 12_345,
      reason: "oauth refresh failed (openai-codex, status 401)",
    });

    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "default"),
    ).toEqual({
      priority: 7,
      schedulable: false,
      autoDisabledForCredentialFailure: true,
      credentialFailedAt: 12_345,
      credentialFailureReason: "oauth refresh failed (openai-codex, status 401)",
    });

    await setAccountSettings(config, KEY, "openai-codex", "manual", { schedulable: false });
    await markAccountCredentialFailure(config, KEY, "openai-codex", "manual", {
      at: 20_000,
      reason: "upstream returned 401",
    });
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "manual"),
    ).toMatchObject({
      schedulable: false,
      autoDisabledForCredentialFailure: false,
      credentialFailedAt: 20_000,
    });
  });

  it("clears credential failure on reconnect and only re-enables auto-disabled accounts", async () => {
    const config = makeConfig();
    await markAccountCredentialFailure(config, KEY, "openai-codex", "auto", {
      at: 12_345,
      reason: "oauth refresh failed (openai-codex, status 401)",
    });
    await setAccountSettings(config, KEY, "openai-codex", "manual", { schedulable: false });
    await markAccountCredentialFailure(config, KEY, "openai-codex", "manual", {
      at: 20_000,
      reason: "upstream returned 401",
    });

    await clearAccountCredentialFailure(config, KEY, "openai-codex", "auto");
    await clearAccountCredentialFailure(config, KEY, "openai-codex", "manual");

    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "auto"),
    ).toEqual({});
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "openai-codex", "manual"),
    ).toEqual({ schedulable: false });
  });

  it("round-trips the global account selection strategy independently from account settings", async () => {
    const config = makeConfig();
    await setAccountSettings(config, KEY, "anthropic", "work", { priority: 7 });
    await setGlobalOAuthSettings(config, KEY, { selectionStrategy: "use_expiring" });

    expect(getAccountSettings(await loadAccountSettings(config, KEY), "anthropic", "work")).toEqual(
      {
        priority: 7,
      },
    );
    expect(await loadGlobalOAuthSettings(config, KEY)).toEqual({
      selectionStrategy: "use_expiring",
    });

    await setGlobalOAuthSettings(config, KEY, { selectionStrategy: "low_risk" });
    expect(await loadGlobalOAuthSettings(config, KEY)).toEqual({
      selectionStrategy: "low_risk",
    });
  });

  it("serializes concurrent load-merge-save updates so unrelated accounts are preserved", async () => {
    const config = new DelayedFirstSetConfig();
    const first = setAccountSettings(config, KEY, "anthropic", "work", {
      proxy: { type: "http", host: "proxy-a", port: 8080, password: "secret-a" },
    });
    const second = setAccountSettings(config, KEY, "github-copilot", "default", {
      enabledModels: ["gpt-4o"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    config.firstSet.resolve();
    await Promise.all([first, second]);

    const map = await loadAccountSettings(config, KEY);
    expect(getAccountSettings(map, "anthropic", "work")).toEqual({
      proxy: { type: "http", host: "proxy-a", port: 8080, password: "secret-a" },
    });
    expect(getAccountSettings(map, "github-copilot", "default")).toEqual({
      enabledModels: ["gpt-4o"],
    });
  });
});
