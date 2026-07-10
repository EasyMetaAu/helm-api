import type { CodexModelInfo, OpenAICodexModelsResult } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexModelCache,
  CodexModelCacheEntry,
  CodexModelCacheKey,
} from "./codex-model-cache.js";
import { createCodexModelCatalog } from "./codex-model-catalog.js";

const KEY: CodexModelCacheKey = {
  providerId: "openai-codex",
  account: "personal",
  accountIdentity: "acc_1",
  clientVersion: "0.144.1",
};

function model(
  slug: string,
  priority = 1,
  overrides: Partial<CodexModelInfo> = {},
): CodexModelInfo {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: "base",
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 372_000,
    max_context_window: 372_000,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: true,
    auto_review_model_override: null,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    ...overrides,
  };
}

function entry(
  models: CodexModelInfo[],
  overrides: Partial<CodexModelCacheEntry> = {},
): CodexModelCacheEntry {
  return {
    ...KEY,
    fetchedAtMs: 1_000,
    etag: '"v1"',
    reasoningIncluded: true,
    models,
    ...overrides,
  };
}

function fakeCache(hit: { entry: CodexModelCacheEntry; fresh: boolean } | null): CodexModelCache {
  return {
    get: vi.fn(async () => hit),
    upsert: vi.fn(async (next) => next),
    renew: vi.fn(async () => (hit ? hit.entry : null)),
  };
}

function remote(models: CodexModelInfo[], etag = '"v2"'): () => Promise<OpenAICodexModelsResult> {
  return vi.fn(async () => ({ models, etag, reasoningIncluded: true }));
}

describe("createCodexModelCatalog", () => {
  it("starts from the bundled Codex catalog when cache and network are unavailable", async () => {
    const bundled = [model("gpt-5.6-sol"), model("gpt-5.6-terra", 2)];
    const catalog = createCodexModelCatalog({
      cache: fakeCache(null),
      bundledModels: bundled,
    });

    await expect(
      catalog.load(KEY, async () => {
        throw new Error("offline");
      }),
    ).resolves.toMatchObject({
      source: "bundled",
      etag: null,
      models: bundled,
    });
    expect(catalog.resolve(KEY, "gpt-5.6-sol")?.slug).toBe("gpt-5.6-sol");
  });

  it("filters bundled fallback models by minimal_client_version", async () => {
    const oldKey = { ...KEY, clientVersion: "0.139.0" };
    const catalog = createCodexModelCatalog({
      cache: fakeCache(null),
      bundledModels: [
        model("gpt-5.6-sol", 1, { minimal_client_version: "0.144.0" }),
        model("gpt-5.5", 2, { minimal_client_version: "0.98.0" }),
      ],
    });

    await expect(
      catalog.load(oldKey, async () => {
        throw new Error("offline");
      }),
    ).resolves.toMatchObject({
      source: "bundled",
      models: [{ slug: "gpt-5.5" }],
    });
    expect(catalog.resolve(oldKey, "gpt-5.6-sol")).toBeUndefined();
  });

  it("filters bundled fallback models with the Codex API version tuple", async () => {
    const oldKey = { ...KEY, clientVersion: "0.139.0" };
    const catalog = createCodexModelCatalog({
      cache: fakeCache(null),
      bundledModels: [
        model("gpt-5.6-sol", 1, { minimal_client_version: [0, 144, 0] }),
        model("gpt-5.5", 2, { minimal_client_version: [0, 98, 0] }),
      ],
    });

    await expect(
      catalog.load(oldKey, async () => {
        throw new Error("offline");
      }),
    ).resolves.toMatchObject({
      source: "bundled",
      models: [{ slug: "gpt-5.5" }],
    });
  });

  it("normalizes prerelease client versions before cache and catalog use", async () => {
    const cache = fakeCache(null);
    const catalog = createCodexModelCatalog({ cache });
    const prereleaseKey = { ...KEY, clientVersion: "0.145.0-alpha.4" };

    await expect(
      catalog.load(prereleaseKey, remote([model("gpt-5.6-sol")])),
    ).resolves.toMatchObject({
      source: "network",
    });

    const normalizedKey = { ...KEY, clientVersion: "0.145.0" };
    expect(cache.get).toHaveBeenCalledWith(normalizedKey);
    expect(cache.upsert).toHaveBeenCalledWith(expect.objectContaining(normalizedKey));
    expect(catalog.snapshot(prereleaseKey)).toEqual(catalog.snapshot(normalizedKey));
  });

  it("fails closed for malformed and oversized client versions", async () => {
    const cache = fakeCache(null);
    const fetchModels = remote([model("gpt-5.6-sol")]);
    const catalog = createCodexModelCatalog({
      cache,
      bundledModels: [model("gpt-5.6-sol")],
    });

    await expect(
      catalog.load({ ...KEY, clientVersion: "latest" }, fetchModels),
    ).resolves.toBeNull();
    await expect(
      catalog.load({ ...KEY, clientVersion: `0.145.0-${"a".repeat(80)}` }, fetchModels),
    ).resolves.toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("uses a fresh account-scoped cache without a network request", async () => {
    const cache = fakeCache({ entry: entry([model("gpt-5.6-sol")]), fresh: true });
    const fetchModels = remote([model("gpt-5.6-terra")]);
    const catalog = createCodexModelCatalog({ cache });

    await expect(catalog.load(KEY, fetchModels)).resolves.toMatchObject({
      source: "fresh-cache",
      etag: '"v1"',
      reasoningIncluded: true,
      models: [{ slug: "gpt-5.6-sol" }],
    });
    expect(fetchModels).not.toHaveBeenCalled();
    expect(catalog.resolve(KEY, "gpt-5.6-sol")?.use_responses_lite).toBe(true);
    expect(catalog.resolve(KEY, "gpt-5.6")?.slug).toBe("gpt-5.6-sol");
  });

  it("refreshes a stale cache and persists the complete remote ModelInfo", async () => {
    const cache = fakeCache({ entry: entry([model("gpt-5.5")]), fresh: false });
    const fetched = [model("gpt-5.6-sol"), model("gpt-5.6-luna", 2)];
    const catalog = createCodexModelCatalog({ cache });

    await expect(catalog.load(KEY, remote(fetched))).resolves.toMatchObject({
      source: "network",
      etag: '"v2"',
      reasoningIncluded: true,
      models: fetched,
    });
    expect(cache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ...KEY,
        etag: '"v2"',
        reasoningIncluded: true,
        models: fetched,
      }),
    );
  });

  it("merges a hidden-only remote response into the bundled catalog like Codex CLI", async () => {
    const bundled = [model("gpt-5.6-sol"), model("gpt-5.5", 3)];
    const hiddenOverride = model("gpt-5.5", 1, { visibility: "hide" });
    const hiddenNew = model("codex-auto-review", 2, { visibility: "hide" });
    const cache = fakeCache(null);
    const catalog = createCodexModelCatalog({
      cache,
      bundledModels: bundled,
    });

    await expect(catalog.load(KEY, remote([hiddenOverride, hiddenNew]))).resolves.toMatchObject({
      source: "network",
      models: [model("gpt-5.6-sol"), hiddenOverride, hiddenNew],
    });
    expect(cache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        models: [hiddenOverride, hiddenNew],
      }),
    );
  });

  it("falls back to stale last-known-good when the network refresh fails", async () => {
    const stale = entry([model("gpt-5.6-terra")]);
    const cache = fakeCache({ entry: stale, fresh: false });
    const catalog = createCodexModelCatalog({ cache });

    await expect(
      catalog.load(KEY, async () => {
        throw new Error("offline");
      }),
    ).resolves.toMatchObject({
      source: "stale-cache",
      etag: '"v1"',
      models: [{ slug: "gpt-5.6-terra" }],
    });
  });

  it("renews TTL on the same response ETag without refetching models", async () => {
    const cache = fakeCache({ entry: entry([model("gpt-5.6-sol")]), fresh: true });
    const fetchModels = vi.fn(
      async (): Promise<OpenAICodexModelsResult> => ({
        models: [model("gpt-5.6-terra")],
        etag: '"v2"',
      }),
    );
    const catalog = createCodexModelCatalog({ cache });
    await catalog.load(KEY, fetchModels);
    fetchModels.mockClear();

    await catalog.observeEtag(KEY, '"v1"', fetchModels);

    expect(cache.renew).toHaveBeenCalledWith(KEY, '"v1"');
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent refreshes for a changed response ETag", async () => {
    const cache = fakeCache({ entry: entry([model("gpt-5.5")]), fresh: true });
    const catalog = createCodexModelCatalog({ cache });
    await catalog.load(KEY, remote([model("gpt-5.5")], '"v1"'));

    let release!: (value: OpenAICodexModelsResult) => void;
    const fetchModels = vi.fn(
      () =>
        new Promise<OpenAICodexModelsResult>((resolve) => {
          release = resolve;
        }),
    );
    const changed = vi.fn();
    const first = catalog.observeEtag(KEY, '"v2"', fetchModels, changed);
    const second = catalog.observeEtag(KEY, '"v2"', fetchModels, changed);
    expect(fetchModels).toHaveBeenCalledTimes(1);

    release({ models: [model("gpt-5.6-sol")], etag: '"v2"' });
    await Promise.all([first, second]);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(catalog.resolve(KEY, "gpt-5.6-sol")).toBeDefined();
  });

  it("combines routable account catalogs into one deterministic Codex response", async () => {
    const catalog = createCodexModelCatalog({ cache: fakeCache(null) });
    const otherKey = { ...KEY, account: "workspace", accountIdentity: "acc_2" };
    await catalog.load(KEY, remote([model("gpt-5.6-sol"), model("gpt-5.6-luna", 3)], '"personal"'));
    await catalog.load(
      otherKey,
      remote([model("gpt-5.6-sol"), model("gpt-5.6-terra", 2)], '"workspace"'),
    );

    const result = catalog.listRoutable([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);

    expect(result?.models.map((item) => item.slug)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(result?.models[0]).toMatchObject({
      slug: "gpt-5.6",
      use_responses_lite: true,
      context_window: 372_000,
    });
    expect(result?.etag).toMatch(/^"helm-codex-[a-f0-9]{64}"$/);
    expect(result?.reasoningIncluded).toBe(true);
    expect(catalog.listRoutable(["not-entitled"])).toBeNull();
  });

  it("does not advertise reasoning-inclusive accounting when any routable account is unknown", async () => {
    const catalog = createCodexModelCatalog({ cache: fakeCache(null), bundledModels: [] });
    const secondKey = { ...KEY, account: "team", accountIdentity: "acc_2" };
    await catalog.load(KEY, remote([model("gpt-5.6-sol")], '"personal"'));
    await catalog.load(secondKey, async () => ({
      models: [model("gpt-5.6-terra")],
      etag: '"team"',
    }));

    expect(
      catalog.listRoutable(["gpt-5.6-sol", "gpt-5.6-terra"], {
        keys: [KEY, secondKey],
      })?.reasoningIncluded,
    ).toBeUndefined();
  });

  it("keeps versioned account snapshots isolated instead of filtering another version", async () => {
    const catalog = createCodexModelCatalog({ cache: fakeCache(null), bundledModels: [] });
    const newerKey = { ...KEY, clientVersion: "0.146.0" };
    await catalog.load(KEY, remote([model("gpt-5.6-sol")], '"older"'));
    await catalog.load(newerKey, remote([model("gpt-5.6-terra")], '"newer"'));

    expect(
      catalog
        .listRoutable(["gpt-5.6-sol", "gpt-5.6-terra"], { keys: [KEY] })
        ?.models.map((item) => item.slug),
    ).toEqual(["gpt-5.6-sol"]);
    expect(
      catalog
        .listRoutable(["gpt-5.6-sol", "gpt-5.6-terra"], { keys: [newerKey] })
        ?.models.map((item) => item.slug),
    ).toEqual(["gpt-5.6-terra"]);
  });

  it("bounds in-memory catalog snapshots by least recently used key", async () => {
    const catalog = createCodexModelCatalog({
      cache: fakeCache(null),
      bundledModels: [],
      maxEntries: 2,
    });
    const first = { ...KEY, clientVersion: "0.145.0" };
    const second = { ...KEY, clientVersion: "0.146.0" };
    const third = { ...KEY, clientVersion: "0.147.0" };
    await catalog.load(first, remote([model("gpt-5.6-sol")]));
    await catalog.load(second, remote([model("gpt-5.6-terra")]));
    expect(catalog.snapshot(first)).toBeDefined();

    await catalog.load(third, remote([model("gpt-5.6-luna")]));

    expect(catalog.snapshot(first)).toBeDefined();
    expect(catalog.snapshot(second)).toBeUndefined();
    expect(catalog.snapshot(third)).toBeDefined();
  });

  it("notifies only after a successful network catalog refresh", async () => {
    const onRefresh = vi.fn();
    const freshCache = fakeCache({ entry: entry([model("gpt-5.5")]), fresh: true });
    const cachedCatalog = createCodexModelCatalog({ cache: freshCache, onRefresh });
    await cachedCatalog.load(KEY, remote([model("gpt-5.6-sol")]));
    expect(onRefresh).not.toHaveBeenCalled();

    const networkCatalog = createCodexModelCatalog({ cache: fakeCache(null), onRefresh });
    await networkCatalog.load(KEY, remote([model("gpt-5.6-sol")]));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await networkCatalog.load({ ...KEY, clientVersion: "0.146.0" }, async () => {
      throw new Error("offline");
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
