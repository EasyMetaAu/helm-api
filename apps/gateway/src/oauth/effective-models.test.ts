import {
  createSqliteDb,
  encryptSecret,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import { describe, expect, it } from "vitest";
import { setAccountSettings } from "./account-settings.js";
import { effectiveAccountModels, effectiveOAuthAliases } from "./effective-models.js";

const KEY = Buffer.alloc(32, 7);
const ROUTABLE = new Set(["anthropic", "github-copilot", "openai-codex"]);

function makeStores(): { tokens: SqliteOAuthTokenStore; config: SqliteConfigStore } {
  const db = createSqliteDb(":memory:");
  return { tokens: new SqliteOAuthTokenStore(db), config: new SqliteConfigStore(db) };
}

async function bind(
  tokens: SqliteOAuthTokenStore,
  providerId: string,
  account: string,
): Promise<void> {
  await tokens.upsert({
    providerId,
    account,
    accessEnc: encryptSecret("AT", KEY),
    refreshEnc: encryptSecret("RT", KEY),
    expiresAt: Date.now() + 3_600_000,
    meta: null,
    updatedAt: 1,
  });
}

describe("effectiveAccountModels", () => {
  it("returns the saved enabledModels verbatim (incl. ids discovery never reported)", () => {
    expect(
      effectiveAccountModels(
        { enabledModels: ["claude-future-9", "claude-opus-4-6"] },
        "anthropic",
      ),
    ).toEqual(["claude-future-9", "claude-opus-4-6"]);
  });

  it("falls back to the provider's curated set when enabledModels is unset", () => {
    expect(effectiveAccountModels({}, "anthropic")).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("returns [] for an unknown provider with no curated set + no enabled list", () => {
    expect(effectiveAccountModels({}, "mystery")).toEqual([]);
  });
});

describe("effectiveOAuthAliases", () => {
  it("emits provider/model aliases for every bound account's effective set, deduped + sorted", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "anthropic", "default");
    await setAccountSettings(config, KEY, "anthropic", "default", {
      enabledModels: ["claude-opus-4-8", "claude-sonnet-4-6"],
    });
    await bind(tokens, "github-copilot", "mylukin");
    await setAccountSettings(config, KEY, "github-copilot", "mylukin", {
      enabledModels: ["gpt-5.4"],
    });
    const aliases = await effectiveOAuthAliases({ store: tokens, encKey: KEY }, config, ROUTABLE);
    expect(aliases).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-4-6",
      "github-copilot/gpt-5.4",
    ]);
  });

  it("uses the curated fallback for a bound-but-never-curated account", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "anthropic", "default");
    const aliases = await effectiveOAuthAliases({ store: tokens, encKey: KEY }, config, ROUTABLE);
    expect(aliases).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("excludes providers NOT in the routable set (e.g. before its executor is wired)", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "openai-codex", "default");
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      enabledModels: ["gpt-5.5"],
    });
    // Codex bound but not routable yet → no aliases.
    const aliases = await effectiveOAuthAliases(
      { store: tokens, encKey: KEY },
      config,
      new Set(["anthropic", "github-copilot"]),
    );
    expect(aliases).toEqual([]);
    // Once routable, it appears.
    const withCodex = await effectiveOAuthAliases({ store: tokens, encKey: KEY }, config, ROUTABLE);
    expect(withCodex).toEqual(["openai-codex/gpt-5.5"]);
  });

  it("reflects a curation edit on the NEXT read (no caching/snapshot)", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "anthropic", "default");
    await setAccountSettings(config, KEY, "anthropic", "default", { enabledModels: ["claude-a"] });
    expect(await effectiveOAuthAliases({ store: tokens, encKey: KEY }, config, ROUTABLE)).toEqual([
      "anthropic/claude-a",
    ]);
    await setAccountSettings(config, KEY, "anthropic", "default", {
      enabledModels: ["claude-a", "claude-b"],
    });
    expect(await effectiveOAuthAliases({ store: tokens, encKey: KEY }, config, ROUTABLE)).toEqual([
      "anthropic/claude-a",
      "anthropic/claude-b",
    ]);
  });
});
