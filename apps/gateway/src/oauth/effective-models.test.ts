import {
  createSqliteDb,
  encryptSecret,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import { describe, expect, it } from "vitest";
import { setAccountSettings } from "./account-settings.js";
import type { CodexModelCatalog } from "./codex-model-catalog.js";
import {
  effectiveAccountModels,
  effectiveOAuthAliases,
  effectiveOAuthModelOptions,
} from "./effective-models.js";

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
  meta: Record<string, unknown> | null = null,
): Promise<void> {
  await tokens.upsert({
    providerId,
    account,
    accessEnc: encryptSecret("AT", KEY),
    refreshEnc: encryptSecret("RT", KEY),
    expiresAt: Date.now() + 3_600_000,
    meta: meta === null ? null : JSON.stringify(meta),
    updatedAt: 1,
  });
}

function codexCatalog(
  modelsByAccount: Record<
    string,
    Array<{ slug: string; priority?: number; visibility?: "list" | "hide" | "none" }>
  >,
): CodexModelCatalog {
  return {
    load: async () => null,
    snapshot: (key) => {
      const models = modelsByAccount[key.account];
      if (!models) return undefined;
      return {
        etag: null,
        source: "fresh-cache",
        models: models.map((model) => ({
          slug: model.slug,
          priority: model.priority ?? 1,
          visibility: model.visibility ?? "list",
        })),
      } as ReturnType<CodexModelCatalog["snapshot"]>;
    },
    resolve: () => undefined,
    listRoutable: () => null,
    observeEtag: async () => {},
  };
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

  it("never treats Codex manual settings or curated hints as account entitlement", () => {
    expect(
      effectiveAccountModels(
        { modelsMode: "manual", enabledModels: ["gpt-5.6-sol"] },
        "openai-codex",
      ),
    ).toEqual([]);
    expect(effectiveAccountModels({}, "openai-codex")).toEqual([]);
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
    await bind(tokens, "openai-codex", "default", { accountId: "acc-default" });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol"],
    });
    // Codex bound but not routable yet → no aliases.
    const aliases = await effectiveOAuthAliases(
      { store: tokens, encKey: KEY },
      config,
      new Set(["anthropic", "github-copilot"]),
    );
    expect(aliases).toEqual([]);
    // Once routable, it appears.
    const withCodex = await effectiveOAuthAliases(
      { store: tokens, encKey: KEY },
      config,
      ROUTABLE,
      {
        codexCatalog: codexCatalog({
          default: [{ slug: "gpt-5.6-sol" }],
        }),
      },
    );
    expect(withCodex).toEqual(["openai-codex/gpt-5.6-sol"]);
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

describe("effectiveOAuthModelOptions", () => {
  it("groups the exposing account(s) under each alias (sorted, deduped)", async () => {
    const { tokens, config } = makeStores();
    // Two Codex accounts: both expose Sol; only `default` exposes Luna.
    await bind(tokens, "openai-codex", "default", { accountId: "acc-default" });
    await bind(tokens, "openai-codex", "mylukin", { accountId: "acc-mylukin" });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
    });
    await setAccountSettings(config, KEY, "openai-codex", "mylukin", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol"],
    });
    const options = await effectiveOAuthModelOptions(
      { store: tokens, encKey: KEY },
      config,
      ROUTABLE,
      {
        codexCatalog: codexCatalog({
          default: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.6-luna" }],
          mylukin: [{ slug: "gpt-5.6-sol" }],
        }),
      },
    );
    expect(options).toEqual([
      { alias: "openai-codex/gpt-5.6-luna", accounts: ["default"] },
      { alias: "openai-codex/gpt-5.6-sol", accounts: ["default", "mylukin"] },
    ]);
  });

  it("intersects Codex manual allowlists with the exact account catalog", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "openai-codex", "default", {
      accountId: "workspace-1",
      chatgptUserId: "user-1",
      chatgptPlanType: "business",
    });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol", "gpt-never-entitled"],
    });

    await expect(
      effectiveOAuthModelOptions({ store: tokens, encKey: KEY }, config, ROUTABLE, {
        codexCatalog: codexCatalog({
          default: [{ slug: "gpt-5.6-sol" }, { slug: "codex-auto-review", visibility: "hide" }],
        }),
      }),
    ).resolves.toEqual([{ alias: "openai-codex/gpt-5.6-sol", accounts: ["default"] }]);
  });

  it("keeps a legacy Codex enabledModels allowlist manual when modelsMode is absent", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "openai-codex", "default", { accountId: "workspace-1" });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      enabledModels: ["gpt-5.5"],
    });

    await expect(
      effectiveOAuthModelOptions({ store: tokens, encKey: KEY }, config, ROUTABLE, {
        codexCatalog: codexCatalog({
          default: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.5" }],
        }),
      }),
    ).resolves.toEqual([{ alias: "openai-codex/gpt-5.5", accounts: ["default"] }]);
  });

  it("keeps hidden account models routable in auto mode while leaving display filtering to UI", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "openai-codex", "default", { accountId: "acc-default" });

    await expect(
      effectiveOAuthModelOptions({ store: tokens, encKey: KEY }, config, ROUTABLE, {
        codexCatalog: codexCatalog({
          default: [{ slug: "gpt-5.6-sol" }, { slug: "codex-auto-review", visibility: "hide" }],
        }),
      }),
    ).resolves.toEqual([
      { alias: "openai-codex/codex-auto-review", accounts: ["default"] },
      { alias: "openai-codex/gpt-5.6", accounts: ["default"] },
      { alias: "openai-codex/gpt-5.6-sol", accounts: ["default"] },
    ]);
  });

  it("exposes no Codex aliases when the account has no exact catalog or stale LKG", async () => {
    const { tokens, config } = makeStores();
    await bind(tokens, "openai-codex", "default", { accountId: "acc-default" });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol"],
    });

    await expect(
      effectiveOAuthModelOptions({ store: tokens, encKey: KEY }, config, ROUTABLE, {
        codexCatalog: codexCatalog({}),
      }),
    ).resolves.toEqual([]);
  });
});
