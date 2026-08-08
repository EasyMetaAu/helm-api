import type { ConfigStore, ResponsesRegistryStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createResponsesRegistry } from "./responses-registry.js";
import type { MessagesIdentity } from "./routes/messages.js";
import type { ResponsesRegistryRecord } from "./routes/responses.js";

function fakeConfigStore(seed: Record<string, string> = {}): ConfigStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

function fakeRegistryStore(): ResponsesRegistryStore {
  const records = new Map<string, ResponsesRegistryRecord>();
  return {
    async upsert(value) {
      records.set(value.responseId, value);
    },
    async insertIfAbsent(value) {
      if (records.has(value.responseId)) return false;
      records.set(value.responseId, value);
      return true;
    },
    async prune({ nowMs, maxEntries }) {
      for (const [id, item] of records) {
        if (item.expiresAt <= nowMs || item.status === "deleted") records.delete(id);
      }
      const newest = [...records.values()].sort(
        (left, right) =>
          right.createdAt - left.createdAt || right.responseId.localeCompare(left.responseId),
      );
      for (const item of newest.slice(maxEntries)) records.delete(item.responseId);
    },
    async getOwnedLive(input) {
      const value = records.get(input.responseId);
      if (!value) return null;
      if (value.accountId !== input.accountId || value.keyId !== input.keyId) return null;
      if (value.expiresAt <= input.nowMs || value.status === "deleted") return null;
      return value;
    },
  };
}

const identity: MessagesIdentity = { keyId: "k1", accountId: "acct" };

function record(over: Partial<ResponsesRegistryRecord> = {}): ResponsesRegistryRecord {
  return {
    responseId: "resp_1",
    accountId: "acct",
    keyId: "k1",
    providerAlias: "responses/gpt-5.5",
    providerName: "openai",
    providerModel: "gpt-5.5",
    providerProtocol: "openai_responses",
    providerAccount: "oauth-a",
    selectedLane: "coding",
    createdAt: 1000,
    expiresAt: 2000,
    status: "completed",
    ...over,
  };
}

describe("createResponsesRegistry", () => {
  it("atomically reserves a registry id without overwriting its original owner", async () => {
    const registry = createResponsesRegistry(fakeRegistryStore(), undefined, { now: () => 1000 });
    const first = record({ responseId: "video-create:req_1", providerAccount: "oauth-a" });

    expect(
      await (
        registry as typeof registry & {
          putIfAbsent(record: ResponsesRegistryRecord): Promise<boolean>;
        }
      ).putIfAbsent(first),
    ).toBe(true);
    expect(
      await (
        registry as typeof registry & {
          putIfAbsent(record: ResponsesRegistryRecord): Promise<boolean>;
        }
      ).putIfAbsent(record({ responseId: "video-create:req_1", providerAccount: "oauth-b" })),
    ).toBe(false);
    await expect(registry.get("video-create:req_1", identity)).resolves.toMatchObject({
      providerAccount: "oauth-a",
    });
  });

  it("persists response ids across fresh registry instances", async () => {
    const store = fakeRegistryStore();
    await createResponsesRegistry(store, undefined, { now: () => 1000 }).put(record());

    const fresh = createResponsesRegistry(store, undefined, { now: () => 1000 });
    await expect(fresh.get("resp_1", identity)).resolves.toMatchObject({
      responseId: "resp_1",
      providerName: "openai",
      providerProtocol: "openai_responses",
      providerAccount: "oauth-a",
      selectedLane: "coding",
    });
  });

  it("prunes expired records and returns null", async () => {
    const store = fakeRegistryStore();
    const registry = createResponsesRegistry(store, undefined, { now: () => 3000 });
    await registry.put(record({ expiresAt: 2000 }));
    await expect(registry.get("resp_1", identity)).resolves.toBeNull();
  });

  it("preserves concurrent writes from independent gateway instances", async () => {
    const store = fakeRegistryStore();
    const first = createResponsesRegistry(store, undefined, { now: () => 1000 });
    const second = createResponsesRegistry(store, undefined, { now: () => 1000 });

    await Promise.all([
      first.put(record({ responseId: "resp_1" })),
      second.put(record({ responseId: "resp_2" })),
    ]);

    const fresh = createResponsesRegistry(store, undefined, { now: () => 1000 });
    await expect(fresh.get("resp_1", identity)).resolves.toMatchObject({ responseId: "resp_1" });
    await expect(fresh.get("resp_2", identity)).resolves.toMatchObject({ responseId: "resp_2" });
  });

  it("keeps high-cardinality writes keyed and prunes at most once per five minutes", async () => {
    let now = 1_000;
    const upsert = vi.fn(async () => {});
    const prune = vi.fn(async () => {});
    const legacyHotPath = vi.fn(async () => {});
    const store = {
      upsert,
      prune,
      upsertAndPrune: legacyHotPath,
      getOwnedLive: async () => null,
    } as unknown as ResponsesRegistryStore;
    const registry = createResponsesRegistry(store, undefined, { now: () => now });

    await Promise.all(
      Array.from({ length: 10_001 }, (_, index) =>
        registry.put(record({ responseId: `resp_${index}`, createdAt: index })),
      ),
    );

    expect(upsert).toHaveBeenCalledTimes(10_001);
    expect(legacyHotPath).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();

    now += 5 * 60_000;
    await registry.put(record({ responseId: "resp_due", createdAt: now }));
    expect(prune).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledWith({ nowMs: now, maxEntries: 10_000, limit: 1_000 });
  });

  it("applies the same bounded prune cadence to atomic media reservations", async () => {
    let now = 1_000;
    const insertIfAbsent = vi.fn(async () => true);
    const prune = vi.fn(async () => {});
    const store = {
      insertIfAbsent,
      prune,
      upsert: async () => {},
      getOwnedLive: async () => null,
    } as unknown as ResponsesRegistryStore;
    const registry = createResponsesRegistry(store, undefined, { now: () => now });

    await registry.putIfAbsent(record({ responseId: "video-create:req_1" }));
    expect(prune).not.toHaveBeenCalled();

    now += 5 * 60_000;
    await registry.putIfAbsent(record({ responseId: "video:req_1" }));
    expect(prune).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledWith({ nowMs: now, maxEntries: 10_000, limit: 1_000 });
  });

  it("keeps a successful atomic reservation when best-effort pruning fails", async () => {
    let now = 1_000;
    const insertIfAbsent = vi.fn(async () => true);
    const prune = vi.fn(async () => {
      throw new Error("prune unavailable");
    });
    const store = {
      insertIfAbsent,
      prune,
      upsert: async () => {},
      getOwnedLive: async () => null,
    } as unknown as ResponsesRegistryStore;
    const registry = createResponsesRegistry(store, undefined, { now: () => now });

    await registry.putIfAbsent(record({ responseId: "video-create:req_1" }));
    now += 5 * 60_000;

    await expect(registry.putIfAbsent(record({ responseId: "video:req_1" }))).resolves.toBe(true);
    expect(prune).toHaveBeenCalledOnce();
  });

  it("serves a continuation while its registry write is still pending", async () => {
    let release!: () => void;
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: ResponsesRegistryStore = {
      upsert: async () => persistence,
      insertIfAbsent: async () => false,
      prune: async () => {},
      getOwnedLive: async () => null,
    };
    const registry = createResponsesRegistry(store, undefined, { now: () => 1000 });

    const write = registry.put(record());
    await expect(registry.get("resp_1", identity)).resolves.toMatchObject({
      responseId: "resp_1",
    });
    release();
    await write;
  });

  it("promotes a live record from the legacy blob on first read", async () => {
    const legacy = fakeConfigStore({
      responses_registry_v1: JSON.stringify({ records: [record()] }),
    });
    const store = fakeRegistryStore();
    const registry = createResponsesRegistry(store, legacy, { now: () => 1000 });

    await expect(registry.get("resp_1", identity)).resolves.toMatchObject({ responseId: "resp_1" });
    const fresh = createResponsesRegistry(store, undefined, { now: () => 1000 });
    await expect(fresh.get("resp_1", identity)).resolves.toMatchObject({ responseId: "resp_1" });
  });
});
