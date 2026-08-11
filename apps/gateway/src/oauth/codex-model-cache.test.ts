import { type ConfigStore, decryptSecret, encryptSecret } from "@helm/core";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class DelayedFirstSetConfig implements ConfigStore {
  readonly values = new Map<string, string>();
  readonly firstSetStarted = deferred();
  readonly releaseFirstSet = deferred();
  private setCount = 0;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.setCount += 1;
    if (this.setCount === 1) {
      this.firstSetStarted.resolve();
      await this.releaseFirstSet.promise;
    }
    this.values.set(key, value);
  }
}

describe("createCodexModelCache", () => {
  it("fails open when the cache is missing, corrupt, or unreadable", async () => {
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
  });

  it("persists an encrypted blob and returns an exact fresh match", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });

    await cache.upsert(entry());

    const blob = store.values.get(CODEX_MODEL_CACHE_CONFIG_KEY);
    expect(blob).toMatch(/^v1:/);
    expect(blob).not.toContain("gpt-5.6-sol");
    expect(JSON.parse(decryptSecret(blob ?? "", ENC_KEY))).toEqual({
      version: 1,
      entries: [entry()],
    });
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

  it("hydrates the encrypted blob once and serves repeated hot gets from memory", async () => {
    let reads = 0;
    const persisted = encryptSecret(JSON.stringify({ version: 1, entries: [entry()] }), ENC_KEY);
    const base = fakeConfigStore({ [CODEX_MODEL_CACHE_CONFIG_KEY]: persisted });
    const store: ConfigStore = {
      get: async (key) => {
        reads += 1;
        return base.get(key);
      },
      set: (key, value) => base.set(key, value),
    };
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });

    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });
    expect(reads).toBe(1);
  });

  it("keeps one underlying hydration when the first caller disconnects", async () => {
    let reads = 0;
    const loading = deferred();
    const persisted = encryptSecret(JSON.stringify({ version: 1, entries: [entry()] }), ENC_KEY);
    const store: ConfigStore = {
      get: async () => {
        reads += 1;
        await loading.promise;
        return persisted;
      },
      set: async () => {},
    };
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 1_100 });
    const caller = new AbortController();
    const first = cache.get(BASE_KEY, caller.signal);
    caller.abort(new Error("caller disconnected"));

    await expect(first).rejects.toThrow("caller disconnected");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = cache.get(BASE_KEY);
    loading.resolve();

    await expect(second).resolves.toMatchObject({ fresh: true });
    expect(reads).toBe(1);
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

    const blob = store.values.get(CODEX_MODEL_CACHE_CONFIG_KEY);
    expect(JSON.parse(decryptSecret(blob ?? "", ENC_KEY))).toMatchObject({
      entries: [{ clientVersion: "0.145.0" }],
    });
  });

  it("fails closed without persisting malformed or oversized client versions", async () => {
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

  it("renews a hot entry without rereading or rewriting the persistent cache", async () => {
    let now = 9_000;
    let reads = 0;
    let writes = 0;
    const persisted = encryptSecret(JSON.stringify({ version: 1, entries: [entry()] }), ENC_KEY);
    const store: ConfigStore = {
      get: async () => {
        reads += 1;
        return persisted;
      },
      set: async () => {
        writes += 1;
      },
    };
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => now });

    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({ fresh: true });
    now = 10_000;
    await expect(cache.renew(BASE_KEY, '"models-v1"')).resolves.toMatchObject({
      fetchedAtMs: 10_000,
    });
    await expect(cache.get(BASE_KEY)).resolves.toMatchObject({
      entry: { fetchedAtMs: 10_000 },
      fresh: true,
    });

    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  it("serializes concurrent upserts so unrelated accounts are not lost", async () => {
    const store = new DelayedFirstSetConfig();
    const cache = createCodexModelCache(store, ENC_KEY, { now: () => 2_000 });
    const personal = cache.upsert(entry());
    await store.firstSetStarted.promise;
    const teamEntry = entry({
      account: "team",
      accountIdentity: "workspace-9",
      etag: '"team-v1"',
      models: [{ slug: "gpt-5.6-terra" }],
    });
    const team = cache.upsert(teamEntry);

    store.releaseFirstSet.resolve();
    await Promise.all([personal, team]);

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

  it("bounds the encrypted persistent cache by newest fetchedAtMs entries", async () => {
    const store = fakeConfigStore();
    const cache = createCodexModelCache(store, ENC_KEY, { maxEntries: 3 });

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

    const blob = store.values.get(CODEX_MODEL_CACHE_CONFIG_KEY);
    const persisted = JSON.parse(decryptSecret(blob ?? "", ENC_KEY)) as {
      entries: CodexModelCacheEntry[];
    };
    expect(persisted.entries).toHaveLength(3);
    expect(persisted.entries.map((item) => item.fetchedAtMs).sort()).toEqual([3, 4, 5]);
    expect(DEFAULT_CODEX_MODEL_CACHE_MAX_ENTRIES).toBe(64);
  });

  it("drops invalid and excess legacy entries while loading an existing blob", async () => {
    const persisted = {
      version: 1,
      entries: [
        entry({ account: "old", fetchedAtMs: 1 }),
        entry({ account: "new", fetchedAtMs: 3 }),
        entry({ account: "middle", fetchedAtMs: 2 }),
        entry({ account: "invalid", clientVersion: "latest", fetchedAtMs: 4 }),
      ],
    };
    const store = fakeConfigStore({
      [CODEX_MODEL_CACHE_CONFIG_KEY]: encryptSecret(JSON.stringify(persisted), ENC_KEY),
    });
    const cache = createCodexModelCache(store, ENC_KEY, { maxEntries: 2 });

    await expect(cache.get({ ...BASE_KEY, account: "new" })).resolves.toMatchObject({
      entry: { account: "new" },
    });
    await expect(cache.get({ ...BASE_KEY, account: "middle" })).resolves.toMatchObject({
      entry: { account: "middle" },
    });
    await expect(cache.get({ ...BASE_KEY, account: "old" })).resolves.toBeNull();
    await expect(
      cache.get({ ...BASE_KEY, account: "invalid", clientVersion: "latest" }),
    ).resolves.toBeNull();

    const cleaned = JSON.parse(
      decryptSecret(store.values.get(CODEX_MODEL_CACHE_CONFIG_KEY) ?? "", ENC_KEY),
    ) as { entries: CodexModelCacheEntry[] };
    expect(cleaned.entries.map((item) => item.account)).toEqual(["new", "middle"]);
  });
});
