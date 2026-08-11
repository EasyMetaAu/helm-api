import type { ConfigStore } from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_CACHE_CONFIG_KEY,
  type CodexModelCacheEntry,
  type CodexModelCacheKey,
  createCodexModelCache,
  DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES,
} from "./codex-model-cache.js";

const ENC_KEY = Buffer.alloc(32, 11);
const BASE_KEY: CodexModelCacheKey = {
  providerId: "openai-codex",
  account: "personal",
  accountIdentity: "user-1",
  clientVersion: "0.42.0",
};

function fakeConfigStore(seed: Record<string, string> = {}): ConfigStore & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(seed));
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
}

function entry(overrides: Partial<CodexModelCacheEntry> = {}): CodexModelCacheEntry {
  return {
    ...BASE_KEY,
    fetchedAtMs: 1_000,
    etag: '"models-v1"',
    reasoningIncluded: true,
    models: [{ slug: "gpt-5.6-sol", visibility: "list" }],
    ...overrides,
  };
}

describe("createCodexModelCache", () => {
  it("never reads or writes ConfigStore", async () => {
    const missing = createCodexModelCache(fakeConfigStore(), ENC_KEY);
    await expect(missing.get(BASE_KEY)).resolves.toBeNull();

    const corruptStore = fakeConfigStore({
      [CODEX_MODEL_CACHE_CONFIG_KEY]: "not-an-encrypted-cache",
    });
    const corrupt = createCodexModelCache(corruptStore, ENC_KEY);
    await expect(corrupt.get(BASE_KEY)).resolves.toBeNull();

    const unreadable: ConfigStore = {
      get: async () => {
        throw new Error("storage unavailable");
      },
      set: async () => {
        throw new Error("storage unavailable");
      },
    };
    const unavailable = createCodexModelCache(unreadable, ENC_KEY);
    await expect(unavailable.get(BASE_KEY)).resolves.toBeNull();
    await expect(unavailable.upsert(entry())).resolves.toEqual(entry());
    await expect(unavailable.get(BASE_KEY)).resolves.toMatchObject({ entry: entry() });
    await expect(unavailable.renew(BASE_KEY, '"models-v1"')).resolves.toMatchObject({
      etag: '"models-v1"',
    });
  });

  it("ignores the aggregate legacy blob and stays hot-only", async () => {
    const values = new Map<string, string>([
      [CODEX_MODEL_CACHE_CONFIG_KEY, "legacy-aggregate-blob"],
    ]);
    let legacyReads = 0;
    const store: ConfigStore = {
      get: async (key) => {
        if (key === CODEX_MODEL_CACHE_CONFIG_KEY) legacyReads += 1;
        return values.get(key) ?? null;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
    };
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });

    await expect(cache.get(BASE_KEY)).resolves.toBeNull();
    expect(legacyReads).toBe(0);
    await expect(cache.upsert(entry())).resolves.toEqual(entry());

    const exactKeys = [...values.keys()].filter((key) => key !== CODEX_MODEL_CACHE_CONFIG_KEY);
    expect(exactKeys).toHaveLength(0);
    await expect(
      createCodexModelCache(store, ENC_KEY, { now: () => 1_100 }).get(BASE_KEY),
    ).resolves.toBeNull();
    expect(legacyReads).toBe(0);
  });

  it("returns an exact fresh match from the hot cache", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });

    await cache.upsert(entry());

    expect(store.values.size).toBe(0);
    await expect(cache.get(BASE_KEY)).resolves.toEqual({
      entry: entry(),
      fresh: true,
    });
  });

  it("uses a 300 second default TTL and still exposes an expired exact match as stale LKG", async () => {
    let now = 300_999;
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => now });
    await cache.upsert(entry());

    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });

    now = 301_000;
    await expect(cache.get(BASE_KEY)).resolves.toEqual({
      entry: entry(),
      fresh: false,
    });
  });

  it("honors an already-aborted get without touching the hot cache", async () => {
    const cache = createCodexModelCache(fakeConfigStore(), ENC_KEY, { now: () => 1_100 });
    await cache.upsert(entry());
    const caller = new AbortController();
    caller.abort(new Error("caller disconnected"));

    await expect(cache.get(BASE_KEY, caller.signal)).rejects.toThrow("caller disconnected");
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });
  });

  it("requires provider, account, identity, and client version to all match", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });
    await cache.upsert(entry());

    for (const mismatch of [
      { providerId: "other-provider" },
      { account: "team" },
      { accountIdentity: "user-2" },
      { clientVersion: "0.43.0" },
    ]) {
      await expect(cache.get({ ...BASE_KEY, ...mismatch })).resolves.toBeNull();
    }
  });

  it("normalizes prerelease versions to the same whole-version cache key", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });

    await expect(cache.upsert(entry({ clientVersion: "0.145.0-alpha.4" }))).resolves.toMatchObject({
      clientVersion: "0.145.0",
    });
    await expect(
      cache.get({ ...BASE_KEY, clientVersion: "0.145.0-beta.2" }),
    ).resolves.toMatchObject({
      entry: { clientVersion: "0.145.0" },
    });

    expect(store.values.size).toBe(0);
  });

  it("fails closed for malformed or oversized client versions", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY);

    await expect(cache.upsert(entry({ clientVersion: "latest" }))).resolves.toBeNull();
    await expect(
      cache.upsert(entry({ clientVersion: `0.145.0-${"a".repeat(80)}` })),
    ).resolves.toBeNull();
    await expect(cache.get({ ...BASE_KEY, clientVersion: "latest" })).resolves.toBeNull();
    expect(store.values.has(CODEX_MODEL_CACHE_CONFIG_KEY)).toBe(false);
  });

  it("upserts one exact key while preserving every other account-scoped entry", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 5_000 });
    const other = entry({
      account: "team",
      accountIdentity: "workspace-9",
      etag: '"team-v1"',
      models: [{ slug: "gpt-5.6-terra" }],
    });

    await cache.upsert(entry());
    await cache.upsert(other);
    await cache.upsert(
      entry({
        fetchedAtMs: 4_000,
        etag: '"models-v2"',
        models: [{ slug: "gpt-5.6-luna" }],
      }),
    );

    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({
      entry: {
        fetchedAtMs: 4_000,
        etag: '"models-v2"',
        models: [{ slug: "gpt-5.6-luna" }],
      },
    });
    await expect(
      cache.get({
        providerId: other.providerId,
        account: other.account,
        accountIdentity: other.accountIdentity,
        clientVersion: other.clientVersion,
      }),
    ).resolves.toMatchObject({ entry: other });
  });

  it("renews fetchedAtMs only when the exact entry has the same ETag", async () => {
    let now = 9_000;
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => now });
    await cache.upsert(entry());

    await expect(cache.renew(BASE_KEY, '"other-etag"')).resolves.toBeNull();
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({
      entry: { fetchedAtMs: 1_000 },
    });

    now = 10_000;
    await expect(cache.renew(BASE_KEY, '"models-v1"')).resolves.toEqual(
      entry({ fetchedAtMs: 10_000 }),
    );
    await expect(cache.get(BASE_KEY)).resolves.toEqual({
      entry: entry({ fetchedAtMs: 10_000 }),
      fresh: true,
    });
  });

  it("renews a hot entry without reading or writing ConfigStore", async () => {
    let now = 9_000;
    let reads = 0;
    let writes = 0;
    const store: ConfigStore = {
      get: async () => {
        reads += 1;
        return null;
      },
      set: async () => {
        writes += 1;
      },
    };
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => now });

    await cache.upsert(entry());
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });
    now = 10_000;
    await expect(cache.renew(BASE_KEY, '"models-v1"')).resolves.toMatchObject({
      fetchedAtMs: 10_000,
    });
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({
      entry: { fetchedAtMs: 10_000 },
      fresh: true,
    });

    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it("keeps unrelated account entries across concurrent upserts", async () => {
    const cache = createCodexModelCache(fakeConfigStore(), ENC_KEY, { now: () => 2_000 });
    const teamEntry = entry({
      account: "team",
      accountIdentity: "workspace-9",
      etag: '"team-v1"',
      models: [{ slug: "gpt-5.6-terra" }],
    });
    await Promise.all([cache.upsert(entry()), cache.upsert(teamEntry)]);

    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ entry: entry() });
    await expect(
      cache.get({
        providerId: teamEntry.providerId,
        account: teamEntry.account,
        accountIdentity: teamEntry.accountIdentity,
        clientVersion: teamEntry.clientVersion,
      }),
    ).resolves.toMatchObject({ entry: teamEntry });
  });

  it("bounds the hot cache by newest fetchedAtMs entries", async () => {
    const cache = createCodexModelCache(fakeConfigStore(), ENC_KEY, { maxEntries: 3 });

    for (let index = 1; index <= 5; index += 1) {
      await cache.upsert(
        entry({
          account: `account-${index}`,
          accountIdentity: `identity-${index}`,
          clientVersion: `0.${index}.0`,
          fetchedAtMs: index,
        }),
      );
    }

    await expect(
      cache.get({
        ...BASE_KEY,
        account: "account-1",
        accountIdentity: "identity-1",
        clientVersion: "0.1.0",
      }),
    ).resolves.toBeNull();
    await expect(
      cache.get({
        ...BASE_KEY,
        account: "account-3",
        accountIdentity: "identity-3",
        clientVersion: "0.3.0",
      }),
    ).resolves.toMatchObject({ entry: { fetchedAtMs: 3 } });
    await expect(
      cache.get({
        ...BASE_KEY,
        account: "account-5",
        accountIdentity: "identity-5",
        clientVersion: "0.5.0",
      }),
    ).resolves.toMatchObject({ entry: { fetchedAtMs: 5 } });
    expect(DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES).toBe(64);
  });
});
